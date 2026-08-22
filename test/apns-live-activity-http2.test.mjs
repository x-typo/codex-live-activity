import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { EventEmitter } from "node:events";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { sensitiveHeaders } from "node:http2";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ApnsDeliveryError,
  ApnsLiveActivityHttp2Sender,
  createApnsProviderToken,
  loadApnsSenderConfiguration,
  sendLiveActivityJsonl,
} from "../src/apns-live-activity-http2.mjs";
import {
  RELAY_MARKER,
  validateLiveActivityPayload,
} from "../src/live-activity-payload.mjs";
import { runApnsSenderCli } from "../bin/codex-live-activity-apns-sender.mjs";

const FIXED_REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const ISSUED_AT = 1_786_551_000;
const ACTIVITY_TOKEN = "ab".repeat(32);
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SENDER_CLI = join(REPOSITORY_ROOT, "bin/codex-live-activity-apns-sender.mjs");

const PRESENTATIONS = {
  blocked: ["Blocked", "Codex could not finish this task", false],
  ready: ["Ready", "Codex finished this task", false],
  running: ["Working", "Codex is working", false],
  waiting: ["Needs input", "Respond in Codex on Mac", true],
};

function payload(kind = "running", sequence = 1) {
  const [status, detail, attentionRequired] = PRESENTATIONS[kind];
  return {
    aps: {
      timestamp: ISSUED_AT + sequence,
      event: "update",
      "content-state": {
        status,
        detail,
        attentionRequired,
        marker: RELAY_MARKER,
        sequence,
      },
      "stale-date": ISSUED_AT + sequence + 300,
    },
  };
}

function keyPair() {
  return generateKeyPairSync("ec", { namedCurve: "P-256" });
}

function decodeJson(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function createSessionFixture(handleRequest) {
  const session = new EventEmitter();
  const streams = new Set();
  session.closed = false;
  session.destroyed = false;
  session.request = (headers) => {
    const stream = new EventEmitter();
    streams.add(stream);
    stream.destroyed = false;
    stream.setTimeout = () => stream;
    stream.close = () => stream.destroy();
    stream.destroy = () => {
      if (stream.destroyed) return;
      stream.destroyed = true;
      streams.delete(stream);
      stream.emit("close");
    };
    stream.once("end", () => streams.delete(stream));
    stream.end = (body) => {
      queueMicrotask(() => handleRequest({ body, headers, stream }));
    };
    return stream;
  };
  session.close = () => {
    session.closed = true;
  };
  session.destroy = () => {
    if (session.destroyed) return;
    session.destroyed = true;
    for (const stream of [...streams]) stream.destroy();
  };
  return session;
}

function runSenderCli(argumentsList, input = "") {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [SENDER_CLI, ...argumentsList], {
      cwd: REPOSITORY_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectChild);
    child.once("close", (code, signal) => {
      resolveChild({ code, signal, stderr, stdout });
    });
    child.stdin.end(input);
  });
}

test("validates the exact relay payload allowlist and ordering", () => {
  assert.deepEqual(validateLiveActivityPayload(payload(), { previousSequence: 0 }), {
    attentionRequired: false,
    sequence: 1,
    status: "Working",
  });

  const extra = payload();
  extra.aps.alert = { title: "not allowed" };
  assert.throws(() => validateLiveActivityPayload(extra), /exact relay APNs update shape/);

  const changedDetail = payload();
  changedDetail.aps["content-state"].detail = "SENSITIVE_PROMPT";
  assert.throws(() => validateLiveActivityPayload(changedDetail), /presentation is invalid/);

  assert.throws(
    () => validateLiveActivityPayload(payload("ready", 2), { previousSequence: 2 }),
    /sequence must increase/,
  );
});

test("creates a verifiable ES256 APNs provider token", () => {
  const { privateKey, publicKey } = keyPair();
  const token = createApnsProviderToken({
    issuedAt: ISSUED_AT,
    keyId: "ABC123DEFG",
    privateKey,
    teamId: "DEF123GHIJ",
  });
  const [encodedHeader, encodedClaims, encodedSignature] = token.split(".");

  assert.deepEqual(decodeJson(encodedHeader), {
    alg: "ES256",
    kid: "ABC123DEFG",
  });
  assert.deepEqual(decodeJson(encodedClaims), {
    iss: "DEF123GHIJ",
    iat: ISSUED_AT,
  });
  assert.equal(
    verify(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      { dsaEncoding: "ieee-p1363", key: publicKey },
      Buffer.from(encodedSignature, "base64url"),
    ),
    true,
  );
});

