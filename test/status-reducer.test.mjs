import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { STATES, StatusReducer } from "../src/status-reducer.mjs";
import { validateJsonSchema } from "../test-support/json-schema-validator.mjs";

const fixtureDirectory = new URL("./fixtures/", import.meta.url);
const harnessPath = fileURLToPath(
  new URL("../bin/codex-status-harness.mjs", import.meta.url),
);
const statusSchema = JSON.parse(
  await readFile(
    new URL("../schema/status-event.v1.schema.json", import.meta.url),
    "utf8",
  ),
);

function assertStatusRecords(records) {
  for (const record of records) {
    const errors = validateJsonSchema(record, statusSchema);
    assert.deepEqual(errors, [], errors.join("\n"));
  }
}

async function playFixture(name, options = {}) {
  const reducer = new StatusReducer(options);
  const content = await readFile(new URL(name, fixtureDirectory), "utf8");
  const outputs = [];

  for (const line of content.trim().split("\n")) {
    const envelope = JSON.parse(line);
    if (envelope.message) {
      outputs.push(...reducer.ingest(envelope.message, envelope.observedAt));
    } else if (envelope.control === "sweep") {
      outputs.push(...reducer.sweep(envelope.observedAt));
    } else if (envelope.control === "disconnect") {
      outputs.push(...reducer.markDisconnected(envelope.observedAt));
    }
  }

  assertStatusRecords(outputs);
  assertStatusRecords(reducer.snapshot());
  return { reducer, outputs };
}

test("maps running and completed turns without treating idle as ready", async () => {
  const { outputs } = await playFixture("running-completed.jsonl");
  assert.deepEqual(
    outputs.map((output) => output.state),
    ["running", "running", "ready"],
  );
  assert.equal(outputs[0].title, "Status harness smoke");
  assert.equal(outputs[0].summary, null);
  assert.equal(outputs.at(-1).source.terminalStatus, "completed");
});

test("keeps the versioned shared schema synchronized with reducer states", async () => {
  assert.equal(statusSchema.properties.schemaVersion.const, 1);
  assert.deepEqual(statusSchema.properties.summary, { type: "null" });
  assert.deepEqual(statusSchema.$defs.state.enum, STATES);
  assert.deepEqual(
    statusSchema.properties.aggregate.properties.counts.required,
    STATES,
  );
});

