#!/usr/bin/env node

const { appendFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const readline = require("node:readline");

const MCP_SERVER_NAME =
  process.env.FAKE_MCP_SERVER_NAME || "SENSITIVE_MCP_SERVER-with-dash";

function log(message) {
  if (!process.env.FAKE_CODEX_LOG_PATH) return;
  appendFileSync(
    process.env.FAKE_CODEX_LOG_PATH,
    `${JSON.stringify(message)}\n`,
  );
}

log({
  kind: "argv",
  values: process.argv.slice(2),
  hasOpenAiApiKey: Object.hasOwn(process.env, "OPENAI_API_KEY"),
  hasCodexAccessToken: Object.hasOwn(process.env, "CODEX_ACCESS_TOKEN"),
});

if (process.argv.includes("mcp") && process.argv.includes("list")) {
  process.stdout.write(
    `${JSON.stringify([{ name: MCP_SERVER_NAME, enabled: true }])}\n`,
  );
} else {
  runFakeAppServer();
}

function runFakeAppServer() {
  const mode = process.env.FAKE_CODEX_MODE;

  if (mode === "stubborn-waiting") {
    process.on("SIGTERM", () => {});
  }

  if (process.env.CODEX_SQLITE_HOME) {
    writeFileSync(join(process.env.CODEX_SQLITE_HOME, "fake-state.sqlite"), "");
  }

  function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  const input = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  input.on("line", (line) => {
    const message = JSON.parse(line);
    log({ kind: "method", value: message.method });
    if (message.method === "initialize") {
      send({ id: message.id, result: { userAgent: "fake-app-server" } });
      return;
    }
    if (message.method === "thread/start") {
      send({
        method: "thread/started",
        params: {
          thread: {
            id: "thread-fake",
            name: "SENSITIVE_FAKE_NAME",
            preview: "SENSITIVE_FAKE_PREVIEW",
            status: { type: "idle" },
          },
        },
      });
      send({
        id: message.id,
        result: {
          thread: {
            id: "thread-fake",
            preview: "SENSITIVE_FAKE_RESPONSE_PREVIEW",
          },
        },
      });
      if (mode === "early-app-mcp-startup") {
        send({
          method: "mcpServer/startupStatus/updated",
          params: {
            threadId: null,
            name: MCP_SERVER_NAME,
            status: "ready",
            error: "SENSITIVE_APP_MCP_STARTUP_ERROR",
          },
        });
      }
      return;
    }
    if (message.method === "mcpServerStatus/list") {
      const expectedOverride = `mcp_servers.${MCP_SERVER_NAME}.enabled=false`;
      const isolated =
        process.argv.includes(expectedOverride) &&
        process.argv.includes("apps._default.enabled=false") &&
        process.argv.includes("--disable") &&
        process.argv.includes("apps") &&
        process.argv.includes("hooks") &&
        process.argv.includes("plugins");
      const isolatedRow = {
        authStatus: "unknown",
        name: MCP_SERVER_NAME,
        resourceTemplates: [],
        resources: [],
        serverInfo: null,
        tools: {},
      };
      let data = [isolatedRow];
      if (!isolated || mode === "mcp-isolation-failure") {
        data = [
          {
            ...isolatedRow,
            tools: {
              SENSITIVE_EXPOSED_TOOL: {
                name: "SENSITIVE_EXPOSED_TOOL",
                inputSchema: {},
              },
            },
          },
        ];
      }
      if (mode === "mcp-unknown-server") {
        data = [{ ...isolatedRow, name: "SENSITIVE_UNKNOWN_MCP_SERVER" }];
      }
      if (mode === "mcp-duplicate-server") {
        data = [isolatedRow, { ...isolatedRow }];
      }
      if (mode === "mcp-malformed-capabilities") {
        data = [{ ...isolatedRow, tools: [] }];
      }
      send({
        id: message.id,
        result: {
          data,
          ...(mode === "mcp-paginated"
            ? { nextCursor: "SENSITIVE_CURSOR" }
            : {}),
        },
      });
      return;
    }

    if (message.method !== "turn/start") return;

    if (mode === "early-mismatched-completion") {
      send({
        method: "turn/completed",
        params: {
          threadId: "thread-fake",
          turn: { id: "turn-other", status: "failed" },
        },
      });
    }

    send({
      id: message.id,
      result: {
        turn: { id: "turn-fake", status: "inProgress", items: [] },
      },
    });
    send({
      method: "thread/status/changed",
      params: {
        threadId: "thread-fake",
        status: { type: "active", activeFlags: [] },
      },
    });
    send({
      method: "turn/started",
      params: {
        threadId: "thread-fake",
        turn: {
          id: "turn-fake",
          status: "inProgress",
          items: [{ type: "userMessage", content: "SENSITIVE_FAKE_PROMPT" }],
        },
      },
    });

    if (mode === "thread-closed") {
      send({
        method: "thread/closed",
        params: {
          threadId: "thread-fake",
          reason: "SENSITIVE_THREAD_CLOSE_REASON",
        },
      });
      return;
    }

    if (mode === "late-mcp-startup") {
      send({
        method: "mcpServer/startupStatus/updated",
        params: {
          threadId: "thread-fake",
          name: MCP_SERVER_NAME,
          status: "ready",
          error: "SENSITIVE_MCP_STARTUP_ERROR",
        },
      });
      return;
    }

    if (mode === "interactive") {
      send({
        id: "request-fake",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-fake",
          turnId: "turn-fake",
          command: "SENSITIVE_FAKE_COMMAND",
        },
      });
      return;
    }

    if (mode === "unknown-request") {
      send({
        id: "request-unknown",
        method: "experimental/sensitiveRequest",
        params: { body: "SENSITIVE_UNKNOWN_REQUEST" },
      });
      return;
    }

    if (mode === "unsupported-terminal") {
      send({
        method: "turn/completed",
        params: {
          threadId: "thread-fake",
          turn: { id: "turn-fake", status: "unknownFutureStatus" },
        },
      });
      return;
    }

    if (mode === "waiting" || mode === "stubborn-waiting") return;

    if (mode === "mismatched-completion") {
      send({
        method: "turn/completed",
        params: {
          threadId: "thread-fake",
          turn: { id: "turn-other", status: "failed" },
        },
      });
    }

    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-fake",
        turnId: "turn-fake",
        delta: "SENSITIVE_FAKE_ASSISTANT_OUTPUT",
      },
    });
    send({
      method: "turn/completed",
      params: {
        threadId: "thread-fake",
        turn: {
          id: "turn-fake",
          status: "completed",
          items: [
            { type: "agentMessage", text: "SENSITIVE_FAKE_ASSISTANT_OUTPUT" },
          ],
        },
      },
    });
  });
}
