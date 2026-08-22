import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MAX_REPLY_CODE_POINTS,
  MockOneTaskTurnActionBoundary,
} from "../src/relay-turn-action.mjs";
import {
  JsonlDryRunApnsTransport,
  OneTaskRelay,
} from "../src/one-task-relay.mjs";
import { validateJsonSchema } from "../test-support/json-schema-validator.mjs";

const actionSchema = JSON.parse(
  await readFile(
    new URL("../schema/relay-turn-action.v1.schema.json", import.meta.url),
    "utf8",
  ),
);

function stopAction(overrides = {}) {
  return {
    schemaVersion: 1,
    actionId: "action-stop-1",
    action: "stop",
    threadId: "thread-owned",
    expectedTurnId: "turn-active",
    ...overrides,
  };
}

function replyAction(overrides = {}) {
  return {
    schemaVersion: 1,
    actionId: "action-reply-1",
    action: "reply",
    threadId: "thread-owned",
    expectedTurnId: "turn-active",
    text: "SENSITIVE_SYNTHETIC_REPLY_TEXT",
    ...overrides,
  };
}

function createBoundary({
  activeTurnId: initialActiveTurnId = "turn-active",
  responder,
} = {}) {
  let activeTurnId = initialActiveTurnId;
  const requests = [];
  const boundary = new MockOneTaskTurnActionBoundary({
    threadId: "thread-owned",
    getActiveTurnId: () => activeTurnId,
    sendRequest: async (request) => {
      requests.push(structuredClone(request));
      if (responder) return responder(request);
      if (request.method === "turn/steer") {
        return {
          id: request.id,
          result: { turnId: request.params.expectedTurnId },
        };
      }
      return { id: request.id, result: {} };
    },
  });
  return {
    boundary,
    requests,
    setActiveTurnId(value) {
      activeTurnId = value;
    },
  };
}

test("the versioned action schema distinguishes exact Stop and Reply shapes", () => {
  assert.deepEqual(validateJsonSchema(stopAction(), actionSchema), []);
  assert.deepEqual(validateJsonSchema(replyAction(), actionSchema), []);
  assert.notDeepEqual(
    validateJsonSchema(stopAction({ text: "not allowed" }), actionSchema),
    [],
  );
  const replyWithoutText = replyAction();
  delete replyWithoutText.text;
  assert.notDeepEqual(validateJsonSchema(replyWithoutText, actionSchema), []);
  assert.notDeepEqual(
    validateJsonSchema(replyAction({ unknown: true }), actionSchema),
    [],
  );
  assert.notDeepEqual(
    validateJsonSchema(stopAction({ actionId: "unsafe action id" }), actionSchema),
    [],
  );
  assert.notDeepEqual(
    validateJsonSchema(stopAction({ actionId: "unsafe-newline\n" }), actionSchema),
    [],
  );
  assert.notDeepEqual(
    validateJsonSchema(stopAction({ threadId: "thread-owned\nother" }), actionSchema),
    [],
  );
  assert.notDeepEqual(
    validateJsonSchema(stopAction({ threadId: "\ud800" }), actionSchema),
    [],
  );
  assert.notDeepEqual(
    validateJsonSchema(replyAction({ text: "   " }), actionSchema),
    [],
  );
  assert.notDeepEqual(
    validateJsonSchema(replyAction({ text: "reply-\ud800" }), actionSchema),
    [],
  );
  assert.deepEqual(
    validateJsonSchema(replyAction({ text: "valid emoji 😀" }), actionSchema),
    [],
  );
});

test("Stop maps only to the owned active turn interrupt request", async () => {
  const { boundary, requests } = createBoundary();
  const result = await boundary.dispatch(stopAction());

  assert.deepEqual(requests, [
    {
      id: "action-stop-1",
      method: "turn/interrupt",
      params: {
        threadId: "thread-owned",
        turnId: "turn-active",
      },
    },
  ]);
  assert.deepEqual(result, {
    schemaVersion: 1,
    actionId: "action-stop-1",
    action: "stop",
    outcome: "accepted",
    reason: null,
    appServerMethod: "turn/interrupt",
  });
  assert.equal(JSON.stringify(result).includes("thread-owned"), false);
  assert.equal(JSON.stringify(result).includes("turn-active"), false);
});

