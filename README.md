# Codex Live Activity

A personal project exploring how to bring Codex task status to iPhone through
Live Activities and the Dynamic Island.

The repository now contains four bounded components:

- a versioned, privacy-conscious reducer for supported Codex App Server
  lifecycle events; and
- a one-task local relay that owns one standalone App Server thread and maps
  allowlisted lifecycle state into ActivityKit APNs payloads through a dry-run
  stdout transport; and
- a separate, dependency-free HTTP/2 sender that accepts only those redacted
  payloads and is designed for direct APNs delivery from the Mac; and
- a versioned, transport-agnostic mock action boundary that maps Stop and Reply
  for the one relay-owned active turn into supported App Server requests.

The relay remains credential-free and does not observe tasks owned by the stock
desktop app or retain task content. It emits generic state labels only; `title`
and `summary` remain `null` at its redacted status boundary. The sender passed
both deterministic in-memory HTTP/2 coverage and a separately approved,
content-free sandbox delivery proof on a locked iPhone. The temporary APNs key,
ActivityKit token, and configuration stayed outside the repository and were
removed after the proof; no credential or device token is part of repository
state.

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

## Mock interactive turn actions

[`schema/relay-turn-action.v1.schema.json`](schema/relay-turn-action.v1.schema.json)
defines the local semantic boundary that must be proved before choosing an
iPhone-to-Mac return path. It accepts only two exact one-task shapes:

```json
{
  "schemaVersion": 1,
  "actionId": "action-stop-1",
  "action": "stop",
  "threadId": "thread-owned",
  "expectedTurnId": "turn-active"
}
```

```json
{
  "schemaVersion": 1,
  "actionId": "action-reply-1",
  "action": "reply",
  "threadId": "thread-owned",
  "expectedTurnId": "turn-active",
  "text": "Please continue with the safe option."
}
```

`src/relay-turn-action.mjs` maps Stop to `turn/interrupt` and Reply to
`turn/steer` with `expectedTurnId`. Reply never becomes `turn/start`, and
neither action can answer or approve a protected App Server request. The action
gate uses the relay's private active-turn correlation rather than the displayed
Live Activity state, because a stale presentation can still refer to an active
turn.

Only allowlisted receipts leave the mock boundary. They contain the action ID,
action kind, outcome, safe reason, and App Server method; they never contain
reply text, thread ID, turn ID, raw App Server errors, or task content. Reply
text is forwarded unchanged only in the in-memory App Server request. If this
contract is later connected to the existing executable, App Server may also
hold that text in its deletion-verified disposable state, just as it does for
the initial task input.

This is not a network protocol or a phone feature yet. The recent in-process
action-ID window is deterministic duplicate protection, not authentication or
durable replay defense. A later return-path decision must separately define
authentication, expiry, replay protection, task capability correlation, and
unavailable behavior before any listener or device action is added.

## Direct APNs sender boundary

The sender is a separate process so Apple credentials and the per-activity token
never enter the Codex App Server process, reducer, or relay environment. It pins
the Apple sandbox or production authority, constructs the Live Activity topic,
uses ES256 provider authentication, sends sequential HTTP/2 requests, and stops
on the first rejected or uncertain delivery without a retry queue.

Duplicate `Working` heartbeats are coalesced until the prior stale window is
half elapsed. Distinct states use current, strictly increasing ActivityKit
timestamps. Routine working/stale refreshes use APNs priority `5`; attention and
terminal states use priority `10`.

Run the sender's local deterministic coverage without credentials or network:

```sh
npm test
```

The protected configuration and live pipeline are documented in
[`docs/direct-apns-delivery.md`](docs/direct-apns-delivery.md). The first
physical-device proof is complete. Do not recreate an APNs key, request another
ActivityKit token, or repeat a live send unless a new bounded proof is separately
approved.
