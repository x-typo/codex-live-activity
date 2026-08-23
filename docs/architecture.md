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

### Mock interactive turn-action contract

The interactive mock is a separate control-plane boundary, not an expansion of
the status reducer or APNs payload. Its versioned input is
`schema/relay-turn-action.v1.schema.json`. Stop and Reply both carry a restricted
action ID, the one owned thread ID, and an expected active turn ID. Reply alone
also carries non-empty, well-formed text capped at 4,096 code points. Extra
fields, other actions, another thread, or a different or absent active turn fail
closed before an App Server request is dispatched.
Validated primitive fields are copied into a canonical snapshot before active-turn
correlation or asynchronous dispatch, so later caller mutation cannot alter the
request or its redacted receipt.

`src/relay-turn-action.mjs` performs only these mappings:

- Stop becomes `turn/interrupt` with the owned `threadId` and active `turnId`.
- Reply becomes `turn/steer` with the owned `threadId`, the exact text input,
  and `expectedTurnId`.

The App Server response must match the action's JSON-RPC ID. A Reply response
must also return the same turn ID. Raw errors and response bodies are discarded.
An accepted Stop prevents more actions for that turn while its terminal
lifecycle event is pending, and only one action can be in flight. The boundary
remembers the 64 most recent dispatched action IDs in memory and rejects their
reuse. Its Stop-pending latch is only a boolean; it keeps no reply text, pending
turn ID, or action journal. Stop sets the latch before dispatch; a rejected
request clears it, and terminal, close, or stream-loss handling can clear it
while a response is still in flight without a late success restoring it.

Control eligibility comes from the relay's private active-turn correlation,
which is established by the supported `turn/start` response and corroborated by
the matching lifecycle notification. It does not come from the published UI
state: `stale` can still describe an in-flight turn. The active correlation must
be cleared on its matching terminal event, owned-thread close, or stream loss,
and that same lifecycle handling must clear the boolean Stop-pending latch.

The injected action boundary remains independently testable. The relay's
explicit `--loopback-action-proof` mode now connects it to the selected ingress,
listener, and one disposable owned App Server process without changing the
one-way APNs pipeline or adding an iPhone control. It still cannot answer an
approval or structured user-input request. Reply text exists transiently in the
outbound App Server request and may enter only that process's deletion-verified
disposable SQLite state; it must not enter relay receipts, logs, APNs payloads,
retained action state, or durable action storage.

The bounded recent-ID set is not a security claim. Authentication, expiry,
durable replay defense, task-scoped capabilities, and unavailable behavior
belong to the separately selected return transport.

### Selected iPhone-to-Mac return transport

The selected transport is tailnet-only HTTPS through Tailscale Serve to an
action-ingress sidecar bound only to literal `127.0.0.1`. Serve terminates HTTPS
and reverse-proxies to that loopback backend. Tailscale Funnel stays disabled;
the ingress never binds a wildcard, LAN address, Tailscale address, or public
address. Codex App Server is not the network server and remains behind the relay
on its supported local stdio boundary.

```text
iPhone app / LiveActivityIntent
  -> HTTPS through Tailscale Serve on the private tailnet
  -> http://127.0.0.1:<ephemeral-or-owner-selected-port>
  -> authenticated action-ingress sidecar
  -> owner-only injected call or Unix socket
  -> one-task relay
  -> Codex App Server stdio
```

Serve supplies encrypted private connectivity, tailnet identity and policy
admission, HTTPS termination, and sanitized forwarded capability metadata. It
does not prove that the request came from this companion app installation, that
the displayed control still targets the same turn, that an action is fresh or
not replayed, that App Server accepted it, or that the Mac is reachable.
Accordingly, the sidecar must require both:

- the expected app capability in Tailscale's forwarded
  `Tailscale-App-Capabilities` JSON header; and
- a paired per-install bearer verified against owner-private Mac state, with the
  phone copy held in Keychain.

The capability header is trusted only behind Serve and a loopback-only backend.
A local process could forge that header when calling the backend directly, so
the paired app credential remains an independent application boundary. Neither
credential may enter APNs, ActivityKit state, deep-link URLs, logs, analytics,
the repository, or the relay/App Server environment.

The pre-listener secret loader accepts separate app-token and HMAC-key files
only when they are absolute, outside the repository, owner-owned, single-link,
non-symlink private files. Each contains one canonical 43-character base64url
encoding of exactly 32 bytes, and the decoded values must differ. The app token
is compared in constant time and maps only to a safe installation ID; the HMAC
key never leaves the fingerprint closure. These files are a synthetic-tested
startup boundary, not the final
Keychain provisioning or phone-pairing workflow.

#### Remote action envelope and private correlation