test("validates every emitted state and signal against the complete v1 schema", async () => {
  const records = [];
  for (const fixture of [
    "auto-reviewed-permission.jsonl",
    "failed-blocked.jsonl",
    "running-completed.jsonl",
    "stale-disconnect.jsonl",
    "waiting-approval.jsonl",
    "waiting-input.jsonl",
  ]) {
    const { outputs } = await playFixture(
      fixture,
      fixture === "stale-disconnect.jsonl" ? { staleAfterMs: 5_000 } : {},
    );
    records.push(...outputs);
  }

  const reducer = new StatusReducer();
  records.push(
    ...reducer.ingest(
      {
        method: "thread/started",
        params: {
          thread: {
            id: "thread-schema-signals",
            name: "Schema signal coverage",
            status: { type: "active", activeFlags: [] },
          },
        },
      },
      "2026-08-09T19:00:00.000Z",
    ),
    ...reducer.ingest(
      {
        method: "thread/name/updated",
        params: {
          threadId: "thread-schema-signals",
          threadName: "Updated schema signal coverage",
        },
      },
      "2026-08-09T19:00:01.000Z",
    ),
    ...reducer.ingest(
      {
        method: "thread/closed",
        params: { threadId: "thread-schema-signals" },
      },
      "2026-08-09T19:00:02.000Z",
    ),
  );

  const recoveryReducer = new StatusReducer({ staleAfterMs: 1_000 });
  records.push(
    ...recoveryReducer.ingest(
      {
        method: "turn/started",
        params: {
          threadId: "thread-schema-recovery",
          turn: {
            id: "turn-schema-recovery",
            status: "inProgress",
            items: [],
          },
        },
      },
      "2026-08-09T19:01:00.000Z",
    ),
    ...recoveryReducer.sweep("2026-08-09T19:01:01.000Z"),
    ...recoveryReducer.ingest(
      {
        method: "item/mcpToolCall/progress",
        params: {
          threadId: "thread-schema-recovery",
          turnId: "turn-schema-recovery",
          itemId: "item-schema-recovery",
          message: "discarded",
        },
      },
      "2026-08-09T19:01:02.000Z",
    ),
  );

  assertStatusRecords(records);
  assert.deepEqual(
    [...new Set(records.map((record) => record.state))].sort(),
    [...STATES].sort(),
  );
  assert.deepEqual(
    [...new Set(records.map((record) => record.source.signal))].sort(),
    [...statusSchema.properties.source.properties.signal.enum].sort(),
  );

  const invalidSummary = structuredClone(records[0]);
  invalidSummary.summary = "not allowed";
  assert.notDeepEqual(validateJsonSchema(invalidSummary, statusSchema), []);

  const invalidDate = structuredClone(records[0]);
  invalidDate.observedAt = "not-a-date";
  assert.notDeepEqual(validateJsonSchema(invalidDate, statusSchema), []);

  for (const impossibleDate of [
    "2026-02-29T00:00:00.000Z",
    "2026-02-30T00:00:00.000Z",
    "2026-04-31T00:00:00.000Z",
    "2026-01-01T24:00:00.000Z",
  ]) {
    const invalidCalendarDate = structuredClone(records[0]);
    invalidCalendarDate.observedAt = impossibleDate;
    assert.notDeepEqual(
      validateJsonSchema(invalidCalendarDate, statusSchema),
      [],
      impossibleDate,
    );
  }

  const leapDay = structuredClone(records[0]);
  leapDay.observedAt = "2024-02-29T23:59:59.999Z";
  leapDay.stateSince = "2024-02-29T23:59:59.999Z";
  assert.deepEqual(validateJsonSchema(leapDay, statusSchema), []);

  const extraField = { ...records[0], rawPayload: "not allowed" };
  assert.notDeepEqual(validateJsonSchema(extraField, statusSchema), []);

  assert.throws(
    () => validateJsonSchema(records[0], { ...statusSchema, allOf: [] }),
    /unsupported schema keyword allOf/,
  );
});

test("never emits attention from PermissionRequest hook observation alone", async () => {
  const { outputs } = await playFixture("auto-reviewed-permission.jsonl");
  assert.deepEqual(
    outputs.map((output) => output.state),
    ["running", "running", "ready"],
  );
  assert.equal(outputs.some((output) => output.attentionRequired), false);
});

test("emits approval attention only after waitingOnApproval", async () => {
  const { outputs } = await playFixture("waiting-approval.jsonl");
  assert.deepEqual(
    outputs.map((output) => output.state),
    ["running", "waitingForApproval", "running"],
  );
  assert.equal(outputs[1].attentionRequired, true);
  assert.equal(outputs[1].source.correlation, "statusFlagAndPendingRequest");
  assert.equal(outputs[2].attentionRequired, false);
});

test("accepts a confirmed approval status even when no request payload is retained", () => {
  const reducer = new StatusReducer();
  const outputs = reducer.ingest(
    {
      method: "thread/status/changed",
      params: {
        threadId: "thread-status-only",
        status: { type: "active", activeFlags: ["waitingOnApproval"] },
      },
    },
    "2026-08-09T20:25:00.000Z",
  );
  assert.equal(outputs[0].state, "waitingForApproval");
  assert.equal(outputs[0].source.correlation, "statusFlag");
});

test("maps the installed stable waitingOnUserInput flag", async () => {
  const { outputs } = await playFixture("waiting-input.jsonl");
  assert.equal(outputs.at(-1).state, "waitingForInput");
  assert.equal(outputs.at(-1).attentionRequired, true);
});

