import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
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

async function relayStateHomes() {
  return (await readdir(tmpdir()))
    .filter((name) => name.startsWith("cla-one-task-relay."))
    .sort();
}

async function withFakeCodex(run) {
  const fakeBinaryDirectory = await mkdtemp(join(tmpdir(), "cla-fake-codex."));
  const fakeBinary = join(fakeBinaryDirectory, "codex");
  await copyFile(fakeCodexSource, fakeBinary);
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
