import { createHmac } from "node:crypto";

import {
  MAX_REPLY_CODE_POINTS,
  RELAY_TURN_ACTION_SCHEMA_VERSION,
} from "./relay-turn-action.mjs";

export const REMOTE_TURN_ACTION_PATH = "/v1/turn-actions";
export const DEFAULT_MAX_REMOTE_ACTION_WINDOW_MS = 60_000;
export const DEFAULT_MAX_REMOTE_ACTION_CLOCK_SKEW_MS = 30_000;
export const MAX_REMOTE_ACTION_BODY_BYTES = 32_768;
export const MIN_REMOTE_ACTION_HMAC_KEY_BYTES = 32;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![\s\S])/u;
const FINGERPRINT = /^[a-f0-9]{64}$/u;
const SAFE_REASONS = new Set([
  "appServerRejected",
  "busy",
  "duplicateAction",
  "expiredControlContext",
  "expiredRequest",
  "invalidAction",
  "invalidRequest",
  "noActiveTurn",
  "outcomeUnknown",
  "replayConflict",
  "staleTurn",
  "stopPending",
  "unauthorized",
  "unavailable",
  "unknownControlContext",
  "wrongThread",
]);
const ACTIONS = new Set(["reply", "stop"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isSafeId(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}

function isPrivateIdentifier(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.toWellFormed() &&
    !/[\r\n\t]/u.test(value) &&
    [...value].length <= 128
  );
}

function parseRfc3339DateTime(value) {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/u,
  );
  if (match === null) return Number.NaN;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59 ||
    (match[7] !== undefined && Number(match[7]) > 23) ||
    (match[8] !== undefined && Number(match[8]) > 59)
  ) {
    return Number.NaN;
  }
  return Date.parse(value);
}

function safeAction(value) {
  return ACTIONS.has(value) ? value : null;
}

function headerValue(headers, name) {
  if (!isObject(headers)) return null;
  const matches = Object.entries(headers).filter(
    ([key]) => key.toLowerCase() === name,
  );
  if (matches.length !== 1 || typeof matches[0][1] !== "string") return null;
  return matches[0][1];
}

function hasTailscaleCapability(header, expectedCapability) {
  if (typeof header !== "string" || header.length > 8_192) return false;
  try {
    const capabilities = JSON.parse(header);
    if (!isObject(capabilities) || !Object.hasOwn(capabilities, expectedCapability)) {
      return false;
    }
    const grants = capabilities[expectedCapability];
    return (
      Array.isArray(grants) &&
      grants.length > 0 &&
      grants.every((grant) => isObject(grant))
    );
  } catch {
    return false;
  }
}

function parseAuthorization(value) {
  if (typeof value !== "string" || value.length > 4_096) {
    return null;
  }
  const scheme = /^Bearer +/iu.exec(value);
  if (scheme === null) return null;
  const token = value.slice(scheme[0].length);
  return token.length > 0 && !/[\r\n]/u.test(token) ? token : null;
}

function requestBodyBytes(body) {
  if (typeof body === "string") return Buffer.byteLength(body);
  if (body instanceof Uint8Array) return body.byteLength;
  return Number.NaN;
}

function hasJsonContentType(value) {
  if (typeof value !== "string" || value.length > 256) return false;
  return /^application\/json(?:[ \t]*;[ \t]*charset=(?:utf-8|"utf-8"))?[ \t]*$/i.test(
    value,
  );
}

function decodeRequestBody(body) {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  }
  throw new TypeError("unsupported request body");
}

