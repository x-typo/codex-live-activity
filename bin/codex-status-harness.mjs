#!/usr/bin/env node

import readline from "node:readline";

import { StatusReducer } from "../src/status-reducer.mjs";

function parseStaleAfterMs(argumentsList) {
  const index = argumentsList.indexOf("--stale-after-ms");
  if (index === -1) return 60_000;
  const value = Number(argumentsList[index + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError("--stale-after-ms requires a positive number");
  }
  return value;
}

function write(records) {
  for (const record of records) process.stdout.write(`${JSON.stringify(record)}\n`);
}

let reducer;
try {
  reducer = new StatusReducer({ staleAfterMs: parseStaleAfterMs(process.argv.slice(2)) });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let lineNumber = 0;
let parseFailed = false;
const sweepInterval = setInterval(
  () => write(reducer.sweep()),
  Math.min(reducer.staleAfterMs, 1_000),
);
sweepInterval.unref();

input.on("line", (line) => {
  lineNumber += 1;
  if (line.trim().length === 0) return;
  try {
    write(reducer.ingest(JSON.parse(line)));
  } catch {
    parseFailed = true;
    process.stderr.write(`Invalid JSON on input line ${lineNumber}\n`);
  }
});

input.on("close", () => {
  clearInterval(sweepInterval);
  write(reducer.markDisconnected());
  if (parseFailed) process.exitCode = 2;
});
