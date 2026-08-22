import { createServer } from "node:http";

import { RELAY_TURN_ACTION_SCHEMA_VERSION } from "./relay-turn-action.mjs";
import { parseJsonRejectingDuplicateMembers } from "./strict-json.mjs";
import {
  MAX_REMOTE_ACTION_BODY_BYTES,
  REMOTE_TURN_ACTION_PATH,
} from "./tailscale-turn-action-ingress.mjs";

export const LOCALHOST_TURN_ACTION_HOST = "127.0.0.1";
export const LOCALHOST_MAX_HEADER_BYTES = 16_384;
export const LOCALHOST_HEADERS_TIMEOUT_MS = 5_000;
export const LOCALHOST_REQUEST_TIMEOUT_MS = 10_000;
export const LOCALHOST_KEEP_ALIVE_TIMEOUT_MS = 1_000;
export const LOCALHOST_SHUTDOWN_GRACE_MS = 5_000;
export const LOCALHOST_MAX_CONNECTIONS = 32;
export const LOCALHOST_MAX_HEADERS = 32;

const FORWARDED_HEADERS = new Set([
  "authorization",
  "content-type",
  "tailscale-app-capabilities",
]);
const UNIQUE_FRAMING_HEADERS = new Set([
  "authorization",
  "content-encoding",
  "content-length",
  "content-type",
  "expect",
  "host",
  "tailscale-app-capabilities",
  "trailer",
  "transfer-encoding",
]);
const SAFE_RESPONSE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
});
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
const SAFE_STATUS_CODES = new Set([200, 400, 401, 404, 409, 413, 502, 503]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![\s\S])/u;

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

function safeReceipt(reason) {
  return JSON.stringify({
    schemaVersion: RELAY_TURN_ACTION_SCHEMA_VERSION,
    actionId: null,
    action: null,
    outcome: "rejected",
    reason,
  });
}

function adapterResponse(statusCode, reason) {
  return {
    statusCode,
    headers: SAFE_RESPONSE_HEADERS,
    body: safeReceipt(reason),
  };
}

function responseStatusMatchesReceipt(statusCode, receipt) {
  if (receipt.outcome === "accepted") return statusCode === 200;
  if (receipt.reason === "invalidRequest") {
    return [400, 404, 413].includes(statusCode);
  }
  if (receipt.reason === "invalidAction") return statusCode === 400;
  if (receipt.reason === "unauthorized") return statusCode === 401;
  if (["unavailable", "outcomeUnknown"].includes(receipt.reason)) {
    return statusCode === 503;
  }
  if (receipt.reason === "appServerRejected") return statusCode === 502;
  return statusCode === 409;
}

function selectSafeIngressResponse(value) {
  try {
    if (!hasExactKeys(value, ["body", "headers", "statusCode"])) return null;
    const statusCode = value.statusCode;
    const body = value.body;
    const headers = value.headers;
    if (
      !SAFE_STATUS_CODES.has(statusCode) ||
      typeof body !== "string" ||
      Buffer.byteLength(body) > 4_096 ||
      !hasExactKeys(headers, Object.keys(SAFE_RESPONSE_HEADERS)) ||
      Object.entries(SAFE_RESPONSE_HEADERS).some(
        ([name, expected]) => headers[name] !== expected,
      )
    ) {
      return null;
    }

    const receipt = parseJsonRejectingDuplicateMembers(body);
    if (
      !hasExactKeys(receipt, [
        "action",
        "actionId",
        "outcome",
        "reason",
        "schemaVersion",
      ]) ||
      receipt.schemaVersion !== RELAY_TURN_ACTION_SCHEMA_VERSION ||
      !(
        receipt.actionId === null ||
        (typeof receipt.actionId === "string" && SAFE_ID.test(receipt.actionId))
      ) ||
      ![null, "reply", "stop"].includes(receipt.action) ||
      (receipt.actionId === null) !== (receipt.action === null) ||
      !["accepted", "rejected"].includes(receipt.outcome) ||
      !(
        receipt.reason === null ||
        (typeof receipt.reason === "string" && SAFE_REASONS.has(receipt.reason))
      ) ||
      (receipt.outcome === "accepted" && receipt.reason !== null) ||
      (receipt.outcome === "rejected" && receipt.reason === null) ||
      !responseStatusMatchesReceipt(statusCode, receipt)
    ) {
      return null;
    }
    return { statusCode, body, headers: SAFE_RESPONSE_HEADERS };
  } catch {
    return null;
  }
}