test("does not silently expire approval or input attention", () => {
  for (const [activeFlag, expectedState] of [
    ["waitingOnApproval", "waitingForApproval"],
    ["waitingOnUserInput", "waitingForInput"],
  ]) {
    const reducer = new StatusReducer({ staleAfterMs: 1_000 });
    reducer.ingest(
      {
        method: "turn/started",
        params: {
          threadId: `thread-${expectedState}`,
          turn: { id: `turn-${expectedState}`, status: "inProgress", items: [] },
        },
      },
      "2026-08-09T20:35:00.000Z",
    );
    reducer.ingest(
      {
        method: "thread/status/changed",
        params: {
          threadId: `thread-${expectedState}`,
          status: { type: "active", activeFlags: [activeFlag] },
        },
      },
      "2026-08-09T20:35:01.000Z",
    );

    const beforeSweep = reducer.snapshot();
    assert.deepEqual(reducer.sweep("2026-08-09T20:36:01.000Z"), []);
    assert.deepEqual(reducer.snapshot(), beforeSweep);
    assert.equal(beforeSweep[0].state, expectedState);
    assert.equal(beforeSweep[0].attentionRequired, true);
    assertStatusRecords(beforeSweep);
  }
});

test("counts allowlisted activity as running liveness without retaining payloads", () => {
  for (const method of [
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
  ]) {
    const reducer = new StatusReducer({ staleAfterMs: 5_000 });
    reducer.ingest(
      {
        method: "turn/started",
        params: {
          threadId: "thread-liveness",
          turn: { id: "turn-liveness", status: "inProgress", items: [] },
        },
      },
      "2026-08-09T20:36:00.000Z",
    );

    assert.deepEqual(
      reducer.ingest(
        {
          method,
          params: {
            threadId: "thread-liveness",
            turnId: "turn-liveness",
            delta: "SENSITIVE_ACTIVITY_PAYLOAD",
            item: { command: "SENSITIVE_ACTIVITY_COMMAND" },
            message: "SENSITIVE_ACTIVITY_MESSAGE",
            changes: [
              {
                path: "/SENSITIVE/ACTIVITY/PATH",
                diff: "SENSITIVE_ACTIVITY_DIFF",
              },
            ],
          },
        },
        "2026-08-09T20:36:04.000Z",
      ),
      [],
    );
    assert.deepEqual(reducer.sweep("2026-08-09T20:36:05.000Z"), []);
    assert.equal(reducer.snapshot()[0].state, "running");

    const stale = reducer.sweep("2026-08-09T20:36:09.000Z");
    assert.equal(stale[0].state, "stale");
    assert.equal(JSON.stringify(stale).includes("SENSITIVE_ACTIVITY"), false);
  }
});

test("recovers a stale task only from matching current-turn activity", () => {
  const reducer = new StatusReducer({ staleAfterMs: 5_000 });
  reducer.ingest(
    {
      method: "turn/started",
      params: {
        threadId: "thread-stale-recovery",
        turn: { id: "turn-current", status: "inProgress", items: [] },
      },
    },
    "2026-08-09T20:36:20.000Z",
  );
  assert.equal(
    reducer.sweep("2026-08-09T20:36:25.000Z")[0].state,
    "stale",
  );

  assert.deepEqual(
    reducer.ingest(
      {
        method: "item/mcpToolCall/progress",
        params: {
          threadId: "thread-stale-recovery",
          turnId: "turn-old",
          itemId: "item-old",
          message: "ignored old turn",
        },
      },
      "2026-08-09T20:36:26.000Z",
    ),
    [],
  );
  assert.equal(reducer.snapshot()[0].state, "stale");

  const [recovered] = reducer.ingest(
    {
      method: "item/mcpToolCall/progress",
      params: {
        threadId: "thread-stale-recovery",
        turnId: "turn-current",
        itemId: "item-current",
        message: "SENSITIVE_RECOVERY_MESSAGE",
      },
    },
    "2026-08-09T20:36:26.000Z",
  );
  assert.equal(recovered.state, "running");
  assert.equal(recovered.source.signal, "turn/activity");
  assert.equal(recovered.source.correlation, "matchingTurnActivity");
  assert.equal(JSON.stringify(recovered).includes("SENSITIVE_RECOVERY"), false);
  assert.deepEqual(reducer.sweep("2026-08-09T20:36:30.000Z"), []);
  assert.equal(
    reducer.sweep("2026-08-09T20:36:31.000Z")[0].state,
    "stale",
  );
  assertStatusRecords([recovered]);
});

