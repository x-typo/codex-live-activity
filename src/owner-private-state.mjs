import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

export class OwnerPrivateStateError extends Error {
  constructor(message) {
    super(message);
    this.name = "OwnerPrivateStateError";
  }
}

function isInside(path, root) {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

function stateError(label, kind) {
  return new OwnerPrivateStateError(
    `${label} must be an owner-private external ${kind}`,
  );
}

function hasExpectedOwner(stats) {
  return typeof process.getuid !== "function" || stats.uid === process.getuid();
}

export async function validateOwnerPrivateExternalDirectory(
  directoryPath,
  { label, repositoryRoot },
) {
  if (
    typeof directoryPath !== "string" ||
    !isAbsolute(directoryPath) ||
    typeof repositoryRoot !== "string" ||
    !isAbsolute(repositoryRoot)
  ) {
    throw stateError(label, "directory");
  }

  let before;
  let directoryRealPath;
  let repositoryRealPath;
  try {
    [before, directoryRealPath, repositoryRealPath] = await Promise.all([
      lstat(directoryPath),
      realpath(directoryPath),
      realpath(repositoryRoot),
    ]);
  } catch {
    throw stateError(label, "directory");
  }
  if (
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    !hasExpectedOwner(before) ||
    (before.mode & 0o777) !== 0o700 ||
    isInside(directoryRealPath, repositoryRealPath)
  ) {
    throw stateError(label, "directory");
  }

  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const directoryFlag = fsConstants.O_DIRECTORY ?? 0;
  let handle;
  try {
    handle = await open(
      directoryPath,
      fsConstants.O_RDONLY | noFollow | directoryFlag,
    );
    const after = await handle.stat();
    if (
      !after.isDirectory() ||
      !hasExpectedOwner(after) ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      (after.mode & 0o777) !== 0o700
    ) {
      throw stateError(label, "directory");
    }
  } catch (error) {
    if (error instanceof OwnerPrivateStateError) throw error;
    throw stateError(label, "directory");
  } finally {
    await handle?.close();
  }
  return Object.freeze({
    realPath: directoryRealPath,
    dev: before.dev,
    ino: before.ino,
  });
}

export async function readOwnerPrivateExternalFile(
  filePath,
  { label, maxBytes, repositoryRoot, requiredMode = null },
) {
  if (
    typeof filePath !== "string" ||
    !isAbsolute(filePath) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    typeof repositoryRoot !== "string" ||
    !isAbsolute(repositoryRoot) ||
    (requiredMode !== null &&
      (!Number.isSafeInteger(requiredMode) || requiredMode < 0 || requiredMode > 0o777))
  ) {
    throw stateError(label, "file");
  }

  let before;
  let fileRealPath;
  let repositoryRealPath;
  try {
    [before, fileRealPath, repositoryRealPath] = await Promise.all([
      lstat(filePath),
      realpath(filePath),
      realpath(repositoryRoot),
    ]);
  } catch {
    throw stateError(label, "file");
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1 ||
    before.size > maxBytes ||
    !hasExpectedOwner(before) ||
    (requiredMode === null
      ? (before.mode & 0o077) !== 0
      : (before.mode & 0o777) !== requiredMode) ||
    isInside(fileRealPath, repositoryRealPath)
  ) {
    throw stateError(label, "file");
  }

  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
    const after = await handle.stat();
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size > maxBytes ||
      !hasExpectedOwner(after) ||
      (requiredMode === null
        ? (after.mode & 0o077) !== 0
        : (after.mode & 0o777) !== requiredMode)
    ) {
      throw stateError(label, "file");
    }
    const bytes = await handle.readFile();
    const final = await handle.stat();
    if (
      bytes.byteLength > maxBytes ||
      final.dev !== after.dev ||
      final.ino !== after.ino ||
      final.size !== bytes.byteLength ||
      final.nlink !== 1 ||
      !hasExpectedOwner(final) ||
      (requiredMode === null
        ? (final.mode & 0o077) !== 0
        : (final.mode & 0o777) !== requiredMode)
    ) {
      bytes.fill(0);
      throw stateError(label, "file");
    }
    return bytes;
  } catch (error) {
    if (error instanceof OwnerPrivateStateError) throw error;
    throw stateError(label, "file");
  } finally {
    await handle?.close();
  }
}
