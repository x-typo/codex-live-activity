import { timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";

import { readOwnerPrivateExternalFile } from "./owner-private-state.mjs";
import { createRemoteActionHmacFingerprint } from "./tailscale-turn-action-ingress.mjs";

export const REMOTE_ACTION_SECRET_BYTES = 32;

const ENCODED_SECRET = /^[A-Za-z0-9_-]{43}$/u;
const SAFE_INSTALLATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![\s\S])/u;
const MAX_ENCODED_SECRET_FILE_BYTES = 64;

export class RemoteActionSecretError extends Error {
  constructor() {
    super("remote action secret configuration is invalid");
    this.name = "RemoteActionSecretError";
  }
}

function decodeSecret(value) {
  if (typeof value !== "string" || !ENCODED_SECRET.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.byteLength !== REMOTE_ACTION_SECRET_BYTES ||
    decoded.toString("base64url") !== value
  ) {
    decoded.fill(0);
    return null;
  }
  return decoded;
}

function decodeSecretFile(bytes) {
  let encoded;
  try {
    encoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RemoteActionSecretError();
  }
  const decoded = decodeSecret(encoded);
  if (decoded === null) throw new RemoteActionSecretError();
  return decoded;
}

export async function loadRemoteActionSecrets({
  installationId,
  appTokenPath,
  hmacKeyPath,
  repositoryRoot,
} = {}) {
  if (
    typeof installationId !== "string" ||
    !SAFE_INSTALLATION_ID.test(installationId) ||
    appTokenPath === hmacKeyPath
  ) {
    throw new RemoteActionSecretError();
  }

  try {
    const [appTokenRealPath, hmacKeyRealPath] = await Promise.all([
      realpath(appTokenPath),
      realpath(hmacKeyPath),
    ]);
    if (appTokenRealPath === hmacKeyRealPath) {
      throw new RemoteActionSecretError();
    }
  } catch (error) {
    if (error instanceof RemoteActionSecretError) throw error;
    throw new RemoteActionSecretError();
  }

  let appTokenFile;
  let hmacKeyFile;
  let expectedAppToken;
  let hmacKey;
  try {
    appTokenFile = await readOwnerPrivateExternalFile(appTokenPath, {
      label: "paired app token",
      maxBytes: MAX_ENCODED_SECRET_FILE_BYTES,
      repositoryRoot,
    });
    expectedAppToken = decodeSecretFile(appTokenFile);
    hmacKeyFile = await readOwnerPrivateExternalFile(hmacKeyPath, {
      label: "replay HMAC key",
      maxBytes: MAX_ENCODED_SECRET_FILE_BYTES,
      repositoryRoot,
    });
    hmacKey = decodeSecretFile(hmacKeyFile);
    if (timingSafeEqual(expectedAppToken, hmacKey)) {
      throw new RemoteActionSecretError();
    }
  } catch {
    expectedAppToken?.fill(0);
    hmacKey?.fill(0);
    throw new RemoteActionSecretError();
  } finally {
    appTokenFile?.fill(0);
    hmacKeyFile?.fill(0);
  }

  let fingerprintAction;
  try {
    fingerprintAction = createRemoteActionHmacFingerprint(hmacKey);
  } finally {
    hmacKey.fill(0);
  }
  let disposed = false;

  const authorizeAppToken = (candidate) => {
    if (disposed) return null;
    const candidateBytes = decodeSecret(candidate);
    if (candidateBytes === null) return null;
    try {
      return timingSafeEqual(candidateBytes, expectedAppToken)
        ? installationId
        : null;
    } finally {
      candidateBytes.fill(0);
    }
  };

  const dispose = () => {
    if (!disposed) {
      expectedAppToken.fill(0);
      fingerprintAction.dispose();
    }
    disposed = true;
  };

  return Object.freeze({ authorizeAppToken, fingerprintAction, dispose });
}
