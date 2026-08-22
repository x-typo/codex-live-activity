import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_STRICT_JSON_DEPTH,
  parseJsonRejectingDuplicateMembers,
} from "../src/strict-json.mjs";

test("strict JSON preserves valid JSON semantics", () => {
  const raw = String.raw`{
    "string": "line\n\u0061",
    "number": -1.25e+3,
    "boolean": true,
    "nothing": null,
    "array": [false, 0, {"same": 1}],
    "object": {"same": 2}
  }`;
  assert.deepEqual(
    parseJsonRejectingDuplicateMembers(raw),
    JSON.parse(raw),
  );
});

test("strict JSON rejects duplicate members at every object depth", () => {
  for (const raw of [
    `{"a":1,"a":1}`,
    `{"a":1,"a":2}`,
    `{"outer":{"a":1,"a":2}}`,
    `[{"a":1,"a":2}]`,
    String.raw`{"action":1,"\u0061ction":2}`,
    String.raw`{"é":1,"\u00e9":2}`,
  ]) {
    assert.throws(
      () => parseJsonRejectingDuplicateMembers(raw),
      /duplicate JSON member/u,
    );
  }
});

test("strict JSON scopes member names to each object without Unicode normalization", () => {
  assert.deepEqual(
    parseJsonRejectingDuplicateMembers(
      `{"left":{"same":1},"right":{"same":2},"é":3,"é":4}`,
    ),
    { left: { same: 1 }, right: { same: 2 }, é: 3, é: 4 },
  );
});

test("strict JSON rejects malformed or excessively nested input", () => {
  for (const raw of ["", "+1", "01", "[1,]", `{"a":}`, `{"a" 1}`]) {
    assert.throws(() => parseJsonRejectingDuplicateMembers(raw), /invalid JSON/u);
  }

  const nested = `${"[".repeat(MAX_STRICT_JSON_DEPTH + 1)}null${"]".repeat(
    MAX_STRICT_JSON_DEPTH + 1,
  )}`;
  assert.throws(
    () => parseJsonRejectingDuplicateMembers(nested),
    /invalid JSON/u,
  );
});
