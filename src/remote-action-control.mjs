import { randomBytes as cryptoRandomBytes } from "node:crypto";

export const CONTROL_CONTEXT_ID_BYTES = 32;
export const CONTROL_CONTEXT_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

const SAFE_INSTALLATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![\s\S])/u;

function isPrivateIdentifier(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.toWellFormed() &&
    !/[\r\n\t]/u.test(value) &&
    [...value].length <= 128
  );
}

function readNow(now) {
  const value = now();
  if (!Number.isSafeInteger(value)) throw new TypeError("clock must return a safe integer");
  return value;
}

export class OneTaskControlContextRegistry {
  #active = null;
  #maxLifetimeMs;
  #now;
  #randomBytes;

  constructor({
    maxLifetimeMs,
    now = Date.now,
    randomBytes = cryptoRandomBytes,
  } = {}) {
    if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs <= 0) {
      throw new TypeError("maxLifetimeMs must be a positive safe integer");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    if (typeof randomBytes !== "function") {
      throw new TypeError("randomBytes must be a function");
    }
    this.#maxLifetimeMs = maxLifetimeMs;
    this.#now = now;
    this.#randomBytes = randomBytes;
  }

  issue({
    installationId,
    threadId,
    expectedTurnId,
    expiresAtMs,
    dispatch,
  } = {}) {
    if (typeof installationId !== "string" || !SAFE_INSTALLATION_ID.test(installationId)) {
      throw new TypeError("installationId must be a safe identifier");
    }
    if (!isPrivateIdentifier(threadId) || !isPrivateIdentifier(expectedTurnId)) {
      throw new TypeError("threadId and expectedTurnId must be private identifiers");
    }
    if (typeof dispatch !== "function") throw new TypeError("dispatch must be a function");

    const nowMs = readNow(this.#now);
    if (
      !Number.isSafeInteger(expiresAtMs) ||
      expiresAtMs <= nowMs ||
      expiresAtMs - nowMs > this.#maxLifetimeMs
    ) {
      throw new TypeError("expiresAtMs exceeds the configured context lifetime");
    }
    let expiresAt;
    try {
      expiresAt = new Date(expiresAtMs).toISOString();
    } catch {
      throw new TypeError("expiresAtMs must be a valid Date timestamp");
    }

    let controlContextId;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const entropy = this.#randomBytes(CONTROL_CONTEXT_ID_BYTES);
      if (!(entropy instanceof Uint8Array) || entropy.byteLength !== CONTROL_CONTEXT_ID_BYTES) {
        throw new TypeError("randomBytes must return exactly 32 bytes");
      }
      controlContextId = Buffer.from(entropy).toString("base64url");
      if (controlContextId !== this.#active?.controlContextId) break;
      controlContextId = undefined;
    }
    if (!CONTROL_CONTEXT_ID_PATTERN.test(controlContextId ?? "")) {
      throw new Error("unable to issue a unique control context");
    }

    const record = Object.freeze({
      installationId,
      controlContextId,
      threadId,
      expectedTurnId,
      expiresAtMs,
      dispatch,
    });
    this.#active = record;
    return Object.freeze({
      controlContextId,
      expiresAt,
    });
  }

  resolve({ installationId, controlContextId } = {}) {
    const record = this.#active;
    if (
      record === null ||
      installationId !== record.installationId ||
      controlContextId !== record.controlContextId
    ) {
      return null;
    }

    const dispatch = (privateAction) => {
      if (this.#active !== record || readNow(this.#now) >= record.expiresAtMs) {
        throw new Error("control context is no longer active");
      }
      if (
        privateAction?.threadId !== record.threadId ||
        privateAction?.expectedTurnId !== record.expectedTurnId
      ) {
        throw new Error("control context correlation changed");
      }
      return record.dispatch(privateAction);
    };

    return Object.freeze({
      installationId: record.installationId,
      controlContextId: record.controlContextId,
      expiresAtMs: record.expiresAtMs,
      threadId: record.threadId,
      expectedTurnId: record.expectedTurnId,
      dispatch,
    });
  }

  revokeTurn({ threadId, expectedTurnId } = {}) {
    if (
      this.#active === null ||
      threadId !== this.#active.threadId ||
      expectedTurnId !== this.#active.expectedTurnId
    ) {
      return false;
    }
    this.#active = null;
    return true;
  }

  revokeAll() {
    const revoked = this.#active !== null;
    this.#active = null;
    return revoked;
  }
}
