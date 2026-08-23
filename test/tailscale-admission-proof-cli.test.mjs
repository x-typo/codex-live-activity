import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(
  new URL("../bin/codex-tailscale-admission-proof.mjs", import.meta.url),
);
const CAPABILITY = "example.test/cap/admission-proof";
const APP_TOKEN = Buffer.alloc(32, 0x71).toString("base64url");
const HMAC_KEY = Buffer.alloc(32, 0x72).toString("base64url");

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "cla-admission-proof."));
  const secretsRoot = join(root, "SENSITIVE_SECRET_PATH");
  const replayRoot = join(root, "replay");
  const appTokenPath = join(secretsRoot, "app-token");
  const hmacKeyPath = join(secretsRoot, "hmac-key");
  await chmod(root, 0o700);
  await Promise.all([
    mkdir(secretsRoot, { mode: 0o700 }),
    mkdir(replayRoot, { mode: 0o700 }),
  ]);
  await Promise.all([chmod(secretsRoot, 0o700), chmod(replayRoot, 0o700)]);
  await Promise.all([
    writeFile(appTokenPath, APP_TOKEN, { mode: 0o600 }),
    writeFile(hmacKeyPath, HMAC_KEY, { mode: 0o600 }),
  ]);
  await Promise.all([chmod(appTokenPath, 0o600), chmod(hmacKeyPath, 0o600)]);
  return { root, replayRoot, appTokenPath, hmacKeyPath };
}

function collectJsonLines(stream) {
  const values = [];
  const waiters = [];
  let pending = "";
  const deliver = (value) => {
    values.push(value);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(value)) continue;
      clearTimeout(waiter.timeout);
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(value);
    }
  };
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    while (pending.includes("\n")) {
      const newline = pending.indexOf("\n");
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.length > 0) deliver(JSON.parse(line));
    }
  });
  return {
    values,
    waitFor(predicate, timeoutMs = 5_000) {
      const existing = values.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timeout: null };
        waiter.timeout = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error("timed out waiting for proof artifact"));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

function collectChild(child) {
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const result = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr }));
  });
  return { result, readStderr: () => stderr };
}

