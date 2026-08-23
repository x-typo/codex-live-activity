#!/usr/bin/env node

const { appendFileSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
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

  function sendExternalCommandStart({
    id = "external-command-fake",
    source = "unifiedExecStartup",
    status = "inProgress",
    threadId = "thread-fake",
    type = "commandExecution",
    turnId = "turn-fake",
  } = {}) {
    send({
      method: "item/started",
      params: {
        threadId,
        turnId,
        startedAtMs: Date.now(),
        item: {
          id,
          type,
          source,
          status,
          command: "SENSITIVE_EXTERNAL_FAKE_COMMAND",
          commandActions: [],
          cwd: "/SENSITIVE_EXTERNAL_FAKE_CWD",
        },
      },
    });
  }

  function sendExternalCommandCompletion({
    id = "external-command-fake",
    type = "commandExecution",
  } = {}) {
    send({
      method: "item/completed",
      params: {
        threadId: "thread-fake",
        turnId: "turn-fake",
        completedAtMs: Date.now(),
        item: {
          id,
          type,
          status: "completed",
          command: "SENSITIVE_EXTERNAL_FAKE_COMMAND",
          output: "SENSITIVE_EXTERNAL_FAKE_OUTPUT",
          cwd: "/SENSITIVE_EXTERNAL_FAKE_CWD",
        },
      },
    });
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

    if (message.method === "turn/steer") {
      if (!mode?.startsWith("loopback-action-proof")) return;
      const valid =
        typeof message.id === "string" &&
        message.params?.threadId === "thread-fake" &&
        message.params?.expectedTurnId === "turn-fake" &&
        Array.isArray(message.params?.input) &&
        message.params.input.length === 1 &&
        message.params.input[0]?.type === "text" &&
        typeof message.params.input[0]?.text === "string" &&
        message.params.input[0].text.length > 0;
      log({ kind: "action-validation", method: message.method, valid });
      if (!valid) {
        send({ id: message.id, error: { message: "SENSITIVE_INVALID_STEER" } });
        return;
      }
      send({
        id: message.id,
        result: {
          turnId:
            mode === "loopback-action-proof-wrong-steer"
              ? "turn-wrong"
              : "turn-fake",
        },
      });
      return;
    }

    if (message.method === "turn/interrupt") {
      if (
        !mode?.startsWith("loopback-action-proof") &&
        !mode?.startsWith("local-long-task-proof") &&
        !mode?.startsWith("external-stop-proof")
      ) {
        return;
      }
      const valid =
        typeof message.id === "string" &&
        message.params?.threadId === "thread-fake" &&
        message.params?.turnId === "turn-fake";
      log({ kind: "action-validation", method: message.method, valid });
      if (!valid) {
        send({ id: message.id, error: { message: "SENSITIVE_INVALID_STOP" } });
        return;
      }
      const acceptInterrupt = () => {
        send({ id: message.id, result: {} });
      };
      const completeTurn = () => {
        send({
          method: "turn/completed",
          params: {
            threadId: "thread-fake",
            turn: { id: "turn-fake", status: "interrupted" },
          },
        });
      };
      const completeInterrupt = () => {
        acceptInterrupt();
        completeTurn();
      };
      if (mode === "external-stop-proof-completion-after-dispatch") {
        sendExternalCommandCompletion();
        completeInterrupt();
      } else if (
        mode === "local-long-task-proof-terminal-before-response" ||
        mode === "external-stop-proof-terminal-before-response"
      ) {
        completeTurn();
        setTimeout(acceptInterrupt, 10);
      } else if (
        mode === "loopback-action-proof-delayed-stop" ||
        mode === "external-stop-proof-delayed-stop"
      ) {
        setTimeout(completeInterrupt, 100);
      } else if (mode === "external-stop-proof-incomplete-retry") {
        setTimeout(completeInterrupt, 500);
      } else if (mode === "external-stop-proof-delayed-terminal") {
        acceptInterrupt();
        setTimeout(completeTurn, 500);
      } else {
        completeInterrupt();
      }
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

    if (
      mode !== "loopback-action-proof-missing-start-response" &&
      mode !== "local-long-task-proof-early-item" &&
      mode !== "local-long-task-proof-early-completion" &&
      mode !== "local-long-task-proof-second-early-item" &&
      mode !== "external-stop-proof-early-item" &&
      mode !== "external-stop-proof-duplicate-early-item" &&
      mode !== "external-stop-proof-second-early-item" &&
      mode !== "external-stop-proof-early-completion"
    ) {
      send({
        id: message.id,
        result: {
          turn: { id: "turn-fake", status: "inProgress", items: [] },
        },
      });
    }
    send({
      method: "thread/status/changed",
      params: {
        threadId: "thread-fake",
        status: { type: "active", activeFlags: [] },
      },
    });
    if (mode !== "loopback-action-proof-missing-start") {
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
    }

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

    if (mode?.startsWith("local-long-task-proof")) {
      const fixtureChild = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
      fixtureChild.unref();
      log({ kind: "fixture-child-pid", value: fixtureChild.pid });
      send({
        method: "item/started",
        params: {
          threadId: "thread-fake",
          turnId: "turn-fake",
          startedAtMs: Date.now(),
          item: {
            id: "command-fake",
            type: "commandExecution",
            source:
              mode === "local-long-task-proof-wrong-source"
                ? "userShell"
                : mode === "local-long-task-proof-short"
                  ? "agent"
                  : "unifiedExecStartup",
            status: "inProgress",
            command: "SENSITIVE_FAKE_COMMAND",
            commandActions: [],
            cwd: "/SENSITIVE_FAKE_CWD",
          },
        },
      });
      if (mode === "local-long-task-proof-early-item") {
        send({
          id: message.id,
          result: {
            turn: { id: "turn-fake", status: "inProgress", items: [] },
          },
        });
      }
      if (mode === "local-long-task-proof-early-completion") {
        send({
          method: "item/completed",
          params: {
            threadId: "thread-fake",
            turnId: "turn-fake",
            completedAtMs: Date.now(),
            item: {
              id: "command-fake",
              type: "agentMessage",
              status: "completed",
              text: "SENSITIVE_FAKE_OUTPUT",
            },
          },
        });
        send({
          id: message.id,
          result: {
            turn: { id: "turn-fake", status: "inProgress", items: [] },
          },
        });
      }
      if (mode === "local-long-task-proof-second-early-item") {
        send({
          method: "item/started",
          params: {
            threadId: "thread-fake",
            turnId: "turn-fake",
            startedAtMs: Date.now(),
            item: {
              id: "command-fake-2",
              type: "commandExecution",
              source: "agent",
              status: "inProgress",
              command: "SENSITIVE_SECOND_FAKE_COMMAND",
              commandActions: [],
              cwd: "/SENSITIVE_SECOND_FAKE_CWD",
            },
          },
        });
        send({
          id: message.id,
          result: {
            turn: { id: "turn-fake", status: "inProgress", items: [] },
          },
        });
      }
      if (mode === "local-long-task-proof-short") {
        setTimeout(() => {
          send({
            method: "item/completed",
            params: {
              threadId: "thread-fake",
              turnId: "turn-fake",
              completedAtMs: Date.now(),
              item: {
                id: "command-fake",
                type: "commandExecution",
                source: "agent",
                status: "completed",
                command: "SENSITIVE_FAKE_COMMAND",
                commandActions: [],
                cwd: "/SENSITIVE_FAKE_CWD",
              },
            },
          });
        }, 10);
      }
      if (mode === "local-long-task-proof-malformed-completion") {
        setTimeout(() => {
          send({
            method: "item/completed",
            params: {
              threadId: "thread-fake",
              turnId: "turn-fake",
              completedAtMs: Date.now(),
              item: {
                id: "command-fake",
                type: "agentMessage",
                status: "completed",
                text: "SENSITIVE_FAKE_OUTPUT",
              },
            },
          });
        }, 10);
      }
      if (mode === "local-long-task-proof-wrong-source") {
        setTimeout(() => {
          send({
            method: "turn/completed",
            params: {
              threadId: "thread-fake",
              turn: { id: "turn-fake", status: "completed" },
            },
          });
        }, 10);
      }
      if (mode === "local-long-task-proof-early-interrupted") {
        setTimeout(() => {
          send({
            method: "turn/completed",
            params: {
              threadId: "thread-fake",
              turn: { id: "turn-fake", status: "interrupted" },
            },
          });
        }, 10);
      }
      return;
    }

    if (mode?.startsWith("external-stop-proof")) {
      const externalCommandId =
        {
          "external-stop-proof-malformed-id": "external-command\nfake",
          "external-stop-proof-overlong-id": "x".repeat(129),
          "external-stop-proof-malformed-unicode-id": "\ud800",
        }[mode] ?? "external-command-fake";
      sendExternalCommandStart({
        id: externalCommandId,
        source:
          mode === "external-stop-proof-wrong-source"
            ? "userShell"
            : mode === "external-stop-proof-agent-source"
              ? "agent"
              : "unifiedExecStartup",
        threadId:
          mode === "external-stop-proof-wrong-thread" ||
          mode === "external-stop-proof-wrong-thread-then-valid"
            ? "thread-other"
            : "thread-fake",
        type:
          mode === "external-stop-proof-wrong-type"
            ? "agentMessage"
            : "commandExecution",
        status:
          mode === "external-stop-proof-wrong-status"
            ? "completed"
            : "inProgress",
        turnId:
          mode === "external-stop-proof-wrong-turn"
            ? "turn-other"
            : "turn-fake",
      });
      if (mode === "external-stop-proof-wrong-thread-then-valid") {
        sendExternalCommandStart();
      }
      if (mode === "external-stop-proof-duplicate-early-item") {
        sendExternalCommandStart();
      }
      if (mode === "external-stop-proof-second-early-item") {
        sendExternalCommandStart({ id: "external-command-fake-2" });
      }
      if (mode === "external-stop-proof-duplicate-item") {
        sendExternalCommandStart();
      }
      if (mode === "external-stop-proof-second-item") {
        sendExternalCommandStart({ id: "external-command-fake-2" });
      }
      if (mode === "external-stop-proof-early-completion") {
        sendExternalCommandCompletion();
      }
      if (
        mode === "external-stop-proof-early-item" ||
        mode === "external-stop-proof-duplicate-early-item" ||
        mode === "external-stop-proof-second-early-item" ||
        mode === "external-stop-proof-early-completion"
      ) {
        send({
          id: message.id,
          result: {
            turn: { id: "turn-fake", status: "inProgress", items: [] },
          },
        });
      }
      if (
        mode === "external-stop-proof-short" ||
        mode === "external-stop-proof-malformed-completion"
      ) {
        setTimeout(
          () =>
            sendExternalCommandCompletion({
              type:
                mode === "external-stop-proof-malformed-completion"
                  ? "agentMessage"
                  : "commandExecution",
            }),
          10,
        );
      }
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

    if (
      mode === "waiting" ||
      mode === "stubborn-waiting" ||
      mode?.startsWith("loopback-action-proof")
    ) {
      return;
    }

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
