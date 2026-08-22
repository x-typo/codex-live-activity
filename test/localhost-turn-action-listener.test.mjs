import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import test from "node:test";

import {
  LOCALHOST_TURN_ACTION_HOST,
  createLocalhostTurnActionListener,
} from "../src/localhost-turn-action-listener.mjs";
import {
  MAX_REMOTE_ACTION_BODY_BYTES,
  REMOTE_TURN_ACTION_PATH,
} from "../src/tailscale-turn-action-ingress.mjs";

function ingressResponse({
  statusCode = 200,
  actionId = "action-safe-1",
  action = "stop",
  outcome = "accepted",
  reason = null,
} = {}) {
  return {
    statusCode,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
    body: JSON.stringify({
      schemaVersion: 1,
      actionId,
      action,
      outcome,
      reason,
    }),
  };
}

function requestListener({
  port,
  method = "POST",
  path = REMOTE_TURN_ACTION_PATH,
  body = "{}",
  headers = {},
} = {}) {
  const encoded = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        agent: false,
        host: LOCALHOST_TURN_ACTION_HOST,
        port,
        method,
        path,
        headers: {
          ...headers,
          "content-length": encoded.byteLength,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(encoded);
  });
}

function rawRequest({ port, raw }) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: LOCALHOST_TURN_ACTION_HOST, port });
    const chunks = [];
    socket.setTimeout(2_000, () => socket.destroy(new Error("raw request timed out")));
    socket.on("connect", () => socket.end(raw));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

function expectConnectionFailure({ host, port }) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    socket.setTimeout(1_000, () => {
      socket.destroy();
      reject(new Error(`unexpected open listener on ${host}:${port}`));
    });
    socket.on("connect", () => {
      socket.destroy();
      reject(new Error(`unexpected connection to ${host}:${port}`));
    });
    socket.on("error", () => resolve());
  });
}

function abortPartialRequest({ port }) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: LOCALHOST_TURN_ACTION_HOST, port });
    socket.setTimeout(1_000, () => {
      socket.destroy();
      reject(new Error("partial request did not close"));
    });
    socket.on("connect", () => {
      socket.write(
        `POST ${REMOTE_TURN_ACTION_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 100\r\n\r\n{`,
      );
      socket.destroy();
    });
    socket.on("close", () => resolve());
    socket.on("error", (error) => {
      if (error.code === "ECONNRESET") resolve();
      else reject(error);
    });
  });
}