async function startProof(fixture, { timeoutMs = 5_000 } = {}) {
  const port = await unusedPort();
  const expectedAuthority = `proof.test:${port}`;
  const child = spawn(
    process.execPath,
    [
      CLI_PATH,
      "--port",
      String(port),
      "--expected-authority",
      expectedAuthority,
      "--capability",
      CAPABILITY,
      "--app-token-file",
      fixture.appTokenPath,
      "--hmac-key-file",
      fixture.hmacKeyPath,
      "--replay-root",
      fixture.replayRoot,
      "--timeout-ms",
      String(timeoutMs),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const artifacts = collectJsonLines(child.stdout);
  const collected = collectChild(child);
  const ready = await artifacts.waitFor((value) => value.state === "ready");
  return { child, artifacts, collected, expectedAuthority, port, ready };
}

function sendAction({ port, expectedAuthority, action }) {
  const body = Buffer.from(JSON.stringify(action));
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        agent: false,
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/v1/turn-actions",
        headers: {
          authorization: `Bearer ${APP_TOKEN}`,
          host: expectedAuthority,
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
    request.setTimeout(2_000, () => request.destroy(new Error("request timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

function assertPortClosed(port) {
  return new Promise((resolve, reject) => {
    const socket = createServer().listen(port, "127.0.0.1");
    socket.once("error", reject);
    socket.once("listening", () =>
      socket.close((error) => (error ? reject(error) : resolve())),
    );
  });
}

test("prints a redacted artifact and dispatches once across an identical durable retry", async () => {
  const fixture = await createFixture();
  try {
    const proof = await startProof(fixture);
    const { ready } = proof;
    assert.deepEqual(Object.keys(ready).sort(), [
      "capability",
      "controlContextId",
      "expectedAuthority",
      "expiresAt",
      "listenerPort",
      "request",
      "state",
    ]);
    assert.equal(ready.listenerPort, proof.port);
    assert.equal(ready.expectedAuthority, proof.expectedAuthority);
    assert.equal(ready.capability, CAPABILITY);
    assert.equal(ready.request.body.action, "stop");
    assert.equal(Object.hasOwn(ready.request.body, "text"), false);
    assert.deepEqual(ready.request.headers, {
      "content-type": "application/json",
    });

    const first = await sendAction({
      port: proof.port,
      expectedAuthority: proof.expectedAuthority,
      action: ready.request.body,
    });
    const retry = await sendAction({
      port: proof.port,
      expectedAuthority: proof.expectedAuthority,
      action: ready.request.body,
    });
    assert.equal(first.statusCode, 409);
    assert.equal(retry.statusCode, 409);
    assert.equal(retry.body, first.body);
    assert.deepEqual(JSON.parse(first.body), {
      schemaVersion: 1,
      actionId: ready.request.body.actionId,
      action: "stop",
      outcome: "rejected",
      reason: "noActiveTurn",
    });

    proof.child.kill("SIGTERM");
    const final = await proof.artifacts.waitFor((value) => value.state === "closed");
    const result = await proof.collected.result;
    assert.deepEqual(final, { state: "closed", dispatchCount: 1 });
    assert.deepEqual(result, { code: 0, signal: null, stderr: "" });
    assert.equal((await readdir(fixture.replayRoot)).length, 1);
    await assertPortClosed(proof.port);

    const output = JSON.stringify(proof.artifacts.values);
    for (const secret of [
      APP_TOKEN,
      HMAC_KEY,
      fixture.appTokenPath,
      fixture.hmacKeyPath,
      fixture.replayRoot,
      "authorization",
    ]) {
      assert.equal(output.includes(secret), false, secret);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("times out, revokes, and closes without a dispatch", async () => {
  const fixture = await createFixture();
  try {
    const proof = await startProof(fixture, { timeoutMs: 150 });
    const final = await proof.artifacts.waitFor((value) => value.state === "failed");
    const result = await proof.collected.result;
    assert.deepEqual(final, { state: "failed", dispatchCount: 0 });
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "admission proof timed out\n");
    assert.deepEqual(await readdir(fixture.replayRoot), []);
    await assertPortClosed(proof.port);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("fails closed on an unexpected authenticated action before dispatch", async () => {
  const fixture = await createFixture();
  try {
    const proof = await startProof(fixture);
    await sendAction({
      port: proof.port,
      expectedAuthority: proof.expectedAuthority,
      action: {
        ...proof.ready.request.body,
        actionId: "unexpected-proof-action",
      },
    }).catch(() => {});
    const final = await proof.artifacts.waitFor((value) => value.state === "failed");
    const result = await proof.collected.result;
    assert.deepEqual(final, { state: "failed", dispatchCount: 0 });
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.equal(
      result.stderr,
      "admission proof did not observe exactly one expected action\n",
    );
    await assertPortClosed(proof.port);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects altered proof timestamps before replay or dispatch", async () => {
  const changes = [
    ["issuedAt", 1],
    ["expiresAt", -1],
  ];

  for (const [field, deltaMs] of changes) {
    const fixture = await createFixture();
    try {
      const proof = await startProof(fixture);
      const changedAction = {
        ...proof.ready.request.body,
        [field]: new Date(
          Date.parse(proof.ready.request.body[field]) + deltaMs,
        ).toISOString(),
      };
      const rejected = await sendAction({
        port: proof.port,
        expectedAuthority: proof.expectedAuthority,
        action: changedAction,
      });
      assert.equal(rejected.statusCode, 400, field);
      assert.deepEqual(JSON.parse(rejected.body), {
        schemaVersion: 1,
        actionId: proof.ready.request.body.actionId,
        action: "stop",
        outcome: "rejected",
        reason: "invalidRequest",
      });
      const final = await proof.artifacts.waitFor(
        (value) => value.state === "failed",
      );
      const result = await proof.collected.result;
      assert.deepEqual(final, { state: "failed", dispatchCount: 0 });
      assert.deepEqual(result, {
        code: 1,
        signal: null,
        stderr: "admission proof did not observe exactly one expected action\n",
      });
      assert.deepEqual(await readdir(fixture.replayRoot), []);
      await assertPortClosed(proof.port);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("bounds silent stdout loss by the configured timeout", async () => {
  const fixture = await createFixture();
  let proof;
  let failSafe;
  try {
    proof = await startProof(fixture, { timeoutMs: 150 });
    proof.child.stdout.destroy();
    failSafe = setTimeout(() => proof.child.kill("SIGKILL"), 2_000);
    const result = await proof.collected.result;
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "admission proof output is unavailable\n");
    assert.deepEqual(await readdir(fixture.replayRoot), []);
    await assertPortClosed(proof.port);
  } finally {
    clearTimeout(failSafe);
    if (proof?.child.exitCode === null) proof.child.kill("SIGKILL");
    await rm(fixture.root, { recursive: true, force: true });
  }
});
