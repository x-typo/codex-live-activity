import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MockOneTaskTurnActionBoundary } from "../src/relay-turn-action.mjs";
import {
  MAX_REMOTE_ACTION_BODY_BYTES,
  MIN_REMOTE_ACTION_HMAC_KEY_BYTES,
  REMOTE_TURN_ACTION_PATH,
  createRemoteActionHmacFingerprint,
  createTailscaleTurnActionRequestHandler,
} from "../src/tailscale-turn-action-ingress.mjs";
import { validateJsonSchema } from "../test-support/json-schema-validator.mjs";

const NOW = Date.parse("2026-08-22T20:00:30.000Z");
const CAPABILITY = "github.com/x-typo/codex-live-activity/cap/control";
const REPLY_TEXT = "SENSITIVE_SYNTHETIC_REMOTE_REPLY";
const APP_TOKEN = "SENSITIVE_SYNTHETIC_APP_TOKEN";

const remoteActionSchema = JSON.parse(
  await readFile(
    new URL("../schema/relay-remote-action.v1.schema.json", import.meta.url),
    "utf8",
  ),
);

function remoteStop(overrides = {}) {
  return {
    schemaVersion: 1,
    actionId: "remote-stop-1",
    controlContextId: "context-active-1",
    issuedAt: "2026-08-22T20:00:00.000Z",
    expiresAt: "2026-08-22T20:01:00.000Z",
    action: "stop",
    ...overrides,
  };
}

function remoteReply(overrides = {}) {
  return {
    schemaVersion: 1,
    actionId: "remote-reply-1",
    controlContextId: "context-active-1",
    issuedAt: "2026-08-22T20:00:00.000Z",
    expiresAt: "2026-08-22T20:01:00.000Z",
    action: "reply",
    text: REPLY_TEXT,
    ...overrides,
  };
}

