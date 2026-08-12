#!/usr/bin/env node

import { buildSmokePayload } from "./apns-smoke-payload.mjs";

const [kind] = process.argv.slice(2);

try {
  process.stdout.write(`${JSON.stringify(buildSmokePayload(kind), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
