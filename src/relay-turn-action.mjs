export const RELAY_TURN_ACTION_SCHEMA_VERSION = 1;

export const MAX_REPLY_CODE_POINTS = 4_096;

const MAX_IDENTIFIER_CODE_POINTS = 128;
const MAX_REMEMBERED_ACTION_IDS = 64;
const ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![\s\S])/u;
const ACTIONS = new Set(["reply", "stop"]);

const REASONS = new Set([
  "appServerRejected",
  "busy",
  "duplicateAction",
  "invalidAction",
  "noActiveTurn",
  "staleTurn",
  "stopPending",
  "wrongThread",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!isObject(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function isIdentifier(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.toWellFormed() &&
    !/[\r\n\t]/u.test(value) &&
    [...value].length <= MAX_IDENTIFIER_CODE_POINTS
  );
}

function safeActionId(value) {
  return typeof value === "string" && ACTION_ID.test(value) ? value : null;
}

function safeAction(value) {
  return ACTIONS.has(value) ? value : null;
}

function validateAction(candidate) {
  if (!isObject(candidate)) return null;

  try {
    const action = {
      schemaVersion: candidate.schemaVersion,
      actionId: candidate.actionId,
      action: candidate.action,
      threadId: candidate.threadId,
      expectedTurnId: candidate.expectedTurnId,
    };
    if (action.action === "reply") action.text = candidate.text;

    const actionName = safeAction(action.action);
    const expectedKeys =
      actionName === "reply"
        ? [
            "action",
            "actionId",
            "expectedTurnId",
            "schemaVersion",
            "text",
            "threadId",
          ]
        : [
            "action",
            "actionId",
            "expectedTurnId",
            "schemaVersion",
            "threadId",
          ];

    if (
      action.schemaVersion !== RELAY_TURN_ACTION_SCHEMA_VERSION ||
      actionName === null ||
      !hasExactKeys(candidate, expectedKeys) ||
      safeActionId(action.actionId) === null ||
      !isIdentifier(action.threadId) ||
      !isIdentifier(action.expectedTurnId)
    ) {
      return null;
    }

    if (actionName === "reply") {
      if (
        typeof action.text !== "string" ||
        action.text !== action.text.toWellFormed() ||
        action.text.trim().length === 0 ||
        [...action.text].length > MAX_REPLY_CODE_POINTS
      ) {
        return null;
      }
    }

    return action;
  } catch {
    return null;
  }
}

function receipt({
  actionId = null,
  action = null,
  outcome,
  reason = null,
  appServerMethod = null,
}) {
  if (
    !["accepted", "rejected"].includes(outcome) ||
    (reason !== null && !REASONS.has(reason)) ||
    ![null, "turn/interrupt", "turn/steer"].includes(appServerMethod)
  ) {
    throw new TypeError("invalid relay action receipt");
  }
  return {
    schemaVersion: RELAY_TURN_ACTION_SCHEMA_VERSION,
    actionId,
    action,
    outcome,
    reason,
    appServerMethod,
  };
}

function rejected(action, reason) {
  return receipt({
    actionId: safeActionId(action?.actionId),
    action: safeAction(action?.action),
    outcome: "rejected",
    reason,
  });
}

function requestFor(action) {
  if (action.action === "stop") {
    return {
      id: action.actionId,
      method: "turn/interrupt",
      params: {
        threadId: action.threadId,
        turnId: action.expectedTurnId,
      },
    };
  }
  return {
    id: action.actionId,
    method: "turn/steer",
    params: {
      threadId: action.threadId,
      input: [{ type: "text", text: action.text }],
      expectedTurnId: action.expectedTurnId,
    },
  };
}

function acceptsResponse(response, request) {
  if (
    !isObject(response) ||
    response.id !== request.id ||
    Object.hasOwn(response, "error") ||
    !isObject(response.result)
  ) {
    return false;
  }
  if (request.method === "turn/interrupt") return true;
  return response.result.turnId === request.params.expectedTurnId;
}

export class MockOneTaskTurnActionBoundary {
  constructor({ threadId, getActiveTurnId, sendRequest } = {}) {
    if (!isIdentifier(threadId)) {
      throw new TypeError(
        "threadId must be a non-empty identifier up to 128 code points",
      );
    }
    if (typeof getActiveTurnId !== "function") {
      throw new TypeError("getActiveTurnId must be a function");
    }
    if (typeof sendRequest !== "function") {
      throw new TypeError("sendRequest must be a function");
    }

    this.threadId = threadId;
    this.getActiveTurnId = getActiveTurnId;
    this.sendRequest = sendRequest;
    this.inFlight = false;
    this.rememberedActionIds = new Set();
    this.rememberedActionOrder = [];
    this.stopPending = false;
  }

  async dispatch(candidate) {
    const action = validateAction(candidate);
    if (action === null) return rejected(null, "invalidAction");

    let activeTurnId;
    try {
      activeTurnId = this.getActiveTurnId();
    } catch {
      return rejected(action, "noActiveTurn");
    }
    if (activeTurnId === null || activeTurnId === undefined) {
      this.clearStopPending();
      return rejected(action, "noActiveTurn");
    }
    if (!isIdentifier(activeTurnId)) {
      return rejected(action, "noActiveTurn");
    }
    if (action.threadId !== this.threadId) {
      return rejected(action, "wrongThread");
    }
    if (action.expectedTurnId !== activeTurnId) {
      return rejected(action, "staleTurn");
    }
    if (this.rememberedActionIds.has(action.actionId)) {
      return rejected(action, "duplicateAction");
    }
    if (this.stopPending) {
      return rejected(action, "stopPending");
    }
    if (this.inFlight) return rejected(action, "busy");

    this.#remember(action.actionId);
    this.inFlight = true;
    if (action.action === "stop") this.stopPending = true;
    const request = requestFor(action);
    try {
      const response = await this.sendRequest(request);
      if (!acceptsResponse(response, request)) {
        if (action.action === "stop") this.clearStopPending();
        return rejected(action, "appServerRejected");
      }
      return receipt({
        actionId: action.actionId,
        action: action.action,
        outcome: "accepted",
        appServerMethod: request.method,
      });
    } catch {
      if (action.action === "stop") this.clearStopPending();
      return rejected(action, "appServerRejected");
    } finally {
      this.inFlight = false;
    }
  }

  clearStopPending() {
    this.stopPending = false;
  }

  #remember(actionId) {
    this.rememberedActionIds.add(actionId);
    this.rememberedActionOrder.push(actionId);
    if (this.rememberedActionOrder.length <= MAX_REMEMBERED_ACTION_IDS) return;
    const oldest = this.rememberedActionOrder.shift();
    this.rememberedActionIds.delete(oldest);
  }
}
