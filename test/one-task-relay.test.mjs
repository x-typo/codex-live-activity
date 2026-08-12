import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildLiveActivityPayload,
  RELAY_MARKER,
} from "../src/live-activity-payload.mjs";
import {
  JsonlDryRunApnsTransport,
  OneTaskRelay,
  projectOwnedLifecycleMessage,
} from "../src/one-task-relay.mjs";
import { STATES } from "../src/status-reducer.mjs";
import { validateJsonSchema } from "../test-support/json-schema-validator.mjs";

const fixtureDirectory = new URL("./fixtures/", import.meta.url);
const statusSchema = JSON.parse(
  await readFile(
    new URL("../schema/status-event.v1.schema.json", import.meta.url),
    "utf8",
  ),
);

function assertStatusRecord(record) {
  const errors = validateJsonSchema(record, statusSchema);
  assert.deepEqual(errors, [], errors.join("\n"));
}

function createRelay(options = {}) {
  const lines = [];
  const transport = new JsonlDryRunApnsTransport({
    write: (line) => lines.push(line),
  });
  const relay = new OneTaskRelay({
    threadId: "thread-relay",
    transport,
    ...options,
  });
  return { lines, relay };
}

async function playRelayFixture(name, options = {}) {
  const { lines, relay } = createRelay(options);
  const content = await readFile(new URL(name, fixtureDirectory), "utf8");
  const outputs = [];

  for (const line of content.trim().split("\n")) {
    const envelope = JSON.parse(line);
    if (envelope.message) {
      outputs.push(...relay.ingest(envelope.message, envelope.observedAt));
    } else if (envelope.control === "sweep") {
      outputs.push(...relay.sweep(envelope.observedAt));
    } else if (envelope.control === "disconnect") {
      outputs.push(...relay.markDisconnected(envelope.observedAt));
    }
  }

  for (const output of outputs) assertStatusRecord(output.record);
  assert.equal(lines.length, outputs.length);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    outputs.map((output) => output.payload),
  );
  return { lines, outputs, relay };
}

test("relays one owned task through confirmed attention and terminal ready", async () => {
  const { lines, outputs } = await playRelayFixture(
    "one-task-relay-lifecycle.jsonl",
  );

  assert.deepEqual(
    outputs.map(({ record }) => record.state),
    [
      "running",
      "waitingForApproval",
      "running",
      "waitingForInput",
      "running",
      "ready",
    ],
  );
  assert.deepEqual(
    outputs.map(({ record }) => record.attentionRequired),
    [false, true, false, true, false, false],
  );
  assert.equal(outputs[1].record.source.correlation, "statusFlagAndPendingRequest");
  assert.equal(outputs[3].record.source.correlation, "statusFlagAndPendingRequest");
  assert.equal(outputs.every(({ record }) => record.title === null), true);
  assert.equal(outputs.every(({ record }) => record.summary === null), true);
  assert.deepEqual(
    outputs.map(({ payload }) => payload.aps["content-state"].sequence),
    [1, 2, 3, 4, 5, 6],
  );

  const encoded = lines.join("");
  for (const marker of [
    "SENSITIVE_THREAD_NAME",
    "SENSITIVE_PREVIEW",
    "SENSITIVE_OTHER_TASK",
    "SENSITIVE_PROMPT",
    "SENSITIVE_COMMAND",
    "/SENSITIVE/CWD",
    "SENSITIVE_REASON",
    "SENSITIVE_RESPONSE",
    "SENSITIVE_QUESTION",
    "SENSITIVE_ASSISTANT_OUTPUT",
    "thread-relay",
    "turn-relay",
  ]) {
    assert.equal(encoded.includes(marker), false, marker);
  }
});

test("maps stale recovery and stream disconnect without retaining activity", async () => {
  const { lines, outputs } = await playRelayFixture(
    "one-task-relay-stale-disconnect.jsonl",
    { staleAfterMs: 5_000 },
  );
  assert.deepEqual(
    outputs.map(({ record }) => record.state),
    ["running", "stale", "running", "disconnected"],
  );
  assert.equal(lines.join("").includes("SENSITIVE_MCP_PROGRESS"), false);
  assert.equal(lines.join("").includes("SENSITIVE_ARGUMENT"), false);
});

