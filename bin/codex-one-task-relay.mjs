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
import { join, resolve } from "node:path";
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
const MAX_MCP_INVENTORY_BYTES = 4 * 1024 * 1024;
const MAX_MCP_SERVERS = 256;
const LOOPBACK_PROOF_CAPABILITY =
  "github.com/x-typo/codex-live-activity/cap/control";
const LOOPBACK_PROOF_INSTALLATION_ID = "local-proof";
const LOOPBACK_PROOF_REPLY_TEXT = "Continue the bounded local proof.";
const REPOSITORY_ROOT = resolve(
  fileURLToPath(new URL("../", import.meta.url)),
);
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
process.stderr.on("error", () => {
  stderrWritable = false;
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
    "  --help                   Show this help",
  ].join("\n");
}

function parseArguments(argumentsList) {
  let cwd = process.cwd();
  let staleAfterMs = 60_000;
  let loopbackActionProof = false;

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
    throw new SafeRelayError(`Unknown option: ${argument}`);
  }

  return { help: false, cwd, staleAfterMs, loopbackActionProof };
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
            [LOOPBACK_PROOF_CAPABILITY]: [{ source: ["synthetic-local-proof"] }],
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
    const pendingActionResponses = new Map();

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
        fail(new SafeRelayError("loopback action proof did not interrupt the task"));
        return;
      }
      if (!actionProofActionsAccepted || terminalStatus !== "interrupted") {
        return;
      }
      clearActionProofTerminalTimer();
      actionProofConfirmed = true;
      actionProof.writeStatus("loopback proof: interrupted lifecycle confirmed\n");
      child.stdin.end();
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
          dispatch: (action) => actionBoundary.dispatch(action),
        });
        actionProofStarted = true;
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
        fail(new SafeRelayError("loopback action proof could not be activated"));
      }
    }

    function fail(error) {
      if (settled) return;
      settled = true;
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
      child.kill("SIGTERM");
      rejectRun(error);
    }

    function onOutputAbort() {
      fail(new SafeRelayError("dry-run output closed"));
    }

    function finishTerminal(status) {
      if (terminalStatus !== null) return;
      terminalStatus = status;
      revokeActiveTurn();
      if (actionProof === null) {
        child.stdin.end();
        return;
      }
      if (!actionProofStarted) {
        fail(new SafeRelayError("task ended before loopback proof activation"));
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
        actionProof !== null &&
        observedTurnId === null &&
        actionProofActivationTimer === null
      ) {
        actionProofActivationTimer = setTimeout(
          () =>
            fail(
              new SafeRelayError(
                "loopback action proof did not observe a matching turn start",
              ),
            ),
          LOOPBACK_PROOF_ACTIVATION_TIMEOUT_MS,
        );
        actionProofActivationTimer.unref();
      }
      beginActionProof();
    }

    function handleResponse(message) {
      const pendingAction = pendingActionResponses.get(message.id);
      if (pendingAction !== undefined) {
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
        rejectRun(new SafeRelayError("loopback action proof was not confirmed"));
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
        address,
        appToken: actionProofState.appToken,
        writeStatus: writeSafeStderr,
      };
    }
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
    if (
      result.terminalStatus !==
      (options.loopbackActionProof ? "interrupted" : "completed")
    ) {
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
      writeSafeStderr("loopback action composition cleanup failed\n");
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
    if (receivedSignal === "SIGINT") process.exitCode = 130;
    if (receivedSignal === "SIGTERM") process.exitCode = 143;
  }
}

await main();