test("ignores old-turn activity when measuring the newer turn", () => {
  const reducer = new StatusReducer({ staleAfterMs: 5_000 });
  reducer.ingest(
    {
      method: "turn/started",
      params: {
        threadId: "thread-activity-order",
        turn: { id: "turn-old", status: "inProgress", items: [] },
      },
    },
    "2026-08-09T20:37:00.000Z",
  );
  reducer.ingest(
    {
      method: "turn/started",
      params: {
        threadId: "thread-activity-order",
        turn: { id: "turn-new", status: "inProgress", items: [] },
      },
    },
    "2026-08-09T20:37:01.000Z",
  );
  reducer.ingest(
    {
      method: "item/mcpToolCall/progress",
      params: {
        threadId: "thread-activity-order",
        turnId: "turn-old",
        itemId: "item-old",
        message: "ignored",
      },
    },
    "2026-08-09T20:37:04.000Z",
  );

  const stale = reducer.sweep("2026-08-09T20:37:06.000Z");
  assert.equal(stale[0].state, "stale");
  assert.equal(stale[0].turnId, "turn-new");
});

test("ignores a late completion from an older turn", () => {
  const reducer = new StatusReducer();
  reducer.ingest(
    {
      method: "turn/started",
      params: {
        threadId: "thread-turn-order",
        turn: { id: "turn-old", status: "inProgress", items: [] },
      },
    },
    "2026-08-09T20:37:00.000Z",
  );
  reducer.ingest(
    {
      method: "turn/started",
      params: {
        threadId: "thread-turn-order",
        turn: { id: "turn-new", status: "inProgress", items: [] },
      },
    },
    "2026-08-09T20:37:01.000Z",
  );

  const newerTurn = reducer.snapshot();
  assert.deepEqual(
    reducer.ingest(
      {
        method: "turn/completed",
        params: {
          threadId: "thread-turn-order",
          turn: { id: "turn-old", status: "completed", items: [] },
        },
      },
      "2026-08-09T20:37:02.000Z",
    ),
    [],
  );
  assert.deepEqual(reducer.snapshot(), newerTurn);
  assert.equal(newerTurn[0].state, "running");
  assert.equal(newerTurn[0].turnId, "turn-new");
  assert.equal(newerTurn[0].source.signal, "turn/started");

  assert.deepEqual(
    reducer.ingest(
      {
        method: "turn/started",
        params: {
          threadId: "thread-turn-order",
          turn: { status: "inProgress", items: [] },
        },
      },
      "2026-08-09T20:37:03.000Z",
    ),
    [],
  );
  assert.deepEqual(reducer.snapshot(), newerTurn);
  assertStatusRecords(newerTurn);
});

