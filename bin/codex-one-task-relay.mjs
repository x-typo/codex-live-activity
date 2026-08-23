#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { createMacLocalTurnActionComposition } from "../src/mac-local-turn-action-composition.mjs";
import {
  JsonlDryRunApnsTransport,
  OneTaskRelay,
} from "../src/one-task-relay.mjs";
import {
  MockOneTaskTurnActionBoundary,
  RelayTurnActionOutcomeUnknownError,
} from "../src/relay-turn-action.mjs";
import {
  createRemoteActionReceipt,
  serializeRemoteActionReceipt,
} from "../src/remote-action-receipt.mjs";
import { REMOTE_TURN_ACTION_PATH } from "../src/tailscale-turn-action-ingress.mjs";

const REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

const TERMINAL_STATUSES = new Set(["completed", "failed", "interrupted"]);
const CHILD_STOP_TIMEOUT_MS = 2_000;
const ACTION_RESPONSE_TIMEOUT_MS = 10_000;
const LOOPBACK_PROOF_ACTIVATION_TIMEOUT_MS = 5_000;
const LOOPBACK_PROOF_TERMINAL_TIMEOUT_MS = 10_000;
const LOCAL_LONG_TASK_PROOF_ACTIVATION_TIMEOUT_MS = 60_000;
const LOCAL_LONG_TASK_PROOF_OBSERVATION_MS = 125_000;
const LOCAL_LONG_TASK_PROOF_TERMINAL_TIMEOUT_MS = 10_000;
const LOCAL_LONG_TASK_PROOF_ACTION_ID = "local-long-task-stop";
const MODEL_OWNED_COMMAND_SOURCES = new Set(["agent", "unifiedExecStartup"]);
const MAX_EXTERNAL_STOP_PROOF_ACTIVATION_TIMEOUT_MS = 60_000;
const MAX_EXTERNAL_STOP_PROOF_TIMEOUT_MS = 120_000;
const EXTERNAL_STOP_PROOF_TERMINAL_TIMEOUT_MS = 10_000;
const EXTERNAL_STOP_PROOF_INSTALLATION_ID = "external-iphone-stop-proof";
const EXTERNAL_STOP_CONTEXT_PREFIX = "control context: ";
const EXTERNAL_STOP_OPTIONS = new Set([
  "--action-app-token-file",
  "--action-capability",
  "--action-expected-authority",
  "--action-hmac-key-file",
  "--action-port",
  "--action-replay-root",
  "--action-timeout-ms",
]);
const MAX_MCP_INVENTORY_BYTES = 4 * 1024 * 1024;
const MAX_MCP_SERVERS = 256;
const LOOPBACK_PROOF_CAPABILITY =
  "github.com/x-typo/codex-live-activity/cap/control";
const LOOPBACK_PROOF_INSTALLATION_ID = "local-proof";
const LOOPBACK_PROOF_REPLY_TEXT = "Continue the bounded local proof.";
const REPOSITORY_ROOT = resolve(
  fileURLToPath(new URL("../", import.meta.url)),
);
const OWNED_PROCESS_GROUP = Symbol("ownedProcessGroup");
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

let stderrWritable = true;
let externalStatusFailure = null;
process.stderr.on("error", () => {
  stderrWritable = false;
  externalStatusFailure?.();
});

function writeSafeStderr(value) {
  if (!stderrWritable || process.stderr.destroyed) return false;
  try {
    return process.stderr.write(value, (error) => {
      if (error) stderrWritable = false;
    });
  } catch {
    stderrWritable = false;
    return false;
  }
}

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
    "  --loopback-action-proof  Self-drive one synthetic Reply and Stop over localhost",
    "  --local-long-task-proof  Prove one model-owned command stays active for 125 seconds",
    "  --local-long-task-observation-ms <ms>",
    "                           Local observation window (default: 125000)",
    "  --external-stop-proof    Wait for one externally driven Stop over localhost",
    "  --action-port <port>     Fixed loopback listener port for external Stop proof",
    "  --action-expected-authority <authority>",
    "                           Exact Serve-forwarded DNS Host authority",
    "  --action-capability <id> Parameterless Tailscale capability identifier",
    "  --action-app-token-file <absolute-path>",
    "  --action-hmac-key-file <absolute-path>",
    "  --action-replay-root <absolute-path>",
    "  --action-timeout-ms <ms> External proof/context timeout (max: 120000)",
    "  --help                   Show this help",
  ].join("\n");
}

function parseExternalProofInteger(value, maximum) {
  if (!/^(?:0|[1-9]\d*)$/u.test(value ?? "")) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum
    ? parsed
    : null;
}

function isParameterlessCapability(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.toWellFormed() &&
    /^[A-Za-z0-9][A-Za-z0-9./:_-]*$/u.test(value) &&
    value.includes("/")
  );
}

function isExactExternalStopProofAction(candidate, expected) {
  return (
    expected !== null &&
    candidate.schemaVersion === expected.schemaVersion &&
    candidate.actionId === expected.actionId &&
    candidate.controlContextId === expected.controlContextId &&
    candidate.issuedAt === expected.issuedAt &&
    candidate.expiresAt === expected.expiresAt &&
    candidate.action === expected.action &&
    Object.keys(candidate).length === Object.keys(expected).length
  );
}