function inspectHeaders(rawHeaders, expectedAuthority) {
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) return null;
  if (rawHeaders.length / 2 > LOCALHOST_MAX_HEADERS) return null;
  const headers = Object.create(null);
  const framing = Object.create(null);
  const seen = new Set();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const rawName = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (typeof rawName !== "string" || typeof value !== "string") return null;
    const name = rawName.toLowerCase();
    if (UNIQUE_FRAMING_HEADERS.has(name)) {
      if (seen.has(name)) return null;
      seen.add(name);
      framing[name] = value;
    }
    if (!FORWARDED_HEADERS.has(name)) continue;
    headers[name] = value;
  }
  if (
    framing.host !== expectedAuthority ||
    Object.hasOwn(framing, "transfer-encoding") ||
    Object.hasOwn(framing, "content-encoding") ||
    Object.hasOwn(framing, "trailer") ||
    Object.hasOwn(framing, "expect") ||
    typeof framing["content-length"] !== "string" ||
    !/^(?:0|[1-9]\d*)$/u.test(framing["content-length"])
  ) {
    return null;
  }
  const contentLength = Number(framing["content-length"]);
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) return null;
  return { headers, contentLength };
}

function readBoundedBody(request) {
  return new Promise((resolve) => {
    let bytes = 0;
    let chunks = [];
    let settled = false;

    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
    };
    const settle = (result, { drain = false } = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (drain) {
        request.on("error", () => {});
        request.resume();
      }
      resolve(result);
    };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_REMOTE_ACTION_BODY_BYTES) {
        chunks = [];
        settle({ state: "tooLarge" }, { drain: true });
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      if (!request.complete) {
        settle({ state: "aborted" });
        return;
      }
      settle({ state: "complete", body: Buffer.concat(chunks, bytes) });
    };
    const onAborted = () => settle({ state: "aborted" });
    const onError = () => settle({ state: "error" });

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("aborted", onAborted);
    request.on("error", onError);
  });
}

function writeResponse(response, value) {
  if (response.destroyed || response.writableEnded) return;
  const selected =
    selectSafeIngressResponse(value) ?? adapterResponse(503, "unavailable");
  try {
    response.strictContentLength = true;
    response.setHeader("connection", "close");
    response.setHeader("content-length", Buffer.byteLength(selected.body));
    for (const [name, headerValue] of Object.entries(selected.headers)) {
      response.setHeader(name, headerValue);
    }
    response.statusCode = selected.statusCode;
    response.end(selected.body);
  } catch {
    response.destroy();
  }
}

async function handleNodeRequest(
  request,
  response,
  { handleRequest, expectedAuthority, isClosing },
) {
  if (isClosing()) {
    request.on("error", () => {});
    request.resume();
    writeResponse(response, adapterResponse(503, "unavailable"));
    return;
  }
  if (
    request.httpVersion !== "1.1" ||
    request.method !== "POST" ||
    request.url !== REMOTE_TURN_ACTION_PATH
  ) {
    request.on("error", () => {});
    request.resume();
    writeResponse(response, adapterResponse(404, "invalidRequest"));
    return;
  }

  const inspected = inspectHeaders(request.rawHeaders, expectedAuthority());
  if (inspected === null) {
    request.on("error", () => {});
    request.resume();
    writeResponse(response, adapterResponse(400, "invalidRequest"));
    return;
  }
  if (inspected.contentLength > MAX_REMOTE_ACTION_BODY_BYTES) {
    request.on("error", () => {});
    request.resume();
    writeResponse(response, adapterResponse(413, "invalidRequest"));
    return;
  }

  const bodyResult = await readBoundedBody(request);
  if (bodyResult.state === "aborted") return;
  if (bodyResult.state === "tooLarge") {
    writeResponse(response, adapterResponse(413, "invalidRequest"));
    return;
  }
  if (bodyResult.state !== "complete") {
    writeResponse(response, adapterResponse(503, "unavailable"));
    return;
  }
  if (bodyResult.body.byteLength !== inspected.contentLength) {
    writeResponse(response, adapterResponse(400, "invalidRequest"));
    return;
  }

  let result;
  try {
    result = await handleRequest({
      method: request.method,
      path: request.url,
      headers: inspected.headers,
      body: bodyResult.body,
    });
  } catch {
    result = adapterResponse(503, "unavailable");
  }
  writeResponse(response, result);
}