The phone-facing v1 envelope is
`schema/relay-remote-action.v1.schema.json`. It contains only an action ID, an
opaque non-secret `controlContextId`, issued and expiry timestamps, the exact
Stop or Reply action, and Reply text when applicable. It never contains the
private Codex thread ID or turn ID.

The Mac resolves a context to one exact `(ownedThreadId, expectedTurnId)` pair
and the existing `MockOneTaskTurnActionBoundary`. The implemented one-task
registry also binds it to the authenticated installation. It emits a 43-character
base64url ID from 32 cryptographically random bytes, enforces an explicitly
configured maximum lifetime, rotates for a new turn, and revokes on matching
terminal completion, owned-thread close, or App Server disconnect. ActivityKit
`stale-date` and the displayed `stale` state are presentation signals only;
neither authorizes a control.

The pure request handler in `src/tailscale-turn-action-ingress.mjs` applies a
60-second maximum request validity window with 30 seconds of future clock-skew
tolerance by default. It also checks the separately stored context expiry. These
prototype constants can be revisited with physical-device timing evidence, but
the independent request and context checks are required architecture.

Before either JSON object is trusted, `src/strict-json.mjs` tokenizes the complete
raw capability header or request body with a separate decoded-name set for every
object. Duplicate members, nested duplicates, and escaped aliases such as `a`
and `\u0061` reject before fingerprinting, replay inspection, context resolution,
or dispatch. The parser deliberately does not normalize distinct Unicode names.

The ingress resolves the install-bound context before the atomic replay claim
and again after the claim. The registry's dispatch handle performs one final
synchronous binding, expiry, and correlation check before calling the injected
boundary. A revoke or rotation while durable I/O is pending therefore becomes a
content-free rejection and cannot reach App Server.

Adding the opaque context to the iPhone/ActivityKit flow is a later protected
schema and privacy decision. The registry proves Mac-side issuance but does not
place a context in ActivityKit or APNs. The localhost adapter therefore has no
real device context to accept in this phase.

#### Durable replay, receipts, and unavailability

The ingress uses a file replay store with an atomic claim-before-send contract.
Its key is the verified installation ID plus action ID; the filename is derived
from their SHA-256 hash. The owner-private version 2 JSON record retains those
two safe identifiers and the safe action kind for integrity validation, plus a
keyed-HMAC fingerprint of the canonical request, the request expiry, and the
eventual content-free receipt. A plain reply-text hash is not retained because
guessable text could be recovered by comparison. The HMAC key loader requires a
separate owner-private external file containing the canonical base64url
encoding of exactly 32 random bytes and keeps the key stable for at least the
replay-retention horizon.

The replay root must already exist outside the repository as an owner-owned
`0700` non-symlink directory. Claims use exclusive, no-follow creation of a
`0600` record. A successful claim is returned only after the record and parent
directory sync. Completion writes and syncs an adjacent exclusive temporary
file, atomically renames it over the claim, then syncs the directory. Directory
sync failure remains a durability failure even if the completed bytes are later
visible. Malformed, truncated, linked, permission-invalid, replaced-root, and
other ambiguous states are never considered missing.

- same ID, action kind, and fingerprint after completion returns the stored
  receipt;
- same ID with a different action kind or fingerprint rejects as
  `replayConflict`;
- a claimed action without a committed receipt returns `outcomeUnknown` and is
  not dispatched again; and
- a receipt-commit failure after dispatch also returns `outcomeUnknown` and
  must not trigger an automatic second send.

An accepted Stop receipt means only that `turn/interrupt` was accepted. The
matching `turn/completed` lifecycle with terminal status `interrupted` proves
the effect. Reply acceptance still requires `turn/steer` to return the same
private turn ID. All network receipts project only schema version, safe action
ID, action kind, outcome, and an allowlisted reason.

`src/remote-action-receipt.mjs` is the canonical table and projector for that
public shape. Ingress production, replay persistence, and listener egress all
use it rather than maintaining separate allowlists or status predicates:

| Outcome / reason | Correlation | Allowed HTTP status |
| --- | --- | --- |
| `accepted` / `null` | exact submitted action | `200` |
| `invalidAction` | `null` / `null` only | `400` |
| `unauthorized` | `null` / `null` only | `401` |
| `invalidRequest` | pre-action `null` / `null` | `400`, `404`, `413` |
| `invalidRequest` | exact submitted action | `400` |
| `unavailable` | outer-adapter `null` / `null` or exact submitted action | `503` |
| `outcomeUnknown` | exact submitted action | `503` |
| `appServerRejected` | exact submitted action | `502` |
| `busy`, `duplicateAction`, `expiredControlContext`, `expiredRequest`, `noActiveTurn`, `replayConflict`, `staleTurn`, `stopPending`, `unknownControlContext`, `wrongThread` | exact submitted action | `409` |

