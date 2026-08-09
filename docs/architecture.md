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
it is not presented as a general Draft 2020-12 implementation.

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
- Documented `item/started`, `item/completed`, item-delta, MCP progress, and
  file-change patch notifications for the matching running turn refresh only its
  private liveness timestamp. They emit no record while the task is already
  running, and their item, text, reasoning, command, diff, path, and output
  payloads are discarded. Matching activity after a stale timeout emits one
  generic `turn/activity` recovery record without retaining the event body.

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