test("starts closed, binds only literal IPv4 loopback, projects headers, and closes", async () => {
  const handled = [];
  let revocations = 0;
  const listener = createLocalhostTurnActionListener({
    handleRequest: async (request) => {
      handled.push(request);
      return ingressResponse();
    },
    revokeControlContexts: () => {
      revocations += 1;
    },
  });

  assert.equal(listener.listening, false);
  const address = await listener.start();
  try {
    assert.deepEqual(address, {
      host: "127.0.0.1",
      port: address.port,
    });
    assert.equal(listener.listening, true);
    await expectConnectionFailure({ host: "::1", port: address.port });

    const result = await requestListener({
      port: address.port,
      headers: {
        authorization: "Bearer synthetic-token",
        "content-type": "application/json",
        "tailscale-app-capabilities": "{\"safe\":[]}",
        "x-must-not-cross": "SENSITIVE_UNKNOWN_HEADER",
      },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers.connection, "close");
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(
      Number(result.headers["content-length"]),
      Buffer.byteLength(result.body),
    );
    assert.equal(handled.length, 1);
    assert.deepEqual(
      {
        ...handled[0],
        headers: { ...handled[0].headers },
      },
      {
        method: "POST",
        path: REMOTE_TURN_ACTION_PATH,
        headers: {
          authorization: "Bearer synthetic-token",
          "content-type": "application/json",
          "tailscale-app-capabilities": "{\"safe\":[]}",
        },
        body: Buffer.from("{}"),
      },
    );
  } finally {
    await Promise.all([listener.close(), listener.close()]);
  }
  assert.equal(revocations, 1);
  assert.equal(listener.listening, false);
  await expectConnectionFailure({
    host: LOCALHOST_TURN_ACTION_HOST,
    port: address.port,
  });
  assert.throws(() => listener.start(), /closed|only once/u);
});

test("rejects method, target, HTTP version, Host, and framing deviations before the handler", async () => {
  let handled = 0;
  const listener = createLocalhostTurnActionListener({
    handleRequest: async () => {
      handled += 1;
      return ingressResponse();
    },
    revokeControlContexts: () => {},
  });
  const { port } = await listener.start();
  try {
    assert.equal(
      (await requestListener({ port, method: "GET", body: "" })).statusCode,
      404,
    );
    assert.equal(
      (
        await requestListener({
          port,
          path: `${REMOTE_TURN_ACTION_PATH}?action=stop`,
        })
      )
        .statusCode,
      404,
    );
    assert.equal(
      (await requestListener({ port, path: "/v1%2fturn-actions" })).statusCode,
      404,
    );
    assert.equal(
      (
        await requestListener({
          port,
          headers: { host: `localhost:${port}` },
        })
      ).statusCode,
      400,
    );

    const http10 = await rawRequest({
      port,
      raw: `POST ${REMOTE_TURN_ACTION_PATH} HTTP/1.0\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 2\r\n\r\n{}`,
    });
    assert.match(http10, /^HTTP\/1\.1 404 /u);

    const missingHost = await rawRequest({
      port,
      raw: `POST ${REMOTE_TURN_ACTION_PATH} HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}`,
    });
    assert.match(missingHost, /^HTTP\/1\.1 400 /u);

    const chunked = await rawRequest({
      port,
      raw: `POST ${REMOTE_TURN_ACTION_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n`,
    });
    assert.match(chunked, /^HTTP\/1\.1 400 /u);

    const compressed = await rawRequest({
      port,
      raw: `POST ${REMOTE_TURN_ACTION_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Encoding: gzip\r\nContent-Length: 2\r\n\r\n{}`,
    });
    assert.match(compressed, /^HTTP\/1\.1 400 /u);

    const missingLength = await rawRequest({
      port,
      raw: `POST ${REMOTE_TURN_ACTION_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`,
    });
    assert.match(missingLength, /^HTTP\/1\.1 400 /u);

    const expected = await requestListener({
      port,
      headers: { expect: "100-continue" },
    });
    assert.equal(expected.statusCode, 400);

    await abortPartialRequest({ port });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(handled, 0);
  } finally {
    await listener.close();
  }
});

test("rejects duplicate protected raw headers before the handler", async () => {
  let handled = 0;
  const listener = createLocalhostTurnActionListener({
    handleRequest: async () => {
      handled += 1;
      return ingressResponse();
    },
    revokeControlContexts: () => {},
  });
  const { port } = await listener.start();
  try {
    for (const duplicate of [
      "Authorization: Bearer one\r\nAuthorization: Bearer two",
      "Content-Type: application/json\r\nContent-Type: application/json",
      "Tailscale-App-Capabilities: {}\r\nTailscale-App-Capabilities: {}",
      `Host: 127.0.0.1:${port}\r\nHost: 127.0.0.1:${port}`,
    ]) {
      const host = duplicate.startsWith("Host:")
        ? ""
        : `Host: 127.0.0.1:${port}\r\n`;
      const raw = await rawRequest({
        port,
        raw: `POST ${REMOTE_TURN_ACTION_PATH} HTTP/1.1\r\n${host}${duplicate}\r\nContent-Length: 2\r\n\r\n{}`,
      });
      assert.match(raw, /^HTTP\/1\.1 400 /u);
    }
    const duplicateLength = await rawRequest({
      port,
      raw: `POST ${REMOTE_TURN_ACTION_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}`,
    }).catch((error) => {
      if (error.code === "ECONNRESET") return "";
      throw error;
    });
    assert.ok(
      duplicateLength === "" || /^HTTP\/1\.1 400 /u.test(duplicateLength),
    );
    assert.equal(handled, 0);
  } finally {
    await listener.close();
  }
});

test("enforces declared and streamed body byte limits before the handler", async () => {
  let handled = 0;
  const listener = createLocalhostTurnActionListener({
    handleRequest: async () => {
      handled += 1;
      return ingressResponse();
    },
    revokeControlContexts: () => {},
  });
  const { port } = await listener.start();
  try {
    const atLimit = await requestListener({
      port,
      body: Buffer.alloc(MAX_REMOTE_ACTION_BODY_BYTES, 0x41),
    });
    assert.equal(atLimit.statusCode, 200);
    assert.equal(handled, 1);

    const overLimit = await requestListener({
      port,
      body: Buffer.alloc(MAX_REMOTE_ACTION_BODY_BYTES + 1, 0x41),
    });
    assert.equal(overLimit.statusCode, 413);
    assert.equal(handled, 1);

    const multibyte = await requestListener({
      port,
      body: "😀".repeat(MAX_REMOTE_ACTION_BODY_BYTES / 2),
    });
    assert.equal(multibyte.statusCode, 413);
    assert.equal(handled, 1);

    const empty = await requestListener({ port, body: "" });
    assert.equal(empty.statusCode, 400);
    assert.equal(handled, 1);
  } finally {
    await listener.close();
  }
});

test("contains thrown and malformed handler results in a content-free response", async () => {
  for (const handleRequest of [
    async () => {
      throw new Error("SENSITIVE_THROWN_HANDLER_VALUE");
    },
    async () => ({
      statusCode: 200,
      headers: { "content-type": "text/plain" },
      body: "SENSITIVE_MALFORMED_HANDLER_VALUE",
    }),
    async () =>
      ingressResponse({
        statusCode: 200,
        outcome: "rejected",
        reason: "unavailable",
      }),
    async () => ({
      ...ingressResponse(),
      body:
        '{"schemaVersion":1,"actionId":"SENSITIVE_DUPLICATE_HANDLER_VALUE","actionId":"action-safe-1","action":"stop","outcome":"accepted","reason":null}',
    }),
    async () => {
      const value = ingressResponse();
      Object.defineProperty(value, "statusCode", {
        enumerable: true,
        get: () => {
          throw new Error("SENSITIVE_THROWING_RESPONSE_GETTER");
        },
      });
      return value;
    },
    async () =>
      new Proxy(ingressResponse(), {
        ownKeys: () => {
          throw new Error("SENSITIVE_THROWING_RESPONSE_PROXY");
        },
      }),
  ]) {
    const listener = createLocalhostTurnActionListener({
      handleRequest,
      revokeControlContexts: () => {},
    });
    const { port } = await listener.start();
    try {
      const result = await requestListener({ port });
      assert.equal(result.statusCode, 503);
      assert.deepEqual(JSON.parse(result.body), {
        schemaVersion: 1,
        actionId: null,
        action: null,
        outcome: "rejected",
        reason: "unavailable",
      });
      assert.doesNotMatch(result.body, /SENSITIVE_/u);
    } finally {
      await listener.close();
    }
  }
});

test("close stops acceptance, revokes controls, and lets an active handler finish", async () => {
  let releaseHandler;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const release = new Promise((resolve) => {
    releaseHandler = resolve;
  });
  const events = [];
  const listener = createLocalhostTurnActionListener({
    handleRequest: async () => {
      events.push("handler-started");
      markStarted();
      await release;
      events.push("handler-finished");
      return ingressResponse();
    },
    revokeControlContexts: () => events.push("revoked"),
  });
  const { port } = await listener.start();
  const pendingRequest = requestListener({ port });
  await started;

  const pendingClose = listener.close();
  assert.equal(listener.listening, false);
  assert.deepEqual(events, ["handler-started", "revoked"]);
  releaseHandler();

  assert.equal((await pendingRequest).statusCode, 200);
  await pendingClose;
  assert.deepEqual(events, ["handler-started", "revoked", "handler-finished"]);
});

test("close prevents reentrant and later listener startup", async () => {
  let listener;
  let reentrantStartRejected = false;
  listener = createLocalhostTurnActionListener({
    handleRequest: async () => ingressResponse(),
    revokeControlContexts: () => {
      assert.throws(() => listener.start(), /closing|closed/u);
      reentrantStartRejected = true;
    },
  });

  await listener.close();
  assert.equal(reentrantStartRejected, true);
  assert.equal(listener.listening, false);
  assert.throws(() => listener.start(), /closing|closed/u);
});

test("a failed fixed-port bind does not fall back to another listener", async () => {
  const first = createLocalhostTurnActionListener({
    handleRequest: async () => ingressResponse(),
    revokeControlContexts: () => {},
  });
  const firstAddress = await first.start();
  const second = createLocalhostTurnActionListener({
    handleRequest: async () => ingressResponse(),
    revokeControlContexts: () => {},
  });
  try {
    await assert.rejects(
      second.start({ port: firstAddress.port }),
      (error) => error?.code === "EADDRINUSE",
    );
    assert.equal(second.listening, false);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});