test("rejects timestamps outside the RFC 3339 contract before state mutation", () => {
  for (const invalidTimestamp of [
    1e20,
    -1e20,
    8_640_000_000_000_000,
    -8_640_000_000_000_000,
  ]) {
    const ingestReducer = new StatusReducer();
    assert.throws(
      () =>
        ingestReducer.ingest(
          {
            method: "turn/started",
            params: {
              threadId: "thread-invalid-ingest",
              turn: {
                id: "turn-invalid-ingest",
                status: "inProgress",
                items: [],
              },
            },
          },
          invalidTimestamp,
        ),
      /observedAt must be an RFC 3339-compatible date or epoch timestamp/,
    );
    assert.deepEqual(ingestReducer.snapshot(), []);

    const reducer = new StatusReducer({ staleAfterMs: 1_000 });
    reducer.ingest(
      {
        method: "turn/started",
        params: {
          threadId: "thread-invalid-control",
          turn: {
            id: "turn-invalid-control",
            status: "inProgress",
            items: [],
          },
        },
      },
      "2026-08-09T20:38:00.000Z",
    );
    const beforeInvalidControl = reducer.snapshot();

    assert.throws(
      () => reducer.sweep(invalidTimestamp),
      /observedAt must be an RFC 3339-compatible date or epoch timestamp/,
    );
    assert.deepEqual(reducer.snapshot(), beforeInvalidControl);
    assert.throws(
      () => reducer.markDisconnected(invalidTimestamp),
      /observedAt must be an RFC 3339-compatible date or epoch timestamp/,
    );
    assert.deepEqual(reducer.snapshot(), beforeInvalidControl);
    assertStatusRecords(beforeInvalidControl);
  }
});

test("emits schema-valid timestamps at the four-digit-year boundaries", () => {
  for (const observedAt of [
    "0000-01-01T00:00:00.000Z",
    "9999-12-31T23:59:59.999Z",
  ]) {
    const reducer = new StatusReducer();
    const records = reducer.ingest(
      {
        method: "turn/started",
        params: {
          threadId: `thread-boundary-${observedAt.slice(0, 4)}`,
          turn: {
            id: `turn-boundary-${observedAt.slice(0, 4)}`,
            status: "inProgress",
            items: [],
          },
        },
      },
      observedAt,
    );

    assert.equal(records[0].observedAt, observedAt);
    assert.equal(records[0].stateSince, observedAt);
    assertStatusRecords(records);
  }
});

test("maps failed terminal turns to blocked without retaining error text", async () => {
  const { outputs } = await playFixture("failed-blocked.jsonl");
  assert.equal(outputs.at(-1).state, "blocked");
  assert.equal(outputs.at(-1).source.terminalStatus, "failed");
  assert.equal(JSON.stringify(outputs).includes("redacted"), false);
});

test("maps thread system errors to blocked", () => {
  const reducer = new StatusReducer();
  const outputs = reducer.ingest(
    {
      method: "thread/status/changed",
      params: {
        threadId: "thread-system-error",
        status: { type: "systemError" },
      },
    },
    "2026-08-09T20:42:00.000Z",
  );
  assert.equal(outputs[0].state, "blocked");
  assert.equal(outputs[0].attentionRequired, false);
});

test("preserves terminal results when an inactive thread unloads", async () => {
  const { reducer, outputs } = await playFixture("running-completed.jsonl");
  const closed = reducer.ingest(
    {
      method: "thread/status/changed",
      params: {
        threadId: "thread-running",
        status: { type: "notLoaded" },
      },
    },
    "2026-08-09T20:00:04.000Z",
  );
  assert.deepEqual(closed, []);
  assert.deepEqual(
    reducer.ingest(
      {
        method: "thread/closed",
        params: { threadId: "thread-running" },
      },
      "2026-08-09T20:00:05.000Z",
    ),
    [],
  );
  assert.deepEqual(reducer.markDisconnected("2026-08-09T20:00:06.000Z"), []);
  assert.equal(outputs.at(-1).state, "ready");
  assert.equal(reducer.snapshot()[0].state, "ready");
});

test("preserves blocked terminal results when the thread and stream close", async () => {
  const { reducer } = await playFixture("failed-blocked.jsonl");
  assert.deepEqual(
    reducer.ingest(
      {
        method: "thread/status/changed",
        params: {
          threadId: "thread-failed",
          status: { type: "notLoaded" },
        },
      },
      "2026-08-09T20:40:01.500Z",
    ),
    [],
  );
  assert.deepEqual(
    reducer.ingest(
      {
        method: "thread/closed",
        params: { threadId: "thread-failed" },
      },
      "2026-08-09T20:40:02.000Z",
    ),
    [],
  );
  assert.deepEqual(reducer.markDisconnected("2026-08-09T20:40:03.000Z"), []);
  assert.equal(reducer.snapshot()[0].state, "blocked");
});

