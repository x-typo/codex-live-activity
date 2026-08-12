# Codex Live Activity

A personal project exploring how to bring Codex task status to iPhone through
Live Activities and the Dynamic Island.

The repository now contains two bounded prototypes:

- a versioned, privacy-conscious reducer for supported Codex App Server
  lifecycle events; and
- a one-task local relay that owns one standalone App Server thread and maps
  allowlisted lifecycle state into ActivityKit APNs payloads through a dry-run
  stdout transport.

The relay does not connect to APNs, use Apple credentials or device tokens,
observe tasks owned by the stock desktop app, or retain task content. It emits
generic state labels only; `title` and `summary` remain `null` at its redacted
status boundary.

## Local one-task dry run

This command starts a real relay-owned Codex task using the existing local Codex
login, while the APNs side remains a JSONL dry run:

```sh
printf '%s' 'Reply with exactly SMOKE_OK. Do not use tools.' \
  | npm run --silent relay -- --cwd "$PWD"
```

The relay starts an ephemeral thread with `approvalPolicy: "never"`, a read-only
turn sandbox, and network-disabled task tools. Before sending task input, it
enumerates configured MCP identifiers, accepts only names that can be represented
as bare Codex config keys, applies process-local per-server disable overrides,
disables app/plugin/hook features, and requires the owned thread's MCP status to
expose no tools, resources, resource templates, server metadata, unknown server
identity, or additional page. Any MCP startup notification fails closed.
Unsupported identifier syntax fails closed before task input. It also removes
`OPENAI_API_KEY` and `CODEX_ACCESS_TOKEN` from the child process environment so
the existing Codex login remains the only supported auth path.
It reads task input from stdin so the prompt is not placed in process arguments.
Its stdout contains only generic mock APNs payloads. Any server-initiated App
Server request stops the dry run because this prototype does not implement an
approval or user-input UI; those remain Mac-side responsibilities for a later
phase.
