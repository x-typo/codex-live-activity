import assert from "node:assert/strict";
import test from "node:test";

import {
  REMOTE_ACTION_RECEIPT_HANDLER_PHASES,
  createRemoteActionReceipt,
  defaultHttpStatusForRemoteActionReceipt,
  isHttpStatusForRemoteActionReceipt,
  projectRemoteActionReceipt,
  serializeRemoteActionReceipt,
} from "../src/remote-action-receipt.mjs";

const ACTION = Object.freeze({ actionId: "remote-action-1", action: "stop" });
const OTHER_ID = Object.freeze({ actionId: "remote-action-2", action: "stop" });
const OTHER_ACTION = Object.freeze({
  actionId: "remote-action-1",
  action: "reply",
});
const ALL_HTTP_STATUSES = [200, 400, 401, 404, 409, 413, 502, 503];

const REJECTION_CASES = [
  ["appServerRejected", "required", [502]],
  ["busy", "required", [409]],
  ["duplicateAction", "required", [409]],
  ["expiredControlContext", "required", [409]],
  ["expiredRequest", "required", [409]],
  ["invalidAction", "forbidden", [400]],
  ["invalidRequest", "optional", [400]],
  ["noActiveTurn", "required", [409]],
  ["outcomeUnknown", "required", [503]],
  ["replayConflict", "required", [409]],
  ["staleTurn", "required", [409]],
  ["stopPending", "required", [409]],
  ["unauthorized", "forbidden", [401]],
  ["unavailable", "optional", [503]],
  ["unknownControlContext", "required", [409]],
  ["wrongThread", "required", [409]],
];

function candidate({ action = ACTION, outcome = "accepted", reason = null } = {}) {
  return {
    schemaVersion: 1,
    actionId: action?.actionId ?? null,
    action: action?.action ?? null,
    outcome,
    reason,
  };
}

test("applies the complete receipt reason, correlation, and HTTP status table", () => {
  const accepted = createRemoteActionReceipt({
    action: ACTION,
    outcome: "accepted",
    reason: null,
  });
  assert.deepEqual(accepted, candidate());
  assert.equal(defaultHttpStatusForRemoteActionReceipt(accepted), 200);
  for (const statusCode of ALL_HTTP_STATUSES) {
    assert.equal(
      isHttpStatusForRemoteActionReceipt(statusCode, accepted),
      statusCode === 200,
    );
  }
  assert.throws(
    () =>
      createRemoteActionReceipt({
        outcome: "accepted",
        reason: null,
      }),
    /invalid remote action receipt/u,
  );

  for (const [reason, correlation, statuses] of REJECTION_CASES) {
    const action = correlation === "forbidden" ? null : ACTION;
    const receipt = createRemoteActionReceipt({
      action,
      outcome: "rejected",
      reason,
    });
    assert.deepEqual(
      receipt,
      candidate({ action, outcome: "rejected", reason }),
      reason,
    );
    assert.equal(
      defaultHttpStatusForRemoteActionReceipt(receipt),
      statuses[0],
      reason,
    );
    for (const statusCode of ALL_HTTP_STATUSES) {
      assert.equal(
        isHttpStatusForRemoteActionReceipt(statusCode, receipt),
        statuses.includes(statusCode),
        `${reason}:${statusCode}`,
      );
    }

    if (correlation === "optional") {
      assert.notEqual(
        projectRemoteActionReceipt(
          candidate({ action: null, outcome: "rejected", reason }),
        ),
        null,
        reason,
      );
    }
  }
});

test("binds correlated receipts to the exact submitted action", () => {
  const receipt = candidate();
  assert.deepEqual(
    projectRemoteActionReceipt(receipt, { expectedAction: ACTION }),
    receipt,
  );
  assert.equal(
    projectRemoteActionReceipt(receipt, { expectedAction: OTHER_ID }),
    null,
  );
  assert.equal(
    projectRemoteActionReceipt(receipt, { expectedAction: OTHER_ACTION }),
    null,
  );
  assert.equal(
    projectRemoteActionReceipt(receipt, { expectedAction: null }),
    null,
  );

  for (const reason of ["invalidAction", "unauthorized"]) {
    assert.equal(
      projectRemoteActionReceipt(
        candidate({ outcome: "rejected", reason }),
        { expectedAction: ACTION },
      ),
      null,
      reason,
    );
  }
  for (const reason of ["busy", "outcomeUnknown", "wrongThread"]) {
    assert.equal(
      projectRemoteActionReceipt(
        candidate({ action: null, outcome: "rejected", reason }),
        { expectedAction: ACTION },
      ),
      null,
      reason,
    );
  }
});