function validatePort(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("port must be an integer from 0 through 65535");
  }
}

export function createLocalhostTurnActionListener({
  handleRequest,
  revokeControlContexts,
} = {}) {
  if (typeof handleRequest !== "function") {
    throw new TypeError("handleRequest must be a function");
  }
  if (typeof revokeControlContexts !== "function") {
    throw new TypeError("revokeControlContexts must be a function");
  }

  let closing = false;
  let expectedAuthority = null;
  const server = createServer({
    connectionsCheckingInterval: 1_000,
    headersTimeout: LOCALHOST_HEADERS_TIMEOUT_MS,
    insecureHTTPParser: false,
    keepAliveTimeout: LOCALHOST_KEEP_ALIVE_TIMEOUT_MS,
    maxHeaderSize: LOCALHOST_MAX_HEADER_BYTES,
    requestTimeout: LOCALHOST_REQUEST_TIMEOUT_MS,
    requireHostHeader: true,
  });
  server.maxConnections = LOCALHOST_MAX_CONNECTIONS;
  server.maxHeadersCount = LOCALHOST_MAX_HEADERS;
  server.maxRequestsPerSocket = 1;
  server.on("request", (request, response) => {
    void handleNodeRequest(request, response, {
      handleRequest,
      expectedAuthority: () => expectedAuthority,
      isClosing: () => closing,
    }).catch(() => writeResponse(response, adapterResponse(503, "unavailable")));
  });
  const rejectExpectation = (request, response) => {
    request.on("error", () => {});
    request.resume();
    writeResponse(response, adapterResponse(400, "invalidRequest"));
  };
  server.on("checkContinue", rejectExpectation);
  server.on("checkExpectation", rejectExpectation);
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("connect", (_request, socket) => socket.destroy());
  server.on("upgrade", (_request, socket) => socket.destroy());

  let startCalled = false;
  let startPromise = null;
  let closePromise = null;
  let closed = false;

  const start = ({ port = 0 } = {}) => {
    validatePort(port);
    if (closing || closed) throw new Error("listener is closing or closed");
    if (startCalled) throw new Error("listener start may be called only once");
    startCalled = true;
    startPromise = new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        closed = true;
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        if (
          !isObject(address) ||
          address.address !== LOCALHOST_TURN_ACTION_HOST ||
          ![4, "IPv4"].includes(address.family) ||
          !Number.isInteger(address.port) ||
          address.port <= 0 ||
          address.port > 65_535
        ) {
          closed = true;
          const error = new Error(
            "listener did not bind to the required loopback host",
          );
          server.close(() => reject(error));
          server.closeAllConnections();
          return;
        }
        expectedAuthority = `${LOCALHOST_TURN_ACTION_HOST}:${address.port}`;
        resolve(
          Object.freeze({
            host: LOCALHOST_TURN_ACTION_HOST,
            port: address.port,
          }),
        );
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({
        exclusive: true,
        host: LOCALHOST_TURN_ACTION_HOST,
        port,
      });
    });
    return startPromise;
  };

  const close = () => {
    if (closePromise !== null) return closePromise;
    closePromise = (async () => {
      closing = true;
      let closeServerPromise = null;
      if (server.listening) {
        closeServerPromise = new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      let revocationError = null;
      try {
        revokeControlContexts();
      } catch (error) {
        revocationError = error;
      }

      if (startPromise !== null) {
        try {
          await startPromise;
        } catch {
          // A failed bind has no open listener to drain.
        }
      }
      if (closeServerPromise === null && server.listening) {
        closeServerPromise = new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      if (closeServerPromise !== null) {
        server.closeIdleConnections();
        const forceTimer = setTimeout(
          () => server.closeAllConnections(),
          revocationError === null ? LOCALHOST_SHUTDOWN_GRACE_MS : 0,
        );
        forceTimer.unref();
        try {
          await closeServerPromise;
        } finally {
          clearTimeout(forceTimer);
        }
      }
      closed = true;
      if (revocationError !== null) {
        throw new Error("control context revocation failed", {
          cause: revocationError,
        });
      }
    })();
    return closePromise;
  };

  const api = { start, close };
  Object.defineProperty(api, "listening", {
    enumerable: true,
    get: () => server.listening,
  });
  return Object.freeze(api);
}
