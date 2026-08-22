import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import {
  connect as connectHttp2,
  constants as http2Constants,
  sensitiveHeaders,
} from "node:http2";
import { isAbsolute, relative } from "node:path";

import { validateLiveActivityPayload } from "./live-activity-payload.mjs";

const APNS_ORIGINS = Object.freeze({
  production: "https://api.push.apple.com:443",
  sandbox: "https://api.sandbox.push.apple.com:443",
});
const CONFIG_KEYS = Object.freeze([
  "activityTokenPath",
  "bundleId",
  "environment",
  "keyId",
  "privateKeyPath",
  "teamId",
  "version",
]);
const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_PRIVATE_KEY_BYTES = 16 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_JSONL_LINE_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024;
const MAX_PAYLOAD_BYTES = 4 * 1024;
const PROVIDER_TOKEN_REFRESH_SECONDS = 50 * 60;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_FUTURE_PAYLOAD_SECONDS = 5;
const IDENTIFIER = /^[A-Z0-9]{10}$/u;
const BUNDLE_ID = /^(?=.{1,255}$)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN_HEX = /^(?:[0-9a-fA-F]{2})+$/u;
const SAFE_APNS_REASONS = new Set([
  "BadDeviceToken",
  "BadExpirationDate",
  "BadMessageId",
  "BadPath",
  "BadPriority",
  "BadTopic",
  "DeviceTokenNotForTopic",
  "DuplicateHeaders",
  "ExpiredProviderToken",
  "ExpiredToken",
  "Forbidden",
  "IdleTimeout",
  "InvalidProviderToken",
  "InvalidPushType",
  "MethodNotAllowed",
  "MissingDeviceToken",
  "MissingProviderToken",
  "MissingTopic",
  "PayloadEmpty",
  "PayloadTooLarge",
  "Shutdown",
  "TooManyProviderTokenUpdates",
  "TooManyRequests",
  "TopicDisallowed",
  "Unregistered",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!isObject(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
}

function isInside(path, root) {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(pathFromRoot))
  );
}

function safeFileError(label) {
  return new ApnsDeliveryError(`${label} must be a private regular file outside the repository`);
}

async function readPrivateFile(
  path,
  { label, maxBytes, repositoryRoot },
) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw safeFileError(label);
  }

  let before;
  let repositoryRealPath;
  try {
    [before, repositoryRealPath] = await Promise.all([
      lstat(path),
      realpath(repositoryRoot),
    ]);
  } catch {
    throw safeFileError(label);
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1 ||
    before.size > maxBytes ||
    (before.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && before.uid !== process.getuid())
  ) {
    throw safeFileError(label);
  }

  let fileRealPath;
  try {
    fileRealPath = await realpath(path);
  } catch {
    throw safeFileError(label);
  }
  if (isInside(fileRealPath, repositoryRealPath)) {
    throw safeFileError(label);
  }

  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
    const after = await handle.stat();
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size > maxBytes ||
      (after.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && after.uid !== process.getuid())
    ) {
      throw safeFileError(label);
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof ApnsDeliveryError) throw error;
    throw safeFileError(label);
  } finally {
    await handle?.close();
  }
}

function validateConfiguration(value) {
  if (!hasExactKeys(value, CONFIG_KEYS) || value.version !== 1) {
    throw new ApnsDeliveryError("APNs sender configuration is invalid");
  }
  if (!Object.hasOwn(APNS_ORIGINS, value.environment)) {
    throw new ApnsDeliveryError("APNs sender environment is invalid");
  }
  if (typeof value.bundleId !== "string" || !BUNDLE_ID.test(value.bundleId)) {
    throw new ApnsDeliveryError("APNs sender bundle identifier is invalid");
  }
  if (typeof value.teamId !== "string" || !IDENTIFIER.test(value.teamId)) {
    throw new ApnsDeliveryError("APNs sender team identifier is invalid");
  }
  if (typeof value.keyId !== "string" || !IDENTIFIER.test(value.keyId)) {
    throw new ApnsDeliveryError("APNs sender key identifier is invalid");
  }
  if (
    typeof value.privateKeyPath !== "string" ||
    typeof value.activityTokenPath !== "string"
  ) {
    throw new ApnsDeliveryError("APNs sender secret file references are invalid");
  }
  return value;
}

