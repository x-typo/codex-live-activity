import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const relayPath = fileURLToPath(
  new URL("../bin/codex-one-task-relay.mjs", import.meta.url),
);
const fakeCodexSource = fileURLToPath(
  new URL("../test-support/fake-codex-app-server.cjs", import.meta.url),
);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const EXTERNAL_STOP_CAPABILITY = "example.test/cap/external-stop";
const EXTERNAL_STOP_APP_TOKEN = Buffer.alloc(32, 0x61).toString("base64url");
const EXTERNAL_STOP_HMAC_KEY = Buffer.alloc(32, 0x62).toString("base64url");
const EXTERNAL_STOP_CONTEXT_PREFIX = "control context: ";

async function relayStateHomes() {
  return (await readdir(tmpdir()))
    .filter((name) => name.startsWith("cla-one-task-relay."))
    .sort();
}

async function loopbackProofHomes() {
  return (await readdir(tmpdir()))
    .filter((name) => name.startsWith("cla-local-action-proof."))
    .sort();
}

async function withFakeCodex(run, { rewriteSource } = {}) {
  const fakeBinaryDirectory = await mkdtemp(join(tmpdir(), "cla-fake-codex."));
  const fakeBinary = join(fakeBinaryDirectory, "codex");
  if (rewriteSource === undefined) {
    await copyFile(fakeCodexSource, fakeBinary);
  } else {
    const source = await readFile(fakeCodexSource, "utf8");
    const rewritten = rewriteSource(source);
    if (typeof rewritten !== "string" || rewritten === source) {
      throw new Error("fake Codex source rewrite did not apply");
    }
    await writeFile(fakeBinary, rewritten);
  }
  await chmod(fakeBinary, 0o755);
  try {
    return await run(fakeBinaryDirectory);
  } finally {
    await rm(fakeBinaryDirectory, { recursive: true, force: true });
  }
}

function waitForOutput(stream, pattern, timeoutMs = 5_000) {
  return new Promise((resolveWait, rejectWait) => {
    let output = "";
    const timeout = setTimeout(() => {
      stream.off("data", onData);
      rejectWait(new Error(`timed out waiting for output matching ${pattern}`));
    }, timeoutMs);
    function onData(chunk) {
      output += chunk;
      if (!pattern.test(output)) return;
      clearTimeout(timeout);
      stream.off("data", onData);
      resolveWait(output);
    }
    stream.on("data", onData);
  });
}

function collectChild(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolveChild, rejectChild) => {
    child.once("error", rejectChild);
    child.once("close", (code, signal) => {
      resolveChild({ code, signal, stdout, stderr });
    });
  });
}

function waitWithin(promise, timeoutMs, message) {
  return new Promise((resolveWait, rejectWait) => {
    const timeout = setTimeout(() => rejectWait(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolveWait(value);
      },
      (error) => {
        clearTimeout(timeout);
        rejectWait(error);
      },
    );
  });
}

