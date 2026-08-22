#!/usr/bin/env node

import {
  ApnsDeliveryError,
  ApnsLiveActivityHttp2Sender,
  loadApnsSenderConfiguration,
  sendLiveActivityJsonl,
} from "../src/apns-live-activity-http2.mjs";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return [
    "Usage: codex-live-activity-apns-sender --config <absolute-path>",
    "",
    "Reads redacted relay payloads as JSONL on stdin and sends them to APNs.",
    "The private configuration, signing key, and ActivityKit token files must",
    "be owner-only regular files outside the repository.",
  ].join("\n");
}

function parseArguments(argumentsList) {
  if (argumentsList.length === 1 && argumentsList[0] === "--help") {
    return { help: true };
  }
  if (
    argumentsList.length !== 2 ||
    argumentsList[0] !== "--config" ||
    argumentsList[1].length === 0
  ) {
    throw new ApnsDeliveryError("--config requires one absolute private file path");
  }
  return { configPath: argumentsList[1], help: false };
}

function writeOutput(output, line, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => fail();
    function cleanup() {
      signal.removeEventListener("abort", onAbort);
    }
    function fail() {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ApnsDeliveryError("APNs sender output closed"));
    }
    function succeed() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }

    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      output.write(line, (error) => {
        if (error) fail();
        else succeed();
      });
    } catch {
      fail();
    }
  });
}

export async function runApnsSenderCli({
  argumentsList = process.argv.slice(2),
  createSender = (configuration) =>
    new ApnsLiveActivityHttp2Sender(configuration),
  errorOutput = process.stderr,
  input = process.stdin,
  loadConfiguration = loadApnsSenderConfiguration,
  output = process.stdout,
  repositoryRoot = REPOSITORY_ROOT,
  signalTarget = process,
} = {}) {
  let options;
  try {
    options = parseArguments(argumentsList);
  } catch (error) {
    errorOutput.write(`${error.message}\n`);
    return 2;
  }

  if (options.help) {
    output.write(`${usage()}\n`);
    return 0;
  }

  let sender = null;
  let receivedSignal = null;
  let outputFailed = false;
  const outputAbortController = new AbortController();
  const handleSignal = (signal) => {
    if (receivedSignal === null) receivedSignal = signal;
    outputAbortController.abort();
    sender?.abort();
    input.destroy();
  };
  const handleInterrupt = () => handleSignal("SIGINT");
  const handleTerminate = () => handleSignal("SIGTERM");
  const handleOutputError = () => {
    outputFailed = true;
    outputAbortController.abort();
    sender?.abort();
    input.destroy();
  };
  signalTarget.on("SIGINT", handleInterrupt);
  signalTarget.on("SIGTERM", handleTerminate);
  output.on("error", handleOutputError);

  let exitCode = 0;
  try {
    const configuration = await loadConfiguration(options.configPath, {
      repositoryRoot,
    });
    if (receivedSignal !== null) {
      throw new ApnsDeliveryError("APNs sender interrupted");
    }
    sender = createSender(configuration);
    await sendLiveActivityJsonl(input, sender, {
      writeReceipt: (line) =>
        writeOutput(output, line, outputAbortController.signal),
    });
    if (outputFailed) throw new ApnsDeliveryError("APNs sender output closed");
  } catch (error) {
    if (receivedSignal === null) {
      errorOutput.write(
        `${error instanceof ApnsDeliveryError ? error.message : "APNs sender failed"}\n`,
      );
    }
    exitCode = 1;
  } finally {
    sender?.close();
    signalTarget.off("SIGINT", handleInterrupt);
    signalTarget.off("SIGTERM", handleTerminate);
    output.off("error", handleOutputError);
  }
  if (receivedSignal === "SIGINT") return 130;
  if (receivedSignal === "SIGTERM") return 143;
  return exitCode;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await runApnsSenderCli();
}
