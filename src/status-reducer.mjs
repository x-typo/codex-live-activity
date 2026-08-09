export const STATUS_SCHEMA_VERSION = 1;

export const STATES = Object.freeze([
  "running",
  "waitingForApproval",
  "waitingForInput",
  "ready",
  "blocked",
  "stale",
  "disconnected",
]);

const REQUEST_KINDS = new Map([
  ["item/commandExecution/requestApproval", "approval"],
  ["item/fileChange/requestApproval", "approval"],
  ["item/permissions/requestApproval", "approval"],
  ["item/tool/requestUserInput", "input"],
  ["mcpServer/elicitation/request", "input"],
]);

const TURN_ACTIVITY_METHODS = new Set([
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
]);

const ACTIVE_STATES = new Set([
  "running",
  "waitingForApproval",
  "waitingForInput",
]);

const RFC3339_ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeIdentifier(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/[\r\n\t]/g, " ");
  return normalized.length > 0 ? safePrefix(normalized, 128) : null;
}

function safeTitle(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? safePrefix(normalized, 96) : null;
}

function safePrefix(value, maximumCodePoints) {
  return [...value.toWellFormed()].slice(0, maximumCodePoints).join("");
}

function toEpochMilliseconds(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}

function validatedEpochMilliseconds(value) {
  const milliseconds = toEpochMilliseconds(value);
  const date = new Date(milliseconds);
  if (!Number.isFinite(milliseconds) || !Number.isFinite(date.getTime())) {
    throw new TypeError(
      "observedAt must be an RFC 3339-compatible date or epoch timestamp",
    );
  }
  if (!RFC3339_ISO_INSTANT.test(date.toISOString())) {
    throw new TypeError(
      "observedAt must be an RFC 3339-compatible date or epoch timestamp",
    );
  }
  return milliseconds;
}