async function readFakeLog(path) {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function assertFixtureChildrenStopped(log) {
  const pids = log
    .filter((entry) => entry.kind === "fixture-child-pid")
    .map((entry) => entry.value);
  assert.equal(pids.length, 1);
  for (const pid of pids) {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error?.code === "ESRCH") break;
        throw error;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
}

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

async function createExternalStopFixture() {
  const root = await mkdtemp(join(tmpdir(), "cla-external-stop-test."));
  const secretRoot = join(root, "SENSITIVE_EXTERNAL_SECRET_PATH");
  const replayRoot = join(root, "replay");
  const appTokenPath = join(secretRoot, "app-token");
  const hmacKeyPath = join(secretRoot, "hmac-key");
  await chmod(root, 0o700);
  await Promise.all([
    mkdir(secretRoot, { mode: 0o700 }),
    mkdir(replayRoot, { mode: 0o700 }),
  ]);
  await Promise.all([chmod(secretRoot, 0o700), chmod(replayRoot, 0o700)]);
  await Promise.all([
    writeFile(appTokenPath, EXTERNAL_STOP_APP_TOKEN, { mode: 0o600 }),
    writeFile(hmacKeyPath, EXTERNAL_STOP_HMAC_KEY, { mode: 0o600 }),
  ]);
  await Promise.all([chmod(appTokenPath, 0o600), chmod(hmacKeyPath, 0o600)]);
  return { root, replayRoot, appTokenPath, hmacKeyPath };
}

function externalStopArguments(
  fixture,
  port,
  expectedAuthority,
  timeoutMs = 5_000,
) {
  return [
    relayPath,
    "--cwd",
    repositoryRoot,
    "--external-stop-proof",
    "--action-port",
    String(port),
    "--action-expected-authority",
    expectedAuthority,
    "--action-capability",
    EXTERNAL_STOP_CAPABILITY,
    "--action-app-token-file",
    fixture.appTokenPath,
    "--action-hmac-key-file",
    fixture.hmacKeyPath,
    "--action-replay-root",
    fixture.replayRoot,
    "--action-timeout-ms",
    String(timeoutMs),
  ];
}

function parseExternalStopContext(output) {
  const lines = output.trim().split("\n");
  const line = lines.find((candidate) =>
    candidate.startsWith(EXTERNAL_STOP_CONTEXT_PREFIX),
  );
  assert.ok(line, output);
  return JSON.parse(line.slice(EXTERNAL_STOP_CONTEXT_PREFIX.length));
}

function externalStopContexts(output) {
  return output
    .trim()
    .split("\n")
    .filter((line) => line.startsWith(EXTERNAL_STOP_CONTEXT_PREFIX))
    .map((line) => JSON.parse(line.slice(EXTERNAL_STOP_CONTEXT_PREFIX.length)));
}

function assertExternalStopOutputRedacted(result, fixture) {
  const publicOutput = `${result.stdout}${result.stderr}`;
  for (const marker of [
    "SENSITIVE",
    EXTERNAL_STOP_APP_TOKEN,
    EXTERNAL_STOP_HMAC_KEY,
    fixture.appTokenPath,
    fixture.hmacKeyPath,
    fixture.replayRoot,
    "thread-fake",
    "turn-fake",
    "external-command-fake",
  ]) {
    assert.equal(publicOutput.includes(marker), false, marker);
  }
}

function sendExternalAction({ port, expectedAuthority, action }) {
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
          authorization: `Bearer ${EXTERNAL_STOP_APP_TOKEN}`,
          host: expectedAuthority,
          "content-length": body.byteLength,
          "content-type": "application/json",
          "tailscale-app-capabilities": JSON.stringify({
            [EXTERNAL_STOP_CAPABILITY]: [{}],
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
    request.setTimeout(2_000, () =>
      request.destroy(new Error("external action request timed out")),
    );
    request.on("error", reject);
    request.end(body);
  });
}

function externalStopAction(context, actionId) {
  const issuedAtMs = Date.now();
  const expiresAtMs = Math.min(
    issuedAtMs + 60_000,
    Date.parse(context.expiresAt),
  );
  return {
    schemaVersion: 1,
    actionId,
    controlContextId: context.controlContextId,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    action: "stop",
  };
}

async function waitForFakeMethod(path, method, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const log = await readFakeLog(path);
      if (log.some((entry) => entry.kind === "method" && entry.value === method)) {
        return;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for fake Codex method ${method}`);
}

function assertPortClosed(port) {
  return new Promise((resolve, reject) => {
    const server = createServer().listen(port, "127.0.0.1");
    server.once("error", reject);
    server.once("listening", () =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
}

test("CLI owns one fake App Server task and emits only dry-run APNs JSONL", async () => {
  const before = await relayStateHomes();
  const { log, result } = await withFakeCodex(async (fakeBinaryDirectory) => {
    const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
    const result = spawnSync(process.execPath, [relayPath, "--cwd", repositoryRoot], {
      input: "SENSITIVE_CLI_TASK_INPUT",
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CODEX_LOG_PATH: logPath,
        CODEX_ACCESS_TOKEN: "SENSITIVE_SYNTHETIC_CODEX_ACCESS_TOKEN",
        OPENAI_API_KEY: "SENSITIVE_SYNTHETIC_API_KEY",
        PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
      },
    });
    return { log: await readFakeLog(logPath), result };
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const invocations = log.filter((entry) => entry.kind === "argv");
  assert.equal(invocations.length, 2);
  assert.equal(
    invocations.some(
      (entry) => entry.values.includes("mcp") && entry.values.includes("list"),
    ),
    true,
  );
  const appServerInvocation = invocations.find((entry) =>
    entry.values.includes("app-server"),
  );
  assert.ok(appServerInvocation);
  assert.equal(
    appServerInvocation.values.includes(
      "mcp_servers.SENSITIVE_MCP_SERVER-with-dash.enabled=false",
    ),
    true,
  );
  for (const feature of ["apps", "hooks", "plugins"]) {
    assert.equal(appServerInvocation.values.includes(feature), true, feature);
  }
  assert.equal(
    invocations.every((entry) => entry.hasOpenAiApiKey === false),
    true,
  );
  assert.equal(
    invocations.every((entry) => entry.hasCodexAccessToken === false),
    true,
  );
  assert.deepEqual(
    log.filter((entry) => entry.kind === "method").map((entry) => entry.value),
    [
      "initialize",
      "initialized",
      "thread/start",
      "mcpServerStatus/list",
      "turn/start",
    ],
  );
  const payloads = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    payloads.map((payload) => payload.aps["content-state"].status),
    ["Working", "Working", "Working", "Ready"],
  );
  assert.deepEqual(
    payloads.map((payload) => payload.aps["content-state"].sequence),
    [1, 2, 3, 4],
  );
  const encoded = JSON.stringify(payloads);
  for (const marker of [
    "SENSITIVE_CLI_TASK_INPUT",
    "SENSITIVE_FAKE_NAME",
    "SENSITIVE_FAKE_PREVIEW",
    "SENSITIVE_FAKE_RESPONSE_PREVIEW",
    "SENSITIVE_FAKE_PROMPT",
    "SENSITIVE_FAKE_ASSISTANT_OUTPUT",
    "SENSITIVE_MCP_SERVER-with-dash",
    "thread-fake",
    "turn-fake",
  ]) {
    assert.equal(encoded.includes(marker), false, marker);
  }
  assert.deepEqual(await relayStateHomes(), before);
});

test("CLI composes synthetic loopback Reply and Stop into one owned task", async () => {
  const stateBefore = await relayStateHomes();
  const proofBefore = await loopbackProofHomes();
  const { log, result } = await withFakeCodex(async (fakeBinaryDirectory) => {
    const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
    const result = spawnSync(
      process.execPath,
      [relayPath, "--cwd", repositoryRoot, "--loopback-action-proof"],
      {
        input: "SENSITIVE_LOOPBACK_TASK_INPUT",
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          FAKE_CODEX_LOG_PATH: logPath,
          FAKE_CODEX_MODE: "loopback-action-proof",
          PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
        },
      },
    );
    return { log: await readFakeLog(logPath), result };
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stderr,
    [
      "loopback proof: Reply accepted",
      "loopback proof: Stop accepted",
      "loopback proof: interrupted lifecycle confirmed",
      "",
    ].join("\n"),
  );
  const methods = log
    .filter((entry) => entry.kind === "method")
    .map((entry) => entry.value);
  assert.equal(methods.filter((method) => method === "thread/start").length, 1);
  assert.equal(methods.filter((method) => method === "turn/start").length, 1);
  assert.deepEqual(methods.slice(-2), ["turn/steer", "turn/interrupt"]);
  assert.deepEqual(
    log
      .filter((entry) => entry.kind === "action-validation")
      .map((entry) => ({ method: entry.method, valid: entry.valid })),
    [
      { method: "turn/steer", valid: true },
      { method: "turn/interrupt", valid: true },
    ],
  );
  const payloads = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(payloads[0].aps["content-state"].status, "Working");
  assert.equal(payloads.at(-1).aps["content-state"].status, "Blocked");
  for (const marker of [
    "SENSITIVE_LOOPBACK_TASK_INPUT",
    "Continue the bounded local proof.",
    "thread-fake",
    "turn-fake",
    "local-proof-reply-1",
    "local-proof-stop-1",
  ]) {
    assert.equal(`${result.stdout}${result.stderr}`.includes(marker), false, marker);
  }
  assert.deepEqual(await relayStateHomes(), stateBefore);
  assert.deepEqual(await loopbackProofHomes(), proofBefore);
});

test("CLI proves one model-owned command remains active before interrupting it", async () => {
  const stateBefore = await relayStateHomes();
  const { log, result } = await withFakeCodex(async (fakeBinaryDirectory) => {
    const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
    const result = spawnSync(
      process.execPath,
      [
        relayPath,
        "--cwd",
        repositoryRoot,
        "--local-long-task-proof",
        "--local-long-task-observation-ms",
        "1000",
      ],
      {
        input: "SENSITIVE_LOCAL_LONG_TASK_INPUT",
        encoding: "utf8",
        timeout: 5_000,
        env: {
          ...process.env,
          FAKE_CODEX_LOG_PATH: logPath,
          FAKE_CODEX_MODE: "local-long-task-proof",
          PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
        },
      },
    );
    return { log: await readFakeLog(logPath), result };
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stderr,
    [
      "local long-task proof: observation window confirmed",
      "local long-task proof: interrupted lifecycle confirmed",
      "",
    ].join("\n"),
  );
  const methods = log
    .filter((entry) => entry.kind === "method")
    .map((entry) => entry.value);
  assert.equal(methods.filter((method) => method === "turn/start").length, 1);
  assert.equal(methods.filter((method) => method === "turn/interrupt").length, 1);
  assert.deepEqual(
    log
      .filter((entry) => entry.kind === "action-validation")
      .map((entry) => ({ method: entry.method, valid: entry.valid })),
    [{ method: "turn/interrupt", valid: true }],
  );
  const payloads = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(payloads[0].aps["content-state"].status, "Working");
  assert.equal(payloads.at(-1).aps["content-state"].status, "Blocked");
  for (const marker of [
    "SENSITIVE_LOCAL_LONG_TASK_INPUT",
    "SENSITIVE_FAKE_COMMAND",
    "SENSITIVE_FAKE_CWD",
    "command-fake",
    "thread-fake",
    "turn-fake",
    "local-long-task-stop",
  ]) {
    assert.equal(`${result.stdout}${result.stderr}`.includes(marker), false, marker);
  }
  await assertFixtureChildrenStopped(log);
  assert.deepEqual(await relayStateHomes(), stateBefore);
});

test("CLI retains one privacy-projected command start until turn correlation", async () => {
  const stateBefore = await relayStateHomes();
  const { log, result } = await withFakeCodex(async (fakeBinaryDirectory) => {
    const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
    const result = spawnSync(
      process.execPath,
      [
        relayPath,
        "--cwd",
        repositoryRoot,
        "--local-long-task-proof",
        "--local-long-task-observation-ms",
        "1000",
      ],
      {
        input: "SENSITIVE_LOCAL_EARLY_TASK_INPUT",
        encoding: "utf8",
        timeout: 5_000,
        env: {
          ...process.env,
          FAKE_CODEX_LOG_PATH: logPath,
          FAKE_CODEX_MODE: "local-long-task-proof-early-item",
          PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
        },
      },
    );
    return { log: await readFakeLog(logPath), result };
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stderr,
    [
      "local long-task proof: observation window confirmed",
      "local long-task proof: interrupted lifecycle confirmed",
      "",
    ].join("\n"),
  );
  assert.equal(
    log.filter(
      (entry) =>
        entry.kind === "method" && entry.value === "turn/interrupt",
    ).length,
    1,
  );
  assert.equal(`${result.stdout}${result.stderr}`.includes("SENSITIVE"), false);
  await assertFixtureChildrenStopped(log);
  assert.deepEqual(await relayStateHomes(), stateBefore);
});

test("CLI rejects a second distinct command start before turn correlation", async () => {
  const stateBefore = await relayStateHomes();
  const { log, result } = await withFakeCodex(async (fakeBinaryDirectory) => {
    const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
    const result = spawnSync(
      process.execPath,
      [relayPath, "--cwd", repositoryRoot, "--local-long-task-proof"],
      {
        input: "SENSITIVE_LOCAL_SECOND_EARLY_TASK_INPUT",
        encoding: "utf8",
        timeout: 5_000,
        env: {
          ...process.env,
          FAKE_CODEX_LOG_PATH: logPath,
          FAKE_CODEX_MODE: "local-long-task-proof-second-early-item",
          PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
        },
      },
    );
    return { log: await readFakeLog(logPath), result };
  });

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "App Server emitted too many early command start notifications\n",
  );
  assert.equal(`${result.stdout}${result.stderr}`.includes("SENSITIVE"), false);
  assert.equal(
    log.some(
      (entry) => entry.kind === "method" && entry.value === "turn/interrupt",
    ),
    false,
  );
  await assertFixtureChildrenStopped(log);
  assert.deepEqual(await relayStateHomes(), stateBefore);
});

test("CLI fails when the observed model-owned command ends too early", async () => {
  const stateBefore = await relayStateHomes();
  const { log, result } = await withFakeCodex(async (fakeBinaryDirectory) => {
    const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
    const result = spawnSync(
      process.execPath,
      [
        relayPath,
        "--cwd",
        repositoryRoot,
        "--local-long-task-proof",
        "--local-long-task-observation-ms",
        "1000",
      ],
      {
        input: "SENSITIVE_LOCAL_SHORT_TASK_INPUT",
        encoding: "utf8",
        timeout: 5_000,
        env: {
          ...process.env,
          FAKE_CODEX_LOG_PATH: logPath,
          FAKE_CODEX_MODE: "local-long-task-proof-short",
          PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
        },
      },
    );
    return { log: await readFakeLog(logPath), result };
  });

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "local long-task proof command ended before the observation window\n",
  );
  assert.equal(result.stdout.includes("SENSITIVE"), false);
  assert.equal(result.stderr.includes("SENSITIVE"), false);
  assert.equal(
    log.some(
      (entry) => entry.kind === "method" && entry.value === "turn/interrupt",
    ),
    false,
  );
  await assertFixtureChildrenStopped(log);
  assert.deepEqual(await relayStateHomes(), stateBefore);
});

test("CLI fails on a malformed same-item completion before interrupt", async () => {
  const stateBefore = await relayStateHomes();
  const { log, result } = await withFakeCodex(async (fakeBinaryDirectory) => {
    const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
    const result = spawnSync(
      process.execPath,
      [
        relayPath,
        "--cwd",
        repositoryRoot,
        "--local-long-task-proof",
        "--local-long-task-observation-ms",
        "1000",
      ],
      {
        input: "SENSITIVE_LOCAL_MALFORMED_COMPLETION_INPUT",
        encoding: "utf8",
        timeout: 5_000,
        env: {
          ...process.env,
          FAKE_CODEX_LOG_PATH: logPath,
          FAKE_CODEX_MODE: "local-long-task-proof-malformed-completion",
          PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
        },
      },
    );
    return { log: await readFakeLog(logPath), result };
  });

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "local long-task proof command ended before the observation window\n",
  );
  assert.equal(`${result.stdout}${result.stderr}`.includes("SENSITIVE"), false);
  assert.equal(
    log.some(
      (entry) => entry.kind === "method" && entry.value === "turn/interrupt",
    ),
    false,
  );
  await assertFixtureChildrenStopped(log);
  assert.deepEqual(await relayStateHomes(), stateBefore);
});

test("CLI fails when a buffered command completes before turn correlation", async () => {
  const stateBefore = await relayStateHomes();
  const { log, result } = await withFakeCodex(async (fakeBinaryDirectory) => {
    const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
    const result = spawnSync(
      process.execPath,
      [
        relayPath,
        "--cwd",
        repositoryRoot,
        "--local-long-task-proof",
        "--local-long-task-observation-ms",
        "1000",
      ],
      {
        input: "SENSITIVE_LOCAL_EARLY_COMPLETION_INPUT",
        encoding: "utf8",
        timeout: 5_000,
        env: {
          ...process.env,
          FAKE_CODEX_LOG_PATH: logPath,
          FAKE_CODEX_MODE: "local-long-task-proof-early-completion",
          PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
        },
      },
    );
    return { log: await readFakeLog(logPath), result };
  });

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "local long-task proof command ended before the observation window\n",
  );
  assert.equal(`${result.stdout}${result.stderr}`.includes("SENSITIVE"), false);
  assert.equal(
    log.some(
      (entry) => entry.kind === "method" && entry.value === "turn/interrupt",
    ),
    false,
  );
  await assertFixtureChildrenStopped(log);
  assert.deepEqual(await relayStateHomes(), stateBefore);
});

test("CLI rejects interrupted lifecycle before local Stop acceptance", async () => {
  const stateBefore = await relayStateHomes();
  const { log, result } = await withFakeCodex(async (fakeBinaryDirectory) => {
    const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
    const result = spawnSync(
      process.execPath,
      [
        relayPath,
        "--cwd",
        repositoryRoot,
        "--local-long-task-proof",
        "--local-long-task-observation-ms",
        "1000",
      ],
      {
        input: "SENSITIVE_LOCAL_EARLY_INTERRUPTED_INPUT",
        encoding: "utf8",
        timeout: 5_000,
        env: {
          ...process.env,
          FAKE_CODEX_LOG_PATH: logPath,
          FAKE_CODEX_MODE: "local-long-task-proof-early-interrupted",
          PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
        },
      },
    );
    return { log: await readFakeLog(logPath), result };
  });

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "local long-task lifecycle preceded App Server acceptance\n",
  );
  assert.equal(`${result.stdout}${result.stderr}`.includes("SENSITIVE"), false);
  assert.equal(
    log.some(
      (entry) => entry.kind === "method" && entry.value === "turn/interrupt",
    ),
    false,
  );
  await assertFixtureChildrenStopped(log);
  assert.deepEqual(await relayStateHomes(), stateBefore);
});

test("CLI rejects interrupted lifecycle before the local Stop response", async () => {
  const stateBefore = await relayStateHomes();
  const { log, result } = await withFakeCodex(async (fakeBinaryDirectory) => {
    const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
    const result = spawnSync(
      process.execPath,
      [
        relayPath,
        "--cwd",
        repositoryRoot,
        "--local-long-task-proof",
        "--local-long-task-observation-ms",
        "1000",
      ],
      {
        input: "SENSITIVE_LOCAL_TERMINAL_BEFORE_RESPONSE_INPUT",
        encoding: "utf8",
        timeout: 5_000,
        env: {
          ...process.env,
          FAKE_CODEX_LOG_PATH: logPath,
          FAKE_CODEX_MODE: "local-long-task-proof-terminal-before-response",
          PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
        },
      },
    );
    return { log: await readFakeLog(logPath), result };
  });

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    [
      "local long-task proof: observation window confirmed",
      "local long-task lifecycle preceded App Server acceptance",
      "",
    ].join("\n"),
  );
  assert.equal(`${result.stdout}${result.stderr}`.includes("SENSITIVE"), false);
  assert.equal(
    log.filter(
      (entry) =>
        entry.kind === "method" && entry.value === "turn/interrupt",
    ).length,
    1,
  );
  await assertFixtureChildrenStopped(log);
  assert.deepEqual(await relayStateHomes(), stateBefore);
});

test("CLI rejects a user-shell command as local model-owned readiness", async () => {
  const stateBefore = await relayStateHomes();
  const { log, result } = await withFakeCodex(async (fakeBinaryDirectory) => {
    const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
    const result = spawnSync(
      process.execPath,
      [relayPath, "--cwd", repositoryRoot, "--local-long-task-proof"],
      {
        input: "SENSITIVE_LOCAL_USER_SHELL_INPUT",
        encoding: "utf8",
        timeout: 5_000,
        env: {
          ...process.env,
          FAKE_CODEX_LOG_PATH: logPath,
          FAKE_CODEX_MODE: "local-long-task-proof-wrong-source",
          PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
        },
      },
    );
    return { log: await readFakeLog(logPath), result };
  });

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "task ended before local long-task proof activation\n",
  );
  assert.equal(result.stdout.includes("SENSITIVE"), false);
  assert.equal(result.stderr.includes("SENSITIVE"), false);
  assert.equal(
    log.some(
      (entry) => entry.kind === "method" && entry.value === "turn/interrupt",
    ),
    false,
  );
  await assertFixtureChildrenStopped(log);
  assert.deepEqual(await relayStateHomes(), stateBefore);
});

test("CLI accepts one external Stop only after its interrupted lifecycle", async () => {
  const stateBefore = await relayStateHomes();
  const fixture = await createExternalStopFixture();
  try {
    await withFakeCodex(async (fakeBinaryDirectory) => {
      const port = await unusedPort();
      const expectedAuthority = `relay-proof.test:${port}`;
      const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
      const relay = spawn(
        process.execPath,
        externalStopArguments(fixture, port, expectedAuthority, 120_000),
        {
          env: {
            ...process.env,
            FAKE_CODEX_LOG_PATH: logPath,
            FAKE_CODEX_MODE: "external-stop-proof",
            PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const completed = collectChild(relay);
      const contextOutput = waitForOutput(
        relay.stderr,
        /control context: \{[^\n]+\}\n/u,
      );
      relay.stdin.end("SENSITIVE_EXTERNAL_STOP_TASK_INPUT");
      try {
        const context = parseExternalStopContext(await contextOutput);
        assert.deepEqual(Object.keys(context), [
          "schemaVersion",
          "kind",
          "controlContextId",
          "expiresAt",
        ]);
        assert.equal(context.schemaVersion, 1);
        assert.equal(context.kind, "controlContext");
        assert.match(context.controlContextId, /^[A-Za-z0-9_-]{43}$/u);
        assert.equal(Number.isFinite(Date.parse(context.expiresAt)), true);

        const action = externalStopAction(context, "ios-external-stop-1");
        assert.equal(
          Date.parse(action.expiresAt) - Date.parse(action.issuedAt),
          60_000,
        );
        assert.equal(
          Date.parse(context.expiresAt) > Date.parse(action.expiresAt),
          true,
        );
        const response = await sendExternalAction({
          port,
          expectedAuthority,
          action,
        });
        assert.equal(response.statusCode, 200);
        assert.equal(
          response.body,
          JSON.stringify({
            schemaVersion: 1,
            actionId: action.actionId,
            action: "stop",
            outcome: "accepted",
            reason: null,
          }),
        );

        const result = await waitWithin(
          completed,
          5_000,
          "external Stop relay did not exit after interrupted lifecycle",
        );
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.signal, null);
        assert.equal(
          result.stderr,
          `${EXTERNAL_STOP_CONTEXT_PREFIX}${JSON.stringify(context)}\n`,
        );
        const payloads = result.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.equal(payloads.at(-1).aps["content-state"].status, "Blocked");

        const log = await readFakeLog(logPath);
        const methods = log
          .filter((entry) => entry.kind === "method")
          .map((entry) => entry.value);
        assert.equal(methods.filter((method) => method === "thread/start").length, 1);
        assert.equal(methods.filter((method) => method === "turn/start").length, 1);
        assert.equal(methods.filter((method) => method === "turn/interrupt").length, 1);
        assert.equal(methods.includes("turn/steer"), false);
        assert.deepEqual(
          log
            .filter((entry) => entry.kind === "action-validation")
            .map((entry) => ({ method: entry.method, valid: entry.valid })),
          [{ method: "turn/interrupt", valid: true }],
        );
        assert.equal((await readdir(fixture.replayRoot)).length, 1);
        await assertPortClosed(port);

        const publicOutput = `${result.stdout}${result.stderr}`;
        for (const marker of [
          "SENSITIVE_EXTERNAL_STOP_TASK_INPUT",
          EXTERNAL_STOP_APP_TOKEN,
          EXTERNAL_STOP_HMAC_KEY,
          fixture.appTokenPath,
          fixture.hmacKeyPath,
          fixture.replayRoot,
          "thread-fake",
          "turn-fake",
        ]) {
          assert.equal(publicOutput.includes(marker), false, marker);
        }
      } finally {
        if (relay.exitCode === null && relay.signalCode === null) {
          relay.kill("SIGKILL");
        }
      }
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
  assert.deepEqual(await relayStateHomes(), stateBefore);
});

test("CLI external Stop readiness accepts allowlisted command ordering", async (t) => {
  for (const [label, mode] of [
    ["agent-owned command", "external-stop-proof-agent-source"],
    ["command before turn/start response", "external-stop-proof-early-item"],
    [
      "duplicate command before turn/start response",
      "external-stop-proof-duplicate-early-item",
    ],
    ["duplicate command after correlation", "external-stop-proof-duplicate-item"],
    [
      "wrong-thread item followed by owned command",
      "external-stop-proof-wrong-thread-then-valid",
    ],
    [
      "tracked command completion after authenticated dispatch",
      "external-stop-proof-completion-after-dispatch",
    ],
  ]) {
    await t.test(label, async () => {
      const stateBefore = await relayStateHomes();
      const fixture = await createExternalStopFixture();
      try {
        await withFakeCodex(async (fakeBinaryDirectory) => {
          const port = await unusedPort();
          const expectedAuthority = `relay-proof.test:${port}`;
          const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
          const relay = spawn(
            process.execPath,
            externalStopArguments(fixture, port, expectedAuthority),
            {
              env: {
                ...process.env,
                FAKE_CODEX_LOG_PATH: logPath,
                FAKE_CODEX_MODE: mode,
                PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
              },
              stdio: ["pipe", "pipe", "pipe"],
            },
          );
          const completed = collectChild(relay);
          const contextOutput = waitForOutput(
            relay.stderr,
            /control context: \{[^\n]+\}\n/u,
          );
          relay.stdin.end("SENSITIVE_EXTERNAL_READINESS_SUCCESS_INPUT");
          try {
            const context = parseExternalStopContext(await contextOutput);
            const response = await sendExternalAction({
              port,
              expectedAuthority,
              action: externalStopAction(
                context,
                `ios-readiness-${mode.length}`,
              ),
            });
            assert.equal(response.statusCode, 200);
            const result = await waitWithin(
              completed,
              5_000,
              `external Stop readiness did not complete for ${mode}`,
            );
            assert.equal(result.code, 0, result.stderr);
            assert.equal(externalStopContexts(result.stderr).length, 1);
            assertExternalStopOutputRedacted(result, fixture);
            const methods = (await readFakeLog(logPath))
              .filter((entry) => entry.kind === "method")
              .map((entry) => entry.value);
            assert.equal(
              methods.filter((method) => method === "turn/interrupt").length,
              1,
            );
            assert.equal((await readdir(fixture.replayRoot)).length, 1);
            await assertPortClosed(port);
          } finally {
            if (relay.exitCode === null && relay.signalCode === null) {
              relay.kill("SIGKILL");
            }
          }
        });
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
      assert.deepEqual(await relayStateHomes(), stateBefore);
    });
  }
});

test("CLI external Stop readiness rejects ineligible or ambiguous commands", async (t) => {
  for (const {
    label,
    mode,
    expectedError,
    expectedContexts,
    timeoutMs = 5_000,
  } of [
    {
      label: "user-shell source",
      mode: "external-stop-proof-wrong-source",
      expectedError: /did not observe a model-owned command/u,
      expectedContexts: 0,
      timeoutMs: 100,
    },
    {
      label: "different thread",
      mode: "external-stop-proof-wrong-thread",
      expectedError: /did not observe a model-owned command/u,
      expectedContexts: 0,
      timeoutMs: 100,
    },
    {
      label: "wrong item type",
      mode: "external-stop-proof-wrong-type",
      expectedError: /did not observe a model-owned command/u,
      expectedContexts: 0,
      timeoutMs: 100,
    },
    {
      label: "non-running item status",
      mode: "external-stop-proof-wrong-status",
      expectedError: /did not observe a model-owned command/u,
      expectedContexts: 0,
      timeoutMs: 100,
    },
    {
      label: "malformed item identifier",
      mode: "external-stop-proof-malformed-id",
      expectedError: /did not observe a model-owned command/u,
      expectedContexts: 0,
      timeoutMs: 100,
    },
    {
      label: "overlong item identifier",
      mode: "external-stop-proof-overlong-id",
      expectedError: /did not observe a model-owned command/u,
      expectedContexts: 0,
      timeoutMs: 100,
    },
    {
      label: "ill-formed Unicode item identifier",
      mode: "external-stop-proof-malformed-unicode-id",
      expectedError: /did not observe a model-owned command/u,
      expectedContexts: 0,
      timeoutMs: 100,
    },
    {
      label: "different turn",
      mode: "external-stop-proof-wrong-turn",
      expectedError: /inconsistent command lifecycle identifiers/u,
      expectedContexts: 0,
    },
    {
      label: "second command before turn/start response",
      mode: "external-stop-proof-second-early-item",
      expectedError: /too many early command start notifications/u,
      expectedContexts: 0,
    },
    {
      label: "second command after correlation",
      mode: "external-stop-proof-second-item",
      expectedError: /another model-owned command before Stop dispatch/u,
      expectedContexts: 1,
    },
    {
      label: "completion before turn/start response",
      mode: "external-stop-proof-early-completion",
      expectedError: /command ended before authenticated dispatch/u,
      expectedContexts: 0,
    },
    {
      label: "malformed same-item completion before dispatch",
      mode: "external-stop-proof-malformed-completion",
      expectedError: /command ended before authenticated dispatch/u,
      expectedContexts: 1,
    },
  ]) {
    await t.test(label, async () => {
      const stateBefore = await relayStateHomes();
      const fixture = await createExternalStopFixture();
      try {
        await withFakeCodex(async (fakeBinaryDirectory) => {
          const port = await unusedPort();
          const expectedAuthority = `relay-proof.test:${port}`;
          const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
          const relay = spawn(
            process.execPath,
            externalStopArguments(
              fixture,
              port,
              expectedAuthority,
              timeoutMs,
            ),
            {
              env: {
                ...process.env,
                FAKE_CODEX_LOG_PATH: logPath,
                FAKE_CODEX_MODE: mode,
                PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
              },
              stdio: ["pipe", "pipe", "pipe"],
            },
          );
          const completed = collectChild(relay);
          relay.stdin.end("SENSITIVE_EXTERNAL_READINESS_REJECTION_INPUT");
          try {
            const result = await waitWithin(
              completed,
              2_000,
              `external Stop readiness did not reject ${mode}`,
            );
            assert.equal(result.code, 1);
            assert.match(result.stderr, expectedError);
            assert.equal(
              externalStopContexts(result.stderr).length,
              expectedContexts,
            );
            assertExternalStopOutputRedacted(result, fixture);
            const methods = (await readFakeLog(logPath))
              .filter((entry) => entry.kind === "method")
              .map((entry) => entry.value);
            assert.equal(methods.includes("turn/interrupt"), false);
            assert.deepEqual(await readdir(fixture.replayRoot), []);
            await assertPortClosed(port);
          } finally {
            if (relay.exitCode === null && relay.signalCode === null) {
              relay.kill("SIGKILL");
            }
          }
        });
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
      assert.deepEqual(await relayStateHomes(), stateBefore);
    });
  }
});

test("CLI external Stop mode rejects Reply and dispatches no App Server action", async () => {
  const stateBefore = await relayStateHomes();
  const fixture = await createExternalStopFixture();
  try {
    await withFakeCodex(async (fakeBinaryDirectory) => {
      const port = await unusedPort();
      const expectedAuthority = `relay-proof.test:${port}`;
      const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
      const relay = spawn(
        process.execPath,
        externalStopArguments(fixture, port, expectedAuthority),
        {
          env: {
            ...process.env,
            FAKE_CODEX_LOG_PATH: logPath,
            FAKE_CODEX_MODE: "external-stop-proof",
            PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const completed = collectChild(relay);
      const contextOutput = waitForOutput(
        relay.stderr,
        /control context: \{[^\n]+\}\n/u,
      );
      relay.stdin.end("SENSITIVE_EXTERNAL_REPLY_TASK_INPUT");
      try {
        const context = parseExternalStopContext(await contextOutput);
        const response = await sendExternalAction({
          port,
          expectedAuthority,
          action: {
            schemaVersion: 1,
            actionId: "ios-external-reply-1",
            controlContextId: context.controlContextId,
            issuedAt: new Date().toISOString(),
            expiresAt: context.expiresAt,
            action: "reply",
            text: "SENSITIVE_EXTERNAL_REPLY_TEXT",
          },
        }).catch(() => null);
        if (response !== null) assert.equal(response.statusCode, 400);
        const result = await waitWithin(
          completed,
          5_000,
          "external Stop relay did not fail after Reply",
        );
        assert.equal(result.code, 1);
        assert.match(result.stderr, /external Stop proof observed another action/);
        assert.equal(result.stderr.includes("SENSITIVE"), false);
        assert.equal(result.stdout.includes("SENSITIVE"), false);
        const log = await readFakeLog(logPath);
        const methods = log
          .filter((entry) => entry.kind === "method")
          .map((entry) => entry.value);
        assert.equal(methods.includes("turn/steer"), false);
        assert.equal(methods.includes("turn/interrupt"), false);
        assert.deepEqual(await readdir(fixture.replayRoot), []);
        await assertPortClosed(port);
      } finally {
        if (relay.exitCode === null && relay.signalCode === null) {
          relay.kill("SIGKILL");
        }
      }
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
  assert.deepEqual(await relayStateHomes(), stateBefore);
});

test("CLI action proof modes are mutually exclusive", () => {
  for (const modes of [
    ["--loopback-action-proof", "--external-stop-proof"],
    ["--loopback-action-proof", "--local-long-task-proof"],
    ["--external-stop-proof", "--local-long-task-proof"],
  ]) {
    const result = spawnSync(process.execPath, [relayPath, ...modes], {
      input: "SENSITIVE_MUTUALLY_EXCLUSIVE_TASK_INPUT",
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "action proof modes are mutually exclusive\n");
  }
});

test("CLI external Stop mode rejects a context timeout above 120 seconds", async () => {
  const fixture = await createExternalStopFixture();
  try {
    const result = spawnSync(
      process.execPath,
      externalStopArguments(fixture, 49_152, "relay-proof.test", 120_001),
      { input: "SENSITIVE_OVERSIZED_CONTEXT_INPUT", encoding: "utf8" },
    );
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "external Stop proof options are invalid\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("CLI external Stop mode preserves its terminal deadline after dispatch", async () => {
  const stateBefore = await relayStateHomes();
  const fixture = await createExternalStopFixture();
  try {
    await withFakeCodex(async (fakeBinaryDirectory) => {
      const port = await unusedPort();
      const expectedAuthority = `relay-proof.test:${port}`;
      const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
      const relay = spawn(
        process.execPath,
        externalStopArguments(fixture, port, expectedAuthority, 200),
        {
          env: {
            ...process.env,
            FAKE_CODEX_LOG_PATH: logPath,
            FAKE_CODEX_MODE: "external-stop-proof-delayed-terminal",
            PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const completed = collectChild(relay);
      const contextOutput = waitForOutput(
        relay.stderr,
        /control context: \{[^\n]+\}\n/u,
      );
      relay.stdin.end("SENSITIVE_EXTERNAL_TERMINAL_DEADLINE_INPUT");
      try {
        const context = parseExternalStopContext(await contextOutput);
        const response = await sendExternalAction({
          port,
          expectedAuthority,
          action: externalStopAction(context, "ios-terminal-deadline-stop-1"),
        });
        assert.equal(response.statusCode, 200);
        const result = await waitWithin(
          completed,
          2_000,
          "external Stop relay did not preserve its terminal deadline",
        );
        assert.equal(result.code, 0, result.stderr);
        assert.equal(
          (await readFakeLog(logPath)).filter(
            (entry) =>
              entry.kind === "method" && entry.value === "turn/interrupt",
          ).length,
          1,
        );
        assert.equal((await readdir(fixture.replayRoot)).length, 1);
        await assertPortClosed(port);
      } finally {
        if (relay.exitCode === null && relay.signalCode === null) {
          relay.kill("SIGKILL");
        }
      }
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
  assert.deepEqual(await relayStateHomes(), stateBefore);
});

test("CLI external Stop mode fails closed on natural completion", async () => {
  const stateBefore = await relayStateHomes();
  const fixture = await createExternalStopFixture();
  try {
    await withFakeCodex(async (fakeBinaryDirectory) => {
      const port = await unusedPort();
      const expectedAuthority = `relay-proof.test:${port}`;
      const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
      const relay = spawn(
        process.execPath,
        externalStopArguments(fixture, port, expectedAuthority),
        {
          env: {
            ...process.env,
            FAKE_CODEX_LOG_PATH: logPath,
            PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const completed = collectChild(relay);
      relay.stdin.end("SENSITIVE_EXTERNAL_NATURAL_COMPLETION_INPUT");
      try {
        const result = await waitWithin(
          completed,
          5_000,
          "external Stop relay did not fail on natural completion",
        );
        assert.equal(result.code, 1);
        assert.match(
          result.stderr,
          /task ended before external Stop proof activation/,
        );
        assert.deepEqual(externalStopContexts(result.stderr), []);
        assertExternalStopOutputRedacted(result, fixture);
        const methods = (await readFakeLog(logPath))
          .filter((entry) => entry.kind === "method")
          .map((entry) => entry.value);
        assert.equal(methods.includes("turn/interrupt"), false);
        assert.deepEqual(await readdir(fixture.replayRoot), []);
        await assertPortClosed(port);
      } finally {
        if (relay.exitCode === null && relay.signalCode === null) {
          relay.kill("SIGKILL");
        }
      }
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
  assert.deepEqual(await relayStateHomes(), stateBefore);
});

test("CLI external Stop mode fails closed on a malformed interrupt response", async () => {
  const stateBefore = await relayStateHomes();
  const fixture = await createExternalStopFixture();
  try {
    await withFakeCodex(
      async (fakeBinaryDirectory) => {
        const port = await unusedPort();
        const expectedAuthority = `relay-proof.test:${port}`;
        const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
        const relay = spawn(
          process.execPath,
          externalStopArguments(fixture, port, expectedAuthority),
          {
            env: {
              ...process.env,
              FAKE_CODEX_LOG_PATH: logPath,
              FAKE_CODEX_MODE: "external-stop-proof",
              PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
            },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        const completed = collectChild(relay);
        const contextOutput = waitForOutput(
          relay.stderr,
          /control context: \{[^\n]+\}\n/u,
        );
        relay.stdin.end("SENSITIVE_EXTERNAL_MALFORMED_RESPONSE_INPUT");
        try {
          const context = parseExternalStopContext(await contextOutput);
          const request = sendExternalAction({
            port,
            expectedAuthority,
            action: externalStopAction(context, "ios-malformed-response-1"),
          }).catch(() => null);
          const result = await waitWithin(
            completed,
            5_000,
            "external Stop relay did not fail on malformed response",
          );
          await request;
          assert.equal(result.code, 1);
          assert.match(
            result.stderr,
            /external Stop proof response was unknown/,
          );
          assert.equal(result.stderr.includes("SENSITIVE"), false);
          assert.equal(result.stdout.includes("SENSITIVE"), false);
          const methods = (await readFakeLog(logPath))
            .filter((entry) => entry.kind === "method")
            .map((entry) => entry.value);
          assert.equal(
            methods.filter((method) => method === "turn/interrupt").length,
            1,
          );
          await assertPortClosed(port);
        } finally {
          if (relay.exitCode === null && relay.signalCode === null) {
            relay.kill("SIGKILL");
          }
        }
      },
      {
        rewriteSource: (source) =>
          source.replace(
            "send({ id: message.id, result: {} });",
            'send({ id: message.id, result: { unexpected: "SENSITIVE" } });',
          ),
      },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
  assert.deepEqual(await relayStateHomes(), stateBefore);
});

test("CLI external Stop mode rejects terminal lifecycle before interrupt acceptance", async () => {
  const stateBefore = await relayStateHomes();
  const fixture = await createExternalStopFixture();
  try {
    await withFakeCodex(
      async (fakeBinaryDirectory) => {
        const port = await unusedPort();
        const expectedAuthority = `relay-proof.test:${port}`;
        const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
        const relay = spawn(
          process.execPath,
          externalStopArguments(fixture, port, expectedAuthority),
          {
            env: {
              ...process.env,
              FAKE_CODEX_LOG_PATH: logPath,
              FAKE_CODEX_MODE: "external-stop-proof-terminal-before-response",
              PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
            },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        const completed = collectChild(relay);
        const contextOutput = waitForOutput(
          relay.stderr,
          /control context: \{[^\n]+\}\n/u,
        );
        relay.stdin.end("SENSITIVE_EXTERNAL_EARLY_INTERRUPT_INPUT");
        try {
          const context = parseExternalStopContext(await contextOutput);
          const request = sendExternalAction({
            port,
            expectedAuthority,
            action: externalStopAction(context, "ios-early-interrupt-1"),
          }).catch(() => null);
          const result = await waitWithin(
            completed,
            5_000,
            "external Stop relay accepted lifecycle before response",
          );
          await request;
          assert.equal(result.code, 1);
          assert.match(
            result.stderr,
            /external Stop lifecycle preceded App Server acceptance/,
          );
          assert.equal(result.stderr.includes("SENSITIVE"), false);
          assert.equal(result.stdout.includes("SENSITIVE"), false);
          const methods = (await readFakeLog(logPath))
            .filter((entry) => entry.kind === "method")
            .map((entry) => entry.value);
          assert.equal(
            methods.filter((method) => method === "turn/interrupt").length,
            1,
          );
          assert.equal((await readdir(fixture.replayRoot)).length, 1);
          await assertPortClosed(port);
        } finally {
          if (relay.exitCode === null && relay.signalCode === null) {
            relay.kill("SIGKILL");
          }
        }
      },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
  assert.deepEqual(await relayStateHomes(), stateBefore);
});

test("CLI external Stop mode fails on a second authenticated action", async () => {
  const stateBefore = await relayStateHomes();
  const fixture = await createExternalStopFixture();
  try {
    await withFakeCodex(async (fakeBinaryDirectory) => {
      const port = await unusedPort();
      const expectedAuthority = `relay-proof.test:${port}`;
      const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
      const relay = spawn(
        process.execPath,
        externalStopArguments(fixture, port, expectedAuthority),
        {
          env: {
            ...process.env,
            FAKE_CODEX_LOG_PATH: logPath,
            FAKE_CODEX_MODE: "external-stop-proof-delayed-stop",
            PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const completed = collectChild(relay);
      const contextOutput = waitForOutput(
        relay.stderr,
        /control context: \{[^\n]+\}\n/u,
      );
      relay.stdin.end("SENSITIVE_EXTERNAL_SECOND_ACTION_INPUT");
      try {
        const context = parseExternalStopContext(await contextOutput);
        const first = sendExternalAction({
          port,
          expectedAuthority,
          action: externalStopAction(context, "ios-first-stop-1"),
        }).catch(() => null);
        await waitForFakeMethod(logPath, "turn/interrupt");
        const second = sendExternalAction({
          port,
          expectedAuthority,
          action: externalStopAction(context, "ios-second-stop-2"),
        }).catch(() => null);
        const result = await waitWithin(
          completed,
          5_000,
          "external Stop relay did not fail on a second action",
        );
        await Promise.all([first, second]);
        assert.equal(result.code, 1);
        assert.match(
          result.stderr,
          /external Stop proof observed another action/,
        );
        assert.equal(result.stderr.includes("SENSITIVE"), false);
        assert.equal(result.stdout.includes("SENSITIVE"), false);
        const methods = (await readFakeLog(logPath))
          .filter((entry) => entry.kind === "method")
          .map((entry) => entry.value);
        assert.equal(
          methods.filter((method) => method === "turn/interrupt").length,
          1,
        );
        assert.equal((await readdir(fixture.replayRoot)).length, 1);
        await assertPortClosed(port);
      } finally {
        if (relay.exitCode === null && relay.signalCode === null) {
          relay.kill("SIGKILL");
        }
      }
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
  assert.deepEqual(await relayStateHomes(), stateBefore);
});

test("CLI external Stop mode preserves exact retries without redispatch", async (t) => {
  for (const { label, mode, retryState } of [
    {
      label: "incomplete claim",
      mode: "external-stop-proof-incomplete-retry",
      retryState: "uncertain",
    },
    {
      label: "completed receipt",
      mode: "external-stop-proof-delayed-terminal",
      retryState: "completed",
    },
  ]) {
    await t.test(label, async () => {
      const stateBefore = await relayStateHomes();
      const fixture = await createExternalStopFixture();
      try {
        await withFakeCodex(async (fakeBinaryDirectory) => {
          const port = await unusedPort();
          const expectedAuthority = `relay-proof.test:${port}`;
          const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
          const relay = spawn(
            process.execPath,
            externalStopArguments(fixture, port, expectedAuthority),
            {
              env: {
                ...process.env,
                FAKE_CODEX_LOG_PATH: logPath,
                FAKE_CODEX_MODE: mode,
                PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
              },
              stdio: ["pipe", "pipe", "pipe"],
            },
          );
          const completed = collectChild(relay);
          const contextOutput = waitForOutput(
            relay.stderr,
            /control context: \{[^\n]+\}\n/u,
          );
          relay.stdin.end("SENSITIVE_EXTERNAL_RETRY_INPUT");
          try {
            const context = parseExternalStopContext(await contextOutput);
            const action = externalStopAction(
              context,
              `ios-exact-retry-${retryState}`,
            );
            let firstResponse;
            let retryResponse;
            if (retryState === "uncertain") {
              const firstRequest = sendExternalAction({
                port,
                expectedAuthority,
                action,
              });
              await waitForFakeMethod(logPath, "turn/interrupt");
              retryResponse = await sendExternalAction({
                port,
                expectedAuthority,
                action,
              });
              firstResponse = await firstRequest;
            } else {
              firstResponse = await sendExternalAction({
                port,
                expectedAuthority,
                action,
              });
              retryResponse = await sendExternalAction({
                port,
                expectedAuthority,
                action,
              });
            }

            assert.equal(firstResponse.statusCode, 200);
            if (retryState === "completed") {
              assert.equal(retryResponse.statusCode, 200);
              assert.equal(retryResponse.body, firstResponse.body);
            } else {
              assert.equal(retryResponse.statusCode, 503);
              assert.equal(
                JSON.parse(retryResponse.body).reason,
                "outcomeUnknown",
              );
            }

            const result = await waitWithin(
              completed,
              5_000,
              `external Stop relay did not finish after ${label} retry`,
            );
            assert.equal(result.code, 0, result.stderr);
            assertExternalStopOutputRedacted(result, fixture);
            const methods = (await readFakeLog(logPath))
              .filter((entry) => entry.kind === "method")
              .map((entry) => entry.value);
            assert.equal(
              methods.filter((method) => method === "turn/interrupt").length,
              1,
            );
            assert.equal((await readdir(fixture.replayRoot)).length, 1);
            await assertPortClosed(port);
          } finally {
            if (relay.exitCode === null && relay.signalCode === null) {
              relay.kill("SIGKILL");
            }
          }
        });
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
      assert.deepEqual(await relayStateHomes(), stateBefore);
    });
  }
});

test("CLI external Stop mode bounds waiting for an external action", async () => {
  const stateBefore = await relayStateHomes();
  const fixture = await createExternalStopFixture();
  try {
    await withFakeCodex(async (fakeBinaryDirectory) => {
      const port = await unusedPort();
      const expectedAuthority = `relay-proof.test:${port}`;
      const relay = spawn(
        process.execPath,
        externalStopArguments(fixture, port, expectedAuthority, 100),
        {
          env: {
            ...process.env,
            FAKE_CODEX_MODE: "external-stop-proof",
            PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const completed = collectChild(relay);
      relay.stdin.end("SENSITIVE_EXTERNAL_TIMEOUT_INPUT");
      try {
        const result = await waitWithin(
          completed,
          2_000,
          "external Stop relay exceeded its configured timeout",
        );
        assert.equal(result.code, 1);
        assert.match(result.stderr, /external Stop proof timed out/);
        assert.equal(result.stderr.includes("SENSITIVE"), false);
        assert.equal(result.stdout.includes("SENSITIVE"), false);
        assert.deepEqual(await readdir(fixture.replayRoot), []);
        await assertPortClosed(port);
      } finally {
        if (relay.exitCode === null && relay.signalCode === null) {
          relay.kill("SIGKILL");
        }
      }
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
  assert.deepEqual(await relayStateHomes(), stateBefore);
});

test("CLI external Stop mode bounds activation without model-owned readiness", async () => {
  const stateBefore = await relayStateHomes();
  const fixture = await createExternalStopFixture();
  try {
    await withFakeCodex(async (fakeBinaryDirectory) => {
      const port = await unusedPort();
      const expectedAuthority = `relay-proof.test:${port}`;
      const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
      const relay = spawn(
        process.execPath,
        externalStopArguments(fixture, port, expectedAuthority, 100),
        {
          env: {
            ...process.env,
            FAKE_CODEX_LOG_PATH: logPath,
            FAKE_CODEX_MODE: "waiting",
            PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const completed = collectChild(relay);
      relay.stdin.end("SENSITIVE_EXTERNAL_ACTIVATION_TIMEOUT_INPUT");
      try {
        const result = await waitWithin(
          completed,
          2_000,
          "external Stop relay exceeded its activation timeout",
        );
        assert.equal(result.code, 1);
        assert.equal(
          result.stderr,
          "external Stop proof did not observe a model-owned command\n",
        );
        assert.deepEqual(externalStopContexts(result.stderr), []);
        assertExternalStopOutputRedacted(result, fixture);
        const methods = (await readFakeLog(logPath))
          .filter((entry) => entry.kind === "method")
          .map((entry) => entry.value);
        assert.equal(methods.includes("turn/start"), true);
        assert.equal(methods.includes("turn/interrupt"), false);
        assert.deepEqual(await readdir(fixture.replayRoot), []);
        await assertPortClosed(port);
      } finally {
        if (relay.exitCode === null && relay.signalCode === null) {
          relay.kill("SIGKILL");
        }
      }
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
  assert.deepEqual(await relayStateHomes(), stateBefore);
});

test("CLI external Stop mode fails when its status output is closed", async () => {
  const stateBefore = await relayStateHomes();
  const fixture = await createExternalStopFixture();
  try {
    await withFakeCodex(async (fakeBinaryDirectory) => {
      const port = await unusedPort();
      const expectedAuthority = `relay-proof.test:${port}`;
      const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
      const relay = spawn(
        process.execPath,
        externalStopArguments(fixture, port, expectedAuthority),
        {
          env: {
            ...process.env,
            FAKE_CODEX_LOG_PATH: logPath,
            FAKE_CODEX_MODE: "external-stop-proof",
            PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const completed = collectChild(relay);
      relay.stderr.destroy();
      relay.stdin.end("SENSITIVE_EXTERNAL_CLOSED_STATUS_INPUT");
      try {
        const result = await waitWithin(
          completed,
          2_000,
          "external Stop relay did not fail after status output closed",
        );
        assert.equal(result.code, 1);
        assert.equal(result.signal, null);
        assert.equal(result.stdout.includes("SENSITIVE"), false);
        const methods = (await readFakeLog(logPath))
          .filter((entry) => entry.kind === "method")
          .map((entry) => entry.value);
        assert.equal(methods.includes("turn/interrupt"), false);
        assert.deepEqual(await readdir(fixture.replayRoot), []);
        await assertPortClosed(port);
      } finally {
        if (relay.exitCode === null && relay.signalCode === null) {
          relay.kill("SIGKILL");
        }
      }
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
  assert.deepEqual(await relayStateHomes(), stateBefore);
});

test("CLI fails closed on a mismatched live steer response and cleans proof state", async () => {
  const stateBefore = await relayStateHomes();
  const proofBefore = await loopbackProofHomes();
  const result = await withFakeCodex((fakeBinaryDirectory) =>
    spawnSync(
      process.execPath,
      [relayPath, "--cwd", repositoryRoot, "--loopback-action-proof"],
      {
        input: "SENSITIVE_MISMATCHED_STEER_TASK_INPUT",
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          FAKE_CODEX_MODE: "loopback-action-proof-wrong-steer",
          PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
        },
      },
    ),
  );

  assert.equal(result.status, 1, result.error?.message);
  assert.match(result.stderr, /loopback action proof was rejected/);
  assert.equal(result.stderr.includes("SENSITIVE"), false);
  assert.equal(result.stdout.includes("SENSITIVE"), false);
  assert.deepEqual(await relayStateHomes(), stateBefore);
  assert.deepEqual(await loopbackProofHomes(), proofBefore);
});

test("CLI bounds incomplete turn-start correlation and cleans proof state", async (t) => {
  for (const [name, mode] of [
    ["missing turn/start response", "loopback-action-proof-missing-start-response"],
    ["missing turn/started notification", "loopback-action-proof-missing-start"],
  ]) {
    await t.test(name, async () => {
      const stateBefore = await relayStateHomes();
      const proofBefore = await loopbackProofHomes();
      const result = await withFakeCodex((fakeBinaryDirectory) =>
        spawnSync(
          process.execPath,
          [relayPath, "--cwd", repositoryRoot, "--loopback-action-proof"],
          {
            input: "SENSITIVE_INCOMPLETE_TURN_START_INPUT",
            encoding: "utf8",
            timeout: 10_000,
            env: {
              ...process.env,
              FAKE_CODEX_MODE: mode,
              PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
            },
          },
        ),
      );

      assert.equal(result.status, 1, result.error?.message);
      assert.match(
        result.stderr,
        /loopback action proof did not observe a matching turn start/,
      );
      assert.equal(result.stderr.includes("SENSITIVE"), false);
      assert.equal(result.stdout.includes("SENSITIVE"), false);
      assert.deepEqual(await relayStateHomes(), stateBefore);
      assert.deepEqual(await loopbackProofHomes(), proofBefore);
    });
  }
});

test("CLI completes proof cleanup when its status output closes", async () => {
  const stateBefore = await relayStateHomes();
  const proofBefore = await loopbackProofHomes();
  await withFakeCodex(async (fakeBinaryDirectory) => {
    const relay = spawn(
      process.execPath,
      [relayPath, "--cwd", repositoryRoot, "--loopback-action-proof"],
      {
        env: {
          ...process.env,
          FAKE_CODEX_MODE: "loopback-action-proof-delayed-stop",
          PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const completed = collectChild(relay);
    const replyAccepted = waitForOutput(
      relay.stderr,
      /loopback proof: Reply accepted/,
    );
    relay.stdin.end("SENSITIVE_CLOSED_STATUS_TASK_INPUT");
    try {
      await replyAccepted;
      relay.stderr.destroy();
      const result = await waitWithin(
        completed,
        5_000,
        "relay did not exit after its status output closed",
      );
      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
      assert.equal(result.stdout.includes("SENSITIVE"), false);
      const payloads = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(payloads.at(-1).aps["content-state"].status, "Blocked");
    } finally {
      if (relay.exitCode === null && relay.signalCode === null) relay.kill("SIGKILL");
    }
  });
  assert.deepEqual(await relayStateHomes(), stateBefore);
  assert.deepEqual(await loopbackProofHomes(), proofBefore);
});

test("CLI fails closed on an MCP identifier that is not a bare config key", async () => {
  const before = await relayStateHomes();
  const result = await withFakeCodex((fakeBinaryDirectory) =>
    spawnSync(process.execPath, [relayPath, "--cwd", repositoryRoot], {
      input: "SENSITIVE_INVALID_MCP_NAME_INPUT",
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_MCP_SERVER_NAME: "SENSITIVE_MCP_SERVER.with.dot",
        PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
      },
    }),
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /tool isolation inventory was invalid/);
  assert.equal(result.stderr.includes("SENSITIVE"), false);
  assert.equal(result.stdout, "");
  assert.deepEqual(await relayStateHomes(), before);
});

test("CLI verifies tool isolation before sending task input", async () => {
  const before = await relayStateHomes();
  const { log, result } = await withFakeCodex(async (fakeBinaryDirectory) => {
    const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
    const result = spawnSync(process.execPath, [relayPath, "--cwd", repositoryRoot], {
      input: "SENSITIVE_MCP_ISOLATION_INPUT",
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CODEX_LOG_PATH: logPath,
        FAKE_CODEX_MODE: "mcp-isolation-failure",
        PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
      },
    });
    return { log: await readFakeLog(logPath), result };
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Codex tool isolation verification failed/);
  assert.equal(result.stderr.includes("SENSITIVE"), false);
  assert.equal(result.stdout.includes("SENSITIVE"), false);
  const methods = log
    .filter((entry) => entry.kind === "method")
    .map((entry) => entry.value);
  assert.equal(methods.includes("mcpServerStatus/list"), true);
  assert.equal(methods.includes("turn/start"), false);
  assert.deepEqual(await relayStateHomes(), before);
});

test("CLI rejects unknown, duplicate, and malformed MCP status rows", async () => {
  for (const mode of [
    "mcp-unknown-server",
    "mcp-duplicate-server",
    "mcp-malformed-capabilities",
  ]) {
    const before = await relayStateHomes();
    const { log, result } = await withFakeCodex(async (fakeBinaryDirectory) => {
      const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
      const result = spawnSync(
        process.execPath,
        [relayPath, "--cwd", repositoryRoot],
        {
          input: "SENSITIVE_INVALID_MCP_STATUS_INPUT",
          encoding: "utf8",
          env: {
            ...process.env,
            FAKE_CODEX_LOG_PATH: logPath,
            FAKE_CODEX_MODE: mode,
            PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
          },
        },
      );
      return { log: await readFakeLog(logPath), result };
    });

    assert.equal(result.status, 1, mode);
    assert.match(result.stderr, /Codex tool isolation verification failed/);
    assert.equal(result.stderr.includes("SENSITIVE"), false, mode);
    assert.equal(result.stdout.includes("SENSITIVE"), false, mode);
    const methods = log
      .filter((entry) => entry.kind === "method")
      .map((entry) => entry.value);
    assert.equal(methods.includes("mcpServerStatus/list"), true, mode);
    assert.equal(methods.includes("turn/start"), false, mode);
    assert.deepEqual(await relayStateHomes(), before, mode);
  }
});

test("CLI fails closed on paginated MCP status before sending task input", async () => {
  const before = await relayStateHomes();
  const { log, result } = await withFakeCodex(async (fakeBinaryDirectory) => {
    const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
    const result = spawnSync(process.execPath, [relayPath, "--cwd", repositoryRoot], {
      input: "SENSITIVE_PAGINATED_MCP_INPUT",
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CODEX_LOG_PATH: logPath,
        FAKE_CODEX_MODE: "mcp-paginated",
        PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
      },
    });
    return { log: await readFakeLog(logPath), result };
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Codex tool isolation verification failed/);
  assert.equal(result.stderr.includes("SENSITIVE"), false);
  assert.equal(result.stdout.includes("SENSITIVE"), false);
  const methods = log
    .filter((entry) => entry.kind === "method")
    .map((entry) => entry.value);
  assert.equal(methods.includes("mcpServerStatus/list"), true);
  assert.equal(methods.includes("turn/start"), false);
  assert.deepEqual(await relayStateHomes(), before);
});

test("CLI fails closed on app-scoped MCP startup before tool verification", async () => {
  const before = await relayStateHomes();
  const { log, result } = await withFakeCodex(async (fakeBinaryDirectory) => {
    const logPath = join(fakeBinaryDirectory, "fake-codex.jsonl");
    const result = spawnSync(process.execPath, [relayPath, "--cwd", repositoryRoot], {
      input: "SENSITIVE_APP_MCP_STARTUP_INPUT",
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CODEX_LOG_PATH: logPath,
        FAKE_CODEX_MODE: "early-app-mcp-startup",
        PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
      },
    });
    return { log: await readFakeLog(logPath), result };
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Codex tool isolation verification failed/);
  assert.equal(result.stderr.includes("SENSITIVE"), false);
  assert.equal(result.stdout.includes("SENSITIVE"), false);
  const methods = log
    .filter((entry) => entry.kind === "method")
    .map((entry) => entry.value);
  assert.equal(methods.includes("turn/start"), false);
  assert.deepEqual(await relayStateHomes(), before);
});

test("CLI fails closed if an MCP server starts after the turn begins", async () => {
  const before = await relayStateHomes();
  const result = await withFakeCodex((fakeBinaryDirectory) =>
    spawnSync(process.execPath, [relayPath, "--cwd", repositoryRoot], {
      input: "SENSITIVE_LATE_MCP_INPUT",
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CODEX_MODE: "late-mcp-startup",
        PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
      },
    }),
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Codex tool isolation verification failed/);
  assert.equal(result.stderr.includes("SENSITIVE"), false);
  assert.equal(result.stdout.includes("SENSITIVE"), false);
  const statuses = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).aps["content-state"].status);
  assert.equal(statuses.includes("Ready"), false);
  assert.equal(statuses.at(-1), "Disconnected");
  assert.deepEqual(await relayStateHomes(), before);
});

test("CLI fails closed on an interactive request and removes disposable state", async () => {
  const before = await relayStateHomes();
  const result = await withFakeCodex((fakeBinaryDirectory) =>
    spawnSync(process.execPath, [relayPath, "--cwd", repositoryRoot], {
      input: "SENSITIVE_INTERACTIVE_TASK_INPUT",
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CODEX_MODE: "interactive",
        PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
      },
    }),
  );

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /server-initiated App Server requests are outside the dry-run relay boundary/,
  );
  assert.equal(result.stderr.includes("SENSITIVE"), false);
  assert.equal(result.stdout.includes("SENSITIVE"), false);
  const statuses = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).aps["content-state"].status);
  assert.equal(statuses.at(-1), "Disconnected");
  assert.deepEqual(await relayStateHomes(), before);
});

test("CLI ignores a different turn's failed completion", async () => {
  const result = await withFakeCodex((fakeBinaryDirectory) =>
    spawnSync(process.execPath, [relayPath, "--cwd", repositoryRoot], {
      input: "SENSITIVE_MISMATCHED_TURN_INPUT",
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CODEX_MODE: "mismatched-completion",
        PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
      },
    }),
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const payloads = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(payloads.at(-1).aps["content-state"].status, "Ready");
  assert.equal(result.stdout.includes("SENSITIVE"), false);
});

test("CLI buffers early terminal notifications until turn correlation", async () => {
  const result = await withFakeCodex((fakeBinaryDirectory) =>
    spawnSync(process.execPath, [relayPath, "--cwd", repositoryRoot], {
      input: "SENSITIVE_EARLY_TERMINAL_INPUT",
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CODEX_MODE: "early-mismatched-completion",
        PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
      },
    }),
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const statuses = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).aps["content-state"].status);
  assert.equal(statuses.includes("Blocked"), false);
  assert.equal(statuses.at(-1), "Ready");
  assert.equal(result.stdout.includes("SENSITIVE"), false);
});

test("CLI fails closed on an unsupported terminal status", async () => {
  const before = await relayStateHomes();
  const result = await withFakeCodex((fakeBinaryDirectory) =>
    spawnSync(process.execPath, [relayPath, "--cwd", repositoryRoot], {
      input: "SENSITIVE_UNSUPPORTED_STATUS_INPUT",
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CODEX_MODE: "unsupported-terminal",
        PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
      },
    }),
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid terminal lifecycle state/);
  assert.equal(result.stderr.includes("SENSITIVE"), false);
  assert.equal(result.stdout.includes("SENSITIVE"), false);
  assert.deepEqual(await relayStateHomes(), before);
});

test("CLI fails closed on an unknown server request", async () => {
  const before = await relayStateHomes();
  const result = await withFakeCodex((fakeBinaryDirectory) =>
    spawnSync(process.execPath, [relayPath, "--cwd", repositoryRoot], {
      input: "SENSITIVE_UNKNOWN_REQUEST_INPUT",
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CODEX_MODE: "unknown-request",
        PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
      },
    }),
  );

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /server-initiated App Server requests are outside the dry-run relay boundary/,
  );
  assert.equal(result.stderr.includes("SENSITIVE"), false);
  assert.equal(result.stdout.includes("SENSITIVE"), false);
  assert.deepEqual(await relayStateHomes(), before);
});

test("CLI terminates and cleans state when its owned thread closes", async () => {
  const before = await relayStateHomes();
  const result = await withFakeCodex((fakeBinaryDirectory) =>
    spawnSync(process.execPath, [relayPath, "--cwd", repositoryRoot], {
      input: "SENSITIVE_THREAD_CLOSE_INPUT",
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        FAKE_CODEX_MODE: "thread-closed",
        PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
      },
    }),
  );

  assert.equal(result.status, 1, result.error?.message);
  assert.match(
    result.stderr,
    /owned App Server thread closed before task completion/,
  );
  assert.equal(result.stderr.includes("SENSITIVE"), false);
  assert.equal(result.stdout.includes("SENSITIVE"), false);
  const statuses = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).aps["content-state"].status);
  assert.equal(statuses.includes("Ready"), false);
  assert.equal(statuses.at(-1), "Disconnected");
  assert.deepEqual(await relayStateHomes(), before);
});

test("documented silent npm invocation keeps stdout JSONL-only", async () => {
  const before = await relayStateHomes();
  const result = await withFakeCodex((fakeBinaryDirectory) =>
    spawnSync(
      "npm",
      ["run", "--silent", "relay", "--", "--cwd", repositoryRoot],
      {
        cwd: repositoryRoot,
        input: "SENSITIVE_NPM_TASK_INPUT",
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
        },
      },
    ),
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const lines = result.stdout.trim().split("\n");
  assert.ok(lines.length > 0);
  for (const line of lines) {
    const payload = JSON.parse(line);
    assert.equal(payload.aps.event, "update");
  }
  assert.equal(result.stdout.includes("SENSITIVE"), false);
  assert.deepEqual(await relayStateHomes(), before);
});

test("CLI escalates SIGTERM and cleans state when its child does not exit", async () => {
  const before = await relayStateHomes();
  await withFakeCodex(async (fakeBinaryDirectory) => {
    const relay = spawn(process.execPath, [relayPath, "--cwd", repositoryRoot], {
      env: {
        ...process.env,
        FAKE_CODEX_MODE: "stubborn-waiting",
        PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const completed = collectChild(relay);
    const working = waitForOutput(relay.stdout, /\"status\":\"Working\"/);
    relay.stdin.end("SENSITIVE_SIGNAL_TASK_INPUT");
    try {
      await working;
      relay.kill("SIGTERM");
      const result = await completed;
      assert.equal(result.code, 143);
      assert.equal(result.signal, null);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout.includes("SENSITIVE"), false);
      const payloads = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(
        payloads.at(-1).aps["content-state"].status,
        "Disconnected",
      );
    } finally {
      if (relay.exitCode === null && relay.signalCode === null) relay.kill("SIGKILL");
    }
  });
  assert.deepEqual(await relayStateHomes(), before);
});

test("CLI cleans state when its dry-run output closes", async () => {
  const before = await relayStateHomes();
  await withFakeCodex(async (fakeBinaryDirectory) => {
    const relay = spawn(
      process.execPath,
      [relayPath, "--cwd", repositoryRoot, "--stale-after-ms", "25"],
      {
        env: {
          ...process.env,
          FAKE_CODEX_MODE: "waiting",
          PATH: `${fakeBinaryDirectory}${delimiter}${process.env.PATH}`,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const completed = collectChild(relay);
    const working = waitForOutput(relay.stdout, /"status":"Working"/);
    relay.stdin.end("SENSITIVE_CLOSED_OUTPUT_INPUT");
    try {
      await working;
      relay.stdout.destroy();
      const result = await waitWithin(
        completed,
        5_000,
        "relay did not exit after its output closed",
      );
      assert.equal(result.code, 1);
      assert.equal(result.signal, null);
      assert.match(result.stderr, /dry-run output closed/);
      assert.equal(result.stderr.includes("EPIPE"), false);
      assert.equal(result.stderr.includes("SENSITIVE"), false);
      assert.equal(result.stdout.includes("SENSITIVE"), false);
    } finally {
      if (relay.exitCode === null && relay.signalCode === null) relay.kill("SIGKILL");
    }
  });
  assert.deepEqual(await relayStateHomes(), before);
});