test("updates the short title only from thread name events", () => {
  const reducer = new StatusReducer();
  reducer.ingest(
    {
      method: "turn/started",
      params: {
        threadId: "thread-title",
        turn: { id: "turn-title", status: "inProgress", items: [] },
      },
    },
    "2026-08-09T20:45:00.000Z",
  );
  const outputs = reducer.ingest(
    {
      method: "thread/name/updated",
      params: {
        threadId: "thread-title",
        threadName: "Supported task title",
      },
    },
    "2026-08-09T20:45:01.000Z",
  );
  assert.equal(outputs[0].title, "Supported task title");
  assert.equal(outputs[0].summary, null);
});

test("truncates titles and identifiers at well-formed Unicode boundaries", () => {
  const title = `${"a".repeat(95)}😀`;
  const threadId = `${"t".repeat(127)}😀`;
  const reducer = new StatusReducer();
  reducer.ingest(
    {
      method: "thread/started",
      params: {
        thread: { id: threadId, name: title, status: { type: "idle" } },
      },
    },
    "2026-08-09T20:46:00.000Z",
  );
  const [record] = reducer.ingest(
    {
      method: "turn/started",
      params: {
        threadId,
        turn: { id: "turn-unicode", status: "inProgress", items: [] },
      },
    },
    "2026-08-09T20:46:01.000Z",
  );

  assert.equal(record.title, title);
  assert.equal(record.threadId, threadId);
  assert.equal([...record.title].length, 96);
  assert.equal([...record.threadId].length, 128);
  assert.equal(JSON.stringify(record).includes("\\ud83d"), false);

  const [updated] = reducer.ingest(
    {
      method: "thread/name/updated",
      params: { threadId, threadName: `unsafe\ud83dtitle` },
    },
    "2026-08-09T20:46:02.000Z",
  );
  assert.equal(updated.title, "unsafe�title");
  assertStatusRecords([record, updated]);
});

test("marks active tasks stale and then disconnected", async () => {
  const { outputs } = await playFixture("stale-disconnect.jsonl", {
    staleAfterMs: 5_000,
  });
  assert.deepEqual(
    outputs.map((output) => [output.threadId, output.state]),
    [
      ["thread-stale", "running"],
      ["thread-stale", "stale"],
      ["thread-disconnect", "running"],
      ["thread-stale", "disconnected"],
      ["thread-disconnect", "disconnected"],
    ],
  );
});

test("computes aggregate counts using the accepted attention-first priority", async () => {
  const reducer = new StatusReducer();
  reducer.ingest(
    {
      method: "turn/started",
      params: {
        threadId: "thread-one",
        turn: { id: "turn-one", status: "inProgress", items: [] },
      },
    },
    "2026-08-09T21:00:00.000Z",
  );
  const outputs = reducer.ingest(
    {
      method: "thread/status/changed",
      params: {
        threadId: "thread-two",
        status: { type: "active", activeFlags: ["waitingOnApproval"] },
      },
    },
    "2026-08-09T21:00:01.000Z",
  );

  assert.equal(outputs[0].aggregate.total, 2);
  assert.equal(outputs[0].aggregate.counts.running, 1);
  assert.equal(outputs[0].aggregate.counts.waitingForApproval, 1);
  assert.equal(outputs[0].aggregate.priorityState, "waitingForApproval");
});