test("sends exact serialized Live Activity requests over a reused HTTP/2 connection", async () => {
  const requests = [];
  const session = createSessionFixture(({ body, headers, stream }) => {
    requests.push({ body, headers });
    stream.emit("response", { ":status": 200, "apns-id": FIXED_REQUEST_ID });
    stream.emit("end");
  });
  const { privateKey, publicKey } = keyPair();
  let connections = 0;
  let currentSeconds = ISSUED_AT + 1;
  const sender = new ApnsLiveActivityHttp2Sender({
    activityToken: ACTIVITY_TOKEN,
    bundleId: "com.xtypo.CodexLiveActivitySmoke",
    connect(origin, options) {
      connections += 1;
      assert.equal(origin, "https://api.sandbox.push.apple.com:443");
      assert.deepEqual(options.ALPNProtocols, ["h2"]);
      assert.equal(options.minVersion, "TLSv1.2");
      assert.equal(options.rejectUnauthorized, true);
      return session;
    },
    delay: async (milliseconds) => {
      currentSeconds += milliseconds / 1_000;
    },
    environment: "sandbox",
    keyId: "ABC123DEFG",
    clock: () => currentSeconds * 1_000,
    privateKey,
    requestId: () => FIXED_REQUEST_ID,
    teamId: "DEF123GHIJ",
  });

  try {
    const first = await sender.send(payload("running", 1));
    const second = await sender.send(payload("ready", 2));
    assert.deepEqual(first, {
      accepted: true,
      apnsId: FIXED_REQUEST_ID,
      sequence: 1,
      status: 200,
    });
    assert.equal(second.sequence, 2);
    assert.equal(connections, 1);
    assert.equal(requests.length, 2);

    for (const [index, request] of requests.entries()) {
      assert.equal(request.headers[":method"], "POST");
      assert.equal(request.headers[":path"], `/3/device/${ACTIVITY_TOKEN}`);
      assert.equal(request.headers["apns-expiration"], "0");
      assert.equal(request.headers["apns-id"], FIXED_REQUEST_ID);
      assert.equal(request.headers["apns-push-type"], "liveactivity");
      assert.deepEqual(request.headers[sensitiveHeaders], [":path", "authorization"]);
      assert.equal(
        request.headers["apns-topic"],
        "com.xtypo.CodexLiveActivitySmoke.push-type.liveactivity",
      );
      assert.deepEqual(
        JSON.parse(request.body),
        payload(index === 0 ? "running" : "ready", index + 1),
      );
    }
    assert.equal(requests[0].headers["apns-priority"], "5");
    assert.equal(requests[1].headers["apns-priority"], "10");
    assert.equal(
      requests[0].headers.authorization,
      requests[1].headers.authorization,
      "the provider token must be reused on the same connection",
    );

    const providerToken = requests[0].headers.authorization.slice("bearer ".length);
    const [header, claims, signature] = providerToken.split(".");
    assert.equal(
      verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        { dsaEncoding: "ieee-p1363", key: publicKey },
        Buffer.from(signature, "base64url"),
      ),
      true,
    );
  } finally {
    sender.close();
  }
});

test("fails closed after one APNs rejection without retrying or exposing bearer values", async () => {
  let requests = 0;
  let authorization = null;
  const session = createSessionFixture(({ headers, stream }) => {
    requests += 1;
    authorization = headers.authorization;
    stream.emit("response", { ":status": 410 });
    stream.emit("data", Buffer.from(JSON.stringify({ reason: "Unregistered" })));
    stream.emit("end");
  });
  const { privateKey } = keyPair();
  const sender = new ApnsLiveActivityHttp2Sender({
    activityToken: ACTIVITY_TOKEN,
    bundleId: "com.xtypo.CodexLiveActivitySmoke",
    connect: () => session,
    environment: "sandbox",
    keyId: "ABC123DEFG",
    clock: () => (ISSUED_AT + 1) * 1_000,
    privateKey,
    requestId: () => FIXED_REQUEST_ID,
    teamId: "DEF123GHIJ",
  });

  try {
    let message = "";
    await assert.rejects(sender.send(payload()), (error) => {
      message = error.message;
      assert.equal(error.status, 410);
      assert.equal(error.reason, "Unregistered");
      return true;
    });
    await assert.rejects(sender.send(payload("ready", 2)), /stopped after a delivery failure/);
    assert.equal(requests, 1);
    assert.equal(message.includes(ACTIVITY_TOKEN), false);
    assert.equal(message.includes(authorization), false);
  } finally {
    sender.close();
  }
});

