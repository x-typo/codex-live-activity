# Status observation harness architecture

## Decision

The spike is a dependency-free Node.js JSONL reducer, not an application target.
Node matches the App Server documentation's line-oriented JSON example, is already
installed with Codex, and gives the spike deterministic tests without adding a
package lock or third-party runtime dependency.

The future Mac relay and iOS app do not need to be written in Node. The durable
boundary from this branch is `schema/status-event.v1.schema.json`, the versioned
redacted JSON record emitted by the reducer. A Swift relay can either launch this
small observer during exploration or port the reducer while keeping the contract
and fixtures as conformance inputs.

The test suite validates emitted records by evaluating every JSON Schema keyword
used in that v1 contract and fails closed if a new unsupported keyword appears.
This dependency-free test helper is scoped to the repository schema vocabulary;
it supports only boolean `additionalProperties` and is not presented as a general
Draft 2020-12 implementation.

## Supported inputs

The primary source is the stable Codex App Server stream:

- `turn/started` maps to `running`.
- `thread/status/changed` with `waitingOnApproval` maps to
  `waitingForApproval`.
- The installed Codex 0.147.0 non-experimental schema also includes
  `waitingOnUserInput`; it maps to `waitingForInput`. The public documentation
  does not currently enumerate that flag, so this mapping remains version-scoped.
- `turn/completed` maps `completed` to `ready` and `failed` or `interrupted` to
  `blocked`.
- `thread/status/changed` with `systemError` maps to `blocked`.
- `thread/status/changed` with `notLoaded`, `thread/closed`, and stream closure
  map active observations to `disconnected`.
- A local timer maps only a `running` task to `stale` after no supported signal
  is seen. Confirmed approval and input waits do not silently lose attention.
- Documented `item/started`, `item/completed`, item-delta, command terminal
  interaction, MCP progress, and file-change patch notifications for the matching
  running turn refresh only its private liveness timestamp. They emit no record
  while the task is already running, and their item, text, reasoning, command,
  diff, path, and output payloads are discarded. Matching activity after a stale
  timeout emits one generic `turn/activity` recovery record without retaining the
  event body.
- An `active` thread status after a terminal turn clears the published turn
  correlation until the next turn event. A bounded private history of the 64 most
  recent terminal identifiers rejects replayed starts, activity, approval
  requests, and completions for prior turns.

An App Server approval request is retained only as an opaque correlation ID. It
does not produce attention by itself. Attention begins only when the matching
thread status includes `waitingOnApproval` or `waitingOnUserInput`. A
`PermissionRequest` hook observation is deliberately ignored for state mapping.

## Redacted record

Each output record contains only:

- schema version, thread ID, and optional turn ID;
- observation and state-start timestamps;
- one internal state and attention boolean;
- a short title from the supported `thread.name` field;
- a nullable summary;
- aggregate counts; and
- allowlisted signal/correlation enums plus an optional terminal status.

Observation timestamps are rejected before mutation unless JavaScript can
serialize them into the contract's four-digit-year RFC 3339 form. This prevents
finite but out-of-contract Date endpoints from reaching `toISOString()` output.
Short identifiers and titles are normalized to well-formed Unicode and capped at
schema code-point boundaries so the JSON record remains decodable by Foundation.

The reducer never stores or emits `thread.preview`, prompts, assistant or reasoning
text, commands, command output, working directories, transcript paths, tool
arguments, hook output entries, or error messages.

## Title and summary boundary

`thread.name` and `thread/name/updated` are the supported title sources observed in
the current documentation. `thread.preview` is not used because it can reflect
user input and is not the proven Pet task-title contract.

The standalone smoke observed a `name` key on both the `thread/start` response and
`thread/started` notification, plus a `preview` key. Their values were discarded,
and no `thread/name/updated` notification was observed. The run therefore proves
field presence, not a usable Pet-style title mapping.

No generic current-task summary field is documented. The output therefore keeps
`summary: null`; Pet-style current running-summary acquisition remains unresolved.
The standalone smoke observed no thread-level `summary` key.
State labels such as "Working" or "Waiting for approval" belong in the future UI
presentation layer and are not fabricated as task summaries.

## Stock desktop boundary

This harness consumes a documented standalone App Server connection. The public
documentation does not describe attaching a second observer to the App Server
owned by an already-running stock desktop task. A standalone smoke therefore does
not prove stock desktop task observation, title parity with Pets, or a durable
manual-approval wait.

