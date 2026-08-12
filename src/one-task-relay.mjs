import { buildLiveActivityPayload } from "./live-activity-payload.mjs";
import { StatusReducer } from "./status-reducer.mjs";

const REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

const ACTIVITY_METHODS = new Set([
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
]);

const THREAD_STATUS_TYPES = new Set([
  "active",
  "idle",
  "notLoaded",
  "systemError",
]);

const ACTIVE_FLAGS = new Set([
  "waitingOnApproval",
  "waitingOnUserInput",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwnedThread(params, ownedThreadId) {
  return isObject(params) && params.threadId === ownedThreadId;
}

function projectThreadStatus(status) {
  if (!isObject(status) || !THREAD_STATUS_TYPES.has(status.type)) return null;
  if (status.type !== "active") return { type: status.type };
  const suppliedFlags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
  const activeFlags = suppliedFlags.filter((flag) => ACTIVE_FLAGS.has(flag));
  if (suppliedFlags.length > 0 && activeFlags.length === 0) return null;
  return { type: "active", activeFlags };
}

export function projectOwnedLifecycleMessage(message, ownedThreadId) {
  if (!isObject(message) || typeof message.method !== "string") return null;
  const params = isObject(message.params) ? message.params : {};

  if (message.method === "thread/started") {
    const thread = isObject(params.thread) ? params.thread : {};
    if (thread.id !== ownedThreadId) return null;
    const status = projectThreadStatus(thread.status);
    return {
      method: "thread/started",
      params: {
        thread: {
          id: ownedThreadId,
          ...(status === null ? {} : { status }),
        },
      },
    };
  }

  if (message.method === "turn/started") {
    const turn = isObject(params.turn) ? params.turn : {};
    if (
      !hasOwnedThread(params, ownedThreadId) ||
      typeof turn.id !== "string" ||
      turn.status !== "inProgress"
    ) {
      return null;
    }
    return {
      method: "turn/started",
      params: {
        threadId: ownedThreadId,
        turn: { id: turn.id, status: "inProgress" },
      },
    };
  }

  if (message.method === "turn/completed") {
    const turn = isObject(params.turn) ? params.turn : {};
    if (
      !hasOwnedThread(params, ownedThreadId) ||
      typeof turn.id !== "string" ||
      !["completed", "failed", "interrupted"].includes(turn.status)
    ) {
      return null;
    }
    return {
      method: "turn/completed",
      params: {
        threadId: ownedThreadId,
        turn: { id: turn.id, status: turn.status },
      },
    };
  }

  if (message.method === "thread/status/changed") {
    if (!hasOwnedThread(params, ownedThreadId)) return null;
    const status = projectThreadStatus(params.status);
    if (status === null) return null;
    return {
      method: "thread/status/changed",
      params: { threadId: ownedThreadId, status },
    };
  }

  if (message.method === "thread/closed") {
    if (!hasOwnedThread(params, ownedThreadId)) return null;
    return {
      method: "thread/closed",
      params: { threadId: ownedThreadId },
    };
  }

  if (REQUEST_METHODS.has(message.method)) {
    if (!hasOwnedThread(params, ownedThreadId)) return null;
    if (typeof message.id !== "string" && typeof message.id !== "number") {
      return null;
    }
    return {
      id: message.id,
      method: message.method,
      params: {
        threadId: ownedThreadId,
        ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
        ...(message.method === "item/tool/requestUserInput"
          ? { isBlocking: params.isBlocking === true }
          : {}),
      },
    };
  }

  if (message.method === "serverRequest/resolved") {
    if (!hasOwnedThread(params, ownedThreadId)) return null;
    if (
      typeof params.requestId !== "string" &&
      typeof params.requestId !== "number"
    ) {
      return null;
    }
    return {
      method: "serverRequest/resolved",
      params: {
        threadId: ownedThreadId,
        requestId: params.requestId,
      },
    };
  }

  if (ACTIVITY_METHODS.has(message.method)) {
    if (
      !hasOwnedThread(params, ownedThreadId) ||
      typeof params.turnId !== "string"
    ) {
      return null;
    }
    return {
      method: message.method,
      params: {
        threadId: ownedThreadId,
        turnId: params.turnId,
      },
    };
  }

  return null;
}

function comparableMilliseconds(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}

export class JsonlDryRunApnsTransport {
  constructor({ write } = {}) {
    if (typeof write !== "function") {
      throw new TypeError("write must be a function");
    }
    this.write = write;
  }

  send(payload) {
    this.write(`${JSON.stringify(payload)}\n`);
  }
}

export class OneTaskRelay {
  constructor({
    threadId,
    transport,
    staleAfterMs = 60_000,
    clock = Date.now,
  } = {}) {
    if (
      typeof threadId !== "string" ||
      threadId.length === 0 ||
      [...threadId].length > 128
    ) {
      throw new TypeError("threadId must be a non-empty identifier up to 128 code points");
    }
    if (!transport || typeof transport.send !== "function") {
      throw new TypeError("transport.send must be a function");
    }

    this.threadId = threadId;
    this.transport = transport;
    this.clock = clock;
    this.reducer = new StatusReducer({ staleAfterMs, clock });
    this.staleAfterSeconds = Math.max(1, Math.ceil(staleAfterMs / 1_000));
    if (!Number.isSafeInteger(this.staleAfterSeconds)) {
      throw new TypeError("staleAfterMs must map to safe epoch-second output");
    }
    this.sequence = 0;
    this.lastObservedAtMs = null;
  }

  ingest(message, observedAt = this.clock()) {
    const projected = projectOwnedLifecycleMessage(message, this.threadId);
    if (projected === null) return [];
    const outputs = this.#apply(observedAt, () =>
      this.reducer.ingest(projected, observedAt),
    );
    if (!ACTIVITY_METHODS.has(projected.method) || outputs.length > 0) {
      return outputs;
    }

    const [record] = this.reducer.snapshot();
    if (
      record?.state !== "running" ||
      record.turnId !== projected.params.turnId
    ) {
      return outputs;
    }
    return [
      this.#emit({
        ...record,
        observedAt: new Date(comparableMilliseconds(observedAt)).toISOString(),
        source: {
          kind: "appServer",
          signal: "turn/activity",
          correlation: "matchingTurnActivity",
        },
      }),
    ];
  }

  sweep(observedAt = this.clock()) {
    return this.#apply(observedAt, () => this.reducer.sweep(observedAt));
  }

  markDisconnected(observedAt = this.clock()) {
    return this.#apply(observedAt, () =>
      this.reducer.markDisconnected(observedAt),
    );
  }

  snapshot() {
    return this.reducer.snapshot();
  }

  #apply(observedAt, transition) {
    const observedAtMs = comparableMilliseconds(observedAt);
    if (
      Number.isFinite(observedAtMs) &&
      this.lastObservedAtMs !== null &&
      observedAtMs < this.lastObservedAtMs
    ) {
      throw new RangeError("owned lifecycle timestamps must be monotonic");
    }

    const records = transition();
    this.lastObservedAtMs = observedAtMs;
    return records.map((record) => this.#emit(record));
  }

  #emit(record) {
    if (
      record.threadId !== this.threadId ||
      record.title !== null ||
      record.summary !== null ||
      record.aggregate.total !== 1
    ) {
      throw new Error("relay reducer violated the one-task privacy boundary");
    }

    const sequence = this.sequence + 1;
    const payload = buildLiveActivityPayload(record, {
      sequence,
      staleAfterSeconds: this.staleAfterSeconds,
    });
    this.transport.send(payload);
    this.sequence = sequence;
    return { record, payload };
  }
}
