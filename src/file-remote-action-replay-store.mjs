import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  open as fsOpen,
  rename as fsRename,
  unlink as fsUnlink,
} from "node:fs/promises";
import { join } from "node:path";

import { validateOwnerPrivateExternalDirectory } from "./owner-private-state.mjs";
import {
  projectRemoteActionCorrelation,
  projectRemoteActionReceipt,
} from "./remote-action-receipt.mjs";
import { parseJsonRejectingDuplicateMembers } from "./strict-json.mjs";

const MAX_REPLAY_RECORD_BYTES = 4_096;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![\s\S])/u;
const FINGERPRINT = /^[a-f0-9]{64}$/u;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isSafeId(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}

function validateReplayInput(value, { withReceipt = false } = {}) {
  const keys = [
    "action",
    "actionId",
    "expiresAtMs",
    "fingerprint",
    "installationId",
  ];
  if (withReceipt) keys.push("receipt");
  const correlation = projectRemoteActionCorrelation(value);
  if (
    !hasExactKeys(value, keys) ||
    correlation === null ||
    !isSafeId(value.installationId) ||
    typeof value.fingerprint !== "string" ||
    !FINGERPRINT.test(value.fingerprint) ||
    !Number.isSafeInteger(value.expiresAtMs)
  ) {
    throw new TypeError("invalid replay record");
  }
  const input = {
    installationId: value.installationId,
    actionId: correlation.actionId,
    action: correlation.action,
    fingerprint: value.fingerprint,
    expiresAtMs: value.expiresAtMs,
  };
  if (withReceipt) {
    input.receipt = validateReceipt(value.receipt, correlation);
  }
  return input;
}

function validateReceipt(value, expectedAction) {
  const receipt = projectRemoteActionReceipt(value, {
    expectedAction,
    requireCorrelation: true,
  });
  if (receipt === null) throw new TypeError("invalid replay receipt");
  return receipt;
}

function validateStoredRecord(value) {
  const baseKeys = [
    "action",
    "actionId",
    "expiresAtMs",
    "fingerprint",
    "installationId",
    "state",
    "version",
  ];
  const completed = value?.state === "completed";
  if (
    !hasExactKeys(value, completed ? [...baseKeys, "receipt"] : baseKeys) ||
    value.version !== 2 ||
    !["claimed", "completed"].includes(value.state) ||
    !isSafeId(value.installationId) ||
    typeof value.fingerprint !== "string" ||
    !FINGERPRINT.test(value.fingerprint) ||
    !Number.isSafeInteger(value.expiresAtMs)
  ) {
    return null;
  }
  const correlation = projectRemoteActionCorrelation(value);
  if (correlation === null) return null;
  let receipt;
  if (completed) {
    try {
      receipt = validateReceipt(value.receipt, correlation);
    } catch {
      return null;
    }
  }
  return {
    version: 2,
    state: value.state,
    installationId: value.installationId,
    actionId: correlation.actionId,
    action: correlation.action,
    fingerprint: value.fingerprint,
    expiresAtMs: value.expiresAtMs,
    ...(completed ? { receipt } : {}),
  };
}

function recordPath(directoryPath, record) {
  const key = createHash("sha256")
    .update(record.installationId)
    .update("\0")
    .update(record.actionId)
    .digest("hex");
  return join(directoryPath, `${key}.json`);
}

function matchingRecord(stored, requested) {
  return (
    stored.installationId === requested.installationId &&
    stored.actionId === requested.actionId &&
    stored.action === requested.action &&
    stored.fingerprint === requested.fingerprint &&
    stored.expiresAtMs === requested.expiresAtMs
  );
}

function projectState(stored, requested) {
  if (
    stored.installationId !== requested.installationId ||
    stored.actionId !== requested.actionId
  ) {
    return { state: "uncertain" };
  }
  if (stored.action !== requested.action) {
    return { state: "conflict" };
  }
  if (stored.fingerprint !== requested.fingerprint) {
    return { state: "conflict" };
  }
  if (stored.expiresAtMs !== requested.expiresAtMs) {
    return { state: "uncertain" };
  }
  if (stored.state === "completed") {
    return { state: "completed", receipt: structuredClone(stored.receipt) };
  }
  return { state: "uncertain" };
}

async function defaultSyncFile(handle) {
  await handle.sync();
}