function parseArguments(argumentsList) {
  let cwd = process.cwd();
  let staleAfterMs = 60_000;
  let loopbackActionProof = false;
  let localLongTaskProof = false;
  let localLongTaskObservationMs = LOCAL_LONG_TASK_PROOF_OBSERVATION_MS;
  let localLongTaskObservationSupplied = false;
  let externalStopProof = false;
  const externalValues = new Map();
  const externalModeRequested = argumentsList.includes("--external-stop-proof");

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
    if (argument === "--loopback-action-proof") {
      if (loopbackActionProof) {
        throw new SafeRelayError("--loopback-action-proof may be supplied only once");
      }
      loopbackActionProof = true;
      continue;
    }
    if (argument === "--local-long-task-proof") {
      if (localLongTaskProof) {
        throw new SafeRelayError(
          "--local-long-task-proof may be supplied only once",
        );
      }
      localLongTaskProof = true;
      continue;
    }
    if (argument === "--local-long-task-observation-ms") {
      if (localLongTaskObservationSupplied) {
        throw new SafeRelayError("local long-task proof options are invalid");
      }
      const value = parseExternalProofInteger(
        argumentsList[index + 1],
        600_000,
      );
      if (value === null || value < 1_000) {
        throw new SafeRelayError("local long-task proof options are invalid");
      }
      localLongTaskObservationMs = value;
      localLongTaskObservationSupplied = true;
      index += 1;
      continue;
    }
    if (argument === "--external-stop-proof") {
      if (externalStopProof) {
        throw new SafeRelayError("--external-stop-proof may be supplied only once");
      }
      externalStopProof = true;
      continue;
    }
    if (EXTERNAL_STOP_OPTIONS.has(argument)) {
      const value = argumentsList[index + 1];
      if (value === undefined || externalValues.has(argument)) {
        throw new SafeRelayError("external Stop proof options are invalid");
      }
      externalValues.set(argument, value);
      index += 1;
      continue;
    }
    throw new SafeRelayError(
      externalModeRequested
        ? "external Stop proof options are invalid"
        : `Unknown option: ${argument}`,
    );
  }

  if (
    [loopbackActionProof, localLongTaskProof, externalStopProof].filter(Boolean)
      .length > 1
  ) {
    throw new SafeRelayError("action proof modes are mutually exclusive");
  }
  if (!externalStopProof && externalValues.size > 0) {
    throw new SafeRelayError(
      "external Stop proof options require --external-stop-proof",
    );
  }
  if (!localLongTaskProof && localLongTaskObservationSupplied) {
    throw new SafeRelayError(
      "local long-task proof options require --local-long-task-proof",
    );
  }

  let externalStopOptions = null;
  if (externalStopProof) {
    const port = parseExternalProofInteger(
      externalValues.get("--action-port"),
      65_535,
    );
    const timeoutMs = parseExternalProofInteger(
      externalValues.get("--action-timeout-ms"),
      MAX_EXTERNAL_STOP_PROOF_TIMEOUT_MS,
    );
    const appTokenPath = externalValues.get("--action-app-token-file");
    const hmacKeyPath = externalValues.get("--action-hmac-key-file");
    const replayDirectoryPath = externalValues.get("--action-replay-root");
    const expectedCapability = externalValues.get("--action-capability");
    const expectedAuthority = externalValues.get(
      "--action-expected-authority",
    );
    const statePaths = [appTokenPath, hmacKeyPath, replayDirectoryPath];
    if (
      externalValues.size !== EXTERNAL_STOP_OPTIONS.size ||
      port === null ||
      timeoutMs === null ||
      !isParameterlessCapability(expectedCapability) ||
      typeof expectedAuthority !== "string" ||
      expectedAuthority.length === 0 ||
      !statePaths.every(
        (path) => typeof path === "string" && isAbsolute(path),
      ) ||
      new Set(statePaths).size !== statePaths.length
    ) {
      throw new SafeRelayError("external Stop proof options are invalid");
    }
    externalStopOptions = {
      appTokenPath,
      expectedAuthority,
      expectedCapability,
      hmacKeyPath,
      port,
      replayDirectoryPath,
      timeoutMs,
    };
  }

  return {
    help: false,
    cwd,
    staleAfterMs,
    loopbackActionProof,
    localLongTaskProof,
    localLongTaskObservationMs,
    externalStopOptions,
  };
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

async function createLoopbackProofState() {
  const root = await mkdtemp(join(tmpdir(), "cla-local-action-proof."));
  try {
    const secretRoot = join(root, "secrets");
    const replayDirectoryPath = join(root, "replay");
    const appTokenPath = join(secretRoot, "app-token");
    const hmacKeyPath = join(secretRoot, "hmac-key");
    await chmod(root, 0o700);
    await Promise.all([
      mkdir(secretRoot, { mode: 0o700 }),
      mkdir(replayDirectoryPath, { mode: 0o700 }),
    ]);
    await Promise.all([
      chmod(secretRoot, 0o700),
      chmod(replayDirectoryPath, 0o700),
    ]);

    const appTokenBytes = randomBytes(32);
    let hmacKeyBytes = randomBytes(32);
    while (appTokenBytes.equals(hmacKeyBytes)) {
      hmacKeyBytes.fill(0);
      hmacKeyBytes = randomBytes(32);
    }
    const appToken = appTokenBytes.toString("base64url");
    const hmacKey = hmacKeyBytes.toString("base64url");
    appTokenBytes.fill(0);
    hmacKeyBytes.fill(0);
    await Promise.all([
      writeFile(appTokenPath, appToken, { mode: 0o600 }),
      writeFile(hmacKeyPath, hmacKey, { mode: 0o600 }),
    ]);
    await Promise.all([chmod(appTokenPath, 0o600), chmod(hmacKeyPath, 0o600)]);
    return {
      root,
      appToken,
      appTokenPath,
      hmacKeyPath,
      replayDirectoryPath,
    };
  } catch {
    await rm(root, { recursive: true, force: true });
    throw new SafeRelayError("synthetic loopback proof state could not be created");
  }
}

