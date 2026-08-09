# Codex Live Activity Relay

This branch contains the smallest status-observation harness needed before any
iOS or ActivityKit implementation begins. It reduces supported Codex App Server
events to a versioned, redaction-safe task-state stream.

## What it proves

- deterministic mapping for running, confirmed approval wait, confirmed input
  wait, ready/completed, blocked/failed, stale, and disconnected states;
- `PermissionRequest` alone never emits an attention state;
- aggregate task counts use the accepted priority: attention, blocked, ready,
  running, stale, disconnected; and
- only allowlisted status metadata leaves the reducer.

It does not prove that a second client can observe stock desktop-hosted tasks. It
also does not prove title parity with Codex Pets or a supported current running
summary. `thread.name` is the only confirmed title source; summary remains `null`.

A live standalone Codex 0.147.0 protocol smoke completed `initialize`, an
ephemeral read-only `thread/start`, one no-tools `turn/start`, and
`turn/completed`. The redacted event envelope mapped `running` to `ready` through
the harness without retaining prompt or response content. This proves only a
standalone App Server session; it does not prove observation of stock
desktop-hosted tasks.

## Run

Node.js 20 or later is the only requirement.

```sh
npm test
```

Pipe newline-delimited App Server messages to the harness:

```sh
node bin/codex-status-harness.mjs < app-server-events.jsonl
```

The harness reads events from standard input and writes only redacted status
records to standard output. Closing input marks active tasks disconnected. Only
`running` can time out to `stale`; confirmed approval and input waits retain
attention until a supported status change or explicit disconnect. Use
`--stale-after-ms` to override the 60-second test threshold.

The shared output contract is
[`schema/status-event.v1.schema.json`](schema/status-event.v1.schema.json).
Tests validate emitted records against every keyword used by that schema. The
test-only validator is intentionally not a general JSON Schema implementation and
fails if the contract introduces an unsupported keyword.

## Privacy contract

Allowed output is limited to thread/turn IDs, short title, nullable summary,
timestamps, state, aggregate counts, and minimal allowlisted correlation metadata.
Do not pipe or save the raw App Server stream as a product log.

The reducer ignores prompts, `thread.preview`, assistant/reasoning text, commands,
command output, working directories, transcript paths, tool arguments, hook output
entries, and error text.

## Supported source

The harness targets the stable event stream documented by OpenAI:

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)

See [docs/architecture.md](docs/architecture.md) for mappings, language rationale,
and the explicit standalone-versus-stock-desktop boundary.

## Scope

No SwiftUI app, ActivityKit extension, push path, global Codex hook/config change,
approval decision, remote deployment, or OpenAI API key is included.