function requestFor(action, overrides = {}) {
  return {
    method: "POST",
    path: REMOTE_TURN_ACTION_PATH,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${APP_TOKEN}`,
      "tailscale-app-capabilities": JSON.stringify({
        [CAPABILITY]: [{ source: ["self"] }],
      }),
    },
    body: JSON.stringify(action),
    ...overrides,
  };
}

function receiptFrom(response) {
  return JSON.parse(response.body);
}

class DeterministicReplayStore {
  constructor({ failComplete = false } = {}) {
    this.failComplete = failComplete;
    this.records = new Map();
    this.inspectCalls = [];
    this.claimCalls = [];
    this.completeCalls = [];
  }

  async inspect(record) {
    this.inspectCalls.push(structuredClone(record));
    const key = `${record.installationId}:${record.actionId}`;
    const existing = this.records.get(key);
    if (existing === undefined) return { state: "missing" };
    if (existing.fingerprint !== record.fingerprint) {
      return { state: "conflict" };
    }
    if (existing.receipt !== undefined) {
      return { state: "completed", receipt: structuredClone(existing.receipt) };
    }
    return { state: "uncertain" };
  }

  async claim(record) {
    this.claimCalls.push(structuredClone(record));
    const key = `${record.installationId}:${record.actionId}`;
    const existing = this.records.get(key);
    if (existing === undefined) {
      this.records.set(key, structuredClone(record));
      return { state: "new" };
    }
    if (existing.fingerprint !== record.fingerprint) {
      return { state: "conflict" };
    }
    if (existing.receipt !== undefined) {
      return { state: "completed", receipt: structuredClone(existing.receipt) };
    }
    return { state: "uncertain" };
  }

  async complete(record) {
    this.completeCalls.push(structuredClone(record));
    if (this.failComplete) throw new Error("SENSITIVE_REPLAY_WRITE_FAILURE");
    const key = `${record.installationId}:${record.actionId}`;
    this.records.set(key, structuredClone(record));
  }
}

function createHarness({
  replayStore = new DeterministicReplayStore(),
  contextExpiresAtMs = NOW + 120_000,
  resolve = true,
  activeTurnId = "turn-active",
  dispatchOverride,
  responder,
  now = () => NOW,
} = {}) {
  const requests = [];
  const boundary = new MockOneTaskTurnActionBoundary({
    threadId: "thread-owned",
    getActiveTurnId: () => activeTurnId,
    sendRequest: async (request) => {
      requests.push(structuredClone(request));
      if (responder) return responder(request);
      if (request.method === "turn/steer") {
        return { id: request.id, result: { turnId: "turn-active" } };
      }
      return { id: request.id, result: {} };
    },
  });
  let authorizationCalls = 0;
  let resolutionCalls = 0;
  const handler = createTailscaleTurnActionRequestHandler({
    expectedCapability: CAPABILITY,
    authorizeAppToken: async (token) => {
      authorizationCalls += 1;
      return token === APP_TOKEN ? "installation-iphone-1" : null;
    },
    resolveControlContext: async (controlContextId) => {
      resolutionCalls += 1;
      if (!resolve || controlContextId !== "context-active-1") return null;
      return {
        expiresAtMs: contextExpiresAtMs,
        threadId: "thread-owned",
        expectedTurnId: "turn-active",
        dispatch: dispatchOverride ?? boundary.dispatch.bind(boundary),
      };
    },
    replayStore,
    fingerprintAction: createRemoteActionHmacFingerprint(
      "SENSITIVE_SYNTHETIC_FINGERPRINT_KEY",
    ),
    now,
  });
  return {
    handler,
    replayStore,
    requests,
    get authorizationCalls() {
      return authorizationCalls;
    },
    get resolutionCalls() {
      return resolutionCalls;
    },
  };
}

test("the remote schema carries opaque correlation and excludes private task IDs", () => {
  assert.deepEqual(validateJsonSchema(remoteStop(), remoteActionSchema), []);
  assert.deepEqual(validateJsonSchema(remoteReply(), remoteActionSchema), []);
  assert.notDeepEqual(
    validateJsonSchema(
      remoteStop({ threadId: "thread-must-stay-on-mac" }),
      remoteActionSchema,
    ),
    [],
  );
  assert.notDeepEqual(
    validateJsonSchema(
      remoteStop({ expectedTurnId: "turn-must-stay-on-mac" }),
      remoteActionSchema,
    ),
    [],
  );
  assert.notDeepEqual(
    validateJsonSchema(remoteReply({ unknown: REPLY_TEXT }), remoteActionSchema),
    [],
  );
  assert.notDeepEqual(
    validateJsonSchema(remoteReply({ text: "   " }), remoteActionSchema),
    [],
  );
});

test("the request fingerprint requires a SHA-256-length secret key", () => {
  assert.throws(
    () =>
      createRemoteActionHmacFingerprint(
        Buffer.alloc(MIN_REMOTE_ACTION_HMAC_KEY_BYTES - 1),
      ),
    /at least 32 bytes/u,
  );
  assert.doesNotThrow(() =>
    createRemoteActionHmacFingerprint(
      Buffer.alloc(MIN_REMOTE_ACTION_HMAC_KEY_BYTES),
    ),
  );
});

test("authorized Stop resolves opaque context to the exact private active turn", async () => {
  const state = createHarness();
  const result = await state.handler(requestFor(remoteStop()));

  assert.equal(result.statusCode, 200);
  assert.deepEqual(state.requests, [
    {
      id: "remote-stop-1",
      method: "turn/interrupt",
      params: { threadId: "thread-owned", turnId: "turn-active" },
    },
  ]);
  assert.deepEqual(receiptFrom(result), {
    schemaVersion: 1,
    actionId: "remote-stop-1",
    action: "stop",
    outcome: "accepted",
    reason: null,
  });
  const retained = JSON.stringify([...state.replayStore.records]);
  assert.equal(retained.includes("thread-owned"), false);
  assert.equal(retained.includes("turn-active"), false);
  assert.equal(retained.includes(APP_TOKEN), false);
});

test("authorized Reply forwards text only to the private boundary and redacts it", async () => {
  const state = createHarness();
  const result = await state.handler(requestFor(remoteReply()));

  assert.equal(result.statusCode, 200);
  assert.deepEqual(state.requests, [
    {
      id: "remote-reply-1",
      method: "turn/steer",
      params: {
        threadId: "thread-owned",
        input: [{ type: "text", text: REPLY_TEXT }],
        expectedTurnId: "turn-active",
      },
    },
  ]);
  const persisted = JSON.stringify({
    records: [...state.replayStore.records],
    inspections: state.replayStore.inspectCalls,
    claims: state.replayStore.claimCalls,
    completions: state.replayStore.completeCalls,
  });
  assert.equal(result.body.includes(REPLY_TEXT), false);
  assert.equal(persisted.includes(REPLY_TEXT), false);
  assert.equal(persisted.includes(APP_TOKEN), false);
  assert.equal(persisted.includes("thread-owned"), false);
  assert.equal(persisted.includes("turn-active"), false);
});

test("requires both Tailscale capability and paired app authorization", async () => {
  const missingCapability = createHarness();
  const headersWithoutCapability = {
    "content-type": "application/json",
    authorization: `Bearer ${APP_TOKEN}`,
  };
  const capabilityResult = await missingCapability.handler(
    requestFor(remoteStop(), { headers: headersWithoutCapability }),
  );
  assert.equal(capabilityResult.statusCode, 401);
  assert.equal(receiptFrom(capabilityResult).reason, "unauthorized");
  assert.equal(missingCapability.authorizationCalls, 0);
  assert.equal(missingCapability.resolutionCalls, 0);

  const wrongToken = createHarness();
  const badHeaders = {
    ...requestFor(remoteStop()).headers,
    authorization: "Bearer wrong-token",
  };
  const tokenResult = await wrongToken.handler(
    requestFor(remoteStop(), { headers: badHeaders }),
  );
  assert.equal(tokenResult.statusCode, 401);
  assert.equal(receiptFrom(tokenResult).reason, "unauthorized");
  assert.equal(wrongToken.resolutionCalls, 0);
  assert.deepEqual(wrongToken.replayStore.claimCalls, []);
});

test("rejects expired requests and unknown or expired control contexts", async () => {
  const expiredRequest = createHarness();
  const requestResult = await expiredRequest.handler(
    requestFor(
      remoteStop({
        issuedAt: "2026-08-22T19:59:00.000Z",
        expiresAt: "2026-08-22T20:00:00.000Z",
      }),
    ),
  );
  assert.equal(receiptFrom(requestResult).reason, "expiredRequest");
  assert.equal(expiredRequest.resolutionCalls, 0);

  const unknown = createHarness({ resolve: false });
  const unknownResult = await unknown.handler(requestFor(remoteStop()));
  assert.equal(receiptFrom(unknownResult).reason, "unknownControlContext");
  assert.deepEqual(unknown.replayStore.claimCalls, []);

  const expiredContext = createHarness({ contextExpiresAtMs: NOW });
  const contextResult = await expiredContext.handler(requestFor(remoteStop()));
  assert.equal(receiptFrom(contextResult).reason, "expiredControlContext");
  assert.deepEqual(expiredContext.replayStore.claimCalls, []);
});

test("runtime freshness checks preserve the RFC 3339 schema boundary", async () => {
  const malformedDate = createHarness();
  const malformedResult = await malformedDate.handler(
    requestFor(remoteStop({ issuedAt: "2026-08-22 20:00:00Z" })),
  );
  assert.equal(malformedResult.statusCode, 400);
  assert.equal(receiptFrom(malformedResult).reason, "invalidRequest");
  assert.deepEqual(malformedDate.replayStore.inspectCalls, []);

  const invalidCalendar = createHarness();
  const calendarResult = await invalidCalendar.handler(
    requestFor(remoteStop({ issuedAt: "2026-02-30T20:00:00.000Z" })),
  );
  assert.equal(receiptFrom(calendarResult).reason, "invalidRequest");
  assert.deepEqual(invalidCalendar.replayStore.inspectCalls, []);

  const oversizedWindow = createHarness();
  const windowResult = await oversizedWindow.handler(
    requestFor(
      remoteStop({
        issuedAt: "2026-08-22T20:00:00.000Z",
        expiresAt: "2026-08-22T20:01:00.001Z",
      }),
    ),
  );
  assert.equal(receiptFrom(windowResult).reason, "invalidRequest");
  assert.deepEqual(oversizedWindow.replayStore.inspectCalls, []);
});

test("freshness is rechecked after the atomic claim and before dispatch", async () => {
  let clockReads = 0;
  const state = createHarness({
    now: () => {
      clockReads += 1;
      return clockReads === 1 ? NOW : NOW + 31_000;
    },
  });
  const result = await state.handler(
    requestFor(remoteStop({ expiresAt: "2026-08-22T20:01:00.000Z" })),
  );

  assert.equal(receiptFrom(result).reason, "expiredRequest");
  assert.equal(state.replayStore.claimCalls.length, 1);
  assert.equal(state.replayStore.completeCalls.length, 1);
  assert.deepEqual(state.requests, []);
});

test("durable claim returns a completed retry and rejects conflicting reuse", async () => {
  const state = createHarness();
  const action = remoteReply();

  const first = await state.handler(requestFor(action));
  const retry = await state.handler(requestFor(action));
  assert.deepEqual(receiptFrom(retry), receiptFrom(first));
  assert.equal(state.requests.length, 1);

  const conflict = await state.handler(
    requestFor({ ...action, text: "DIFFERENT_SENSITIVE_REPLY" }),
  );
  assert.equal(conflict.statusCode, 409);
  assert.equal(receiptFrom(conflict).reason, "replayConflict");
  assert.equal(state.requests.length, 1);
});

test("a completed retry returns its receipt after private context revocation", async () => {
  let contextResolutionCalled = false;
  const replayStore = new DeterministicReplayStore();
  const base = createHarness({ replayStore });
  const first = await base.handler(requestFor(remoteReply()));
  assert.equal(receiptFrom(first).outcome, "accepted");

  const revokedHandler = createTailscaleTurnActionRequestHandler({
    expectedCapability: CAPABILITY,
    authorizeAppToken: async (token) =>
      token === APP_TOKEN ? "installation-iphone-1" : null,
    resolveControlContext: async () => {
      contextResolutionCalled = true;
      return null;
    },
    replayStore,
    fingerprintAction: createRemoteActionHmacFingerprint(
      "SENSITIVE_SYNTHETIC_FINGERPRINT_KEY",
    ),
    now: () => NOW,
  });
  const retry = await revokedHandler(requestFor(remoteReply()));

  assert.deepEqual(receiptFrom(retry), receiptFrom(first));
  assert.equal(contextResolutionCalled, false);
  assert.equal(base.requests.length, 1);
});

test("an incomplete durable claim is outcome-unknown and never redispatched", async () => {
  const replayStore = new DeterministicReplayStore();
  const state = createHarness({ replayStore });
  const action = remoteReply({ actionId: "remote-uncertain-1" });
  const fingerprint = createRemoteActionHmacFingerprint(
    "SENSITIVE_SYNTHETIC_FINGERPRINT_KEY",
  )(action);
  await replayStore.claim({
    installationId: "installation-iphone-1",
    actionId: action.actionId,
    fingerprint,
    expiresAtMs: Date.parse(action.expiresAt),
  });

  const result = await state.handler(requestFor(action));
  assert.equal(result.statusCode, 503);
  assert.equal(receiptFrom(result).reason, "outcomeUnknown");
  assert.deepEqual(state.requests, []);
});

test("a failed receipt commit never causes an automatic second dispatch", async () => {
  const replayStore = new DeterministicReplayStore({ failComplete: true });
  const state = createHarness({ replayStore });
  const action = remoteReply({ actionId: "remote-write-failure-1" });

  const first = await state.handler(requestFor(action));
  assert.equal(first.statusCode, 503);
  assert.equal(receiptFrom(first).reason, "outcomeUnknown");
  assert.equal(state.requests.length, 1);

  const retry = await state.handler(requestFor(action));
  assert.equal(receiptFrom(retry).reason, "outcomeUnknown");
  assert.equal(state.requests.length, 1);
});

test("malformed, expanded, oversized, and wrong-route requests fail before dispatch", async () => {
  const state = createHarness();
  const malformed = await state.handler(
    requestFor(remoteStop(), { body: "{not-json" }),
  );
  assert.equal(malformed.statusCode, 400);
  assert.equal(receiptFrom(malformed).reason, "invalidAction");

  const expanded = await state.handler(
    requestFor(remoteStop({ text: REPLY_TEXT })),
  );
  assert.equal(receiptFrom(expanded).reason, "invalidAction");

  const oversized = await state.handler(
    requestFor(remoteStop(), { body: "x".repeat(MAX_REMOTE_ACTION_BODY_BYTES + 1) }),
  );
  assert.equal(oversized.statusCode, 413);

  const wrongRoute = await state.handler(
    requestFor(remoteStop(), { path: "/v1/anything-else" }),
  );
  assert.equal(wrongRoute.statusCode, 404);
  assert.deepEqual(state.requests, []);
  assert.deepEqual(state.replayStore.claimCalls, []);
});

test("private boundary failures remain allowlisted and content-free", async () => {
  const state = createHarness({
    responder: (request) => ({
      id: request.id,
      error: { message: "SENSITIVE_PRIVATE_APP_SERVER_ERROR" },
    }),
  });
  const result = await state.handler(requestFor(remoteReply()));

  assert.equal(result.statusCode, 502);
  assert.equal(receiptFrom(result).reason, "appServerRejected");
  assert.equal(result.body.includes("SENSITIVE"), false);
  const retained = JSON.stringify([...state.replayStore.records]);
  assert.equal(retained.includes("SENSITIVE"), false);
});

test("malformed or expanded private receipts become outcome-unknown", async () => {
  const malformedReceipts = [
    {
      schemaVersion: 1,
      actionId: "remote-reply-1",
      action: "reply",
      outcome: "accepted",
      reason: null,
      appServerMethod: "turn/interrupt",
    },
    {
      schemaVersion: 1,
      actionId: "remote-reply-1",
      action: "reply",
      outcome: "accepted",
      reason: null,
      appServerMethod: "turn/steer",
      rawError: "SENSITIVE_PRIVATE_RECEIPT_FIELD",
    },
    {
      schemaVersion: 1,
      actionId: "remote-reply-1",
      action: "reply",
      outcome: "rejected",
      reason: "appServerRejected",
      appServerMethod: "turn/steer",
    },
  ];

  for (const malformedReceipt of malformedReceipts) {
    const state = createHarness({
      dispatchOverride: async () => structuredClone(malformedReceipt),
    });
    const result = await state.handler(requestFor(remoteReply()));
    assert.equal(result.statusCode, 503);
    assert.equal(receiptFrom(result).reason, "outcomeUnknown");
    const retained = JSON.stringify([...state.replayStore.records]);
    assert.equal(retained.includes("SENSITIVE"), false);
    assert.equal(retained.includes("turn/steer"), false);
    assert.equal(retained.includes("turn/interrupt"), false);
  }
});