function validateRemoteAction(candidate) {
  if (!isObject(candidate)) return null;
  try {
    const actionName = safeAction(candidate.action);
    const expectedKeys =
      actionName === "reply"
        ? [
            "action",
            "actionId",
            "controlContextId",
            "expiresAt",
            "issuedAt",
            "schemaVersion",
            "text",
          ]
        : [
            "action",
            "actionId",
            "controlContextId",
            "expiresAt",
            "issuedAt",
            "schemaVersion",
          ];
    if (
      candidate.schemaVersion !== RELAY_TURN_ACTION_SCHEMA_VERSION ||
      actionName === null ||
      !hasExactKeys(candidate, expectedKeys) ||
      !isSafeId(candidate.actionId) ||
      !isSafeId(candidate.controlContextId) ||
      typeof candidate.issuedAt !== "string" ||
      typeof candidate.expiresAt !== "string"
    ) {
      return null;
    }

    const action = {
      schemaVersion: RELAY_TURN_ACTION_SCHEMA_VERSION,
      actionId: candidate.actionId,
      controlContextId: candidate.controlContextId,
      issuedAt: candidate.issuedAt,
      expiresAt: candidate.expiresAt,
      action: actionName,
    };
    if (actionName === "reply") {
      if (
        typeof candidate.text !== "string" ||
        candidate.text !== candidate.text.toWellFormed() ||
        candidate.text.trim().length === 0 ||
        [...candidate.text].length > MAX_REPLY_CODE_POINTS
      ) {
        return null;
      }
      action.text = candidate.text;
    }
    return Object.freeze(action);
  } catch {
    return null;
  }
}

function networkReceipt({ actionId = null, action = null, outcome, reason }) {
  if (
    !["accepted", "rejected"].includes(outcome) ||
    (reason !== null && !SAFE_REASONS.has(reason)) ||
    (outcome === "accepted" && reason !== null) ||
    (outcome === "rejected" && reason === null)
  ) {
    throw new TypeError("invalid remote action receipt");
  }
  return {
    schemaVersion: RELAY_TURN_ACTION_SCHEMA_VERSION,
    actionId: isSafeId(actionId) ? actionId : null,
    action: safeAction(action),
    outcome,
    reason,
  };
}

function rejected(reason, action = null) {
  return networkReceipt({
    actionId: action?.actionId,
    action: action?.action,
    outcome: "rejected",
    reason,
  });
}

function response(statusCode, receipt) {
  return {
    statusCode,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
    body: JSON.stringify(receipt),
  };
}

function statusFor(receipt) {
  if (receipt.outcome === "accepted") return 200;
  if (receipt.reason === "invalidRequest" || receipt.reason === "invalidAction") {
    return 400;
  }
  if (receipt.reason === "unauthorized") return 401;
  if (receipt.reason === "unavailable" || receipt.reason === "outcomeUnknown") {
    return 503;
  }
  if (receipt.reason === "appServerRejected") return 502;
  return 409;
}

function completedReceipt(value, action) {
  if (
    !hasExactKeys(value, [
      "action",
      "actionId",
      "outcome",
      "reason",
      "schemaVersion",
    ]) ||
    value.schemaVersion !== RELAY_TURN_ACTION_SCHEMA_VERSION ||
    value.actionId !== action.actionId ||
    value.action !== action.action ||
    !["accepted", "rejected"].includes(value.outcome) ||
    (value.reason !== null && !SAFE_REASONS.has(value.reason))
  ) {
    return null;
  }
  return networkReceipt(value);
}

function actionResultReceipt(value, action) {
  const expectedMethod =
    action.action === "reply" ? "turn/steer" : "turn/interrupt";
  if (
    !hasExactKeys(value, [
      "action",
      "actionId",
      "appServerMethod",
      "outcome",
      "reason",
      "schemaVersion",
    ]) ||
    value.schemaVersion !== RELAY_TURN_ACTION_SCHEMA_VERSION ||
    value.actionId !== action.actionId ||
    value.action !== action.action ||
    !["accepted", "rejected"].includes(value.outcome) ||
    (value.reason !== null && !SAFE_REASONS.has(value.reason)) ||
    (value.outcome === "accepted" && value.appServerMethod !== expectedMethod) ||
    (value.outcome === "rejected" && value.appServerMethod !== null)
  ) {
    return null;
  }
  return networkReceipt(value);
}

function validateContext(value, nowMs) {
  if (!isObject(value)) return null;
  let context;
  try {
    context = {
      expiresAtMs: value.expiresAtMs,
      threadId: value.threadId,
      expectedTurnId: value.expectedTurnId,
      dispatch: value.dispatch,
    };
  } catch {
    return null;
  }
  if (
    !Number.isSafeInteger(context.expiresAtMs) ||
    !isPrivateIdentifier(context.threadId) ||
    !isPrivateIdentifier(context.expectedTurnId) ||
    typeof context.dispatch !== "function"
  ) {
    return null;
  }
  if (nowMs >= context.expiresAtMs) return "expired";
  return context;
}