test("allowlists output fields and ignores sensitive App Server payload fields", () => {
  const reducer = new StatusReducer();
  reducer.ingest(
    {
      method: "thread/started",
      params: {
        thread: {
          id: "thread-private",
          name: "Safe task title",
          preview: "SENSITIVE_PREVIEW_9C4E",
        },
      },
    },
    "2026-08-09T21:10:00.000Z",
  );
  reducer.ingest(
    {
      id: "request-private",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-private",
        turnId: "turn-private",
        itemId: "item-private",
        command: "SENSITIVE_COMMAND_9C4E",
        cwd: "/SENSITIVE/CWD/9C4E",
        reason: "SENSITIVE_REASON_9C4E",
        toolPayload: "SENSITIVE_PAYLOAD_9C4E",
        prompt: "SENSITIVE_PROMPT_9C4E",
        transcriptPath: "/SENSITIVE/TRANSCRIPT/9C4E",
        assistantMessage: "SENSITIVE_ASSISTANT_9C4E",
        reasoning: "SENSITIVE_REASONING_9C4E",
      },
    },
    "2026-08-09T21:10:01.000Z",
  );
  const outputs = reducer.ingest(
    {
      method: "thread/status/changed",
      params: {
        threadId: "thread-private",
        status: { type: "active", activeFlags: ["waitingOnApproval"] },
      },
    },
    "2026-08-09T21:10:02.000Z",
  );

  const encoded = JSON.stringify(outputs);
  for (const marker of [
    "SENSITIVE_PREVIEW_9C4E",
    "SENSITIVE_COMMAND_9C4E",
    "/SENSITIVE/CWD/9C4E",
    "SENSITIVE_REASON_9C4E",
    "SENSITIVE_PAYLOAD_9C4E",
    "SENSITIVE_PROMPT_9C4E",
    "/SENSITIVE/TRANSCRIPT/9C4E",
    "SENSITIVE_ASSISTANT_9C4E",
    "SENSITIVE_REASONING_9C4E",
  ]) {
    assert.equal(encoded.includes(marker), false);
  }
  const record = outputs[0];
  assert.deepEqual(Object.keys(record).sort(), [
    "aggregate",
    "attentionRequired",
    "observedAt",
    "schemaVersion",
    "source",
    "state",
    "stateSince",
    "summary",
    "threadId",
    "title",
    "turnId",
  ].sort());
  assert.deepEqual(Object.keys(record.source).sort(), [
    "correlation",
    "kind",
    "pendingRequestCount",
    "signal",
  ]);
  assert.deepEqual(Object.keys(record.aggregate).sort(), [
    "attention",
    "counts",
    "priorityState",
    "total",
  ]);
  assert.deepEqual(Object.keys(record.aggregate.counts), STATES);
  assert.equal(record.title, "Safe task title");
  assert.equal(record.summary, null);
});

test("CLI emits only redacted status records and disconnects on EOF", () => {
  const input = [
    {
      method: "turn/started",
      params: {
        threadId: "thread-cli",
        turn: { id: "turn-cli", status: "inProgress", items: [] },
      },
    },
    {
      method: "thread/status/changed",
      params: {
        threadId: "thread-cli",
        status: { type: "active", activeFlags: ["waitingOnApproval"] },
      },
    },
  ]
    .map((message) => JSON.stringify(message))
    .join("\n");

  const result = spawnSync(
    process.execPath,
    [harnessPath],
    { input, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const states = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).state);
  assert.deepEqual(states, ["running", "waitingForApproval", "disconnected"]);
});

test("CLI EOF preserves ready and blocked terminal states", () => {
  const input = [
    {
      method: "turn/started",
      params: {
        threadId: "thread-cli-ready",
        turn: { id: "turn-cli-ready", status: "inProgress", items: [] },
      },
    },
    {
      method: "turn/completed",
      params: {
        threadId: "thread-cli-ready",
        turn: { id: "turn-cli-ready", status: "completed", items: [] },
      },
    },
    {
      method: "turn/started",
      params: {
        threadId: "thread-cli-blocked",
        turn: { id: "turn-cli-blocked", status: "inProgress", items: [] },
      },
    },
    {
      method: "turn/completed",
      params: {
        threadId: "thread-cli-blocked",
        turn: { id: "turn-cli-blocked", status: "failed", items: [] },
      },
    },
  ]
    .map((message) => JSON.stringify(message))
    .join("\n");

  const result = spawnSync(
    process.execPath,
    [harnessPath],
    { input, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const states = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).state);
  assert.deepEqual(states, ["running", "ready", "running", "blocked"]);
});
