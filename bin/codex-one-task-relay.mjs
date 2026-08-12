#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import readline from "node:readline";

import {
  JsonlDryRunApnsTransport,
  OneTaskRelay,
} from "../src/one-task-relay.mjs";

const REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

const TERMINAL_STATUSES = new Set(["completed", "failed", "interrupted"]);
const CHILD_STOP_TIMEOUT_MS = 2_000;
const MAX_MCP_INVENTORY_BYTES = 4 * 1024 * 1024;
const MAX_MCP_SERVERS = 256;
const BARE_CONFIG_KEY = /^[A-Za-z0-9_-]+$/u;
const DISABLED_FEATURES = [
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "hooks",
  "image_generation",
  "in_app_browser",
  "multi_agent",
  "plugins",
  "remote_plugin",
  "skill_mcp_dependency_install",
  "tool_suggest",
  "workspace_dependencies",
];
const PROCESS_ISOLATION_ARGUMENTS = [
  ...DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
  "-c",
  'web_search="disabled"',
  "-c",
  "tools.web_search=false",
  "-c",
  "apps._default.enabled=false",
];

class SafeRelayError extends Error {}

function usage() {
  return [
    "Usage: printf '%s' '<task input>' | codex-one-task-relay [options]",
    "",
    "Options:",
    "  --cwd <path>             Task working directory (default: current directory)",
    "  --stale-after-ms <ms>    Running-state stale threshold (default: 60000)",
    "  --help                   Show this help",
  ].join("\n");
}

function parseArguments(argumentsList) {
  let cwd = process.cwd();
  let staleAfterMs = 60_000;

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--help") return { help: true };
    if (argument === "--cwd") {
      const value = argumentsList[index + 1];
      if (!value) throw new SafeRelayError("--cwd requires a path");
      cwd = resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--stale-after-ms") {
      const value = Number(argumentsList[index + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new SafeRelayError("--stale-after-ms requires a positive number");
      }
      staleAfterMs = value;
      index += 1;
      continue;
    }
    throw new SafeRelayError(`Unknown option: ${argument}`);
  }

  return { help: false, cwd, staleAfterMs };
}

async function readTaskInput() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  if (input.trim().length === 0) {
    throw new SafeRelayError("task input on stdin must not be empty");
  }
  return input;
}

function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function mcpDisableArguments(serverNames) {
  return serverNames.flatMap((name) => [
    "-c",
    `mcp_servers.${name}.enabled=false`,
  ]);
}

function parseMcpInventory(raw) {
  let inventory;
  try {
    inventory = JSON.parse(raw);
  } catch {
    throw new SafeRelayError("Codex tool isolation inventory was invalid");
  }
  if (!Array.isArray(inventory) || inventory.length > MAX_MCP_SERVERS) {
    throw new SafeRelayError("Codex tool isolation inventory was invalid");
  }

  const names = new Set();
  for (const entry of inventory) {
    const name = entry?.name;
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > 256 ||
      !BARE_CONFIG_KEY.test(name) ||
      names.has(name)
    ) {
      throw new SafeRelayError("Codex tool isolation inventory was invalid");
    }
    names.add(name);
  }
  inventory = null;
  return names;
}

function verifyMcpIsolationStatus(result, configuredMcpNames) {
  if (
    !Array.isArray(result?.data) ||
    result.data.length > MAX_MCP_SERVERS ||
    (result.nextCursor !== undefined && result.nextCursor !== null)
  ) {
    throw new SafeRelayError("Codex tool isolation verification failed");
  }

  const seenNames = new Set();
  for (const entry of result.data) {
    const name = entry?.name;
    if (
      typeof name !== "string" ||
      !configuredMcpNames.has(name) ||
      seenNames.has(name) ||
      entry.serverInfo != null ||
      !entry.tools ||
      Array.isArray(entry.tools) ||
      typeof entry.tools !== "object" ||
      Object.keys(entry.tools).length !== 0 ||
      !Array.isArray(entry.resources) ||
      entry.resources.length !== 0 ||
      !Array.isArray(entry.resourceTemplates) ||
      entry.resourceTemplates.length !== 0
    ) {
      throw new SafeRelayError("Codex tool isolation verification failed");
    }
    seenNames.add(name);
  }
}