test("applies correlation-dependent status and handler-phase rows", () => {
  const uncorrelatedInvalidRequest = candidate({
    action: null,
    outcome: "rejected",
    reason: "invalidRequest",
  });
  for (const statusCode of ALL_HTTP_STATUSES) {
    assert.equal(
      isHttpStatusForRemoteActionReceipt(
        statusCode,
        uncorrelatedInvalidRequest,
      ),
      [400, 404, 413].includes(statusCode),
      `uncorrelated-invalidRequest:${statusCode}`,
    );
  }

  const cases = [
    {
      receipt: uncorrelatedInvalidRequest,
      statusCode: 400,
      handlerPhase:
        REMOTE_ACTION_RECEIPT_HANDLER_PHASES.invalidContentType,
      accepted: true,
    },
    {
      receipt: uncorrelatedInvalidRequest,
      statusCode: 404,
      handlerPhase:
        REMOTE_ACTION_RECEIPT_HANDLER_PHASES.invalidContentType,
      accepted: false,
    },
    {
      receipt: candidate({
        action: null,
        outcome: "rejected",
        reason: "invalidAction",
      }),
      statusCode: 400,
      handlerPhase: REMOTE_ACTION_RECEIPT_HANDLER_PHASES.invalidAction,
      accepted: true,
    },
    {
      receipt: candidate({
        action: null,
        outcome: "rejected",
        reason: "unauthorized",
      }),
      statusCode: 401,
      handlerPhase: REMOTE_ACTION_RECEIPT_HANDLER_PHASES.invalidAction,
      accepted: true,
    },
    {
      receipt: candidate({
        action: null,
        outcome: "rejected",
        reason: "unauthorized",
      }),
      statusCode: 401,
      handlerPhase: REMOTE_ACTION_RECEIPT_HANDLER_PHASES.validAction,
      accepted: true,
    },
    {
      receipt: candidate({
        outcome: "rejected",
        reason: "invalidRequest",
      }),
      statusCode: 400,
      handlerPhase: REMOTE_ACTION_RECEIPT_HANDLER_PHASES.validAction,
      accepted: true,
    },
    {
      receipt: candidate({
        outcome: "rejected",
        reason: "invalidRequest",
      }),
      statusCode: 404,
      handlerPhase: REMOTE_ACTION_RECEIPT_HANDLER_PHASES.validAction,
      accepted: false,
    },
    {
      receipt: uncorrelatedInvalidRequest,
      statusCode: 400,
      handlerPhase: REMOTE_ACTION_RECEIPT_HANDLER_PHASES.validAction,
      accepted: false,
    },
    {
      receipt: candidate({
        action: null,
        outcome: "rejected",
        reason: "unavailable",
      }),
      statusCode: 503,
      handlerPhase: REMOTE_ACTION_RECEIPT_HANDLER_PHASES.validAction,
      accepted: false,
    },
  ];

  for (const entry of cases) {
    assert.equal(
      projectRemoteActionReceipt(entry.receipt, {
        expectedAction: ACTION,
        handlerPhase: entry.handlerPhase,
        statusCode: entry.statusCode,
      }) !== null,
      entry.accepted,
      `${entry.handlerPhase}:${entry.statusCode}:${entry.receipt.reason}`,
    );
  }
  assert.equal(
    projectRemoteActionReceipt(candidate(), {
      expectedAction: ACTION,
      handlerPhase: "unknownPhase",
      statusCode: 200,
    }),
    null,
  );
});

test("rejects malformed shapes and requires correlation for replay storage", () => {
  const malformed = [
    { ...candidate(), extra: "SENSITIVE_EXTRA" },
    { ...candidate(), schemaVersion: 2 },
    { ...candidate(), actionId: null },
    { ...candidate(), action: null },
    { ...candidate(), actionId: "unsafe id" },
    { ...candidate(), action: "pause" },
    { ...candidate(), outcome: "unknown" },
    { ...candidate(), reason: "busy" },
    candidate({ outcome: "rejected", reason: null }),
    candidate({ outcome: "rejected", reason: "unknownReason" }),
  ];
  const missing = candidate();
  delete missing.reason;
  malformed.push(missing);

  for (const value of malformed) {
    assert.equal(projectRemoteActionReceipt(value), null);
  }
  for (const reason of ["invalidAction", "invalidRequest", "unauthorized", "unavailable"]) {
    assert.equal(
      projectRemoteActionReceipt(
        candidate({ action: null, outcome: "rejected", reason }),
        { requireCorrelation: true },
      ),
      null,
      reason,
    );
  }
});

test("serializes canonical receipt bytes in fixed field order", () => {
  const projected = projectRemoteActionReceipt(
    {
      reason: null,
      outcome: "accepted",
      action: "stop",
      actionId: "remote-action-1",
      schemaVersion: 1,
    },
    { expectedAction: ACTION, statusCode: 200 },
  );
  assert.notEqual(projected, null);
  assert.equal(
    serializeRemoteActionReceipt(projected),
    '{"schemaVersion":1,"actionId":"remote-action-1","action":"stop","outcome":"accepted","reason":null}',
  );
});