function parseActivityToken(bytes) {
  try {
    const token = bytes.toString("utf8").trim();
    if (!TOKEN_HEX.test(token)) {
      throw new ApnsDeliveryError("ActivityKit token file is invalid");
    }
    return token.toLowerCase();
  } finally {
    bytes.fill(0);
  }
}

function parsePrivateKey(bytes) {
  try {
    const key = createPrivateKey(bytes);
    if (
      key.asymmetricKeyType !== "ec" ||
      !["P-256", "prime256v1"].includes(key.asymmetricKeyDetails?.namedCurve)
    ) {
      throw new ApnsDeliveryError("APNs signing key must be an ES256 private key");
    }
    return key;
  } catch (error) {
    if (error instanceof ApnsDeliveryError) throw error;
    throw new ApnsDeliveryError("APNs signing key is invalid");
  } finally {
    bytes.fill(0);
  }
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function parseSafeReason(body) {
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    return SAFE_APNS_REASONS.has(parsed?.reason) ? parsed.reason : "Unknown";
  } catch {
    return "Unknown";
  }
}

function priorityFor({ attentionRequired, status }) {
  return attentionRequired || ["Blocked", "Disconnected", "Ready"].includes(status)
    ? "10"
    : "5";
}

function sleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ApnsDeliveryError("APNs delivery delay was aborted"));
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    function onAbort() {
      clearTimeout(timeout);
      reject(new ApnsDeliveryError("APNs delivery delay was aborted"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class ApnsDeliveryError extends Error {
  constructor(message, { status = null, reason = null } = {}) {
    super(message);
    this.name = "ApnsDeliveryError";
    this.status = status;
    this.reason = reason;
  }
}

export function createApnsProviderToken({
  issuedAt,
  keyId,
  privateKey,
  teamId,
}) {
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
    throw new ApnsDeliveryError("APNs provider token clock is invalid");
  }
  if (!IDENTIFIER.test(keyId) || !IDENTIFIER.test(teamId)) {
    throw new ApnsDeliveryError("APNs provider token identifiers are invalid");
  }
  const unsigned = `${base64UrlJson({ alg: "ES256", kid: keyId })}.${base64UrlJson({ iss: teamId, iat: issuedAt })}`;
  let signature;
  try {
    signature = sign("sha256", Buffer.from(unsigned), {
      dsaEncoding: "ieee-p1363",
      key: privateKey,
    });
  } catch {
    throw new ApnsDeliveryError("APNs provider token could not be signed");
  }
  if (signature.length !== 64) {
    signature.fill(0);
    throw new ApnsDeliveryError("APNs provider token signature is invalid");
  }
  const encodedSignature = signature.toString("base64url");
  signature.fill(0);
  return `${unsigned}.${encodedSignature}`;
}

export async function loadApnsSenderConfiguration(
  configPath,
  { repositoryRoot = process.cwd() } = {},
) {
  const configBytes = await readPrivateFile(configPath, {
    label: "APNs sender configuration",
    maxBytes: MAX_CONFIG_BYTES,
    repositoryRoot,
  });
  let config;
  try {
    config = validateConfiguration(JSON.parse(configBytes.toString("utf8")));
  } catch (error) {
    if (error instanceof ApnsDeliveryError) throw error;
    throw new ApnsDeliveryError("APNs sender configuration is invalid");
  } finally {
    configBytes.fill(0);
  }

  const privateKeyBytes = await readPrivateFile(config.privateKeyPath, {
    label: "APNs signing key",
    maxBytes: MAX_PRIVATE_KEY_BYTES,
    repositoryRoot,
  });
  const privateKey = parsePrivateKey(privateKeyBytes);
  const activityTokenBytes = await readPrivateFile(config.activityTokenPath, {
    label: "ActivityKit token file",
    maxBytes: MAX_TOKEN_BYTES,
    repositoryRoot,
  });

  return {
    activityToken: parseActivityToken(activityTokenBytes),
    bundleId: config.bundleId,
    environment: config.environment,
    keyId: config.keyId,
    privateKey,
    teamId: config.teamId,
  };
}

export class ApnsLiveActivityHttp2Sender {
  constructor({
    activityToken,
    bundleId,
    connect = connectHttp2,
    delay = sleep,
    environment,
    keyId,
    clock = Date.now,
    privateKey,
    requestId = randomUUID,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    teamId,
  }) {
    if (!Object.hasOwn(APNS_ORIGINS, environment)) {
      throw new ApnsDeliveryError("APNs sender environment is invalid");
    }
    if (typeof activityToken !== "string" || !TOKEN_HEX.test(activityToken)) {
      throw new ApnsDeliveryError("ActivityKit token is invalid");
    }
    if (!BUNDLE_ID.test(bundleId) || !IDENTIFIER.test(keyId) || !IDENTIFIER.test(teamId)) {
      throw new ApnsDeliveryError("APNs sender identity is invalid");
    }
    if (
      typeof connect !== "function" ||
      typeof delay !== "function" ||
      typeof clock !== "function" ||
      typeof requestId !== "function"
    ) {
      throw new TypeError("APNs sender dependencies must be functions");
    }
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new TypeError("requestTimeoutMs must be a positive safe integer");
    }

    this.activityToken = activityToken.toLowerCase();
    this.bundleId = bundleId;
    this.connect = connect;
    this.delay = delay;
    this.environment = environment;
    this.keyId = keyId;
    this.clock = clock;
    this.privateKey = privateKey;
    this.requestId = requestId;
    this.requestTimeoutMs = requestTimeoutMs;
    this.teamId = teamId;
    this.session = null;
    this.activeStream = null;
    this.abortController = new AbortController();
    this.closed = false;
    this.failed = false;
    this.lastInputSequence = 0;
    this.lastSentPresentation = null;
    this.lastSentTimestamp = null;
    this.nextRefreshTimestamp = null;
    this.providerToken = null;
    this.providerTokenIssuedAt = null;
  }

  async send(payload) {
    if (this.failed) {
      throw new ApnsDeliveryError("APNs sender stopped after a delivery failure");
    }
    if (this.closed) {
      throw new ApnsDeliveryError("APNs sender is closed");
    }

    try {
      const metadata = validateLiveActivityPayload(payload, {
        previousSequence: this.lastInputSequence,
      });
      let currentTimestamp = Math.floor(this.clock() / 1_000);
      if (!Number.isSafeInteger(currentTimestamp) || currentTimestamp <= 0) {
        throw new ApnsDeliveryError("APNs delivery clock is invalid");
      }
      if (
        this.lastSentTimestamp !== null &&
        currentTimestamp < this.lastSentTimestamp
      ) {
        throw new ApnsDeliveryError("APNs delivery clock moved backward");
      }
      if (payload.aps.timestamp > currentTimestamp + MAX_FUTURE_PAYLOAD_SECONDS) {
        throw new ApnsDeliveryError("relay payload timestamp is too far in the future");
      }

      const staleAfterSeconds = payload.aps["stale-date"] - payload.aps.timestamp;
      const presentation = `${metadata.status}\u0000${metadata.attentionRequired}`;
      if (
        presentation === this.lastSentPresentation &&
        currentTimestamp < this.nextRefreshTimestamp
      ) {
        this.lastInputSequence = metadata.sequence;
        return {
          accepted: false,
          reason: "coalesced",
          sequence: metadata.sequence,
        };
      }

      const earliestTimestamp = Math.max(
        payload.aps.timestamp,
        this.lastSentTimestamp === null ? 0 : this.lastSentTimestamp + 1,
      );
      if (currentTimestamp < earliestTimestamp) {
        await this.delay(
          (earliestTimestamp - currentTimestamp) * 1_000,
          this.abortController.signal,
        );
        if (this.closed) {
          throw new ApnsDeliveryError("APNs delivery delay was aborted");
        }
        currentTimestamp = Math.floor(this.clock() / 1_000);
        if (currentTimestamp < earliestTimestamp) {
          throw new ApnsDeliveryError("APNs delivery clock did not advance safely");
        }
      }

      const staleDate = currentTimestamp + staleAfterSeconds;
      if (!Number.isSafeInteger(staleDate)) {
        throw new ApnsDeliveryError("APNs delivery stale date is invalid");
      }
      const outgoingPayload = {
        aps: {
          timestamp: currentTimestamp,
          event: payload.aps.event,
          "content-state": { ...payload.aps["content-state"] },
          "stale-date": staleDate,
        },
      };
      validateLiveActivityPayload(outgoingPayload, {
        previousSequence: this.lastInputSequence,
      });
      const body = Buffer.from(JSON.stringify(outgoingPayload));
      if (body.length > MAX_PAYLOAD_BYTES) {
        throw new ApnsDeliveryError("Live Activity payload exceeds the APNs limit");
      }

      const apnsId = this.requestId();
      if (typeof apnsId !== "string" || !UUID.test(apnsId)) {
        throw new ApnsDeliveryError("APNs request identifier is invalid");
      }
      const session = this.#getSession();
      const headers = {
        ":method": "POST",
        ":path": `/3/device/${this.activityToken}`,
        authorization: `bearer ${this.#getProviderToken()}`,
        "apns-expiration": "0",
        "apns-id": apnsId,
        "apns-priority": priorityFor(metadata),
        "apns-push-type": "liveactivity",
        "apns-topic": `${this.bundleId}.push-type.liveactivity`,
        [sensitiveHeaders]: [":path", "authorization"],
      };
      const response = await this.#post(session, headers, body);
      this.lastInputSequence = metadata.sequence;
      this.lastSentPresentation = presentation;
      this.lastSentTimestamp = currentTimestamp;
      this.nextRefreshTimestamp =
        currentTimestamp + Math.max(1, Math.floor(staleAfterSeconds / 2));
      return {
        accepted: true,
        apnsId: response.apnsId ?? apnsId,
        sequence: metadata.sequence,
        status: response.status,
      };
    } catch (error) {
      this.failed = true;
      this.abort();
      if (error instanceof ApnsDeliveryError) throw error;
      throw new ApnsDeliveryError("APNs Live Activity delivery failed");
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort();
    if (this.session !== null) {
      this.session.close();
      this.session = null;
    }
    this.#releaseSecrets();
  }

  abort() {
    if (this.closed && this.activeStream === null && this.session === null) return;
    this.closed = true;
    this.abortController.abort();
    const activeStream = this.activeStream;
    const session = this.session;
    this.activeStream = null;
    this.session = null;
    activeStream?.destroy();
    session?.destroy();
    this.#releaseSecrets();
  }

  #releaseSecrets() {
    this.providerToken = null;
    this.providerTokenIssuedAt = null;
    this.activityToken = null;
    this.privateKey = null;
  }

  #getProviderToken() {
    const issuedAt = Math.floor(this.clock() / 1_000);
    if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
      throw new ApnsDeliveryError("APNs provider token clock is invalid");
    }
    if (
      this.providerTokenIssuedAt !== null &&
      issuedAt < this.providerTokenIssuedAt
    ) {
      throw new ApnsDeliveryError("APNs provider token clock moved backward");
    }
    if (
      this.providerToken === null ||
      issuedAt - this.providerTokenIssuedAt >= PROVIDER_TOKEN_REFRESH_SECONDS
    ) {
      this.providerToken = createApnsProviderToken({
        issuedAt,
        keyId: this.keyId,
        privateKey: this.privateKey,
        teamId: this.teamId,
      });
      this.providerTokenIssuedAt = issuedAt;
    }
    return this.providerToken;
  }

  #getSession() {
    if (this.session !== null && !this.session.closed && !this.session.destroyed) {
      return this.session;
    }
    try {
      this.session = this.connect(APNS_ORIGINS[this.environment], {
        ALPNProtocols: ["h2"],
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
      });
      this.session.on("error", () => {
        this.failed = true;
        this.abort();
      });
      return this.session;
    } catch {
      throw new ApnsDeliveryError("APNs HTTP/2 connection failed");
    }
  }

  #post(session, headers, body) {
    return new Promise((resolve, reject) => {
      let responseHeaders = null;
      let responseBytes = 0;
      const chunks = [];
      let settled = false;
      let stream;

      const clearActiveStream = () => {
        if (this.activeStream === stream) this.activeStream = null;
      };

      function fail(error) {
        if (settled) return;
        settled = true;
        clearActiveStream();
        reject(error);
      }

      try {
        stream = session.request(headers);
      } catch {
        fail(new ApnsDeliveryError("APNs HTTP/2 request failed"));
        return;
      }
      this.activeStream = stream;

      stream.setTimeout(this.requestTimeoutMs, () => {
        stream.close(http2Constants.NGHTTP2_CANCEL);
        fail(new ApnsDeliveryError("APNs HTTP/2 request timed out"));
      });
      stream.on("response", (receivedHeaders) => {
        responseHeaders = receivedHeaders;
      });
      stream.on("data", (chunk) => {
        responseBytes += chunk.length;
        if (responseBytes > MAX_RESPONSE_BYTES) {
          stream.close(http2Constants.NGHTTP2_CANCEL);
          fail(new ApnsDeliveryError("APNs response exceeded the safe limit"));
          return;
        }
        chunks.push(chunk);
      });
      stream.once("error", () => {
        fail(new ApnsDeliveryError("APNs HTTP/2 request failed"));
      });
      stream.once("aborted", () => {
        fail(new ApnsDeliveryError("APNs HTTP/2 request was aborted"));
      });
      stream.once("close", () => {
        fail(new ApnsDeliveryError("APNs HTTP/2 request closed unexpectedly"));
      });
      stream.once("end", () => {
        if (settled) return;
        const status = Number(responseHeaders?.[":status"]);
        const responseBody = Buffer.concat(chunks);
        if (status === 200) {
          settled = true;
          clearActiveStream();
          resolve({
            apnsId:
              typeof responseHeaders?.["apns-id"] === "string" &&
              UUID.test(responseHeaders["apns-id"])
                ? responseHeaders["apns-id"]
                : null,
            status,
          });
          return;
        }
        const reason = parseSafeReason(responseBody);
        fail(
          new ApnsDeliveryError(
            `APNs rejected Live Activity update (status ${Number.isInteger(status) ? status : "unknown"}, reason ${reason})`,
            { status: Number.isInteger(status) ? status : null, reason },
          ),
        );
      });
      stream.end(body);
    });
  }
}

