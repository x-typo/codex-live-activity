import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSmokePayload,
  SMOKE_MARKER,
} from "../spikes/apns-live-activity-smoke/scripts/apns-smoke-payload.mjs";

test("renders deterministic allowlisted APNs Live Activity states", () => {
  const timestamp = 1_786_551_000;
  const attention = buildSmokePayload("attention", timestamp);
  const ready = buildSmokePayload("ready", timestamp + 1);
  const end = buildSmokePayload("end", timestamp + 2);

  assert.deepEqual(
    [attention, ready, end].map((payload) => payload.aps.event),
    ["update", "update", "end"],
  );
  assert.deepEqual(
    [attention, ready, end].map(
      (payload) => payload.aps["content-state"].sequence,
    ),
    [1, 2, 3],
  );
  assert.equal(attention.aps["content-state"].attentionRequired, true);
  assert.equal(ready.aps["content-state"].attentionRequired, false);
  assert.equal(end.aps["content-state"].marker, SMOKE_MARKER);
  assert.equal(attention.aps["stale-date"], timestamp + 300);
  assert.equal(end.aps["dismissal-date"], timestamp + 32);
  assert.deepEqual(Object.keys(attention.aps["content-state"]).sort(), [
    "attentionRequired",
    "detail",
    "marker",
    "sequence",
    "status",
  ]);
});

test("rejects unknown states and invalid timestamps", () => {
  assert.throws(() => buildSmokePayload("running", 1), /kind must be one of/);
  assert.throws(() => buildSmokePayload("ready", 0), /positive integer/);
  assert.throws(() => buildSmokePayload("ready", 1.5), /positive integer/);
});