test("fails closed when an HTTP/2 stream closes without a response or end", async () => {
  let requests = 0;
  const session = createSessionFixture(({ stream }) => {
    requests += 1;
    stream.emit("close");
  });
  const { privateKey } = keyPair();
  const sender = new ApnsLiveActivityHttp2Sender({
    activityToken: ACTIVITY_TOKEN,
    bundleId: "com.xtypo.CodexLiveActivitySmoke",
    connect: () => session,
    environment: "sandbox",
    keyId: "ABC123DEFG",
    clock: () => (ISSUED_AT + 1) * 1_000,
    privateKey,
    requestId: () => FIXED_REQUEST_ID,
    teamId: "DEF123GHIJ",
  });

  await assert.rejects(sender.send(payload()), /closed unexpectedly/);
  await assert.rejects(
    sender.send(payload("ready", 2)),
    /stopped after a delivery failure/,
  );
  assert.equal(requests, 1);
  assert.equal(session.destroyed, true);
});

test("coalesces duplicate working heartbeats until the stale deadline needs renewal", async () => {
  const requests = [];
  const session = createSessionFixture(({ body, stream }) => {
    requests.push(JSON.parse(body));
    stream.emit("response", { ":status": 200, "apns-id": FIXED_REQUEST_ID });
    stream.emit("end");
  });
  const { privateKey } = keyPair();
  let currentSeconds = ISSUED_AT + 1;
  const sender = new ApnsLiveActivityHttp2Sender({
    activityToken: ACTIVITY_TOKEN,
    bundleId: "com.xtypo.CodexLiveActivitySmoke",
    connect: () => session,
    environment: "sandbox",
    keyId: "ABC123DEFG",
    clock: () => currentSeconds * 1_000,
    privateKey,
    requestId: () => FIXED_REQUEST_ID,
    teamId: "DEF123GHIJ",
  });

  try {
    assert.equal((await sender.send(payload("running", 1))).accepted, true);
    const coalesced = await sender.send(payload("running", 2));
    assert.deepEqual(coalesced, {
      accepted: false,
      reason: "coalesced",
      sequence: 2,
    });
    assert.equal(requests.length, 1);

    currentSeconds += 150;
    assert.equal((await sender.send(payload("running", 3))).accepted, true);
    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map(({ aps }) => aps.timestamp),
      [ISSUED_AT + 1, ISSUED_AT + 151],
    );
    assert.deepEqual(
      requests.map(({ aps }) => aps["stale-date"]),
      [ISSUED_AT + 301, ISSUED_AT + 451],
    );
  } finally {
    sender.close();
  }
});

test("coalesces against the prior successfully sent stale window", async () => {
  const requests = [];
  const session = createSessionFixture(({ body, stream }) => {
    requests.push(JSON.parse(body));
    stream.emit("response", { ":status": 200, "apns-id": FIXED_REQUEST_ID });
    stream.emit("end");
  });
  const { privateKey } = keyPair();
  let currentSeconds = ISSUED_AT + 1;
  const sender = new ApnsLiveActivityHttp2Sender({
    activityToken: ACTIVITY_TOKEN,
    bundleId: "com.xtypo.CodexLiveActivitySmoke",
    connect: () => session,
    environment: "sandbox",
    keyId: "ABC123DEFG",
    clock: () => currentSeconds * 1_000,
    privateKey,
    requestId: () => FIXED_REQUEST_ID,
    teamId: "DEF123GHIJ",
  });

  const shortWindow = payload("running", 1);
  shortWindow.aps["stale-date"] = shortWindow.aps.timestamp + 60;
  const longWindow = payload("running", 2);
  longWindow.aps["stale-date"] = longWindow.aps.timestamp + 600;
  const shortWindowAgain = payload("running", 3);
  shortWindowAgain.aps["stale-date"] = shortWindowAgain.aps.timestamp + 60;

  try {
    assert.equal((await sender.send(shortWindow)).accepted, true);
    currentSeconds += 31;
    assert.equal((await sender.send(longWindow)).accepted, true);
    currentSeconds += 31;
    assert.deepEqual(await sender.send(shortWindowAgain), {
      accepted: false,
      reason: "coalesced",
      sequence: 3,
    });
    assert.equal(requests.length, 2);
  } finally {
    sender.close();
  }
});

