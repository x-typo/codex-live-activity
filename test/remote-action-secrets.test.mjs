import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  REMOTE_ACTION_SECRET_BYTES,
  loadRemoteActionSecrets,
} from "../src/remote-action-secrets.mjs";

const repositoryRoot = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");
const APP_TOKEN = Buffer.alloc(REMOTE_ACTION_SECRET_BYTES, 0x31).toString("base64url");
const OTHER_TOKEN = Buffer.alloc(REMOTE_ACTION_SECRET_BYTES, 0x32).toString("base64url");
const HMAC_KEY = Buffer.alloc(REMOTE_ACTION_SECRET_BYTES, 0x33).toString("base64url");

async function secretFixture() {
  const directoryPath = await mkdtemp(join(tmpdir(), "cla-remote-secrets-"));
  const appTokenPath = join(directoryPath, "app-token");
  const hmacKeyPath = join(directoryPath, "hmac-key");
  await writeFile(appTokenPath, APP_TOKEN, { mode: 0o600 });
  await writeFile(hmacKeyPath, HMAC_KEY, { mode: 0o600 });
  return { directoryPath, appTokenPath, hmacKeyPath };
}

test("loads synthetic owner-private secrets and exposes only verifier functions", async () => {
  const fixture = await secretFixture();
  try {
    const secrets = await loadRemoteActionSecrets({
      installationId: "installation-iphone-1",
      appTokenPath: fixture.appTokenPath,
      hmacKeyPath: fixture.hmacKeyPath,
      repositoryRoot,
    });

    assert.deepEqual(Object.keys(secrets).sort(), [
      "authorizeAppToken",
      "dispose",
      "fingerprintAction",
    ]);
    assert.equal(secrets.authorizeAppToken(APP_TOKEN), "installation-iphone-1");
    assert.equal(secrets.authorizeAppToken(OTHER_TOKEN), null);
    assert.equal(secrets.authorizeAppToken("not-a-canonical-token"), null);
    assert.match(
      secrets.fingerprintAction({ action: "reply", text: "SYNTHETIC_PRIVATE_TEXT" }),
      /^[a-f0-9]{64}$/u,
    );
    assert.doesNotMatch(JSON.stringify(secrets), /installation|SYNTHETIC_PRIVATE_TEXT/u);

    secrets.dispose();
    assert.equal(secrets.authorizeAppToken(APP_TOKEN), null);
    assert.throws(
      () => secrets.fingerprintAction({ action: "stop" }),
      /unavailable/u,
    );
  } finally {
    await rm(fixture.directoryPath, { recursive: true, force: true });
  }
});

test("rejects malformed, loose, linked, or aliased secret files without disclosure", async () => {
  const fixture = await secretFixture();
  const secretMarker = "SYNTHETIC_SECRET_MUST_NOT_APPEAR";
  try {
    const assertInvalid = async (overrides = {}) => {
      await assert.rejects(
        loadRemoteActionSecrets({
          installationId: "installation-iphone-1",
          appTokenPath: fixture.appTokenPath,
          hmacKeyPath: fixture.hmacKeyPath,
          repositoryRoot,
          ...overrides,
        }),
        (error) => {
          assert.equal(error.message, "remote action secret configuration is invalid");
          assert.doesNotMatch(error.message, new RegExp(secretMarker, "u"));
          assert.doesNotMatch(error.message, /cla-remote-secrets/u);
          return true;
        },
      );
    };

    await writeFile(fixture.appTokenPath, secretMarker, { mode: 0o600 });
    await assertInvalid();
    await writeFile(fixture.appTokenPath, APP_TOKEN, { mode: 0o600 });

    await chmod(fixture.appTokenPath, 0o644);
    await assertInvalid();
    await chmod(fixture.appTokenPath, 0o600);

    const symbolicPath = join(fixture.directoryPath, "symbolic-token");
    await symlink(fixture.appTokenPath, symbolicPath);
    await assertInvalid({ appTokenPath: symbolicPath });

    const hardlinkPath = join(fixture.directoryPath, "hardlink-token");
    await link(fixture.appTokenPath, hardlinkPath);
    await assertInvalid();
    await rm(hardlinkPath);

    await assertInvalid({
      hmacKeyPath: `${fixture.directoryPath}/./app-token`,
    });
    await writeFile(fixture.hmacKeyPath, Buffer.alloc(31).toString("base64url"), {
      mode: 0o600,
    });
    await assertInvalid();
    await writeFile(fixture.hmacKeyPath, APP_TOKEN, { mode: 0o600 });
    await assertInvalid();
  } finally {
    await rm(fixture.directoryPath, { recursive: true, force: true });
  }
});

test("rejects owner-private-looking secrets stored inside the repository", async () => {
  const insideDirectory = await mkdtemp(join(repositoryRoot, ".remote-secret-test-"));
  const appTokenPath = join(insideDirectory, "app-token");
  const hmacKeyPath = join(insideDirectory, "hmac-key");
  try {
    await writeFile(appTokenPath, APP_TOKEN, { mode: 0o600 });
    await writeFile(hmacKeyPath, HMAC_KEY, { mode: 0o600 });
    await assert.rejects(
      loadRemoteActionSecrets({
        installationId: "installation-iphone-1",
        appTokenPath,
        hmacKeyPath,
        repositoryRoot,
      }),
      /invalid/u,
    );
  } finally {
    await rm(insideDirectory, { recursive: true, force: true });
  }
});