function validateReplayState(value, action, { allowMissing = false } = {}) {
  if (!isObject(value)) return null;
  let state;
  try {
    state = value.state;
  } catch {
    return null;
  }
  if (typeof state !== "string") return null;
  if (
    allowMissing &&
    state === "missing" &&
    hasExactKeys(value, ["state"])
  ) {
    return { state };
  }
  if (state === "new" && hasExactKeys(value, ["state"])) return { state };
  if (
    ["conflict", "uncertain"].includes(state) &&
    hasExactKeys(value, ["state"])
  ) {
    return { state };
  }
  if (
    state === "completed" &&
    hasExactKeys(value, ["receipt", "state"])
  ) {
    const receipt = completedReceipt(value.receipt, action);
    return receipt === null ? null : { state: "completed", receipt };
  }
  return null;
}

export function createRemoteActionHmacFingerprint(key) {
  if (!(typeof key === "string" || key instanceof Uint8Array)) {
    throw new TypeError("fingerprint key must be a string or Uint8Array");
  }
  const keyCopy = Buffer.from(key);
  if (keyCopy.byteLength < MIN_REMOTE_ACTION_HMAC_KEY_BYTES) {
    throw new TypeError(
      `fingerprint key must be at least ${MIN_REMOTE_ACTION_HMAC_KEY_BYTES} bytes`,
    );
  }
  return (action) =>
    createHmac("sha256", keyCopy).update(JSON.stringify(action)).digest("hex");
}