test("Reply maps only to same-turn steering and redacts its text from receipts", async () => {
  const { boundary, requests } = createBoundary();
  const result = await boundary.dispatch(replyAction());

  assert.deepEqual(requests, [
    {
      id: "action-reply-1",
      method: "turn/steer",
      params: {
        threadId: "thread-owned",
        input: [{ type: "text", text: "SENSITIVE_SYNTHETIC_REPLY_TEXT" }],
        expectedTurnId: "turn-active",
      },
    },
  ]);
  assert.deepEqual(result, {
    schemaVersion: 1,
    actionId: "action-reply-1",
    action: "reply",
    outcome: "accepted",
    reason: null,
    appServerMethod: "turn/steer",
  });
  const encodedReceipt = JSON.stringify(result);
  assert.equal(encodedReceipt.includes("SENSITIVE_SYNTHETIC_REPLY_TEXT"), false);
  assert.equal(encodedReceipt.includes("thread-owned"), false);
  assert.equal(encodedReceipt.includes("turn-active"), false);
});

test("rejects malformed or expanded action envelopes before dispatch", async () => {
  const { boundary, requests } = createBoundary();
  const malformed = [
    null,
    [],
    stopAction({ schemaVersion: 2 }),
    stopAction({ actionId: "unsafe action id" }),
    stopAction({ actionId: "unsafe-newline\n" }),
    stopAction({ action: "approve" }),
    stopAction({ threadId: "thread-owned\nSENSITIVE" }),
    stopAction({ threadId: "\ud800" }),
    stopAction({ unknown: "SENSITIVE_UNKNOWN_BODY" }),
    { ...stopAction(), text: "SENSITIVE_STOP_TEXT" },
    replyAction({ text: "   " }),
    replyAction({ text: "\ud800" }),
    replyAction({ text: "x".repeat(MAX_REPLY_CODE_POINTS + 1) }),
  ];

  for (const candidate of malformed) {
    const result = await boundary.dispatch(candidate);
    assert.equal(result.outcome, "rejected");
    assert.equal(result.reason, "invalidAction");
    const encoded = JSON.stringify(result);
    assert.equal(encoded.includes("SENSITIVE"), false);
  }
  assert.deepEqual(requests, []);
});

test("rejects wrong-task, stale-turn, and terminal actions without dispatch", async () => {
  const wrongTask = createBoundary();
  assert.equal(
    (await wrongTask.boundary.dispatch(
      stopAction({ threadId: "thread-other" }),
    )).reason,
    "wrongThread",
  );
  assert.deepEqual(wrongTask.requests, []);

  const staleTurn = createBoundary();
  assert.equal(
    (await staleTurn.boundary.dispatch(
      stopAction({ expectedTurnId: "turn-old" }),
    )).reason,
    "staleTurn",
  );
  assert.deepEqual(staleTurn.requests, []);

  const terminal = createBoundary({ activeTurnId: null });
  assert.equal(
    (await terminal.boundary.dispatch(replyAction())).reason,
    "noActiveTurn",
  );
  assert.deepEqual(terminal.requests, []);
});

test("redacts active-turn correlation lookup failures", async () => {
  const boundary = new MockOneTaskTurnActionBoundary({
    threadId: "thread-owned",
    getActiveTurnId: () => {
      throw new Error("SENSITIVE_CORRELATION_FAILURE");
    },
    sendRequest: () => {
      throw new Error("request must not be sent");
    },
  });

  const result = await boundary.dispatch(replyAction());
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reason, "noActiveTurn");
  assert.equal(JSON.stringify(result).includes("SENSITIVE"), false);
});