test("refreshes the payload stale deadline from matching current-turn activity", () => {
  const { lines, relay } = createRelay({ staleAfterMs: 5_000 });
  const [started] = relay.ingest(
    {
      method: "turn/started",
      params: {
        threadId: "thread-relay",
        turn: { id: "turn-heartbeat", status: "inProgress" },
      },
    },
    "2026-08-12T20:15:00.000Z",
  );
  const [heartbeat] = relay.ingest(
    {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-relay",
        turnId: "turn-heartbeat",
        delta: "SENSITIVE_HEARTBEAT_CONTENT",
      },
    },
    "2026-08-12T20:15:04.000Z",
  );

  assert.equal(heartbeat.record.source.signal, "turn/activity");
  assert.equal(heartbeat.record.source.correlation, "matchingTurnActivity");
  assert.equal(
    heartbeat.payload.aps["stale-date"],
    heartbeat.payload.aps.timestamp + 5,
  );
  assert.equal(
    heartbeat.payload.aps["stale-date"],
    started.payload.aps["stale-date"] + 4,
  );
  assert.deepEqual(
    [started, heartbeat].map(
      ({ payload }) => payload.aps["content-state"].sequence,
    ),
    [1, 2],
  );
  assert.deepEqual(relay.sweep("2026-08-12T20:15:08.000Z"), []);
  assert.equal(
    relay.sweep("2026-08-12T20:15:09.000Z")[0].record.state,
    "stale",
  );
  assert.equal(lines.join("").includes("SENSITIVE_HEARTBEAT_CONTENT"), false);
});

test("does not refresh liveness from activity before turn correlation", () => {
  const { relay } = createRelay({ staleAfterMs: 5_000 });
  relay.ingest(
    {
      method: "thread/status/changed",
      params: {
        threadId: "thread-relay",
        status: { type: "active", activeFlags: [] },
      },
    },
    "2026-08-12T20:16:00.000Z",
  );
  assert.deepEqual(
    relay.ingest(
      {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-relay",
          turnId: "turn-not-yet-correlated",
          delta: "SENSITIVE_UNCORRELATED_CONTENT",
        },
      },
      "2026-08-12T20:16:04.000Z",
    ),
    [],
  );
  assert.equal(
    relay.sweep("2026-08-12T20:16:05.000Z")[0].record.state,
    "stale",
  );
});

test("maps failed and interrupted terminal turns to generic blocked payloads", async () => {
  const failed = await playRelayFixture("one-task-relay-failed.jsonl");
  assert.deepEqual(
    failed.outputs.map(({ record }) => record.state),
    ["running", "blocked"],
  );
  assert.equal(failed.outputs.at(-1).record.source.terminalStatus, "failed");
  assert.equal(failed.lines.join("").includes("SENSITIVE_FAILURE"), false);
  assert.equal(failed.lines.join("").includes("SENSITIVE_DETAILS"), false);

  const { relay } = createRelay();
  relay.ingest(
    {
      method: "turn/started",
      params: {
        threadId: "thread-relay",
        turn: { id: "turn-interrupted", status: "inProgress" },
      },
    },
    "2026-08-12T20:21:00.000Z",
  );
  const interrupted = relay.ingest(
    {
      method: "turn/completed",
      params: {
        threadId: "thread-relay",
        turn: { id: "turn-interrupted", status: "interrupted" },
      },
    },
    "2026-08-12T20:21:01.000Z",
  );
  assert.equal(interrupted[0].record.state, "blocked");
  assert.equal(interrupted[0].record.source.terminalStatus, "interrupted");
});

test("a request alone never emits attention", () => {
  const { lines, relay } = createRelay();
  relay.ingest(
    {
      method: "turn/started",
      params: {
        threadId: "thread-relay",
        turn: { id: "turn-request", status: "inProgress" },
      },
    },
    "2026-08-12T20:30:00.000Z",
  );
  assert.deepEqual(
    relay.ingest(
      {
        id: "request-only",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-relay",
          turnId: "turn-request",
          command: "SENSITIVE_COMMAND",
        },
      },
      "2026-08-12T20:30:01.000Z",
    ),
    [],
  );
  assert.equal(lines.length, 1);
  assert.equal(relay.snapshot()[0].state, "running");
  assert.equal(relay.snapshot()[0].attentionRequired, false);
});