export function createTailscaleTurnActionRequestHandler({
  expectedCapability,
  authorizeAppToken,
  resolveControlContext,
  replayStore,
  fingerprintAction,
  now = Date.now,
  maxRequestWindowMs = DEFAULT_MAX_REMOTE_ACTION_WINDOW_MS,
  maxClockSkewMs = DEFAULT_MAX_REMOTE_ACTION_CLOCK_SKEW_MS,
} = {}) {
  if (typeof expectedCapability !== "string" || expectedCapability.length === 0) {
    throw new TypeError("expectedCapability must be non-empty");
  }
  if (typeof authorizeAppToken !== "function") {
    throw new TypeError("authorizeAppToken must be a function");
  }
  if (typeof resolveControlContext !== "function") {
    throw new TypeError("resolveControlContext must be a function");
  }
  if (
    !isObject(replayStore) ||
    typeof replayStore.inspect !== "function" ||
    typeof replayStore.claim !== "function" ||
    typeof replayStore.complete !== "function"
  ) {
    throw new TypeError(
      "replayStore must provide inspect, claim, and complete functions",
    );
  }
  if (typeof fingerprintAction !== "function") {
    throw new TypeError("fingerprintAction must be a function");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (!Number.isSafeInteger(maxRequestWindowMs) || maxRequestWindowMs <= 0) {
    throw new TypeError("maxRequestWindowMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxClockSkewMs) || maxClockSkewMs < 0) {
    throw new TypeError("maxClockSkewMs must be a non-negative safe integer");
  }

  return async function handleTailscaleTurnAction(request) {
    if (
      !isObject(request) ||
      request.method !== "POST" ||
      request.path !== REMOTE_TURN_ACTION_PATH
    ) {
      return response(404, rejected("invalidRequest"));
    }

    const bodyBytes = requestBodyBytes(request.body);
    if (!Number.isFinite(bodyBytes)) {
      return response(400, rejected("invalidRequest"));
    }
    if (bodyBytes > MAX_REMOTE_ACTION_BODY_BYTES) {
      return response(413, rejected("invalidRequest"));
    }
    if (!hasJsonContentType(headerValue(request.headers, "content-type"))) {
      return response(400, rejected("invalidRequest"));
    }
    if (
      !hasTailscaleCapability(
        headerValue(request.headers, "tailscale-app-capabilities"),
        expectedCapability,
      )
    ) {
      return response(401, rejected("unauthorized"));
    }

    const appToken = parseAuthorization(
      headerValue(request.headers, "authorization"),
    );
    let installationId;
    try {
      installationId =
        appToken === null ? null : await authorizeAppToken(appToken);
    } catch {
      installationId = null;
    }
    if (!isSafeId(installationId)) {
      return response(401, rejected("unauthorized"));
    }

    let action;
    try {
      action = validateRemoteAction(JSON.parse(decodeRequestBody(request.body)));
    } catch {
      action = null;
    }
    if (action === null) return response(400, rejected("invalidAction"));

    let nowMs;
    try {
      nowMs = now();
    } catch {
      return response(503, rejected("unavailable", action));
    }
    const issuedAtMs = parseRfc3339DateTime(action.issuedAt);
    const expiresAtMs = parseRfc3339DateTime(action.expiresAt);
    if (
      !Number.isSafeInteger(nowMs) ||
      !Number.isFinite(issuedAtMs) ||
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs <= issuedAtMs ||
      expiresAtMs - issuedAtMs > maxRequestWindowMs ||
      issuedAtMs > nowMs + maxClockSkewMs
    ) {
      return response(400, rejected("invalidRequest", action));
    }
    if (nowMs >= expiresAtMs) {
      return response(409, rejected("expiredRequest", action));
    }

    let fingerprint;
    try {
      fingerprint = await fingerprintAction(action);
    } catch {
      fingerprint = null;
    }
    if (typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint)) {
      return response(503, rejected("unavailable", action));
    }

    const replayRecord = {
      installationId,
      actionId: action.actionId,
      fingerprint,
      expiresAtMs,
    };
    let inspected;
    try {
      inspected = validateReplayState(
        await replayStore.inspect(replayRecord),
        action,
        { allowMissing: true },
      );
    } catch {
      inspected = null;
    }
    if (inspected === null) {
      return response(503, rejected("unavailable", action));
    }
    if (inspected.state === "completed") {
      return response(statusFor(inspected.receipt), inspected.receipt);
    }
    if (inspected.state === "conflict") {
      return response(409, rejected("replayConflict", action));
    }
    if (inspected.state === "uncertain") {
      return response(503, rejected("outcomeUnknown", action));
    }

    let context;
    try {
      context = validateContext(
        await resolveControlContext(action.controlContextId),
        nowMs,
      );
    } catch {
      return response(503, rejected("unavailable", action));
    }
    if (context === "expired") {
      return response(409, rejected("expiredControlContext", action));
    }
    if (context === null) {
      return response(409, rejected("unknownControlContext", action));
    }

    let claim;
    try {
      claim = validateReplayState(await replayStore.claim(replayRecord), action);
    } catch {
      claim = null;
    }
    if (claim === null) {
      return response(503, rejected("unavailable", action));
    }
    if (claim.state === "completed") {
      return response(statusFor(claim.receipt), claim.receipt);
    }
    if (claim.state === "conflict") {
      return response(409, rejected("replayConflict", action));
    }
    if (claim.state === "uncertain") {
      return response(503, rejected("outcomeUnknown", action));
    }

    const completeReceipt = async (receipt) => {
      try {
        await replayStore.complete({ ...replayRecord, receipt });
      } catch {
        return response(503, rejected("outcomeUnknown", action));
      }
      return response(statusFor(receipt), receipt);
    };

    let dispatchNowMs;
    try {
      dispatchNowMs = now();
    } catch {
      dispatchNowMs = null;
    }
    if (!Number.isSafeInteger(dispatchNowMs)) {
      return completeReceipt(rejected("unavailable", action));
    }
    if (dispatchNowMs >= expiresAtMs) {
      return completeReceipt(rejected("expiredRequest", action));
    }
    if (dispatchNowMs >= context.expiresAtMs) {
      return completeReceipt(rejected("expiredControlContext", action));
    }

    const privateAction = {
      schemaVersion: RELAY_TURN_ACTION_SCHEMA_VERSION,
      actionId: action.actionId,
      action: action.action,
      threadId: context.threadId,
      expectedTurnId: context.expectedTurnId,
    };
    if (action.action === "reply") privateAction.text = action.text;

    let receipt;
    try {
      receipt = actionResultReceipt(await context.dispatch(privateAction), action);
    } catch {
      receipt = null;
    }
    if (receipt === null) receipt = rejected("outcomeUnknown", action);
    return completeReceipt(receipt);
  };
}