## Protocol smoke boundary

The required standalone smoke redirected `CODEX_SQLITE_HOME` to a uniquely named
disposable directory and used Codex CLI 0.147.0 with MCP servers disabled by a
process-local override. The thread was ephemeral with `approvalPolicy: "never"`;
the turn was read-only, network-disabled, and requested one short text response
without tools. The installed schema requires legacy `sandbox: "read-only"` on
`thread/start`, while turn-level `sandboxPolicy.type` uses `"readOnly"`.

The retained allowlisted sequence was:

1. `thread/started` with `idle` status;
2. `thread/status/changed` to `active` with no flags;
3. `turn/started` with `inProgress` status;
4. `thread/status/changed` to `idle`; and
5. `turn/completed` with `completed` status.

The harness emitted `running`, `running`, then `ready`. It retained no title or
summary value, emitted no attention state, and observed no server request or tool
item. Fifteen content-bearing events were counted and discarded without retaining
their bodies. The exact App Server process exited after stdin closed, and its
disposable state was removed.

The redirected SQLite home contained the standalone state. Modification times for
the normal config, hooks, and auth files all predated the smoke. A combined
fingerprint of normal desktop SQLite files changed while this desktop task was
also active, so that metadata cannot attribute a writer; no private database
content was inspected or adopted as an integration source.

## Stale and disconnect behavior

The default stale threshold is 60 seconds and is a harness value, not a product
decision. Only `running` becomes stale, and allowlisted activity for its matching
turn resets the elapsed-without-signal timer without retaining event bodies. A
matching event after the timeout directly recovers `stale` to `running` and
restarts the timer; old-turn activity cannot recover the current turn.
`waitingForApproval` and
`waitingForInput` keep their attention state until a supported status change or
explicit stream/thread disconnect; a timer never clears the human-action signal.
Stream closure marks active or stale tasks disconnected, while completed and
failed terminal results remain available. The production retention policy still
needs a device-level decision.

## One-task relay prototype

The relay phase keeps the v1 status schema and reducer unchanged, then adds a
strict process boundary in front of them:

1. `bin/codex-one-task-relay.mjs` starts one standalone `codex app-server`
   process over its default JSONL stdio transport.
2. It performs the documented `initialize`, `initialized`, `thread/start`, and
   `turn/start` sequence and claims exactly the thread ID returned by that one
   `thread/start` request.
3. `src/one-task-relay.mjs` projects messages into lifecycle-only envelopes
   before the reducer sees them. The projector retains only the owned thread ID,
   current turn ID, request correlation ID, terminal status, supported thread
   status, and the stable `waitingOnApproval` or `waitingOnUserInput` flag.
4. `src/live-activity-payload.mjs` removes even those identifiers and maps the
   resulting one-task status record into the synthetic ActivityKit content-state
   shape already exercised by the APNs smoke.
5. `JsonlDryRunApnsTransport` writes the payload to stdout. It has no provider
   credential, ActivityKit token, device token, socket, retry queue, or hosted
   service.