test("the lifecycle projector retains only allowlisted identifiers and state", () => {
  assert.deepEqual(
    projectOwnedLifecycleMessage(
      {
        method: "thread/status/changed",
        params: {
          threadId: "thread-relay",
          prompt: "SENSITIVE_PROMPT",
          status: {
            type: "active",
            activeFlags: ["waitingOnApproval", "unknownSensitiveFlag"],
            error: "SENSITIVE_ERROR",
          },
        },
      },
      "thread-relay",
    ),
    {
      method: "thread/status/changed",
      params: {
        threadId: "thread-relay",
        status: { type: "active", activeFlags: ["waitingOnApproval"] },
      },
    },
  );
  assert.equal(
    projectOwnedLifecycleMessage(
      {
        method: "turn/started",
        params: {
          threadId: "thread-other",
          turn: { id: "turn-other", status: "inProgress" },
        },
      },
      "thread-relay",
    ),
    null,
  );
  assert.equal(
    projectOwnedLifecycleMessage(
      {
        method: "thread/status/changed",
        params: {
          threadId: "thread-relay",
          status: { type: "active", activeFlags: ["unknownFutureFlag"] },
        },
      },
      "thread-relay",
    ),
    null,
  );
  assert.equal(
    projectOwnedLifecycleMessage(
      {
        method: "thread/name/updated",
        params: { threadId: "thread-relay", threadName: "SENSITIVE_NAME" },
      },
      "thread-relay",
    ),
    null,
  );
});

test("rejects backward lifecycle timestamps before changing relay state", () => {
  const { relay } = createRelay();
  relay.ingest(
    {
      method: "turn/started",
      params: {
        threadId: "thread-relay",
        turn: { id: "turn-order", status: "inProgress" },
      },
    },
    "2026-08-12T20:40:01.000Z",
  );
  const before = relay.snapshot();
  assert.throws(
    () =>
      relay.ingest(
        {
          method: "thread/status/changed",
          params: {
            threadId: "thread-relay",
            status: { type: "active", activeFlags: ["waitingOnApproval"] },
          },
        },
        "2026-08-12T20:40:00.000Z",
      ),
    /timestamps must be monotonic/,
  );
  assert.deepEqual(relay.snapshot(), before);
});

test("covers every reducer state with deterministic allowlisted APNs fields", async () => {
  const fixtureResults = await Promise.all([
    playRelayFixture("one-task-relay-lifecycle.jsonl"),
    playRelayFixture("one-task-relay-stale-disconnect.jsonl", {
      staleAfterMs: 5_000,
    }),
    playRelayFixture("one-task-relay-failed.jsonl"),
  ]);
  const outputs = fixtureResults.flatMap((result) => result.outputs);
  assert.deepEqual(
    [...new Set(outputs.map(({ record }) => record.state))].sort(),
    [...STATES].sort(),
  );

  for (const { payload } of outputs) {
    assert.deepEqual(Object.keys(payload), ["aps"]);
    assert.deepEqual(Object.keys(payload.aps).sort(), [
      "content-state",
      "event",
      "stale-date",
      "timestamp",
    ]);
    assert.equal(payload.aps.event, "update");
    assert.deepEqual(Object.keys(payload.aps["content-state"]).sort(), [
      "attentionRequired",
      "detail",
      "marker",
      "sequence",
      "status",
    ]);
    assert.equal(payload.aps["content-state"].marker, RELAY_MARKER);
  }
});

test("payload mapping rejects privacy and one-task contract violations", () => {
  const record = {
    schemaVersion: 1,
    threadId: "thread-relay",
    turnId: "turn-relay",
    observedAt: "2026-08-12T20:50:00.000Z",
    stateSince: "2026-08-12T20:50:00.000Z",
    state: "running",
    attentionRequired: false,
    title: null,
    summary: null,
    source: {
      kind: "appServer",
      signal: "turn/started",
      correlation: "direct",
    },
    aggregate: {
      total: 1,
      attention: 0,
      priorityState: "running",
      counts: Object.fromEntries(STATES.map((state) => [state, state === "running" ? 1 : 0])),
    },
  };

  assert.throws(
    () => buildLiveActivityPayload({ ...record, title: "Not allowed" }, { sequence: 1 }),
    /title and summary must remain null/,
  );
  assert.throws(
    () =>
      buildLiveActivityPayload(
        { ...record, aggregate: { ...record.aggregate, total: 2 } },
        { sequence: 1 },
      ),
    /exactly one task/,
  );
  assert.throws(
    () =>
      buildLiveActivityPayload(
        { ...record, attentionRequired: true },
        { sequence: 1 },
      ),
    /attention does not match/,
  );
  assert.throws(
    () => buildLiveActivityPayload(record, { sequence: 0 }),
    /sequence must be/,
  );
  assert.throws(
    () => buildLiveActivityPayload(record, { sequence: 1, timestamp: 0 }),
    /timestamp must be/,
  );
  assert.throws(
    () =>
      buildLiveActivityPayload(record, {
        sequence: 1,
        timestamp: Number.MAX_SAFE_INTEGER,
      }),
    /must remain a safe integer/,
  );
});
