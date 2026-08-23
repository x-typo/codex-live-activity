import { RELAY_TURN_ACTION_SCHEMA_VERSION } from "./relay-turn-action.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![\s\S])/u;
const ACTIONS = new Set(["reply", "stop"]);

export const REMOTE_ACTION_RECEIPT_HANDLER_PHASES = Object.freeze({
  invalidContentType: "invalidContentType",
  invalidAction: "invalidAction",
  validAction: "validAction",
});

const HANDLER_PHASES = new Set(
  Object.values(REMOTE_ACTION_RECEIPT_HANDLER_PHASES),
);

function receiptVariant(
  defaultStatus,
  correlated,
  { statuses = [defaultStatus], handlerPhases = [] } = {},
) {
  return Object.freeze({
    correlated,
    statuses: Object.freeze([...statuses]),
    handlerPhases: Object.freeze([...handlerPhases]),
    defaultStatus,
  });
}

function receiptRule(...variants) {
  return Object.freeze(variants);
}

const VALID_ACTION_PHASE = REMOTE_ACTION_RECEIPT_HANDLER_PHASES.validAction;
const CORRELATED_ACCEPTED_RULE = receiptRule(
  receiptVariant(200, true, { handlerPhases: [VALID_ACTION_PHASE] }),
);
const CORRELATED_CONFLICT_RULE = receiptRule(
  receiptVariant(409, true, { handlerPhases: [VALID_ACTION_PHASE] }),
);
const REJECTED_RULES = new Map([
  [
    "appServerRejected",
    receiptRule(receiptVariant(502, true, { handlerPhases: [VALID_ACTION_PHASE] })),
  ],
  ["busy", CORRELATED_CONFLICT_RULE],
  ["duplicateAction", CORRELATED_CONFLICT_RULE],
  ["expiredControlContext", CORRELATED_CONFLICT_RULE],
  ["expiredRequest", CORRELATED_CONFLICT_RULE],
  [
    "invalidAction",
    receiptRule(
      receiptVariant(400, false, {
        handlerPhases: [REMOTE_ACTION_RECEIPT_HANDLER_PHASES.invalidAction],
      }),
    ),
  ],
  [
    "invalidRequest",
    receiptRule(
      receiptVariant(400, false, {
        handlerPhases: [
          REMOTE_ACTION_RECEIPT_HANDLER_PHASES.invalidContentType,
        ],
      }),
      receiptVariant(404, false),
      receiptVariant(413, false),
      receiptVariant(400, true, { handlerPhases: [VALID_ACTION_PHASE] }),
    ),
  ],
  ["noActiveTurn", CORRELATED_CONFLICT_RULE],
  [
    "outcomeUnknown",
    receiptRule(receiptVariant(503, true, { handlerPhases: [VALID_ACTION_PHASE] })),
  ],
  ["replayConflict", CORRELATED_CONFLICT_RULE],
  ["staleTurn", CORRELATED_CONFLICT_RULE],
  ["stopPending", CORRELATED_CONFLICT_RULE],
  [
    "unauthorized",
    receiptRule(
      receiptVariant(401, false, {
        handlerPhases: [
          REMOTE_ACTION_RECEIPT_HANDLER_PHASES.invalidAction,
          VALID_ACTION_PHASE,
        ],
      }),
    ),
  ],
  [
    "unavailable",
    receiptRule(
      receiptVariant(503, false),
      receiptVariant(503, true, { handlerPhases: [VALID_ACTION_PHASE] }),
    ),
  ],
  ["unknownControlContext", CORRELATED_CONFLICT_RULE],
  ["wrongThread", CORRELATED_CONFLICT_RULE],
]);

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

function safeCorrelation(value) {
  if (!isObject(value)) return null;
  let actionId;
  let action;
  try {
    actionId = value.actionId;
    action = value.action;
  } catch {
    return null;
  }
  return typeof actionId === "string" && SAFE_ID.test(actionId) && ACTIONS.has(action)
    ? { actionId, action }
    : null;
}