test("reuses a provider token until its safe 50-minute refresh point", async () => {
  const authorizations = [];
  const session = createSessionFixture(({ headers, stream }) => {
    authorizations.push(headers.authorization);
    stream.emit("response", { ":status": 200, "apns-id": FIXED_REQUEST_ID });
    stream.emit("end");
  });
  const { privateKey } = keyPair();
  let currentSeconds = ISSUED_AT + 1;
  const sender = new ApnsLiveActivityHttp2Sender({
    activityToken: ACTIVITY_TOKEN,
    bundleId: "com.xtypo.CodexLiveActivitySmoke",
    connect: () => session,
    environment: "sandbox",
    keyId: "ABC123DEFG",
    clock: () => currentSeconds * 1_000,
    privateKey,
    requestId: () => FIXED_REQUEST_ID,
    teamId: "DEF123GHIJ",
  });

  try {
    await sender.send(payload("running", 1));
    currentSeconds += 49 * 60;
    await sender.send(payload("ready", 2));
    currentSeconds += 60;
    await sender.send(payload("blocked", 3));

    assert.equal(authorizations[0], authorizations[1]);
    assert.notEqual(authorizations[1], authorizations[2]);
    assert.deepEqual(
      authorizations.map((authorization) =>
        decodeJson(authorization.slice("bearer ".length).split(".")[1]).iat,
      ),
      [ISSUED_AT + 1, ISSUED_AT + 1, ISSUED_AT + 3_001],
    );
  } finally {
    sender.close();
  }
});

test("aborts the timestamp serialization delay without waiting for its timer", async () => {
  let requests = 0;
  const session = createSessionFixture(({ stream }) => {
    requests += 1;
    stream.emit("response", { ":status": 200, "apns-id": FIXED_REQUEST_ID });
    stream.emit("end");
  });
  const { privateKey } = keyPair();
  const sender = new ApnsLiveActivityHttp2Sender({
    activityToken: ACTIVITY_TOKEN,
    bundleId: "com.xtypo.CodexLiveActivitySmoke",
    connect: () => session,
    environment: "sandbox",
    keyId: "ABC123DEFG",
    clock: () => (ISSUED_AT + 1) * 1_000,
    privateKey,
    requestId: () => FIXED_REQUEST_ID,
    teamId: "DEF123GHIJ",
  });

  await sender.send(payload("running", 1));
  const startedAt = Date.now();
  const pendingSend = sender.send(payload("ready", 2));
  setTimeout(() => sender.abort(), 10);

  await assert.rejects(pendingSend, /delivery delay was aborted/);
  assert.equal(Date.now() - startedAt < 500, true);
  assert.equal(requests, 1);
  assert.equal(session.destroyed, true);
});