function startMcpInventory({ cwd, env }) {
  const child = spawn(
    "codex",
    [
      ...PROCESS_ISOLATION_ARGUMENTS,
      "mcp",
      "list",
      "--json",
    ],
    {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stderr.resume();

  const result = new Promise((resolveInventory, rejectInventory) => {
    let raw = "";
    let settled = false;
    function fail() {
      if (settled) return;
      settled = true;
      raw = "";
      child.kill("SIGTERM");
      rejectInventory(
        new SafeRelayError("Codex tool isolation inventory could not be read"),
      );
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      raw += chunk;
      if (Buffer.byteLength(raw, "utf8") <= MAX_MCP_INVENTORY_BYTES) return;
      fail();
    });
    child.once("error", fail);
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) return fail();
      try {
        const names = parseMcpInventory(raw);
        settled = true;
        resolveInventory(names);
      } catch (error) {
        settled = true;
        rejectInventory(error);
      } finally {
        raw = "";
      }
    });
  });

  return { child, result };
}

async function removeStateHome(stateHome) {
  await rm(stateHome, { recursive: true, force: true });
  try {
    await access(stateHome);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new SafeRelayError("disposable App Server state cleanup failed");
}

function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolveClose) => {
    const timeout = setTimeout(() => {
      child.off("close", onClose);
      resolveClose(false);
    }, timeoutMs);
    function onClose() {
      clearTimeout(timeout);
      resolveClose(true);
    }
    child.once("close", onClose);
  });
}

async function stopOwnedChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForChildClose(child, CHILD_STOP_TIMEOUT_MS)) return;
  child.kill("SIGKILL");
  if (!(await waitForChildClose(child, CHILD_STOP_TIMEOUT_MS))) {
    throw new SafeRelayError("owned App Server process cleanup failed");
  }
}