function sendLoopbackProofAction({ address, appToken, action }) {
  const body = Buffer.from(JSON.stringify(action));
  const expectedBody = serializeRemoteActionReceipt(
    createRemoteActionReceipt({
      action,
      outcome: "accepted",
      reason: null,
    }),
  );
  return new Promise((resolveAction, rejectAction) => {
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      rejectAction(new SafeRelayError("loopback action proof was rejected"));
    };
    const request = httpRequest(
      {
        agent: false,
        host: address.host,
        port: address.port,
        method: "POST",
        path: REMOTE_TURN_ACTION_PATH,
        headers: {
          authorization: `Bearer ${appToken}`,
          "content-length": body.byteLength,
          "content-type": "application/json",
          "tailscale-app-capabilities": JSON.stringify({
            [LOOPBACK_PROOF_CAPABILITY]: [{}],
          }),
        },
      },
      (response) => {
        let bytes = 0;
        let chunks = [];
        response.on("data", (chunk) => {
          if (settled) return;
          bytes += chunk.byteLength;
          if (bytes > 4_096) {
            chunks = [];
            response.destroy();
            fail();
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", fail);
        response.on("end", () => {
          if (settled) return;
          const responseBody = Buffer.concat(chunks, bytes).toString("utf8");
          chunks = [];
          if (response.statusCode !== 200 || responseBody !== expectedBody) {
            fail();
            return;
          }
          settled = true;
          resolveAction();
        });
      },
    );
    request.setTimeout(ACTION_RESPONSE_TIMEOUT_MS, () =>
      request.destroy(new SafeRelayError("loopback action proof timed out")),
    );
    request.on("error", fail);
    request.end(body);
  });
}

async function runLoopbackActionProof({
  address,
  appToken,
  publicContext,
  writeStatus,
}) {
  const issuedAtMs = Date.now();
  if (!Number.isSafeInteger(issuedAtMs)) {
    throw new SafeRelayError("loopback action proof clock was invalid");
  }
  const expiresAtMs = issuedAtMs + 30_000;
  const shared = {
    schemaVersion: 1,
    controlContextId: publicContext.controlContextId,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
  await sendLoopbackProofAction({
    address,
    appToken,
    action: {
      ...shared,
      actionId: "local-proof-reply-1",
      action: "reply",
      text: LOOPBACK_PROOF_REPLY_TEXT,
    },
  });
  writeStatus("loopback proof: Reply accepted\n");
  await sendLoopbackProofAction({
    address,
    appToken,
    action: {
      ...shared,
      actionId: "local-proof-stop-1",
      action: "stop",
    },
  });
  writeStatus("loopback proof: Stop accepted\n");
}

function signalOwnedChild(child, signal) {
  if (!child) return false;
  if (child[OWNED_PROCESS_GROUP] === true && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      throw error;
    }
  }
  return child.kill(signal);
}

function ownedChildTreeIsRunning(child) {
  if (!child) return false;
  if (child[OWNED_PROCESS_GROUP] !== true || !Number.isInteger(child.pid)) {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
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
  if (!child) return;
  const processGroupOwned = child[OWNED_PROCESS_GROUP] === true;
  const childRunning = child.exitCode === null && child.signalCode === null;
  if (childRunning) {
    try {
      signalOwnedChild(child, "SIGTERM");
    } catch {
      // A concurrent group exit is resolved by the bounded child-close wait.
    }
  }
  if (!(await waitForChildClose(child, CHILD_STOP_TIMEOUT_MS))) {
    try {
      signalOwnedChild(child, "SIGKILL");
    } catch {
      // The bounded child-close check below remains authoritative.
    }
  }
  if (!(await waitForChildClose(child, CHILD_STOP_TIMEOUT_MS))) {
    throw new SafeRelayError("owned App Server process cleanup failed");
  }
  if (processGroupOwned) {
    try {
      signalOwnedChild(child, "SIGKILL");
    } catch {
      // The group can disappear between wrapper reaping and this final sweep.
    }
  }
}

function runOwnedTask({
  actionComposition,
  actionProof,
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
    let actionBoundary = null;
    let actionProofStarted = false;
    let actionProofActionsAccepted = false;
    let actionProofConfirmed = false;
    let actionProofActivationTimer = null;
    let actionProofTerminalTimer = null;
    let externalStopResponseObserved = false;
    let localLongTaskResponseObserved = false;
    let trackedModelOwnedCommand = null;
    let pendingModelOwnedCommandStart = null;
    let stopDispatchStarted = false;
    const pendingActionResponses = new Map();

    const isExternalStopProof = actionProof?.mode === "external-stop";
    const isLocalLongTaskProof = actionProof?.mode === "local-long-task";
    const requiresModelOwnedCommandReadiness =
      isExternalStopProof || isLocalLongTaskProof;

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

    function clearActionProofTerminalTimer() {
      if (actionProofTerminalTimer === null) return;
      clearTimeout(actionProofTerminalTimer);
      actionProofTerminalTimer = null;
    }

    function clearActionProofActivationTimer() {
      if (actionProofActivationTimer === null) return;
      clearTimeout(actionProofActivationTimer);
      actionProofActivationTimer = null;
    }

    function armActionProofActivationTimer() {
      if (
        actionProof === null ||
        actionProofStarted ||
        actionProofActivationTimer !== null
      ) {
        return;
      }
      actionProofActivationTimer = setTimeout(
        () =>
          fail(
            new SafeRelayError(
              isExternalStopProof
                ? "external Stop proof did not observe a model-owned command"
                : isLocalLongTaskProof
                  ? "local long-task proof did not observe a sustained command"
                : "loopback action proof did not observe a matching turn start",
            ),
          ),
        isExternalStopProof
          ? Math.min(
              actionProof.timeoutMs,
              MAX_EXTERNAL_STOP_PROOF_ACTIVATION_TIMEOUT_MS,
            )
          : isLocalLongTaskProof
            ? LOCAL_LONG_TASK_PROOF_ACTIVATION_TIMEOUT_MS
            : LOOPBACK_PROOF_ACTIVATION_TIMEOUT_MS,
      );
      actionProofActivationTimer.unref();
    }

    function revokeActiveTurn() {
      try {
        if (claimedThreadId !== null && expectedTurnId !== null) {
          actionComposition?.revokeTurn({
            threadId: claimedThreadId,
            expectedTurnId,
          });
        } else {
          actionComposition?.revokeAll();
        }
      } catch {
        try {
          actionComposition?.revokeAll();
        } catch {
          // Teardown must continue even if an injected revocation seam fails.
        }
      }
      actionBoundary?.clearStopPending();
    }

    function rejectPendingActionResponses() {
      const error = new RelayTurnActionOutcomeUnknownError();
      for (const pending of pendingActionResponses.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      pendingActionResponses.clear();
    }

    function sendAppServerActionRequest(request) {
      if (
        settled ||
        phase !== "running" ||
        terminalStatus !== null ||
        typeof request?.id !== "string" ||
        pendingActionResponses.has(request.id)
      ) {
        return Promise.reject(
          new SafeRelayError("App Server action request was unavailable"),
        );
      }

      return new Promise((resolveResponse, rejectResponse) => {
        let written = false;
        const timeout = setTimeout(() => {
          if (!pendingActionResponses.delete(request.id)) return;
          rejectResponse(new RelayTurnActionOutcomeUnknownError());
        }, ACTION_RESPONSE_TIMEOUT_MS);
        timeout.unref();
        pendingActionResponses.set(request.id, {
          resolve: resolveResponse,
          reject: rejectResponse,
          request,
          timeout,
        });
        try {
          child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
            if (!error || !pendingActionResponses.has(request.id)) return;
            const pending = pendingActionResponses.get(request.id);
            pendingActionResponses.delete(request.id);
            clearTimeout(pending.timeout);
            pending.reject(
              written
                ? new RelayTurnActionOutcomeUnknownError()
                : new SafeRelayError("App Server action request was unavailable"),
            );
          });
          written = true;
        } catch {
          const pending = pendingActionResponses.get(request.id);
          pendingActionResponses.delete(request.id);
          clearTimeout(pending.timeout);
          rejectResponse(
            written
              ? new RelayTurnActionOutcomeUnknownError()
              : new SafeRelayError("App Server action request was unavailable"),
          );
        }
      });
    }

    function maybeConfirmActionProof() {
      if (actionProof === null || actionProofConfirmed || settled) return;
      if (terminalStatus !== null && terminalStatus !== "interrupted") {
        fail(
          new SafeRelayError(
            isExternalStopProof
              ? "external Stop proof did not interrupt the task"
              : isLocalLongTaskProof
                ? "local long-task proof did not interrupt the task"
                : "loopback action proof did not interrupt the task",
          ),
        );
        return;
      }
      if (!actionProofActionsAccepted || terminalStatus !== "interrupted") {
        return;
      }
      clearActionProofTerminalTimer();
      actionProofConfirmed = true;
      if (isExternalStopProof) {
        child.stdin.end();
      } else {
        actionProof.writeStatus(
          isLocalLongTaskProof
            ? "local long-task proof: interrupted lifecycle confirmed\n"
            : "loopback proof: interrupted lifecycle confirmed\n",
        );
        child.stdin.end();
      }
    }

    function acceptExternalStopDispatch(action) {
      stopDispatchStarted = true;
      clearActionProofTerminalTimer();
      return actionBoundary.dispatch(action).then(
        (receipt) => {
          if (
            Object.keys(receipt ?? {}).length !== 6 ||
            receipt.schemaVersion !== 1 ||
            receipt.actionId !== action.actionId ||
            receipt.action !== "stop" ||
            receipt.outcome !== "accepted" ||
            receipt.reason !== null ||
            receipt.appServerMethod !== "turn/interrupt"
          ) {
            fail(new SafeRelayError("external Stop proof was rejected"));
            return receipt;
          }
          actionProofActionsAccepted = true;
          if (terminalStatus === null) {
            actionProofTerminalTimer = setTimeout(
              () =>
                fail(
                  new SafeRelayError(
                    "external Stop was not confirmed by terminal lifecycle",
                  ),
                ),
              EXTERNAL_STOP_PROOF_TERMINAL_TIMEOUT_MS,
            );
            actionProofTerminalTimer.unref();
          }
          maybeConfirmActionProof();
          return receipt;
        },
        (error) => {
          fail(new SafeRelayError("external Stop proof response was unknown"));
          throw error;
        },
      );
    }

    function acceptLocalLongTaskDispatch() {
      stopDispatchStarted = true;
      return actionBoundary
        .dispatch({
          schemaVersion: 1,
          actionId: LOCAL_LONG_TASK_PROOF_ACTION_ID,
          action: "stop",
          threadId: claimedThreadId,
          expectedTurnId,
        })
        .then(
          (receipt) => {
            if (
              Object.keys(receipt ?? {}).length !== 6 ||
              receipt.schemaVersion !== 1 ||
              receipt.actionId !== LOCAL_LONG_TASK_PROOF_ACTION_ID ||
              receipt.action !== "stop" ||
              receipt.outcome !== "accepted" ||
              receipt.reason !== null ||
              receipt.appServerMethod !== "turn/interrupt"
            ) {
              fail(new SafeRelayError("local long-task proof was rejected"));
              return receipt;
            }
            actionProofActionsAccepted = true;
            if (terminalStatus === null) {
              actionProofTerminalTimer = setTimeout(
                () =>
                  fail(
                    new SafeRelayError(
                      "local long-task Stop was not confirmed by terminal lifecycle",
                    ),
                  ),
                LOCAL_LONG_TASK_PROOF_TERMINAL_TIMEOUT_MS,
              );
              actionProofTerminalTimer.unref();
            }
            maybeConfirmActionProof();
            return receipt;
          },
          () => {
            fail(new SafeRelayError("local long-task proof response was unknown"));
          },
        );
    }

    function projectModelOwnedCommandStart(message) {
      if (!requiresModelOwnedCommandReadiness) return null;
      const item = message.params?.item;
      if (
        message.params?.threadId !== claimedThreadId ||
        typeof message.params?.turnId !== "string" ||
        message.params.turnId.length === 0 ||
        item?.type !== "commandExecution" ||
        !MODEL_OWNED_COMMAND_SOURCES.has(item.source) ||
        item.status !== "inProgress" ||
        typeof item.id !== "string" ||
        item.id.length === 0 ||
        item.id !== item.id.toWellFormed() ||
        /[\r\n\t]/u.test(item.id) ||
        [...item.id].length > 128
      ) {
        return null;
      }
      return Object.freeze({
        threadId: message.params.threadId,
        turnId: message.params.turnId,
        itemId: item.id,
        type: item.type,
        source: item.source,
        status: item.status,
      });
    }

    function sameModelOwnedCommand(left, right) {
      return (
        left.threadId === right.threadId &&
        left.turnId === right.turnId &&
        left.itemId === right.itemId &&
        left.type === right.type &&
        left.source === right.source &&
        left.status === right.status
      );
    }

    function startProofFromCorrelatedCommand(candidate) {
      if (
        !requiresModelOwnedCommandReadiness ||
        actionProofStarted ||
        trackedModelOwnedCommand !== null ||
        phase !== "running" ||
        terminalStatus !== null ||
        expectedTurnId === null ||
        expectedTurnId !== observedTurnId ||
        candidate.threadId !== claimedThreadId ||
        candidate.turnId !== expectedTurnId
      ) {
        return false;
      }
      trackedModelOwnedCommand = candidate;
      if (isExternalStopProof) {
        beginActionProof();
        return true;
      }
      clearActionProofActivationTimer();
      actionProofStarted = true;
      actionBoundary = new MockOneTaskTurnActionBoundary({
        threadId: claimedThreadId,
        getActiveTurnId: () =>
          terminalStatus === null && expectedTurnId === observedTurnId
            ? expectedTurnId
            : null,
        sendRequest: sendAppServerActionRequest,
      });
      actionProofTerminalTimer = setTimeout(() => {
        actionProofTerminalTimer = null;
        if (settled || terminalStatus !== null) return;
        if (
          !actionProof.writeStatus(
            "local long-task proof: observation window confirmed\n",
          )
        ) {
          fail(
            new SafeRelayError("local long-task proof output was unavailable"),
          );
          return;
        }
        void acceptLocalLongTaskDispatch();
      }, actionProof.observationMs);
      actionProofTerminalTimer.unref();
      return true;
    }

    function handleModelOwnedCommandStart(message) {
      const candidate = projectModelOwnedCommandStart(message);
      if (candidate === null) return;
      if (trackedModelOwnedCommand !== null) {
        if (sameModelOwnedCommand(trackedModelOwnedCommand, candidate)) return;
        if (!stopDispatchStarted) {
          throw new SafeRelayError(
            "App Server emitted another model-owned command before Stop dispatch",
          );
        }
        return;
      }
      if (
        phase === "running" &&
        expectedTurnId !== null &&
        observedTurnId !== null
      ) {
        if (
          candidate.threadId !== claimedThreadId ||
          candidate.turnId !== expectedTurnId ||
          observedTurnId !== expectedTurnId
        ) {
          throw new SafeRelayError(
            "App Server emitted inconsistent command lifecycle identifiers",
          );
        }
        startProofFromCorrelatedCommand(candidate);
        return;
      }
      if (
        terminalStatus !== null ||
        (phase !== "starting-turn" && phase !== "running")
      ) {
        return;
      }
      if (pendingModelOwnedCommandStart === null) {
        pendingModelOwnedCommandStart = candidate;
        return;
      }
      if (sameModelOwnedCommand(pendingModelOwnedCommandStart, candidate)) return;
      throw new SafeRelayError(
        "App Server emitted too many early command start notifications",
      );
    }

    function beginActionProof() {
      if (
        actionProof === null ||
        actionProofStarted ||
        phase !== "running" ||
        expectedTurnId === null ||
        expectedTurnId !== observedTurnId
      ) {
        return;
      }
      if (isLocalLongTaskProof) return;
      if (isExternalStopProof && trackedModelOwnedCommand === null) return;
      clearActionProofActivationTimer();
      actionBoundary = new MockOneTaskTurnActionBoundary({
        threadId: claimedThreadId,
        getActiveTurnId: () =>
          terminalStatus === null && expectedTurnId === observedTurnId
            ? expectedTurnId
            : null,
        sendRequest: sendAppServerActionRequest,
      });
      try {
        const publicControlContext = actionComposition.activate({
          threadId: claimedThreadId,
          expectedTurnId,
          dispatch: (action) =>
            isExternalStopProof
              ? acceptExternalStopDispatch(action)
              : actionBoundary.dispatch(action),
        });
        actionProofStarted = true;
        if (isExternalStopProof) {
          const artifact = {
            schemaVersion: 1,
            kind: "controlContext",
            controlContextId: publicControlContext.controlContextId,
            expiresAt: publicControlContext.expiresAt,
          };
          if (
            !actionProof.writeStatus(
              `${EXTERNAL_STOP_CONTEXT_PREFIX}${JSON.stringify(artifact)}\n`,
            )
          ) {
            fail(new SafeRelayError("external Stop proof output was unavailable"));
            return;
          }
          actionProofTerminalTimer = setTimeout(
            () => fail(new SafeRelayError("external Stop proof timed out")),
            actionProof.timeoutMs,
          );
          actionProofTerminalTimer.unref();
          return;
        }
        void runLoopbackActionProof({
          address: actionProof.address,
          appToken: actionProof.appToken,
          publicContext: publicControlContext,
          writeStatus: actionProof.writeStatus,
        }).then(
          () => {
            if (settled) return;
            actionProofActionsAccepted = true;
            if (terminalStatus === null) {
              actionProofTerminalTimer = setTimeout(
                () =>
                  fail(
                    new SafeRelayError(
                      "loopback Stop was not confirmed by terminal lifecycle",
                    ),
                  ),
                LOOPBACK_PROOF_TERMINAL_TIMEOUT_MS,
              );
              actionProofTerminalTimer.unref();
            }
            maybeConfirmActionProof();
          },
          (error) =>
            fail(
              error instanceof SafeRelayError
                ? error
                : new SafeRelayError("loopback action proof failed"),
            ),
        );
      } catch {
        fail(
          new SafeRelayError(
            isExternalStopProof
              ? "external Stop proof could not be activated"
              : "loopback action proof could not be activated",
          ),
        );
      }
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      if (isExternalStopProof) externalStatusFailure = null;
      clearActionProofActivationTimer();
      clearActionProofTerminalTimer();
      revokeActiveTurn();
      rejectPendingActionResponses();
      if (relay !== null && terminalStatus === null && !outputSignal.aborted) {
        try {
          relay.markDisconnected();
        } catch {
          // Preserve the original safe failure if the output boundary also fails.
        }
      }
      clearInterval(sweepInterval);
      lines.close();
      outputSignal.removeEventListener("abort", onOutputAbort);
      child.stdin.end();
      try {
        signalOwnedChild(child, "SIGTERM");
      } catch {
        // The main cleanup path will report a process-tree cleanup failure.
      }
      rejectRun(error);
    }

    if (isExternalStopProof) {
      externalStatusFailure = () =>
        fail(new SafeRelayError("external Stop proof output was unavailable"));
      actionProof.onUnexpectedAction = () =>
        fail(new SafeRelayError("external Stop proof observed another action"));
      if (actionProof.unexpectedAction) actionProof.onUnexpectedAction();
    }

    function onOutputAbort() {
      fail(new SafeRelayError("dry-run output closed"));
    }

    function finishTerminal(status) {
      if (terminalStatus !== null) return;
      if (
        isExternalStopProof &&
        status === "interrupted" &&
        !externalStopResponseObserved
      ) {
        fail(
          new SafeRelayError(
            "external Stop lifecycle preceded App Server acceptance",
          ),
        );
        return;
      }
      if (
        isLocalLongTaskProof &&
        status === "interrupted" &&
        !localLongTaskResponseObserved
      ) {
        fail(
          new SafeRelayError(
            "local long-task lifecycle preceded App Server acceptance",
          ),
        );
        return;
      }
      terminalStatus = status;
      revokeActiveTurn();
      if (actionProof === null) {
        child.stdin.end();
        return;
      }
      if (!actionProofStarted) {
        fail(
          new SafeRelayError(
            isExternalStopProof
              ? "task ended before external Stop proof activation"
              : isLocalLongTaskProof
                ? "task ended before local long-task proof activation"
              : "task ended before loopback proof activation",
          ),
        );
        return;
      }
      maybeConfirmActionProof();
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
      if (terminal) {
        acceptTerminal(terminal);
        return;
      }
      if (
        requiresModelOwnedCommandReadiness &&
        pendingModelOwnedCommandStart !== null &&
        observedTurnId !== null
      ) {
        const candidate = pendingModelOwnedCommandStart;
        pendingModelOwnedCommandStart = null;
        if (
          candidate.threadId !== claimedThreadId ||
          candidate.turnId !== expectedTurnId ||
          observedTurnId !== expectedTurnId
        ) {
          throw new SafeRelayError(
            "App Server emitted inconsistent command lifecycle identifiers",
          );
        }
        startProofFromCorrelatedCommand(candidate);
      }
      armActionProofActivationTimer();
      beginActionProof();
    }

    function handleResponse(message) {
      const pendingAction = pendingActionResponses.get(message.id);
      if (pendingAction !== undefined) {
        if (isExternalStopProof || isLocalLongTaskProof) {
          if (
            pendingAction.request.method !== "turn/interrupt" ||
            message.id !== pendingAction.request.id ||
            message.error !== undefined ||
            message.result === null ||
            typeof message.result !== "object" ||
            Array.isArray(message.result) ||
            Object.keys(message.result).length !== 0 ||
            Object.keys(message).length !== 2
          ) {
            throw new SafeRelayError(
              isExternalStopProof
                ? "external Stop proof response was unknown"
                : "local long-task proof response was unknown",
            );
          }
          if (isExternalStopProof) {
            externalStopResponseObserved = true;
          } else {
            localLongTaskResponseObserved = true;
          }
        }
        pendingActionResponses.delete(message.id);
        clearTimeout(pendingAction.timeout);
        pendingAction.resolve(message);
        return;
      }
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
        armActionProofActivationTimer();
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

      if (message.method === "item/started") {
        handleModelOwnedCommandStart(message);
      }

      if (
        requiresModelOwnedCommandReadiness &&
        !stopDispatchStarted &&
        message.method === "item/completed" &&
        ((actionProofStarted &&
          message.params?.threadId === claimedThreadId &&
          message.params?.turnId === expectedTurnId &&
          message.params?.item?.id === trackedModelOwnedCommand?.itemId) ||
          (!actionProofStarted &&
            pendingModelOwnedCommandStart !== null &&
            message.params?.threadId === pendingModelOwnedCommandStart.threadId &&
            message.params?.turnId === pendingModelOwnedCommandStart.turnId &&
            message.params?.item?.id === pendingModelOwnedCommandStart.itemId))
      ) {
        fail(
          new SafeRelayError(
            isExternalStopProof
              ? "external Stop proof command ended before authenticated dispatch"
              : "local long-task proof command ended before the observation window",
          ),
        );
        return;
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
      if (settled || line.trim().length === 0) return;
      try {
        const message = JSON.parse(line);
        if (message && message.id !== undefined && message.method === undefined) {
          handleResponse(message);
          return;
        }
        if (terminalStatus !== null) return;
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
      settled = true;
      clearActionProofActivationTimer();
      clearActionProofTerminalTimer();
      revokeActiveTurn();
      rejectPendingActionResponses();
      if (isExternalStopProof) externalStatusFailure = null;
      try {
        clearInterval(sweepInterval);
        if (relay !== null && terminalStatus === null) relay.markDisconnected();
      } catch {
        outputSignal.removeEventListener("abort", onOutputAbort);
        rejectRun(new SafeRelayError("relay disconnect handling failed"));
        return;
      }
      outputSignal.removeEventListener("abort", onOutputAbort);
      if (code !== 0) {
        rejectRun(new SafeRelayError("Codex App Server exited unexpectedly"));
        return;
      }
      if (terminalStatus === null) {
        rejectRun(new SafeRelayError("Codex App Server closed before task completion"));
        return;
      }
      if (actionProof !== null && !actionProofConfirmed) {
        rejectRun(
          new SafeRelayError(
            isExternalStopProof
              ? "external Stop proof was not confirmed"
              : isLocalLongTaskProof
                ? "local long-task proof was not confirmed"
              : "loopback action proof was not confirmed",
          ),
        );
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
  let actionComposition = null;
  let actionProofState = null;
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
        signalOwnedChild(child, "SIGTERM");
        signalEscalationTimer = setTimeout(() => {
          signalEscalationTimer = null;
          if (child && ownedChildTreeIsRunning(child)) {
            signalOwnedChild(child, "SIGKILL");
          }
        }, CHILD_STOP_TIMEOUT_MS);
        signalEscalationTimer.unref();
      } else {
        signalOwnedChild(child, "SIGKILL");
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
    writeSafeStderr(`${error.message}\n`);
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
    let actionProof = null;
    if (options.loopbackActionProof) {
      actionProofState = await createLoopbackProofState();
      actionComposition = await createMacLocalTurnActionComposition({
        installationId: LOOPBACK_PROOF_INSTALLATION_ID,
        expectedCapability: LOOPBACK_PROOF_CAPABILITY,
        appTokenPath: actionProofState.appTokenPath,
        hmacKeyPath: actionProofState.hmacKeyPath,
        replayDirectoryPath: actionProofState.replayDirectoryPath,
        repositoryRoot: REPOSITORY_ROOT,
      });
      const address = await actionComposition.start();
      actionProof = {
        mode: "loopback",
        address,
        appToken: actionProofState.appToken,
        writeStatus: writeSafeStderr,
      };
    } else if (options.localLongTaskProof) {
      actionProof = {
        mode: "local-long-task",
        observationMs: options.localLongTaskObservationMs,
        writeStatus: writeSafeStderr,
      };
    } else if (options.externalStopOptions !== null) {
      const externalProof = {
        mode: "external-stop",
        timeoutMs: options.externalStopOptions.timeoutMs,
        unexpectedAction: false,
        onUnexpectedAction: null,
        writeStatus: writeSafeStderr,
      };
      let admittedAction = null;
      const rejectUnexpectedAction = () => {
        externalProof.unexpectedAction = true;
        queueMicrotask(() => externalProof.onUnexpectedAction?.());
        return false;
      };
      actionComposition = await createMacLocalTurnActionComposition({
        installationId: EXTERNAL_STOP_PROOF_INSTALLATION_ID,
        expectedCapability: options.externalStopOptions.expectedCapability,
        admitResolvedAction: (action) => {
          if (admittedAction === null) {
            if (action.action !== "stop") return rejectUnexpectedAction();
            admittedAction = action;
            return true;
          }
          if (isExactExternalStopProofAction(action, admittedAction)) return true;
          return rejectUnexpectedAction();
        },
        appTokenPath: options.externalStopOptions.appTokenPath,
        hmacKeyPath: options.externalStopOptions.hmacKeyPath,
        replayDirectoryPath:
          options.externalStopOptions.replayDirectoryPath,
        repositoryRoot: REPOSITORY_ROOT,
        contextLifetimeMs: options.externalStopOptions.timeoutMs,
      });
      const address = await actionComposition.start({
        port: options.externalStopOptions.port,
        expectedAuthority: options.externalStopOptions.expectedAuthority,
      });
      if (address.port !== options.externalStopOptions.port) {
        throw new SafeRelayError(
          "external Stop listener did not bind the requested port",
        );
      }
      actionProof = externalProof;
    }
    if (receivedSignal !== null) throw new SafeRelayError("relay interrupted");
    const appServerArguments = [
      "app-server",
      ...PROCESS_ISOLATION_ARGUMENTS,
      ...mcpDisableArguments([...configuredMcpNames]),
    ];
    child = spawn("codex", appServerArguments, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: appServerEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child[OWNED_PROCESS_GROUP] = process.platform !== "win32";
    appServerArguments.length = 0;
    child.stderr.resume();
    if (receivedSignal !== null) throw new SafeRelayError("relay interrupted");
    const run = runOwnedTask({
      actionComposition,
      actionProof,
      child,
      configuredMcpNames,
      cwd: options.cwd,
      outputSignal: outputAbort.signal,
      staleAfterMs: options.staleAfterMs,
      taskInput,
    });
    taskInput = null;
    const result = await run;
    const expectedTerminalStatus =
      options.loopbackActionProof ||
      options.localLongTaskProof ||
      options.externalStopOptions !== null
        ? "interrupted"
        : "completed";
    if (result.terminalStatus !== expectedTerminalStatus) {
      process.exitCode = 1;
    }
  } catch (error) {
    if (receivedSignal === null) {
      writeSafeStderr(
        `${error instanceof SafeRelayError ? error.message : "relay execution failed"}\n`,
      );
    }
    process.exitCode = 1;
  } finally {
    configuredMcpNames?.clear();
    if (actionProofState !== null) actionProofState.appToken = null;
    if (signalEscalationTimer !== null) {
      clearTimeout(signalEscalationTimer);
      signalEscalationTimer = null;
    }
    let actionCompositionClosed = true;
    try {
      await actionComposition?.close();
    } catch {
      actionCompositionClosed = false;
      writeSafeStderr(
        options?.externalStopOptions !== null
          ? "external Stop action composition cleanup failed\n"
          : "loopback action composition cleanup failed\n",
      );
      process.exitCode = 1;
    }
    let childStopped = true;
    try {
      await stopOwnedChild(child);
    } catch {
      childStopped = false;
      writeSafeStderr("owned App Server process cleanup failed\n");
      process.exitCode = 1;
    }
    if (stateHome !== null && childStopped) {
      try {
        await removeStateHome(stateHome);
      } catch {
        writeSafeStderr(
          `disposable App Server state cleanup failed: ${stateHome}\n`,
        );
        process.exitCode = 1;
      }
    } else if (stateHome !== null) {
      writeSafeStderr(`disposable App Server state retained: ${stateHome}\n`);
    }
    if (actionProofState !== null && actionCompositionClosed) {
      try {
        await removeStateHome(actionProofState.root);
      } catch {
        writeSafeStderr(
          `synthetic loopback proof state cleanup failed: ${actionProofState.root}\n`,
        );
        process.exitCode = 1;
      }
    } else if (actionProofState !== null) {
      writeSafeStderr(
        `synthetic loopback proof state retained: ${actionProofState.root}\n`,
      );
    }
    process.off("SIGINT", handleInterrupt);
    process.off("SIGTERM", handleTerminate);
    externalStatusFailure = null;
    if (receivedSignal === "SIGINT") process.exitCode = 130;
    if (receivedSignal === "SIGTERM") process.exitCode = 143;
  }
}

await main();