test("loads only owner-private external config, key, and token files", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cla-apns-config-test."));
  const repositoryRoot = join(stateDirectory, "repository");
  const configPath = join(stateDirectory, "apns-config.json");
  const privateKeyPath = join(stateDirectory, "AuthKey_TEST.p8");
  const activityTokenPath = join(stateDirectory, "activity-token.txt");
  const { privateKey } = keyPair();
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" });
  const configuration = {
    version: 1,
    environment: "sandbox",
    bundleId: "com.xtypo.CodexLiveActivitySmoke",
    teamId: "DEF123GHIJ",
    keyId: "ABC123DEFG",
    privateKeyPath,
    activityTokenPath,
  };

  try {
    await mkdir(repositoryRoot);
    await writeFile(privateKeyPath, privateKeyPem, { mode: 0o600 });
    await writeFile(activityTokenPath, `${ACTIVITY_TOKEN}\n`, { mode: 0o600 });
    await writeFile(configPath, JSON.stringify(configuration), { mode: 0o600 });

    const loaded = await loadApnsSenderConfiguration(configPath, { repositoryRoot });
    assert.equal(loaded.activityToken, ACTIVITY_TOKEN);
    assert.equal(loaded.environment, "sandbox");
    assert.equal(loaded.privateKey.asymmetricKeyType, "ec");

    const looseConfigPath = join(stateDirectory, "loose-config.json");
    await writeFile(looseConfigPath, JSON.stringify(configuration), { mode: 0o644 });
    await assert.rejects(
      loadApnsSenderConfiguration(looseConfigPath, { repositoryRoot }),
      /private regular file outside the repository/,
    );

    const symlinkPath = join(stateDirectory, "linked-config.json");
    await symlink(configPath, symlinkPath);
    await assert.rejects(
      loadApnsSenderConfiguration(symlinkPath, { repositoryRoot }),
      /private regular file outside the repository/,
    );

    const hardlinkPath = join(stateDirectory, "hardlinked-token.txt");
    await link(activityTokenPath, hardlinkPath);
    await assert.rejects(
      loadApnsSenderConfiguration(configPath, { repositoryRoot }),
      /private regular file outside the repository/,
    );
    await rm(hardlinkPath);

    await assert.rejects(
      loadApnsSenderConfiguration(configPath, { repositoryRoot: stateDirectory }),
      /private regular file outside the repository/,
    );
  } finally {
    await rm(stateDirectory, { force: true, recursive: true });
  }
});

test("serializes JSONL sends and stops after the first failed payload", async () => {
  const seen = [];
  const receipts = [];
  const sender = {
    async send(value) {
      const sequence = value.aps["content-state"].sequence;
      seen.push(sequence);
      if (sequence === 2) throw new ApnsDeliveryError("synthetic delivery failure");
      return { accepted: true, apnsId: FIXED_REQUEST_ID, sequence, status: 200 };
    },
  };
  const lines = [payload("running", 1), payload("ready", 2), payload("blocked", 3)]
    .map((value) => JSON.stringify(value))
    .join("\n");

  await assert.rejects(
    sendLiveActivityJsonl(Readable.from([`${lines}\n`]), sender, {
      writeReceipt: async (line) => receipts.push(JSON.parse(line)),
    }),
    /synthetic delivery failure/,
  );
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(receipts.map(({ sequence }) => sequence), [1]);
});

test("rejects malformed and oversized JSONL without echoing its content", async () => {
  const sender = { send: async () => assert.fail("must not send") };
  const sensitive = "SENSITIVE_TASK_CONTENT";
  await assert.rejects(
    sendLiveActivityJsonl(Readable.from([`{${sensitive}\n`]), sender),
    (error) => {
      assert.equal(error.message, "APNs sender input is not valid JSONL");
      assert.equal(error.message.includes(sensitive), false);
      return true;
    },
  );
  await assert.rejects(
    sendLiveActivityJsonl(Readable.from(["x".repeat(8 * 1024 + 1)]), sender),
    /exceeds the safe limit/,
  );
});

test("sender CLI exposes only safe help and argument failures", async () => {
  const help = await runSenderCli(["--help"]);
  assert.equal(help.code, 0);
  assert.equal(help.signal, null);
  assert.match(help.stdout, /Reads redacted relay payloads as JSONL/);
  assert.equal(help.stderr, "");

  const sensitive = "SENSITIVE_ACTIVITY_TOKEN";
  const invalid = await runSenderCli(["--token", sensitive]);
  assert.equal(invalid.code, 2);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /--config requires/);
  assert.equal(invalid.stderr.includes(sensitive), false);
});