The installed Codex 0.147.0 stable schema generated by
`codex app-server generate-json-schema` confirms `threadId` on turn lifecycle
notifications, both wait flags on active thread status, and the exact
`item/tool/requestUserInput` request method. Generated schemas are disposable
inspection evidence and are not committed. The public protocol reference is the
[Codex App Server documentation](https://learn.chatgpt.com/docs/app-server).

### Relay privacy and ownership

The relay intentionally owns the task it reports; it does not attach to or claim
to observe stock desktop-owned tasks. Events from any other thread are ignored.
`thread.name`, `thread/name/updated`, previews, prompts, user and assistant
messages, reasoning, plan text, commands, paths, diffs, tool arguments/results,
error text, and unknown event bodies are discarded by projection. The reducer's
relay-facing `title` and `summary` therefore remain `null`, and the APNs payload
contains no thread ID, turn ID, request ID, aggregate object, or source metadata.

Approval and input request messages are reduced to opaque correlation IDs and
never emit attention by themselves. Attention begins only after the matching
stable thread status flag and persists until a supported status change or
disconnect. The executable stops on any server-initiated JSON-RPC request because
this dry-run phase has no approval UI or user-input response channel.

### Ordering, stale state, and terminal policy

The existing reducer rejects old-turn activity and completion by turn
correlation and terminal tombstones. The one-task boundary also rejects a
decreasing local observation timestamp and adds a strictly increasing payload
sequence. Only matching current-turn activity refreshes liveness. Each such
activity emits a generic `Working` heartbeat with a renewed `stale-date` while
discarding its body; activity before turn correlation or from an old turn does
not refresh the task. Only running can become stale, and stream loss or a fatal
relay failure maps active, waiting, or stale state to disconnected when stdout
is still available.

Every prototype payload uses APNs event `update`, including `ready`, `blocked`,
and `disconnected`. That preserves a visible final state at the mock boundary
without inventing a dismissal or unread-retention policy. A future phase must
choose when to issue a separate `end` event after the user reviews physical
device behavior.

### App Server process boundary

The executable reads the task input from stdin and removes `OPENAI_API_KEY` and
`CODEX_ACCESS_TOKEN` from the child environment so the existing Codex login
remains the only supported authentication path. It first enumerates configured
MCP identifiers locally, requires each identifier to use Codex's bare config-key
character set, then starts App Server with one process-local `enabled=false`
override per identifier and disables app, plugin, hook, browsing, and related
external-tool features. An unsupported identifier fails closed before App Server
receives task input.
After claiming the ephemeral thread but before sending task input, it
requires `mcpServerStatus/list` to contain only known configured identities with
no tools, resources, resource templates, server metadata, duplicate identity, or
next page. Configured-but-disabled rows may remain visible; the supported
process-local `enabled=false` overrides are the isolation control, while this
redacted shape check rejects exposed capabilities. Any MCP startup notification,
including app-scoped startup, fails the run closed without retaining its body.

Both the legacy thread sandbox and turn sandbox are read-only. Both relay
references to the task input are dropped after `turn/start`, and task-tool
network access is disabled. App Server SQLite state is redirected to a uniquely
named temporary directory; after the owned child exits, the directory is removed
and absence is read back. App Server stderr and all content-bearing notification
bodies are drained without being forwarded or persisted. `SIGINT` and `SIGTERM`
initiate the same child-stop and verified temporary-state cleanup path before the
relay exits with the conventional signal status. A broken dry-run stdout also
stops the child and runs the same cleanup path.

## Direct APNs delivery boundary

Direct delivery is implemented as a second process, not as a credential-bearing
transport inside `OneTaskRelay`:

```text
task input -> one-task relay -> redacted JSONL -> APNs sender -> Apple APNs
```

The relay side is unchanged and remains safe to run as a JSONL dry run. The APNs
sender receives no prompt, App Server event, thread or turn identifier, Codex
environment, or child process handle. Its only input is the exact allowlisted
ActivityKit body produced by `src/live-activity-payload.mjs`.

`src/apns-live-activity-http2.mjs` validates that body a second time, loads one
owner-private configuration, signing key, and ActivityKit token from regular
non-symlink files outside the repository, creates an in-memory ES256 provider
JWT, and posts over Node's built-in HTTP/2 client. The environment selects one of
two fixed Apple authorities; callers cannot supply a URL, topic, header, raw APNs
body, key value, bearer token, or ActivityKit token through arguments or
environment variables. The topic is always the configured main bundle ID plus
`.push-type.liveactivity`.

The sender preserves input ordering and stops after the first input, protocol,
transport, or APNs response failure. It has no redirects, proxy configuration,
retry queue, disk cache, hosted service, or automatic token repair. Its stdout
contains only content-free acceptance/coalescing receipts; its errors contain
only allowlisted APNs reason names and status codes.

To avoid spending the ActivityKit push budget on App Server item noise, repeated
presentations are coalesced until half of the prior stale interval has elapsed.
A state change is sent immediately, subject to a short serialization delay when
needed to keep ActivityKit's integer-second timestamps current and strictly
increasing. Working and stale refreshes use APNs priority `5`; approval/input,
ready, blocked, and disconnected states use priority `10`. Every first-proof
request uses `apns-expiration: 0`, so APNs makes a delivery attempt without
storing a stale task update.

All relay payloads still use ActivityKit event `update`. Direct delivery does not
choose the product's `end` event, dismissal, unread retention, or reconnect
policy. The first physical working-to-ready proof passed without expanding that
boundary. Terminal lifecycle behavior remains a separate product-policy phase;
in particular, a fixed dismissal timer must not be described as unread retention
without an acknowledgement contract.

The request contract and protected live procedure are documented in
`docs/direct-apns-delivery.md`. Deterministic tests use an in-memory HTTP/2 stream
double and synthetic P-256 key; they never open a socket or contact Apple.
