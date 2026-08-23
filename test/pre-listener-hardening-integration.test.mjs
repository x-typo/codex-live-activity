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
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFileRemoteActionReplayStore } from "../src/file-remote-action-replay-store.mjs";
import {
  LOCALHOST_TURN_ACTION_HOST,
  createLocalhostTurnActionListener,
} from "../src/localhost-turn-action-listener.mjs";
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

function sendLoopbackRequest(port, request) {
  const body = Buffer.from(request.body);
  return new Promise((resolve, reject) => {
    const clientRequest = httpRequest(
      {
        agent: false,
        host: LOCALHOST_TURN_ACTION_HOST,
        port,
        method: request.method,
        path: request.path,
        headers: {
          ...request.headers,
          "content-length": body.byteLength,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    clientRequest.on("error", reject);
    clientRequest.end(body);
  });
}

test("wires the hardened seams through literal localhost without retained task content", async () => {
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
  const listeners = [];
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
          [CAPABILITY]: [{}],
        }),
      },
      body: JSON.stringify(action),
    };

    const listener = createLocalhostTurnActionListener({
      handleRequest: handler,
      revokeControlContexts: () => registry.revokeAll(),
    });
    listeners.push(listener);
    const address = await listener.start();
    assert.equal(address.host, "127.0.0.1");

    const first = await sendLoopbackRequest(address.port, request);
    const retry = await sendLoopbackRequest(address.port, request);
    const expectedReceipt = JSON.stringify({
      schemaVersion: 1,
      actionId: action.actionId,
      action: action.action,
      outcome: "accepted",
      reason: null,
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.body, expectedReceipt);
    assert.equal(retry.body, expectedReceipt);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].text, REPLY_TEXT);

    const missingCapability = structuredClone(request);
    delete missingCapability.headers["tailscale-app-capabilities"];
    const denied = await sendLoopbackRequest(address.port, missingCapability);
    assert.equal(denied.statusCode, 401);
    assert.equal(dispatched.length, 1);

    await listener.close();
    assert.equal(listener.listening, false);
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
    const restartedListener = createLocalhostTurnActionListener({
      handleRequest: restartedHandler,
      revokeControlContexts: () => registry.revokeAll(),
    });
    listeners.push(restartedListener);
    const restartedAddress = await restartedListener.start();
    const restartRetry = await sendLoopbackRequest(
      restartedAddress.port,
      request,
    );
    assert.equal(restartRetry.body, expectedReceipt);
    assert.equal(dispatched.length, 1);
    await restartedListener.close();

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
    await Promise.allSettled(listeners.map((listener) => listener.close()));
    secrets?.dispose();
    await rm(stateRoot, { recursive: true, force: true });
  }
});
