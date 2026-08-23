#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { createMacLocalTurnActionComposition } from "../src/mac-local-turn-action-composition.mjs";
import { REMOTE_TURN_ACTION_PATH } from "../src/tailscale-turn-action-ingress.mjs";

const SCHEMA_VERSION = 1;
const MAX_TIMEOUT_MS = 60_000;
const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(
  /\/$/u,
  "",
);
const OPTIONS = new Set([
  "--app-token-file",
  "--capability",
  "--expected-authority",
  "--hmac-key-file",
  "--port",
  "--replay-root",
  "--timeout-ms",
]);

const containStreamError = () => {};
process.stdout.on("error", containStreamError);
process.stderr.on("error", containStreamError);

class AdmissionProofError extends Error {
  constructor(message) {
    super(message);
    this.name = "AdmissionProofError";
  }
}

function usage() {
  return [
    "Usage: codex-tailscale-admission-proof",
    "  --port <1-65535>",
    "  --expected-authority <exact-host-authority>",
    "  --capability <parameterless-capability-id>",
    "  --app-token-file <absolute-path>",
    "  --hmac-key-file <absolute-path>",
    "  --replay-root <absolute-path>",
    "  --timeout-ms <1-60000>",
  ].join("\n");
}

function parseInteger(value, name, maximum) {
  if (!/^(?:0|[1-9]\d*)$/u.test(value ?? "")) {
    throw new AdmissionProofError(`${name} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new AdmissionProofError(`${name} is invalid`);
  }
  return parsed;
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

function parseArguments(argumentsList) {
  if (argumentsList.length === 1 && argumentsList[0] === "--help") {
    return { help: true };
  }
  if (argumentsList.length !== OPTIONS.size * 2) {
    throw new AdmissionProofError("required proof options are missing");
  }
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!OPTIONS.has(name) || values.has(name) || value === undefined) {
      throw new AdmissionProofError("proof options are invalid");
    }
    values.set(name, value);
  }

  const port = parseInteger(values.get("--port"), "port", 65_535);
  const timeoutMs = parseInteger(
    values.get("--timeout-ms"),
    "timeout",
    MAX_TIMEOUT_MS,
  );
  const expectedAuthority = values.get("--expected-authority");
  const capability = values.get("--capability");
  const appTokenPath = values.get("--app-token-file");
  const hmacKeyPath = values.get("--hmac-key-file");
  const replayDirectoryPath = values.get("--replay-root");
  if (!isParameterlessCapability(capability)) {
    throw new AdmissionProofError("capability identifier is invalid");
  }
  if (
    ![appTokenPath, hmacKeyPath, replayDirectoryPath].every(isAbsolute) ||
    appTokenPath === hmacKeyPath
  ) {
    throw new AdmissionProofError("proof state paths are invalid");
  }
  return {
    appTokenPath,
    capability,
    expectedAuthority,
    hmacKeyPath,
    port,
    replayDirectoryPath,
    timeoutMs,
  };
}

function opaqueId(prefix, bytes = 16) {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

function correlatedNoActiveTurn(action) {
  return {
    schemaVersion: SCHEMA_VERSION,
    actionId: action.actionId,
    action: action.action,
    outcome: "rejected",
    reason: "noActiveTurn",
    appServerMethod: null,
  };
}

function isExactProofAction(candidate, expected) {
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

function writeStream(stream, value) {
  return new Promise((resolve) => {
    if (stream.destroyed) {
      resolve(false);
      return;
    }
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      stream.off("error", onError);
      resolve(result);
    };
    const onError = () => settle(false);
    stream.once("error", onError);
    try {
      stream.write(value, (error) => settle(error === null || error === undefined));
    } catch {
      settle(false);
    }
  });
}

function writeArtifact(value) {
  return writeStream(process.stdout, `${JSON.stringify(value)}\n`);
}

function writeError(value) {
  return writeStream(process.stderr, `${value}\n`);
}

async function run(options) {
  const installationId = opaqueId("proof");
  const threadId = opaqueId("opaque");
  const expectedTurnId = opaqueId("opaque");
  const actionId = opaqueId("proof");
  let composition;
  let dispatchCount = 0;
  let expectedAction = null;
  let unexpectedAction = false;
  let finishPromise = null;
  let ready = false;
  let signalRequested = false;
  let timeout = null;
  let resolveFinished;
  const finished = new Promise((resolve) => {
    resolveFinished = resolve;
  });

  const finish = (reason) => {
    if (finishPromise !== null) return finishPromise;
    finishPromise = (async () => {
      if (timeout !== null) clearTimeout(timeout);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      await composition?.close();
      const successfulSignal =
        reason === "signal" && dispatchCount === 1 && !unexpectedAction;
      const artifactWritten = await writeArtifact({
        state: successfulSignal ? "closed" : "failed",
        dispatchCount,
      });
      const successful = successfulSignal && artifactWritten;
      if (!successful) {
        const message = !artifactWritten
          ? "admission proof output is unavailable"
          : reason === "timeout"
            ? "admission proof timed out"
            : "admission proof did not observe exactly one expected action";
        await writeError(message);
      }
      resolveFinished(successful ? 0 : 1);
    })().catch(async () => {
      await writeError("admission proof cleanup failed");
      resolveFinished(1);
    });
    return finishPromise;
  };

  const onSignal = () => {
    signalRequested = true;
    if (ready) void finish("signal");
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    composition = await createMacLocalTurnActionComposition({
      installationId,
      expectedCapability: options.capability,
      admitAction: (action) => {
        if (isExactProofAction(action, expectedAction)) return true;
        unexpectedAction = true;
        if (ready) queueMicrotask(() => void finish("unexpected"));
        return false;
      },
      appTokenPath: options.appTokenPath,
      hmacKeyPath: options.hmacKeyPath,
      replayDirectoryPath: options.replayDirectoryPath,
      repositoryRoot: REPOSITORY_ROOT,
      contextLifetimeMs: options.timeoutMs,
    });
    const address = await composition.start({
      port: options.port,
      expectedAuthority: options.expectedAuthority,
    });
    if (address.port !== options.port) {
      throw new AdmissionProofError("listener did not bind the requested port");
    }

    const publicContext = composition.activate({
      threadId,
      expectedTurnId,
      dispatch: (action) => {
        dispatchCount += 1;
        if (
          dispatchCount !== 1 ||
          action.schemaVersion !== SCHEMA_VERSION ||
          action.actionId !== actionId ||
          action.action !== "stop" ||
          action.threadId !== threadId ||
          action.expectedTurnId !== expectedTurnId ||
          Object.hasOwn(action, "text")
        ) {
          unexpectedAction = true;
          queueMicrotask(() => void finish("unexpected"));
        }
        return correlatedNoActiveTurn(action);
      },
    });
    const issuedAtMs = Date.now();
    if (!Number.isSafeInteger(issuedAtMs)) {
      throw new AdmissionProofError("proof clock is invalid");
    }
    expectedAction = Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      actionId,
      controlContextId: publicContext.controlContextId,
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: publicContext.expiresAt,
      action: "stop",
    });

    const readyArtifact = {
      state: "ready",
      listenerPort: address.port,
      expectedAuthority: options.expectedAuthority,
      capability: options.capability,
      controlContextId: publicContext.controlContextId,
      expiresAt: publicContext.expiresAt,
      request: {
        method: "POST",
        path: REMOTE_TURN_ACTION_PATH,
        headers: {
          "content-type": "application/json",
        },
        body: expectedAction,
      },
    };
    ready = true;
    timeout = setTimeout(() => {
      void finish("timeout");
    }, options.timeoutMs);
    if (!(await writeArtifact(readyArtifact))) {
      throw new AdmissionProofError("proof output is unavailable");
    }
    if (unexpectedAction) void finish("unexpected");
    if (signalRequested) void finish("signal");
  } catch (error) {
    if (timeout !== null) clearTimeout(timeout);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    try {
      await composition?.close();
    } catch {}
    if (error instanceof AdmissionProofError) throw error;
    throw new AdmissionProofError("admission proof setup failed");
  }

  return finished;
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
  if (options.help) {
    if (!(await writeStream(process.stdout, `${usage()}\n`))) {
      process.exitCode = 1;
    }
  } else {
    process.exitCode = await run(options);
  }
} catch (error) {
  const message =
    error instanceof AdmissionProofError
      ? error.message
      : "admission proof failed";
  await writeError(message);
  process.exitCode = 2;
}