The listener parses the request body through the same remote-action validator
used by ingress, retains only the transient validated action for correlation,
classifies the handler call as invalid content type, invalid action, or valid
action, and reserializes every admitted receipt into fixed field order. The
table permits only the ingress outcomes possible in that observed phase. Mixed
nullability, a different action ID or kind, and any reason/status/correlation or
handler-phase combination outside the table fail closed as an `unavailable`
adapter response. That fallback retains the exact submitted action only after
the action has already been validated; otherwise it is uncorrelated.

There is no server or cloud command queue. If the Mac, Tailscale, ingress, replay
store, or App Server is unavailable, the phone reports not delivered or outcome
unknown. It may retry only the same action ID while the request remains valid;
it never optimistically displays a stopped task. Unsent Reply text stays only in
the foreground composer unless encrypted draft retention is separately chosen.

The current implementation supplies the strict JSON adapter boundary, one-task
context registry, owner-private secret loader/verifier, durable file replay
store, and `src/localhost-turn-action-listener.mjs`. The listener factory is
closed by default and has no standalone executable entry point. Its explicit one-shot
`start()` accepts only a validated port and hard-codes literal `127.0.0.1`; it
does not accept a host, DNS name, wildcard, IPv6, LAN, or Tailscale address. The
bound address is checked after startup, and a failed fixed-port bind never
falls back to another port or interface.

Before the pure handler runs, the adapter requires exact HTTP/1.1 method, target,
and local `Host`, rejects transfer encoding, content encoding, trailers,
expectations, duplicate protected or framing headers, and non-canonical or
oversized `Content-Length`, and buffers no more than the ingress's 32 KiB byte
limit. It projects only `content-type`, `authorization`, and
`tailscale-app-capabilities`; arbitrary headers and socket metadata never cross
the seam. Every application response adds an exact byte length and closes the
connection. Parser errors, upgrades, CONNECT, handler exceptions, and malformed
handler output cannot expose request or error content.

Construction opens no socket. Shutdown first stops new accepts, then revokes all
control contexts, closes idle connections, and gives active requests a bounded
grace period before forcing their sockets closed. A claimed action is never
deleted during shutdown: an interrupted durable outcome remains an uncertain
tombstone and cannot become dispatchable after restart.

The base integration proof composes all five ingress pieces with synthetic
temporary state, uses a real ephemeral loopback socket, verifies an authorized
Reply and durable retry plus unauthorized rejection, then closes the listener
and removes the temporary state. `src/mac-local-turn-action-composition.mjs`
adds the executable seam: it loads the same secret and replay boundaries, starts
the same listener, and issues one context only for a corroborated active turn.
The relay's opt-in proof mode supplies synthetic owner-private files, self-drives
one Reply and one Stop over that socket, and requires both App Server acceptance
and the matching interrupted lifecycle before cleanup.

The synthetic capability header used by this local proof is forgeable by other
local processes and is not evidence of Tailscale admission. The proof supplies
no real token generation or phone pairing, Keychain adapter, Tailscale
configuration, Swift UI, App Intent, or persistent service. The later Serve
phase must observe the actual forwarded `Host` before selecting its exact
configured authority. Durable replay records are retained indefinitely by the
production boundary; only the proof's entire disposable root is deleted after
the listener closes.

An App Intent's authentication policy defaults to `alwaysAllowed`, including
when the device is locked. The future Stop `LiveActivityIntent` must therefore
set `requiresAuthentication` explicitly before this project can treat the
Lock Screen control as authenticated. Reply should open a focused task-scoped
composer and submit from the foreground app, not attempt inline free-text entry
on the Live Activity.

Alternatives remain deliberately bounded. LAN-only transport fails away from
home. CloudKit private records add offline queueing but also durable reply
content, synchronization, deletion, and replay complexity that this project
does not require. A public tunnel or Funnel expands attack surface without
removing any app-layer requirement, and direct public exposure is rejected.

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

In `--loopback-action-proof` mode, the listener and synthetic secret/replay root
are ready before task input is sent. The executable creates the private action
boundary only after the `turn/start` response and matching `turn/started`
notification corroborate the exact owned turn. A bounded response multiplexer
accepts only the pending safe string action ID in addition to startup request
IDs `0` through `3`; unknown, duplicate, or late responses remain protocol
failures. An explicit correlated App Server JSON-RPC error becomes the
content-free `appServerRejected` receipt. A missing, malformed, or mismatched
success response, or loss of the stdio response after a request may have been
written, propagates as `outcomeUnknown`, retains Stop's pending latch, and is
never redispatched.

Matching terminal, owned-thread close, stream loss, signal, or output failure
revokes the control context and clears the action gate before the listener and
child are closed. A successful Stop smoke additionally requires
`turn/completed: interrupted`; its accepted HTTP receipt alone is not proof of
effect. The interrupted lifecycle continues to map to the existing generic
`Blocked` status because this phase does not add a new presentation state.

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
