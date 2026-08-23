import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFileRemoteActionReplayStore } from "../src/file-remote-action-replay-store.mjs";

const repositoryRoot = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");
const REPLY_TEXT = "SYNTHETIC_PRIVATE_REPLY_MUST_NOT_PERSIST";
const replayRecord = Object.freeze({
  installationId: "installation-iphone-1",
  actionId: "remote-reply-1",
  action: "reply",
  fingerprint: "a".repeat(64),
  expiresAtMs: Date.parse("2026-08-22T20:01:00.000Z"),
});
const acceptedReceipt = Object.freeze({
  schemaVersion: 1,
  actionId: "remote-reply-1",
  action: "reply",
  outcome: "accepted",
  reason: null,
});

async function replayDirectory() {
  const directoryPath = await mkdtemp(join(tmpdir(), "cla-replay-store-"));
  await chmod(directoryPath, 0o700);
  return directoryPath;
}

async function openStore(directoryPath, operations) {
  return createFileRemoteActionReplayStore({
    directoryPath,
    repositoryRoot,
    ...(operations === undefined ? {} : { operations }),
  });
}

test("persists claim and content-free completion across store restarts", async () => {
  const directoryPath = await replayDirectory();
  try {
    const first = await openStore(directoryPath);
    assert.deepEqual(await first.inspect(replayRecord), { state: "missing" });
    assert.deepEqual(await first.claim(replayRecord), { state: "new" });

    const afterClaimRestart = await openStore(directoryPath);
    assert.deepEqual(await afterClaimRestart.inspect(replayRecord), {
      state: "uncertain",
    });
    await afterClaimRestart.complete({ ...replayRecord, receipt: acceptedReceipt });

    const afterCompletionRestart = await openStore(directoryPath);
    assert.deepEqual(await afterCompletionRestart.inspect(replayRecord), {
      state: "completed",
      receipt: acceptedReceipt,
    });
    assert.deepEqual(
      await afterCompletionRestart.inspect({
        ...replayRecord,
        fingerprint: "b".repeat(64),
      }),
      { state: "conflict" },
    );

    const files = await readdir(directoryPath);
    assert.equal(files.length, 1);
    assert.match(files[0], /^[a-f0-9]{64}\.json$/u);
    const recordPath = join(directoryPath, files[0]);
    assert.equal((await stat(recordPath)).mode & 0o777, 0o600);
    const retained = await readFile(recordPath, "utf8");
    assert.deepEqual(JSON.parse(retained), {
      version: 2,
      state: "completed",
      installationId: replayRecord.installationId,
      actionId: replayRecord.actionId,
      action: replayRecord.action,
      fingerprint: replayRecord.fingerprint,
      expiresAtMs: replayRecord.expiresAtMs,
      receipt: acceptedReceipt,
    });
    assert.doesNotMatch(
      retained,
      new RegExp(`${REPLY_TEXT}|app-token|controlContext|thread-|turn-`, "u"),
    );
  } finally {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

test("allows exactly one new claim across independent store instances", async () => {
  const directoryPath = await replayDirectory();
  try {
    const first = await openStore(directoryPath);
    const second = await openStore(directoryPath);
    const results = await Promise.all([
      first.claim(replayRecord),
      second.claim(replayRecord),
    ]);
    assert.equal(results.filter((result) => result.state === "new").length, 1);
    assert.equal(results.filter((result) => result.state === "uncertain").length, 1);
  } finally {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

test("treats truncated, linked, or permission-loose records as uncertain", async () => {
  const directoryPath = await replayDirectory();
  try {
    const store = await openStore(directoryPath);
    assert.deepEqual(await store.claim(replayRecord), { state: "new" });
    const [fileName] = await readdir(directoryPath);
    const recordPath = join(directoryPath, fileName);

    const hardlinkPath = join(directoryPath, "record-hardlink");
    await link(recordPath, hardlinkPath);
    assert.deepEqual(await store.inspect(replayRecord), { state: "uncertain" });
    await rm(hardlinkPath);

    await chmod(recordPath, 0o644);
    assert.deepEqual(await store.inspect(replayRecord), { state: "uncertain" });
    await chmod(recordPath, 0o600);

    await truncate(recordPath, 1);
    assert.deepEqual(await store.inspect(replayRecord), { state: "uncertain" });
    assert.deepEqual(await store.claim(replayRecord), { state: "uncertain" });
  } finally {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

test("poisons failed claim durability and failed completion commits", async () => {
  const claimDirectory = await replayDirectory();
  const renameDirectory = await replayDirectory();
  const syncDirectory = await replayDirectory();
  try {
    const failedClaimStore = await openStore(claimDirectory, {
      syncFile: async () => {
        throw new Error("synthetic sync failure");
      },
    });
    assert.deepEqual(await failedClaimStore.claim(replayRecord), {
      state: "uncertain",
    });
    assert.deepEqual(
      await (await openStore(claimDirectory)).inspect(replayRecord),
      { state: "uncertain" },
    );

    const normalRenameStore = await openStore(renameDirectory);
    assert.deepEqual(await normalRenameStore.claim(replayRecord), { state: "new" });
    const failedRenameStore = await openStore(renameDirectory, {
      rename: async () => {
        throw new Error("synthetic rename failure");
      },
    });
    await assert.rejects(
      failedRenameStore.complete({ ...replayRecord, receipt: acceptedReceipt }),
      /completion failed/u,
    );
    assert.deepEqual(await normalRenameStore.inspect(replayRecord), {
      state: "uncertain",
    });
    assert.equal((await readdir(renameDirectory)).length, 1);

    const normalSyncStore = await openStore(syncDirectory);
    assert.deepEqual(await normalSyncStore.claim(replayRecord), { state: "new" });
    const failedDirectorySyncStore = await openStore(syncDirectory, {
      syncDirectory: async () => {
        throw new Error("synthetic directory sync failure");
      },
    });
    await assert.rejects(
      failedDirectorySyncStore.complete({
        ...replayRecord,
        receipt: acceptedReceipt,
      }),
      /completion failed/u,
    );
    assert.deepEqual(await normalSyncStore.inspect(replayRecord), {
      state: "completed",
      receipt: acceptedReceipt,
    });
  } finally {
    await Promise.all([
      rm(claimDirectory, { recursive: true, force: true }),
      rm(renameDirectory, { recursive: true, force: true }),
      rm(syncDirectory, { recursive: true, force: true }),
    ]);
  }
});

test("rejects loose, repository-contained, or replaced replay roots", async () => {
  const looseDirectory = await replayDirectory();
  const insideDirectory = await mkdtemp(join(repositoryRoot, ".replay-test-"));
  const replaceDirectory = await replayDirectory();
  const movedDirectory = `${replaceDirectory}-moved`;
  try {
    await chmod(looseDirectory, 0o755);
    await assert.rejects(openStore(looseDirectory), /owner-private external directory/u);
    await chmod(insideDirectory, 0o700);
    await assert.rejects(openStore(insideDirectory), /owner-private external directory/u);

    const store = await openStore(replaceDirectory);
    await rename(replaceDirectory, movedDirectory);
    await mkdir(replaceDirectory, { mode: 0o700 });
    await assert.rejects(store.inspect(replayRecord), /root changed/u);
  } finally {
    await Promise.all([
      rm(looseDirectory, { recursive: true, force: true }),
      rm(insideDirectory, { recursive: true, force: true }),
      rm(replaceDirectory, { recursive: true, force: true }),
      rm(movedDirectory, { recursive: true, force: true }),
    ]);
  }
});

test("rejects content-bearing or mismatched completion receipts", async () => {
  const directoryPath = await replayDirectory();
  try {
    const store = await openStore(directoryPath);
    assert.deepEqual(await store.claim(replayRecord), { state: "new" });
    await assert.rejects(
      store.complete({
        ...replayRecord,
        receipt: { ...acceptedReceipt, text: REPLY_TEXT },
      }),
      /invalid replay receipt/u,
    );
    await assert.rejects(
      store.complete({
        ...replayRecord,
        receipt: {
          ...acceptedReceipt,
          outcome: "rejected",
          reason: "invalidAction",
        },
      }),
      /invalid replay receipt/u,
    );
    await assert.rejects(
      store.complete({
        ...replayRecord,
        receipt: {
          schemaVersion: 1,
          actionId: null,
          action: null,
          outcome: "rejected",
          reason: "wrongThread",
        },
      }),
      /invalid replay receipt/u,
    );
    await assert.rejects(
      store.complete({
        ...replayRecord,
        receipt: { ...acceptedReceipt, actionId: "remote-other" },
      }),
      /replay completion target is uncertain|invalid replay receipt/u,
    );
    await assert.rejects(
      store.complete({
        ...replayRecord,
        receipt: { ...acceptedReceipt, action: "stop" },
      }),
      /invalid replay receipt/u,
    );
    assert.deepEqual(
      await store.inspect({ ...replayRecord, action: "stop" }),
      { state: "conflict" },
    );
    assert.deepEqual(await store.inspect(replayRecord), { state: "uncertain" });
  } finally {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

test("never removes a pre-existing temporary-name collision", async () => {
  const directoryPath = await replayDirectory();
  try {
    const store = await openStore(directoryPath);
    assert.deepEqual(await store.claim(replayRecord), { state: "new" });
    const [recordName] = await readdir(directoryPath);
    const temporaryPath = join(
      directoryPath,
      `${recordName}.${Buffer.alloc(12).toString("base64url")}.tmp`,
    );
    const marker = "SYNTHETIC_PREEXISTING_FILE";
    await writeFile(temporaryPath, marker, { mode: 0o600 });

    const collisionStore = await openStore(directoryPath, {
      randomBytes: () => Buffer.alloc(12),
    });
    await assert.rejects(
      collisionStore.complete({ ...replayRecord, receipt: acceptedReceipt }),
      /completion failed/u,
    );
    assert.equal(await readFile(temporaryPath, "utf8"), marker);
  } finally {
    await rm(directoryPath, { recursive: true, force: true });
  }
});