function runOwnedTask({
  child,
  configuredMcpNames,
  cwd,
  outputSignal,
  staleAfterMs,
  taskInput,
}) {
  return new Promise((resolveRun, rejectRun) => {
    let phase = "initializing";
    let relay = null;
    let claimedThreadId = null;
    let expectedTurnId = null;
    let observedTurnId = null;
    const pendingTerminalNotifications = [];
    let terminalStatus = null;
    let settled = false;
    let input = taskInput;

    const transport = new JsonlDryRunApnsTransport({
      write: (line) => process.stdout.write(line),
    });

    const sweepInterval = setInterval(() => {
      if (relay === null || terminalStatus !== null) return;
      try {
        relay.sweep();
      } catch {
        fail(new SafeRelayError("relay stale sweep failed"));
      }
    }, Math.min(staleAfterMs, 1_000));
    sweepInterval.unref();

    const lines = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    function claimThread(threadId) {
      if (typeof threadId !== "string" || threadId.length === 0) {
        throw new SafeRelayError("App Server returned an invalid thread identifier");
      }
      if (claimedThreadId !== null && claimedThreadId !== threadId) {
        throw new SafeRelayError("App Server attempted to attach a second task");
      }
      if (relay === null) {
        claimedThreadId = threadId;
        relay = new OneTaskRelay({
          threadId,
          transport,
          staleAfterMs,
        });
      }
    }

    function fail(error) {
      if (settled) return;
      if (relay !== null && terminalStatus === null && !outputSignal.aborted) {
        try {
          relay.markDisconnected();
        } catch {
          // Preserve the original safe failure if the output boundary also fails.
        }
      }
      settled = true;
      clearInterval(sweepInterval);
      lines.close();
      outputSignal.removeEventListener("abort", onOutputAbort);
      child.stdin.end();
      child.kill("SIGTERM");
      rejectRun(error);
    }

    function onOutputAbort() {
      fail(new SafeRelayError("dry-run output closed"));
    }

    function finishTerminal(status) {
      if (terminalStatus !== null) return;
      terminalStatus = status;
      child.stdin.end();
    }

    function acceptTerminal({ turnId, status }) {
      relay.ingest({
        method: "turn/completed",
        params: {
          threadId: claimedThreadId,
          turn: { id: turnId, status },
        },
      });
      finishTerminal(status);
    }

    function reconcileTurnCorrelation() {
      if (
        expectedTurnId !== null &&
        observedTurnId !== null &&
        observedTurnId !== expectedTurnId
      ) {
        throw new SafeRelayError(
          "App Server returned inconsistent turn lifecycle identifiers",
        );
      }
      if (expectedTurnId === null) return;
      const terminal = pendingTerminalNotifications.find(
        (candidate) => candidate.turnId === expectedTurnId,
      );
      pendingTerminalNotifications.length = 0;
      if (terminal) acceptTerminal(terminal);
    }

    function handleResponse(message) {
      if (message.error !== undefined) {
        throw new SafeRelayError("App Server rejected a relay protocol request");
      }

      if (message.id === 0 && phase === "initializing") {
        phase = "starting-thread";
        send(child, { method: "initialized", params: {} });
        send(child, {
          method: "thread/start",
          id: 1,
          params: {
            cwd,
            approvalPolicy: "never",
            sandbox: "read-only",
            ephemeral: true,
            serviceName: "codex_live_activity_relay",
          },
        });
        return;
      }

      if (message.id === 1 && phase === "starting-thread") {
        claimThread(message.result?.thread?.id);
        phase = "checking-tools";
        send(child, {
          method: "mcpServerStatus/list",
          id: 2,
          params: {
            threadId: claimedThreadId,
            cursor: null,
            detail: "toolsAndAuthOnly",
            limit: MAX_MCP_SERVERS,
          },
        });
        return;
      }

      if (message.id === 2 && phase === "checking-tools") {
        verifyMcpIsolationStatus(message.result, configuredMcpNames);
        configuredMcpNames.clear();
        phase = "starting-turn";
        send(child, {
          method: "turn/start",
          id: 3,
          params: {
            threadId: claimedThreadId,
            input: [{ type: "text", text: input }],
            cwd,
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
          },
        });
        input = null;
        return;
      }

      if (message.id === 3 && phase === "starting-turn") {
        expectedTurnId = message.result?.turn?.id ?? null;
        if (typeof expectedTurnId !== "string") {
          throw new SafeRelayError("App Server returned an invalid turn identifier");
        }
        phase = "running";
        reconcileTurnCorrelation();
        return;
      }

      throw new SafeRelayError("App Server returned an unexpected response");
    }

    function handleNotification(message) {
      if (message.method === "mcpServer/startupStatus/updated") {
        throw new SafeRelayError("Codex tool isolation verification failed");
      }
      if (message.method === "thread/started" && phase === "starting-thread") {
        claimThread(message.params?.thread?.id);
      }
      if (relay === null) return;

      if (
        message.method === "turn/started" &&
        message.params?.threadId === claimedThreadId
      ) {
        const turnId = message.params?.turn?.id;
        if (
          typeof turnId !== "string" ||
          message.params?.turn?.status !== "inProgress"
        ) {
          throw new SafeRelayError("App Server emitted an invalid turn start");
        }
        if (observedTurnId !== null && observedTurnId !== turnId) {
          throw new SafeRelayError(
            "App Server emitted inconsistent turn lifecycle identifiers",
          );
        }
        observedTurnId = turnId;
        reconcileTurnCorrelation();
      }

      if (
        message.method === "turn/completed" &&
        message.params?.threadId === claimedThreadId
      ) {
        const turnId = message.params?.turn?.id;
        const status = message.params?.turn?.status;
        if (typeof turnId !== "string" || !TERMINAL_STATUSES.has(status)) {
          throw new SafeRelayError(
            "App Server emitted an invalid terminal lifecycle state",
          );
        }
        if (expectedTurnId === null) {
          if (pendingTerminalNotifications.length >= 8) {
            throw new SafeRelayError(
              "App Server emitted too many early terminal notifications",
            );
          }
          pendingTerminalNotifications.push({ turnId, status });
        } else if (turnId === expectedTurnId) {
          acceptTerminal({ turnId, status });
        }
        return;
      }

      if (
        message.method === "thread/closed" &&
        message.params?.threadId === claimedThreadId
      ) {
        relay.ingest(message);
        throw new SafeRelayError(
          "owned App Server thread closed before task completion",
        );
      }

      relay.ingest(message);
    }

    lines.on("line", (line) => {
      if (settled || terminalStatus !== null || line.trim().length === 0) return;
      try {
        const message = JSON.parse(line);
        if (message && message.id !== undefined && message.method === undefined) {
          handleResponse(message);
          return;
        }
        if (message && message.id !== undefined && message.method !== undefined) {
          if (relay !== null && REQUEST_METHODS.has(message.method)) {
            relay.ingest(message);
          }
          throw new SafeRelayError(
            "server-initiated App Server requests are outside the dry-run relay boundary",
          );
        }
        handleNotification(message);
      } catch (error) {
        fail(
          error instanceof SafeRelayError
            ? error
            : new SafeRelayError("App Server emitted an invalid protocol message"),
        );
      }
    });

    child.once("error", () => {
      fail(new SafeRelayError("Codex App Server could not be started"));
    });
    child.stdin.once("error", () => {
      fail(new SafeRelayError("Codex App Server input closed unexpectedly"));
    });

    child.once("close", (code) => {
      if (settled) return;
      try {
        clearInterval(sweepInterval);
        if (relay !== null && terminalStatus === null) relay.markDisconnected();
      } catch {
        fail(new SafeRelayError("relay disconnect handling failed"));
        return;
      }
      settled = true;
      outputSignal.removeEventListener("abort", onOutputAbort);
      if (code !== 0) {
        rejectRun(new SafeRelayError("Codex App Server exited unexpectedly"));
        return;
      }
      if (terminalStatus === null) {
        rejectRun(new SafeRelayError("Codex App Server closed before task completion"));
        return;
      }
      resolveRun({ terminalStatus });
    });

    outputSignal.addEventListener("abort", onOutputAbort, { once: true });
    if (outputSignal.aborted) {
      onOutputAbort();
      return;
    }

    send(child, {
      method: "initialize",
      id: 0,
      params: {
        clientInfo: {
          name: "codex_live_activity_relay",
          title: "Codex Live Activity Relay",
          version: "0.1.0",
        },
      },
    });
  });
}