test("sender CLI rejects malformed JSONL without opening APNs or echoing input", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cla-apns-cli-test."));
  const configPath = join(stateDirectory, "apns-config.json");
  const privateKeyPath = join(stateDirectory, "AuthKey_TEST.p8");
  const activityTokenPath = join(stateDirectory, "activity-token.txt");
  const { privateKey } = keyPair();
  const configuration = {
    version: 1,
    environment: "sandbox",
    bundleId: "com.xtypo.CodexLiveActivitySmoke",
    teamId: "DEF123GHIJ",
    keyId: "ABC123DEFG",
    privateKeyPath,
    activityTokenPath,
  };
  const sensitive = "SENSITIVE_TASK_BODY";

  try {
    await writeFile(
      privateKeyPath,
      privateKey.export({ format: "pem", type: "pkcs8" }),
      { mode: 0o600 },
    );
    await writeFile(activityTokenPath, ACTIVITY_TOKEN, { mode: 0o600 });
    await writeFile(configPath, JSON.stringify(configuration), { mode: 0o600 });

    const result = await runSenderCli(["--config", configPath], `{${sensitive}\n`);
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "APNs sender input is not valid JSONL\n");
    assert.equal(result.stderr.includes(sensitive), false);
    assert.equal(result.stderr.includes(ACTIVITY_TOKEN), false);
  } finally {
    await rm(stateDirectory, { force: true, recursive: true });
  }
});

test("sender CLI aborts stalled HTTP/2 delivery immediately on SIGINT and SIGTERM", async () => {
  for (const [signal, expectedCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    const signalTarget = new EventEmitter();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    let stdout = "";
    let stderr = "";
    output.setEncoding("utf8");
    errorOutput.setEncoding("utf8");
    output.on("data", (chunk) => {
      stdout += chunk;
    });
    errorOutput.on("data", (chunk) => {
      stderr += chunk;
    });

    let requests = 0;
    const session = createSessionFixture(() => {
      requests += 1;
      queueMicrotask(() => signalTarget.emit(signal));
    });
    const { privateKey } = keyPair();
    const sender = new ApnsLiveActivityHttp2Sender({
      activityToken: ACTIVITY_TOKEN,
      bundleId: "com.xtypo.CodexLiveActivitySmoke",
      connect: () => session,
      environment: "sandbox",
      keyId: "ABC123DEFG",
      clock: () => (ISSUED_AT + 1) * 1_000,
      privateKey,
      requestId: () => FIXED_REQUEST_ID,
      requestTimeoutMs: 15_000,
      teamId: "DEF123GHIJ",
    });

    const startedAt = Date.now();
    const code = await runApnsSenderCli({
      argumentsList: ["--config", "/unused/private/config.json"],
      createSender: () => sender,
      errorOutput,
      input: Readable.from([`${JSON.stringify(payload())}\n`]),
      loadConfiguration: async () => ({}),
      output,
      signalTarget,
    });

    assert.equal(code, expectedCode, signal);
    assert.equal(Date.now() - startedAt < 1_000, true, signal);
    assert.equal(requests, 1, signal);
    assert.equal(session.destroyed, true, signal);
    assert.equal(stdout, "", signal);
    assert.equal(stderr, "", signal);
  }
});

test("sender CLI aborts stalled receipt output immediately on SIGINT and SIGTERM", async () => {
  for (const [signal, expectedCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    const signalTarget = new EventEmitter();
    const errorOutput = new PassThrough();
    let releaseWrite;
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        releaseWrite = callback;
        queueMicrotask(() => signalTarget.emit(signal));
      },
    });
    let stderr = "";
    errorOutput.setEncoding("utf8");
    errorOutput.on("data", (chunk) => {
      stderr += chunk;
    });

    let aborted = false;
    let closed = false;
    const sender = {
      abort() {
        aborted = true;
      },
      close() {
        closed = true;
      },
      async send(value) {
        return {
          accepted: true,
          apnsId: FIXED_REQUEST_ID,
          sequence: value.aps["content-state"].sequence,
          status: 200,
        };
      },
    };

    const startedAt = Date.now();
    const pendingCode = runApnsSenderCli({
      argumentsList: ["--config", "/unused/private/config.json"],
      createSender: () => sender,
      errorOutput,
      input: Readable.from([`${JSON.stringify(payload())}\n`]),
      loadConfiguration: async () => ({}),
      output,
      signalTarget,
    });
    let timeout;
    const code = await Promise.race([
      pendingCode,
      new Promise((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(null), 100);
      }),
    ]);
    clearTimeout(timeout);

    try {
      assert.equal(code, expectedCode, signal);
      assert.equal(Date.now() - startedAt < 1_000, true, signal);
      assert.equal(aborted, true, signal);
      assert.equal(closed, true, signal);
      assert.equal(stderr, "", signal);
    } finally {
      releaseWrite?.();
      await pendingCode;
    }
  }
});
