import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMacLocalTurnActionComposition } from "../src/mac-local-turn-action-composition.mjs";
import { LOCALHOST_TURN_ACTION_HOST } from "../src/localhost-turn-action-listener.mjs";
import { REMOTE_TURN_ACTION_PATH } from "../src/tailscale-turn-action-ingress.mjs";

const NOW = Date.parse("2026-08-22T20:00:30.000Z");
const CAPABILITY = "github.com/x-typo/codex-live-activity/cap/control";
const APP_TOKEN = Buffer.alloc(32, 0x51).toString("base64url");
const HMAC_KEY = Buffer.alloc(32, 0x52).toString("base64url");
const REPOSITORY_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");

function sendAction(port, action) {
  const body = Buffer.from(JSON.stringify(action));
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        agent: false,
        host: LOCALHOST_TURN_ACTION_HOST,
        port,
        method: "POST",
        path: REMOTE_TURN_ACTION_PATH,
        headers: {
          authorization: `Bearer ${APP_TOKEN}`,
          "content-length": body.byteLength,
          "content-type": "application/json",
          "tailscale-app-capabilities": JSON.stringify({
            [CAPABILITY]: [{}],
          }),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            statusCode: response.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

test("composes one active turn through the hardened loopback path", async () => {
  const root = await mkdtemp(join(tmpdir(), "cla-mac-local-composition."));
  const secretsDirectory = join(root, "secrets");
  const replayDirectoryPath = join(root, "replay");
  const appTokenPath = join(secretsDirectory, "app-token");
  const hmacKeyPath = join(secretsDirectory, "hmac-key");
  await chmod(root, 0o700);
  await Promise.all([
    mkdir(secretsDirectory, { mode: 0o700 }),
    mkdir(replayDirectoryPath, { mode: 0o700 }),
  ]);
  await Promise.all([
    chmod(secretsDirectory, 0o700),
    chmod(replayDirectoryPath, 0o700),
  ]);
  await Promise.all([
    writeFile(appTokenPath, APP_TOKEN, { mode: 0o600 }),
    writeFile(hmacKeyPath, HMAC_KEY, { mode: 0o600 }),
  ]);

  let composition;
  try {
    composition = await createMacLocalTurnActionComposition({
      installationId: "installation-local-test",
      expectedCapability: CAPABILITY,
      appTokenPath,
      hmacKeyPath,
      replayDirectoryPath,
      repositoryRoot: REPOSITORY_ROOT,
      now: () => NOW,
      randomBytes: (length) => Buffer.alloc(length, 0x61),
    });
    assert.equal(composition.listening, false);
    assert.throws(
      () =>
        composition.activate({
          threadId: "thread-private",
          expectedTurnId: "turn-private",
          dispatch: () => {},
        }),
      /listener is not active/,
    );

    const address = await composition.start();
    assert.equal(address.host, LOCALHOST_TURN_ACTION_HOST);
    assert.equal(composition.listening, true);
    const dispatched = [];
    const publicContext = composition.activate({
      threadId: "thread-private",
      expectedTurnId: "turn-private",
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
    assert.throws(
      () =>
        composition.activate({
          threadId: "thread-private",
          expectedTurnId: "turn-private",
          dispatch: () => {},
        }),
      /already owns an active turn/,
    );

    const action = {
      schemaVersion: 1,
      actionId: "local-composition-reply-1",
      controlContextId: publicContext.controlContextId,
      issuedAt: "2026-08-22T20:00:00.000Z",
      expiresAt: "2026-08-22T20:01:00.000Z",
      action: "reply",
      text: "SENSITIVE_COMPOSITION_REPLY",
    };
    const accepted = await sendAction(address.port, action);
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(JSON.parse(accepted.body), {
      schemaVersion: 1,
      actionId: action.actionId,
      action: "reply",
      outcome: "accepted",
      reason: null,
    });
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].threadId, "thread-private");
    assert.equal(dispatched[0].expectedTurnId, "turn-private");
    assert.equal(dispatched[0].text, "SENSITIVE_COMPOSITION_REPLY");

    assert.equal(
      composition.revokeTurn({
        threadId: "thread-private",
        expectedTurnId: "turn-private",
      }),
      true,
    );
    const afterRevoke = await sendAction(address.port, {
      ...action,
      actionId: "local-composition-reply-2",
    });
    assert.equal(afterRevoke.statusCode, 409);
    assert.equal(dispatched.length, 1);

    await composition.close();
    await composition.close();
    assert.equal(composition.listening, false);
    assert.equal((await readdir(replayDirectoryPath)).length, 1);
  } finally {
    await composition?.close();
    await rm(root, { recursive: true, force: true });
  }
});