async function defaultSyncDirectory(directoryPath, expectedIdentity) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const directoryFlag = fsConstants.O_DIRECTORY ?? 0;
  const handle = await fsOpen(
    directoryPath,
    fsConstants.O_RDONLY | noFollow | directoryFlag,
  );
  try {
    const stats = await handle.stat();
    if (
      !stats.isDirectory() ||
      stats.dev !== expectedIdentity.dev ||
      stats.ino !== expectedIdentity.ino ||
      (stats.mode & 0o777) !== 0o700 ||
      (typeof process.getuid === "function" && stats.uid !== process.getuid())
    ) {
      throw new Error("replay store root changed");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function createFileRemoteActionReplayStore({
  directoryPath,
  repositoryRoot,
  operations = {},
} = {}) {
  const rootIdentity = await validateOwnerPrivateExternalDirectory(directoryPath, {
    label: "replay store",
    repositoryRoot,
  });
  const openFile = operations.open ?? fsOpen;
  const renameFile = operations.rename ?? fsRename;
  const unlinkFile = operations.unlink ?? fsUnlink;
  const syncFile = operations.syncFile ?? defaultSyncFile;
  const syncDirectory = operations.syncDirectory ?? defaultSyncDirectory;
  const randomBytes = operations.randomBytes ?? cryptoRandomBytes;
  for (const operation of [
    openFile,
    renameFile,
    unlinkFile,
    syncFile,
    syncDirectory,
    randomBytes,
  ]) {
    if (typeof operation !== "function") throw new TypeError("invalid replay operation");
  }

  const assertRoot = async () => {
    const current = await validateOwnerPrivateExternalDirectory(directoryPath, {
      label: "replay store",
      repositoryRoot,
    });
    if (
      current.realPath !== rootIdentity.realPath ||
      current.dev !== rootIdentity.dev ||
      current.ino !== rootIdentity.ino
    ) {
      throw new Error("replay store root changed");
    }
  };

  const readStoredRecord = async (path) => {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    let handle;
    try {
      handle = await openFile(path, fsConstants.O_RDONLY | noFollow);
    } catch (error) {
      if (error?.code === "ENOENT") return { kind: "missing" };
      return { kind: "invalid" };
    }
    try {
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        stats.size > MAX_REPLAY_RECORD_BYTES ||
        (stats.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === "function" && stats.uid !== process.getuid())
      ) {
        return { kind: "invalid" };
      }
      const bytes = await handle.readFile();
      const final = await handle.stat();
      if (
        bytes.byteLength > MAX_REPLAY_RECORD_BYTES ||
        final.size !== bytes.byteLength ||
        final.dev !== stats.dev ||
        final.ino !== stats.ino ||
        final.nlink !== 1 ||
        (final.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === "function" && final.uid !== process.getuid())
      ) {
        bytes.fill(0);
        return { kind: "invalid" };
      }
      let parsed;
      try {
        parsed = parseJsonRejectingDuplicateMembers(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } finally {
        bytes.fill(0);
      }
      const record = validateStoredRecord(parsed);
      return record === null
        ? { kind: "invalid" }
        : { kind: "record", record };
    } catch {
      return { kind: "invalid" };
    } finally {
      await handle.close();
    }
  };

  const inspect = async (value) => {
    const requested = validateReplayInput(value);
    await assertRoot();
    const stored = await readStoredRecord(recordPath(rootIdentity.realPath, requested));
    if (stored.kind === "missing") return { state: "missing" };
    if (stored.kind !== "record") return { state: "uncertain" };
    return projectState(stored.record, requested);
  };

  const claim = async (value) => {
    const requested = validateReplayInput(value);
    await assertRoot();
    const path = recordPath(rootIdentity.realPath, requested);
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    let handle;
    try {
      handle = await openFile(
        path,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          noFollow,
        0o600,
      );
    } catch (error) {
      if (error?.code === "EEXIST") return inspect(requested);
      throw new Error("replay claim failed");
    }

    try {
      await handle.chmod(0o600);
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        (stats.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === "function" && stats.uid !== process.getuid())
      ) {
        throw new Error("invalid replay claim file");
      }
      await handle.writeFile(
        JSON.stringify({ version: 2, state: "claimed", ...requested }),
        "utf8",
      );
      await syncFile(handle);
      await handle.close();
      handle = undefined;
      await syncDirectory(rootIdentity.realPath, rootIdentity);
      return { state: "new" };
    } catch {
      try {
        await handle?.close();
      } catch {}
      return { state: "uncertain" };
    }
  };

  const complete = async (value) => {
    const requested = validateReplayInput(value, { withReceipt: true });
    await assertRoot();
    const path = recordPath(rootIdentity.realPath, requested);
    const stored = await readStoredRecord(path);
    if (stored.kind !== "record" || !matchingRecord(stored.record, requested)) {
      throw new Error("replay completion target is uncertain");
    }
    if (stored.record.state === "completed") {
      if (JSON.stringify(stored.record.receipt) !== JSON.stringify(requested.receipt)) {
        throw new Error("replay completion conflicts");
      }
      return;
    }

    const entropy = randomBytes(12);
    if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 12) {
      throw new Error("replay temporary name is unavailable");
    }
    const temporaryPath = `${path}.${Buffer.from(entropy).toString("base64url")}.tmp`;
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    let handle;
    let temporaryCreated = false;
    let renamed = false;
    try {
      handle = await openFile(
        temporaryPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          noFollow,
        0o600,
      );
      temporaryCreated = true;
      await handle.chmod(0o600);
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        (stats.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === "function" && stats.uid !== process.getuid())
      ) {
        throw new Error("invalid replay completion file");
      }
      await handle.writeFile(
        JSON.stringify({
          version: 2,
          state: "completed",
          installationId: requested.installationId,
          actionId: requested.actionId,
          action: requested.action,
          fingerprint: requested.fingerprint,
          expiresAtMs: requested.expiresAtMs,
          receipt: requested.receipt,
        }),
        "utf8",
      );
      await syncFile(handle);
      await handle.close();
      handle = undefined;
      await renameFile(temporaryPath, path);
      renamed = true;
      await syncDirectory(rootIdentity.realPath, rootIdentity);
    } catch {
      try {
        await handle?.close();
      } catch {}
      if (temporaryCreated && !renamed) {
        try {
          await unlinkFile(temporaryPath);
        } catch {}
      }
      throw new Error("replay completion failed");
    }
  };

  return Object.freeze({ inspect, claim, complete });
}