async function main() {
  let child = null;
  let configuredMcpNames = null;
  let receivedSignal = null;
  let signalCount = 0;
  let signalEscalationTimer = null;
  const outputAbort = new AbortController();

  process.stdout.on("error", () => {
    process.exitCode = 1;
    if (!outputAbort.signal.aborted) {
      outputAbort.abort(new SafeRelayError("dry-run output closed"));
    }
  });

  function handleSignal(signal) {
    signalCount += 1;
    if (receivedSignal === null) receivedSignal = signal;
    if (child && child.exitCode === null && child.signalCode === null) {
      if (signalCount === 1) {
        child.kill("SIGTERM");
        signalEscalationTimer = setTimeout(() => {
          signalEscalationTimer = null;
          if (child && child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, CHILD_STOP_TIMEOUT_MS);
        signalEscalationTimer.unref();
      } else {
        child.kill("SIGKILL");
      }
    } else {
      process.stdin.destroy();
    }
  }

  const handleInterrupt = () => handleSignal("SIGINT");
  const handleTerminate = () => handleSignal("SIGTERM");
  process.on("SIGINT", handleInterrupt);
  process.on("SIGTERM", handleTerminate);

  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    process.off("SIGINT", handleInterrupt);
    process.off("SIGTERM", handleTerminate);
    return;
  }

  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    process.off("SIGINT", handleInterrupt);
    process.off("SIGTERM", handleTerminate);
    return;
  }

  let stateHome = null;
  try {
    let taskInput = await readTaskInput();
    if (receivedSignal !== null) throw new SafeRelayError("relay interrupted");
    stateHome = await mkdtemp(join(tmpdir(), "cla-one-task-relay."));
    if (receivedSignal !== null) throw new SafeRelayError("relay interrupted");
    const appServerEnvironment = {
      ...process.env,
      CODEX_SQLITE_HOME: stateHome,
    };
    delete appServerEnvironment.OPENAI_API_KEY;
    delete appServerEnvironment.CODEX_ACCESS_TOKEN;
    const inventory = startMcpInventory({
      cwd: options.cwd,
      env: appServerEnvironment,
    });
    child = inventory.child;
    configuredMcpNames = await inventory.result;
    if (receivedSignal !== null) throw new SafeRelayError("relay interrupted");
    const appServerArguments = [
      "app-server",
      ...PROCESS_ISOLATION_ARGUMENTS,
      ...mcpDisableArguments([...configuredMcpNames]),
    ];
    child = spawn("codex", appServerArguments, {
      cwd: options.cwd,
      env: appServerEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    appServerArguments.length = 0;
    child.stderr.resume();
    if (receivedSignal !== null) throw new SafeRelayError("relay interrupted");
    const run = runOwnedTask({
      child,
      configuredMcpNames,
      cwd: options.cwd,
      outputSignal: outputAbort.signal,
      staleAfterMs: options.staleAfterMs,
      taskInput,
    });
    taskInput = null;
    const result = await run;
    if (result.terminalStatus !== "completed") process.exitCode = 1;
  } catch (error) {
    if (receivedSignal === null) {
      process.stderr.write(
        `${error instanceof SafeRelayError ? error.message : "relay execution failed"}\n`,
      );
    }
    process.exitCode = 1;
  } finally {
    configuredMcpNames?.clear();
    if (signalEscalationTimer !== null) {
      clearTimeout(signalEscalationTimer);
      signalEscalationTimer = null;
    }
    let childStopped = true;
    try {
      await stopOwnedChild(child);
    } catch {
      childStopped = false;
      process.stderr.write("owned App Server process cleanup failed\n");
      process.exitCode = 1;
    }
    if (stateHome !== null && childStopped) {
      try {
        await removeStateHome(stateHome);
      } catch {
        process.stderr.write(
          `disposable App Server state cleanup failed: ${stateHome}\n`,
        );
        process.exitCode = 1;
      }
    } else if (stateHome !== null) {
      process.stderr.write(`disposable App Server state retained: ${stateHome}\n`);
    }
    process.off("SIGINT", handleInterrupt);
    process.off("SIGTERM", handleTerminate);
    if (receivedSignal === "SIGINT") process.exitCode = 130;
    if (receivedSignal === "SIGTERM") process.exitCode = 143;
  }
}

await main();