test("rejects throwing action accessors without rereading them for a receipt", async () => {
  let reads = 0;
  const candidate = {
    schemaVersion: 1,
    actionId: "action-throwing-accessor-1",
    get action() {
      reads += 1;
      throw new Error("SENSITIVE_ACCESSOR_FAILURE");
    },
    threadId: "thread-owned",
    expectedTurnId: "turn-active",
  };
  const { boundary, requests } = createBoundary();

  const result = await boundary.dispatch(candidate);

  assert.equal(reads, 1);
  assert.deepEqual(result, {
    schemaVersion: 1,
    actionId: null,
    action: null,
    outcome: "rejected",
    reason: "invalidAction",
    appServerMethod: null,
  });
  assert.deepEqual(requests, []);
  assert.equal(JSON.stringify(result).includes("SENSITIVE"), false);
});

test("snapshots a validated action before active-turn correlation", async () => {
  const candidate = stopAction({ actionId: "action-snapshot-stop-1" });
  const requests = [];
  const boundary = new MockOneTaskTurnActionBoundary({
    threadId: "thread-owned",
    getActiveTurnId: () => {
      candidate.action = "reply";
      candidate.text = "SENSITIVE_MUTATED_REPLY".repeat(500);
      return "turn-active";
    },
    sendRequest: async (request) => {
      requests.push(structuredClone(request));
      return { id: request.id, result: {} };
    },
  });

  const result = await boundary.dispatch(candidate);

  assert.equal(result.outcome, "accepted");
  assert.equal(result.action, "stop");
  assert.equal(result.actionId, "action-snapshot-stop-1");
  assert.deepEqual(requests, [
    {
      id: "action-snapshot-stop-1",
      method: "turn/interrupt",
      params: {
        threadId: "thread-owned",
        turnId: "turn-active",
      },
    },
  ]);
  assert.equal(JSON.stringify({ requests, result }).includes("SENSITIVE"), false);
});

test("keeps receipts canonical when the caller mutates an in-flight action", async () => {
  let releaseResponse;
  const heldResponse = new Promise((resolve) => {
    releaseResponse = resolve;
  });
  const candidate = replyAction({ actionId: "action-snapshot-reply-1" });
  const actionState = createBoundary({ responder: () => heldResponse });

  const pendingResult = actionState.boundary.dispatch(candidate);
  candidate.actionId = "SENSITIVE_MUTATED_ACTION_ID";
  candidate.action = "approve";
  candidate.text = "SENSITIVE_MUTATED_REPLY";
  releaseResponse({
    id: "action-snapshot-reply-1",
    result: { turnId: "turn-active" },
  });

  const result = await pendingResult;
  assert.deepEqual(result, {
    schemaVersion: 1,
    actionId: "action-snapshot-reply-1",
    action: "reply",
    outcome: "accepted",
    reason: null,
    appServerMethod: "turn/steer",
  });
  assert.equal(JSON.stringify(result).includes("SENSITIVE"), false);
});

test("uses private active-turn correlation instead of presentation state", async () => {
  const relay = new OneTaskRelay({
    threadId: "thread-owned",
    staleAfterMs: 1_000,
    transport: new JsonlDryRunApnsTransport({ write: () => {} }),
  });
  relay.ingest(
    {
      method: "turn/started",
      params: {
        threadId: "thread-owned",
        turn: { id: "turn-active", status: "inProgress" },
      },
    },
    "2026-08-22T18:00:00.000Z",
  );
  relay.sweep("2026-08-22T18:00:01.000Z");
  assert.equal(relay.snapshot()[0].state, "stale");

  const actionState = createBoundary();
  const result = await actionState.boundary.dispatch(
    replyAction({ actionId: "action-stale-ui-1" }),
  );

  assert.equal(result.outcome, "accepted");
  assert.equal(actionState.requests.length, 1);
});

