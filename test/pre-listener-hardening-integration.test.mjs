import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFileRemoteActionReplayStore } from "../src/file-remote-action-replay-store.mjs";
import { OneTaskControlContextRegistry } from "../src/remote-action-control.mjs";
import { loadRemoteActionSecrets } from "../src/remote-action-secrets.mjs";
import {
  REMOTE_TURN_ACTION_PATH,
  createTailscaleTurnActionRequestHandler,
} from "../src/tailscale-turn-action-ingress.mjs";

const repositoryRoot = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");
const NOW = Date.parse("2026-08-22T20:00:30.000Z");
const CAPABILITY = "github.com/x-typo/codex-live-activity/cap/control";
const APP_TOKEN = Buffer.alloc(32, 0x41).toString("base64url");
const HMAC_KEY = Buffer.alloc(32, 0x42).toString("base64url");
const REPLY_TEXT = "SYNTHETIC_PRIVATE_REPLY_ONLY_IN_MEMORY";

test("wires the hardened seams without a listener or retained task content", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "cla-pre-listener-"));
  const secretRoot = join(stateRoot, "secrets");
  const replayRoot = join(stateRoot, "replay");
  const appTokenPath = join(secretRoot, "app-token");
  const hmacKeyPath = join(secretRoot, "hmac-key");
  await mkdir(secretRoot, { mode: 0o700 });
  await mkdir(replayRoot, { mode: 0o700 });
  await Promise.all([chmod(secretRoot, 0o700), chmod(replayRoot, 0o700)]);
  await writeFile(appTokenPath, APP_TOKEN, { mode: 0o600 });
  await writeFile(hmacKeyPath, HMAC_KEY, { mode: 0o600 });

  let secrets;
  try {
    secrets = await loadRemoteActionSecrets({
      installationId: "installation-iphone-1",
      appTokenPath,
      hmacKeyPath,
      repositoryRoot,
    });
    const replayStore = await createFileRemoteActionReplayStore({
      directoryPath: replayRoot,
      repositoryRoot,
    });
    let randomByte = 0;
    const registry = new OneTaskControlContextRegistry({
      maxLifetimeMs: 120_000,
      now: () => NOW,
      randomBytes: (length) => Buffer.alloc(length, (randomByte += 1)),
    });
    const dispatched = [];
    const publicContext = registry.issue({
      installationId: "installation-iphone-1",
      threadId: "thread-private-owned",
      expectedTurnId: "turn-private-active",
      expiresAtMs: NOW + 120_000,
      dispatch: (action) => {
        dispatched.push(structuredClone(action));
        return {
          schemaVersion: 1,
          actionId: action.actionId,
          action: action.action,
          outcome: "accepted",
          reason: null,
          appServerMethod: "turn/steer",
        };
      },
    });
    const handler = createTailscaleTurnActionRequestHandler({
      expectedCapability: CAPABILITY,
      authorizeAppToken: secrets.authorizeAppToken,
      resolveControlContext: (request) => registry.resolve(request),
      replayStore,
      fingerprintAction: secrets.fingerprintAction,
      now: () => NOW,
    });
    const action = {
      schemaVersion: 1,
      actionId: "remote-reply-integrated-1",
      controlContextId: publicContext.controlContextId,
      issuedAt: "2026-08-22T20:00:00.000Z",
      expiresAt: "2026-08-22T20:01:00.000Z",
      action: "reply",
      text: REPLY_TEXT,
    };
    const request = {
      method: "POST",
      path: REMOTE_TURN_ACTION_PATH,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${APP_TOKEN}`,
        "tailscale-app-capabilities": JSON.stringify({
          [CAPABILITY]: [{ source: ["self"] }],
        }),
      },
      body: JSON.stringify(action),
    };

    const first = await handler(request);
    const retry = await handler(request);
    assert.equal(first.statusCode, 200);
    assert.deepEqual(JSON.parse(retry.body), JSON.parse(first.body));
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].text, REPLY_TEXT);

    registry.revokeAll();
    const restartedStore = await createFileRemoteActionReplayStore({
      directoryPath: replayRoot,
      repositoryRoot,
    });
    const restartedHandler = createTailscaleTurnActionRequestHandler({
      expectedCapability: CAPABILITY,
      authorizeAppToken: secrets.authorizeAppToken,
      resolveControlContext: () => null,
      replayStore: restartedStore,
      fingerprintAction: secrets.fingerprintAction,
      now: () => NOW,
    });
    const restartRetry = await restartedHandler(request);
    assert.deepEqual(JSON.parse(restartRetry.body), JSON.parse(first.body));
    assert.equal(dispatched.length, 1);

    const replayFiles = await readdir(replayRoot);
    assert.equal(replayFiles.length, 1);
    const retained = await readFile(join(replayRoot, replayFiles[0]), "utf8");
    assert.doesNotMatch(
      retained,
      new RegExp(
        `${REPLY_TEXT}|${APP_TOKEN}|${HMAC_KEY}|controlContext|thread-private|turn-private`,
        "u",
      ),
    );
  } finally {
    secrets?.dispose();
    await rm(stateRoot, { recursive: true, force: true });
  }
});