export async function sendLiveActivityJsonl(
  input,
  sender,
  { writeReceipt = async () => {} } = {},
) {
  if (!input || typeof input[Symbol.asyncIterator] !== "function") {
    throw new TypeError("input must be an async iterable");
  }
  if (!sender || typeof sender.send !== "function") {
    throw new TypeError("sender.send must be a function");
  }
  if (typeof writeReceipt !== "function") {
    throw new TypeError("writeReceipt must be a function");
  }

  let pending = Buffer.alloc(0);
  let sent = 0;

  async function processLine(line) {
    if (line.length === 0) return;
    if (line.length > MAX_JSONL_LINE_BYTES) {
      throw new ApnsDeliveryError("APNs sender input line exceeds the safe limit");
    }
    let payload;
    try {
      payload = JSON.parse(line.toString("utf8"));
    } catch {
      throw new ApnsDeliveryError("APNs sender input is not valid JSONL");
    }
    const receipt = await sender.send(payload);
    await writeReceipt(`${JSON.stringify(receipt)}\n`);
    sent += 1;
  }

  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    pending = Buffer.concat([pending, bytes]);
    let newline;
    while ((newline = pending.indexOf(0x0a)) !== -1) {
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      await processLine(line);
    }
    if (pending.length > MAX_JSONL_LINE_BYTES) {
      throw new ApnsDeliveryError("APNs sender input line exceeds the safe limit");
    }
  }

  await processLine(pending);
  if (sent === 0) {
    throw new ApnsDeliveryError("APNs sender input must contain a relay payload");
  }
  return { sent };
}