function toIsoString(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function emptyCounts() {
  return Object.fromEntries(STATES.map((state) => [state, 0]));
}

export class StatusReducer {
  constructor({ staleAfterMs = 60_000, clock = Date.now } = {}) {
    if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
      throw new TypeError("staleAfterMs must be a positive number");
    }

    this.staleAfterMs = staleAfterMs;
    this.clock = clock;
    this.tasks = new Map();
  }

  ingest(message, observedAt = this.clock()) {
    const observedAtMs = validatedEpochMilliseconds(observedAt);
    if (!isObject(message) || typeof message.method !== "string") return [];

    const params = isObject(message.params) ? message.params : {};
    const requestKind = REQUEST_KINDS.get(message.method);
    if (requestKind) {
      this.#observePendingRequest(message, params, requestKind, observedAtMs);
      return [];
    }

    if (TURN_ACTIVITY_METHODS.has(message.method)) {
      return this.#observeTurnActivity(params, observedAtMs);
    }

    switch (message.method) {
      case "thread/started":
        return this.#observeThreadStarted(params, observedAtMs);
      case "thread/name/updated":
        return this.#observeThreadName(params, observedAtMs);
      case "turn/started":
        return this.#observeTurnStarted(params, observedAtMs);
      case "turn/completed":
        return this.#observeTurnCompleted(params, observedAtMs);
      case "thread/status/changed":
        return this.#observeThreadStatus(params, observedAtMs);
      case "serverRequest/resolved":
        this.#observeResolvedRequest(params);
        return [];
      case "thread/closed":
        return this.#observeThreadClosed(params, observedAtMs);
      case "hook/started":
      case "hook/completed":
        return [];
      default:
        return [];
    }
  }

  sweep(observedAt = this.clock()) {
    const observedAtMs = validatedEpochMilliseconds(observedAt);

    const records = [];
    for (const task of this.tasks.values()) {
      if (
        task.state === "running" &&
        observedAtMs - task.lastSignalAtMs >= this.staleAfterMs
      ) {
        records.push(
          this.#transition(task, "stale", observedAtMs, {
            kind: "timer",
            signal: "staleTimeout",
            correlation: "elapsedWithoutSignal",
          }),
        );
      }
    }
    return records;
  }

  markDisconnected(observedAt = this.clock()) {
    const observedAtMs = validatedEpochMilliseconds(observedAt);

    const records = [];
    for (const task of this.tasks.values()) {
      if (ACTIVE_STATES.has(task.state) || task.state === "stale") {
        records.push(
          this.#transition(task, "disconnected", observedAtMs, {
            kind: "transport",
            signal: "streamClosed",
            correlation: "direct",
          }),
        );
      }
    }
    return records;
  }

  snapshot() {
    return [...this.tasks.values()]
      .filter((task) => task.state !== null)
      .sort((left, right) => left.threadId.localeCompare(right.threadId))
      .map((task) => this.#record(task, task.lastSource));
  }

  aggregate() {
    const counts = emptyCounts();
    for (const task of this.tasks.values()) {
      if (task.state !== null) counts[task.state] += 1;
    }

    const orderedPriority = [
      "waitingForApproval",
      "waitingForInput",
      "blocked",
      "ready",
      "running",
      "stale",
      "disconnected",
    ];

    return {
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      attention: counts.waitingForApproval + counts.waitingForInput,
      priorityState: orderedPriority.find((state) => counts[state] > 0) ?? null,
      counts,
    };
  }

  #observeThreadStarted(params, observedAtMs) {
    const thread = isObject(params.thread) ? params.thread : {};
    const threadId = safeIdentifier(thread.id);
    if (!threadId) return [];

    const task = this.#task(threadId);
    task.title = safeTitle(thread.name);
    task.lastSignalAtMs = observedAtMs;

    const status = isObject(thread.status) ? thread.status : null;
    if (status?.type === "active" || status?.type === "systemError") {
      return this.#applyThreadStatus(task, status, observedAtMs, "thread/started");
    }
    return [];
  }

  #observeThreadName(params, observedAtMs) {
    const threadId = safeIdentifier(params.threadId);
    if (!threadId) return [];

    const task = this.#task(threadId);
    task.title = safeTitle(params.threadName);
    task.lastSignalAtMs = observedAtMs;
    if (task.state === null) return [];

    return [
      this.#transition(task, task.state, observedAtMs, {
        kind: "appServer",
        signal: "thread/name/updated",
        correlation: "direct",
      }),
    ];
  }

  #observeTurnStarted(params, observedAtMs) {
    const turn = isObject(params.turn) ? params.turn : {};
    const threadId = safeIdentifier(params.threadId);
    const turnId = safeIdentifier(turn.id);
    if (!threadId || !turnId) return [];

    const task = this.#task(threadId);
    task.turnId = turnId;
    task.terminalStatus = null;
    return [
      this.#transition(task, "running", observedAtMs, {
        kind: "appServer",
        signal: "turn/started",
        correlation: "direct",
      }),
    ];
  }

  #observeTurnCompleted(params, observedAtMs) {
    const turn = isObject(params.turn) ? params.turn : {};
    const turnId = safeIdentifier(turn.id);
    if (!turnId) return [];
    const threadId =
      safeIdentifier(params.threadId) ?? this.#threadIdForTurn(turnId);
    if (!threadId) return [];

    const task = this.#task(threadId);
    if (task.turnId !== null && task.turnId !== turnId) return [];
    const terminalStatus = ["completed", "failed", "interrupted"].includes(
      turn.status,
    )
      ? turn.status
      : null;
    if (!terminalStatus) return [];

    task.turnId = turnId;
    task.terminalStatus = terminalStatus;
    task.pendingRequests.clear();
    const state = terminalStatus === "completed" ? "ready" : "blocked";
    return [
      this.#transition(task, state, observedAtMs, {
        kind: "appServer",
        signal: "turn/completed",
        correlation: "direct",
        terminalStatus,
      }),
    ];
  }

  #observeThreadStatus(params, observedAtMs) {
    const threadId = safeIdentifier(params.threadId);
    const status = isObject(params.status) ? params.status : null;
    if (!threadId || !status) return [];
    return this.#applyThreadStatus(
      this.#task(threadId),
      status,
      observedAtMs,
      "thread/status/changed",
    );
  }

  #applyThreadStatus(task, status, observedAtMs, signal) {
    if (status.type === "active") {
      const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
      let state = "running";
      if (flags.includes("waitingOnApproval")) state = "waitingForApproval";
      else if (flags.includes("waitingOnUserInput")) state = "waitingForInput";

      const expectedRequestKind =
        state === "waitingForApproval"
          ? "approval"
          : state === "waitingForInput"
            ? "input"
            : null;
      const matchingRequestCount = [...task.pendingRequests.values()].filter(
        (request) =>
          request.kind === expectedRequestKind &&
          (request.turnId === null ||
            task.turnId === null ||
            request.turnId === task.turnId),
      ).length;

      return [
        this.#transition(task, state, observedAtMs, {
          kind: "appServer",
          signal,
          correlation:
            state === "running"
              ? "direct"
              : matchingRequestCount > 0
                ? "statusFlagAndPendingRequest"
                : "statusFlag",
          pendingRequestCount: matchingRequestCount,
        }),
      ];
    }

    if (status.type === "systemError") {
      return [
        this.#transition(task, "blocked", observedAtMs, {
          kind: "appServer",
          signal,
          correlation: "direct",
        }),
      ];
    }

    if (status.type === "notLoaded") {
      return this.#disconnectIfActive(task, observedAtMs, signal);
    }

    task.lastSignalAtMs = observedAtMs;
    return [];
  }

  #observePendingRequest(message, params, kind, observedAtMs) {
    const threadId = safeIdentifier(params.threadId);
    if (!threadId) return;
    if (kind === "input" && params.isBlocking === false) return;

    const task = this.#task(threadId);
    const requestId = safeIdentifier(String(message.id ?? ""));
    if (!requestId) return;
    task.pendingRequests.set(requestId, {
      kind,
      turnId: safeIdentifier(params.turnId),
      observedAtMs,
    });
    task.lastSignalAtMs = observedAtMs;
  }

  #observeResolvedRequest(params) {
    const threadId = safeIdentifier(params.threadId);
    if (!threadId) return;
    const task = this.tasks.get(threadId);
    if (!task) return;
    task.pendingRequests.delete(String(params.requestId ?? ""));
  }

  #observeTurnActivity(params, observedAtMs) {
    const threadId = safeIdentifier(params.threadId);
    const turnId = safeIdentifier(params.turnId);
    if (!threadId || !turnId) return [];

    const task = this.tasks.get(threadId);
    if (!task || !["running", "stale"].includes(task.state)) return [];
    if (task.turnId !== null && task.turnId !== turnId) return [];
    if (task.state === "stale") {
      return [
        this.#transition(task, "running", observedAtMs, {
          kind: "appServer",
          signal: "turn/activity",
          correlation: "matchingTurnActivity",
        }),
      ];
    }
    task.lastSignalAtMs = Math.max(task.lastSignalAtMs ?? observedAtMs, observedAtMs);
    return [];
  }

  #observeThreadClosed(params, observedAtMs) {
    const threadId = safeIdentifier(params.threadId);
    if (!threadId) return [];
    const task = this.#task(threadId);
    return this.#disconnectIfActive(task, observedAtMs, "thread/closed");
  }

  #disconnectIfActive(task, observedAtMs, signal) {
    task.lastSignalAtMs = observedAtMs;
    if (!ACTIVE_STATES.has(task.state) && task.state !== "stale") return [];
    return [
      this.#transition(task, "disconnected", observedAtMs, {
        kind: "appServer",
        signal,
        correlation: "direct",
      }),
    ];
  }

  #task(threadId) {
    let task = this.tasks.get(threadId);
    if (!task) {
      task = {
        threadId,
        turnId: null,
        title: null,
        summary: null,
        state: null,
        stateSinceMs: null,
        observedAtMs: null,
        lastSignalAtMs: null,
        lastSource: null,
        terminalStatus: null,
        pendingRequests: new Map(),
      };
      this.tasks.set(threadId, task);
    }
    return task;
  }

  #threadIdForTurn(turnId) {
    if (!turnId) return null;
    for (const task of this.tasks.values()) {
      if (task.turnId === turnId) return task.threadId;
    }
    return null;
  }

  #transition(task, state, observedAtMs, source) {
    if (!STATES.includes(state)) throw new TypeError(`Unknown state: ${state}`);
    if (task.state !== state || task.stateSinceMs === null) {
      task.stateSinceMs = observedAtMs;
    }
    task.state = state;
    task.observedAtMs = observedAtMs;
    task.lastSignalAtMs = observedAtMs;
    task.lastSource = source;
    return this.#record(task, source);
  }

  #record(task, source) {
    return {
      schemaVersion: STATUS_SCHEMA_VERSION,
      threadId: task.threadId,
      turnId: task.turnId,
      observedAt: toIsoString(task.observedAtMs),
      stateSince: toIsoString(task.stateSinceMs),
      state: task.state,
      attentionRequired:
        task.state === "waitingForApproval" || task.state === "waitingForInput",
      title: task.title,
      summary: task.summary,
      source: { ...source },
      aggregate: this.aggregate(),
    };
  }
}