test("serializes actions and rejects recent action ID replays", async () => {
  let releaseFirst;
  const heldResponse = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const actionState = createBoundary({ responder: () => heldResponse });
  const first = actionState.boundary.dispatch(replyAction());

  const duplicate = await actionState.boundary.dispatch(replyAction());
  assert.equal(duplicate.reason, "duplicateAction");

  const busy = await actionState.boundary.dispatch(
    replyAction({ actionId: "action-reply-2" }),
  );
  assert.equal(busy.reason, "busy");
  assert.equal(actionState.requests.length, 1);

  releaseFirst({
    id: "action-reply-1",
    result: { turnId: "turn-active" },
  });
  assert.equal((await first).outcome, "accepted");
});

test("an accepted Stop blocks actions until lifecycle clears its pending latch", async () => {
  const actionState = createBoundary();
  assert.equal(
    (await actionState.boundary.dispatch(stopAction())).outcome,
    "accepted",
  );
  assert.equal(
    (await actionState.boundary.dispatch(
      replyAction({ actionId: "action-after-stop-1" }),
    )).reason,
    "stopPending",
  );
  assert.equal(actionState.boundary.stopPending, true);
  assert.equal(Object.hasOwn(actionState.boundary, "stopPendingTurnId"), false);

  actionState.setActiveTurnId("turn-next");
  assert.equal(
    (await actionState.boundary.dispatch(
      replyAction({
        actionId: "action-before-terminal-clear-1",
        expectedTurnId: "turn-next",
      }),
    )).reason,
    "stopPending",
  );
  actionState.boundary.clearStopPending();
  const next = await actionState.boundary.dispatch(
    replyAction({
      actionId: "action-next-turn-1",
      expectedTurnId: "turn-next",
    }),
  );
  assert.equal(next.outcome, "accepted");
});

test("a lifecycle reset wins a race with an in-flight Stop response", async () => {
  let releaseStop;
  const heldResponse = new Promise((resolve) => {
    releaseStop = resolve;
  });
  const actionState = createBoundary({ responder: () => heldResponse });
  const pendingStop = actionState.boundary.dispatch(
    stopAction({ actionId: "action-racing-stop-1" }),
  );

  actionState.boundary.clearStopPending();
  releaseStop({ id: "action-racing-stop-1", result: {} });

  assert.equal((await pendingStop).outcome, "accepted");
  assert.equal(actionState.boundary.stopPending, false);
  assert.equal(
    Object.values(actionState.boundary).includes("turn-active"),
    false,
  );
});

test("a rejected Stop releases its pending latch", async () => {
  const actionState = createBoundary({
    responder: (request) => ({
      id: request.id,
      error: { message: "SENSITIVE_STOP_REJECTION" },
    }),
  });
  const result = await actionState.boundary.dispatch(
    stopAction({ actionId: "action-rejected-stop-1" }),
  );

  assert.equal(result.outcome, "rejected");
  assert.equal(result.reason, "appServerRejected");
  assert.equal(actionState.boundary.stopPending, false);
  assert.equal(JSON.stringify(result).includes("SENSITIVE"), false);
});

test("fails closed on rejected or mismatched App Server responses", async () => {
  const cases = [
    () => ({ id: "wrong-id", result: { turnId: "turn-active" } }),
    (request) => ({ id: request.id, error: { message: "SENSITIVE_ERROR" } }),
    (request) => ({ id: request.id, result: { turnId: "turn-other" } }),
    () => {
      throw new Error("SENSITIVE_THROWN_ERROR");
    },
  ];

  for (const [index, responder] of cases.entries()) {
    const actionState = createBoundary({ responder });
    const action = replyAction({ actionId: `action-error-${index}` });
    const result = await actionState.boundary.dispatch(action);
    assert.equal(result.outcome, "rejected");
    assert.equal(result.reason, "appServerRejected");
    assert.equal(JSON.stringify(result).includes("SENSITIVE"), false);
    assert.equal(
      (await actionState.boundary.dispatch(action)).reason,
      "duplicateAction",
    );
  }
});
