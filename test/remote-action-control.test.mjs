import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_CONTEXT_ID_PATTERN,
  OneTaskControlContextRegistry,
} from "../src/remote-action-control.mjs";

const NOW = Date.parse("2026-08-22T20:00:00.000Z");
const MAX_LIFETIME_MS = 5 * 60_000;

function createRegistry(overrides = {}) {
  let byte = 0;
  return new OneTaskControlContextRegistry({
    maxLifetimeMs: MAX_LIFETIME_MS,
    now: () => NOW,
    randomBytes: (length) => Buffer.alloc(length, (byte += 1)),
    ...overrides,
  });
}

function issue(registry, overrides = {}) {
  return registry.issue({
    installationId: "installation-iphone-1",
    threadId: "thread-private-owned",
    expectedTurnId: "turn-private-active",
    expiresAtMs: NOW + 60_000,
    dispatch: (action) => ({ accepted: action.actionId }),
    ...overrides,
  });
}

test("issues one opaque installation-bound context without private identifiers", () => {
  const registry = createRegistry();
  const publicContext = issue(registry);

  assert.match(publicContext.controlContextId, CONTROL_CONTEXT_ID_PATTERN);
  assert.equal(publicContext.controlContextId.length, 43);
  assert.equal(publicContext.expiresAt, "2026-08-22T20:01:00.000Z");
  assert.doesNotMatch(
    JSON.stringify(publicContext),
    /installation|thread-private|turn-private/u,
  );
  assert.equal(
    registry.resolve({
      installationId: "installation-other",
      controlContextId: publicContext.controlContextId,
    }),
    null,
  );
});

test("rotates the one-task context and invalidates the prior dispatch handle", () => {
  const registry = createRegistry();
  const first = issue(registry);
  const firstHandle = registry.resolve({
    installationId: "installation-iphone-1",
    controlContextId: first.controlContextId,
  });
  const second = issue(registry, { expectedTurnId: "turn-private-next" });

  assert.notEqual(first.controlContextId, second.controlContextId);
  assert.equal(
    registry.resolve({
      installationId: "installation-iphone-1",
      controlContextId: first.controlContextId,
    }),
    null,
  );
  assert.throws(
    () =>
      firstHandle.dispatch({
        actionId: "action-1",
        threadId: "thread-private-owned",
        expectedTurnId: "turn-private-active",
      }),
    /no longer active/u,
  );
});

test("enforces explicit lifetime, expiry, and exact private correlation", () => {
  let nowMs = NOW;
  const registry = createRegistry({ now: () => nowMs });
  assert.throws(
    () => issue(registry, { expiresAtMs: NOW + MAX_LIFETIME_MS + 1 }),
    /configured context lifetime/u,
  );

  const context = issue(registry);
  const handle = registry.resolve({
    installationId: "installation-iphone-1",
    controlContextId: context.controlContextId,
  });
  assert.throws(
    () =>
      handle.dispatch({
        actionId: "action-1",
        threadId: "thread-private-other",
        expectedTurnId: "turn-private-active",
      }),
    /correlation changed/u,
  );
  nowMs = NOW + 60_000;
  assert.throws(
    () =>
      handle.dispatch({
        actionId: "action-1",
        threadId: "thread-private-owned",
        expectedTurnId: "turn-private-active",
      }),
    /no longer active/u,
  );
});

test("revokes on exact terminal turn and clears on close or disconnect", () => {
  const registry = createRegistry();
  const terminalContext = issue(registry);
  assert.equal(
    registry.revokeTurn({
      threadId: "thread-private-owned",
      expectedTurnId: "turn-private-other",
    }),
    false,
  );
  assert.equal(
    registry.revokeTurn({
      threadId: "thread-private-owned",
      expectedTurnId: "turn-private-active",
    }),
    true,
  );
  assert.equal(
    registry.resolve({
      installationId: "installation-iphone-1",
      controlContextId: terminalContext.controlContextId,
    }),
    null,
  );

  issue(registry);
  assert.equal(registry.revokeAll(), true);
  assert.equal(registry.revokeAll(), false);
  issue(registry);
  assert.equal(registry.revokeAll(), true);
});
