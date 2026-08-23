import { createFileRemoteActionReplayStore } from "./file-remote-action-replay-store.mjs";
import { createLocalhostTurnActionListener } from "./localhost-turn-action-listener.mjs";
import { OneTaskControlContextRegistry } from "./remote-action-control.mjs";
import { loadRemoteActionSecrets } from "./remote-action-secrets.mjs";
import { createTailscaleTurnActionRequestHandler } from "./tailscale-turn-action-ingress.mjs";

export const DEFAULT_LOCAL_CONTROL_CONTEXT_LIFETIME_MS = 120_000;

function readNow(now) {
  const value = now();
  if (!Number.isSafeInteger(value)) {
    throw new TypeError("clock must return a safe integer");
  }
  return value;
}

export async function createMacLocalTurnActionComposition({
  installationId,
  expectedCapability,
  appTokenPath,
  hmacKeyPath,
  replayDirectoryPath,
  repositoryRoot,
  contextLifetimeMs = DEFAULT_LOCAL_CONTROL_CONTEXT_LIFETIME_MS,
  now = Date.now,
  randomBytes,
} = {}) {
  if (
    !Number.isSafeInteger(contextLifetimeMs) ||
    contextLifetimeMs <= 0
  ) {
    throw new TypeError("contextLifetimeMs must be a positive safe integer");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");

  const secrets = await loadRemoteActionSecrets({
    installationId,
    appTokenPath,
    hmacKeyPath,
    repositoryRoot,
  });

  try {
    const replayStore = await createFileRemoteActionReplayStore({
      directoryPath: replayDirectoryPath,
      repositoryRoot,
    });
    const registry = new OneTaskControlContextRegistry({
      maxLifetimeMs: contextLifetimeMs,
      now,
      ...(randomBytes === undefined ? {} : { randomBytes }),
    });
    const handler = createTailscaleTurnActionRequestHandler({
      expectedCapability,
      authorizeAppToken: secrets.authorizeAppToken,
      resolveControlContext: (request) => registry.resolve(request),
      replayStore,
      fingerprintAction: secrets.fingerprintAction,
      now,
    });
    const listener = createLocalhostTurnActionListener({
      handleRequest: handler,
      revokeControlContexts: () => registry.revokeAll(),
    });

    let closed = false;
    let activeTurn = null;
    let closePromise = null;

    const start = (options) => {
      if (closed) throw new Error("composition is closed");
      return listener.start(options);
    };

    const activate = ({ threadId, expectedTurnId, dispatch } = {}) => {
      if (closed || !listener.listening) {
        throw new Error("composition listener is not active");
      }
      if (activeTurn !== null) {
        throw new Error("composition already owns an active turn");
      }
      const nowMs = readNow(now);
      const expiresAtMs = nowMs + contextLifetimeMs;
      if (!Number.isSafeInteger(expiresAtMs)) {
        throw new TypeError("control context expiry is out of range");
      }
      const publicContext = registry.issue({
        installationId,
        threadId,
        expectedTurnId,
        expiresAtMs,
        dispatch,
      });
      activeTurn = Object.freeze({ threadId, expectedTurnId });
      return publicContext;
    };

    const revokeTurn = ({ threadId, expectedTurnId } = {}) => {
      const revoked = registry.revokeTurn({ threadId, expectedTurnId });
      if (
        activeTurn?.threadId === threadId &&
        activeTurn.expectedTurnId === expectedTurnId
      ) {
        activeTurn = null;
      }
      return revoked;
    };

    const revokeAll = () => {
      activeTurn = null;
      return registry.revokeAll();
    };

    const close = () => {
      if (closePromise !== null) return closePromise;
      closePromise = (async () => {
        closed = true;
        activeTurn = null;
        try {
          await listener.close();
        } finally {
          secrets.dispose();
        }
      })();
      return closePromise;
    };

    return Object.freeze({
      start,
      activate,
      revokeTurn,
      revokeAll,
      close,
      get listening() {
        return listener.listening;
      },
    });
  } catch (error) {
    secrets.dispose();
    throw error;
  }
}