export function projectRemoteActionCorrelation(value) {
  const correlation = safeCorrelation(value);
  return correlation === null ? null : Object.freeze(correlation);
}

function ruleFor(outcome, reason) {
  if (outcome === "accepted" && reason === null) {
    return CORRELATED_ACCEPTED_RULE;
  }
  if (outcome !== "rejected" || typeof reason !== "string") return null;
  return REJECTED_RULES.get(reason) ?? null;
}

function variantFor(rule, correlated, options) {
  const hasStatusCode = Object.hasOwn(options, "statusCode");
  const hasHandlerPhase = Object.hasOwn(options, "handlerPhase");
  if (
    hasHandlerPhase &&
    !HANDLER_PHASES.has(options.handlerPhase)
  ) {
    return null;
  }
  return (
    rule.find(
      (variant) =>
        variant.correlated === correlated &&
        (!hasStatusCode || variant.statuses.includes(options.statusCode)) &&
        (!hasHandlerPhase ||
          variant.handlerPhases.includes(options.handlerPhase)),
    ) ?? null
  );
}

export function projectRemoteActionReceipt(value, options = {}) {
  try {
    if (
      !hasExactKeys(value, [
        "action",
        "actionId",
        "outcome",
        "reason",
        "schemaVersion",
      ])
    ) {
      return null;
    }
    const receipt = {
      schemaVersion: value.schemaVersion,
      actionId: value.actionId,
      action: value.action,
      outcome: value.outcome,
      reason: value.reason,
    };
    if (
      !hasExactKeys(value, [
        "action",
        "actionId",
        "outcome",
        "reason",
        "schemaVersion",
      ]) ||
      receipt.schemaVersion !== RELAY_TURN_ACTION_SCHEMA_VERSION
    ) {
      return null;
    }

    const correlated = safeCorrelation(receipt);
    const uncorrelated = receipt.actionId === null && receipt.action === null;
    if (correlated === null && !uncorrelated) return null;

    const rule = ruleFor(receipt.outcome, receipt.reason);
    if (rule === null) return null;
    if (options.requireCorrelation === true && correlated === null) return null;

    if (Object.hasOwn(options, "expectedAction") && correlated !== null) {
      const expected = safeCorrelation(options.expectedAction);
      if (
        expected === null ||
        correlated.actionId !== expected.actionId ||
        correlated.action !== expected.action
      ) {
        return null;
      }
    }
    if (variantFor(rule, correlated !== null, options) === null) return null;

    return Object.freeze(receipt);
  } catch {
    return null;
  }
}

export function createRemoteActionReceipt({ action = null, outcome, reason }) {
  const correlation = action === null ? null : safeCorrelation(action);
  if (action !== null && correlation === null) {
    throw new TypeError("invalid remote action correlation");
  }
  const receipt = projectRemoteActionReceipt(
    {
      schemaVersion: RELAY_TURN_ACTION_SCHEMA_VERSION,
      actionId: correlation?.actionId ?? null,
      action: correlation?.action ?? null,
      outcome,
      reason,
    },
    { expectedAction: correlation },
  );
  if (receipt === null) throw new TypeError("invalid remote action receipt");
  return receipt;
}

export function serializeRemoteActionReceipt(value) {
  const receipt = projectRemoteActionReceipt(value);
  if (receipt === null) throw new TypeError("invalid remote action receipt");
  return JSON.stringify(receipt);
}

export function defaultHttpStatusForRemoteActionReceipt(value) {
  const receipt = projectRemoteActionReceipt(value);
  if (receipt === null) throw new TypeError("invalid remote action receipt");
  const variant = variantFor(
    ruleFor(receipt.outcome, receipt.reason),
    receipt.actionId !== null,
    {},
  );
  return variant.defaultStatus;
}

export function isHttpStatusForRemoteActionReceipt(statusCode, value) {
  return projectRemoteActionReceipt(value, { statusCode }) !== null;
}
