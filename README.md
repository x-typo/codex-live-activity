# Codex Live Activity

A personal project exploring how to bring Codex task status to iPhone through
Live Activities and the Dynamic Island.

The repository now contains five bounded components:

- a versioned, privacy-conscious reducer for supported Codex App Server
  lifecycle events; and
- a one-task local relay that owns one standalone App Server thread and maps
  allowlisted lifecycle state into ActivityKit APNs payloads through a dry-run
  stdout transport; and
- a separate, dependency-free HTTP/2 sender that accepts only those redacted
  payloads and is designed for direct APNs delivery from the Mac; and
- a versioned, transport-agnostic mock action boundary that maps Stop and Reply
  for the one relay-owned active turn into supported App Server requests; and
- a closed-by-default HTTP/1.1 adapter that exposes the hardened action ingress
  only on literal IPv4 loopback for disposable local proofs.

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

The executable also has one explicit composition-proof mode:

```sh
printf '%s' 'Run a bounded wait and do nothing else.' \
  | npm run --silent relay -- --cwd "$PWD" --loopback-action-proof
```

That mode creates synthetic 32-byte token and HMAC files plus a replay root in
one owner-private disposable directory outside the repository, starts the
existing listener on an ephemeral `127.0.0.1` port, and issues one control
context only after the `turn/start` response and matching `turn/started`
notification agree. A bounded activation deadline fails closed if that
corroboration never arrives. An internal proof client then sends one Reply and
one Stop through the complete listener, ingress, replay, context,
action-boundary, and App Server stdio path. Success requires accepted
`turn/steer` and `turn/interrupt` responses plus a matching
`turn/completed: interrupted`
lifecycle event. The listener, secrets, replay state, and App Server SQLite home
are closed and deletion-verified before exit.

This flag is a local composition smoke, not an authentication or deployment
mode. Its locally forged Tailscale capability header and synthetic bearer prove
only that the selected components connect correctly; they do not prove
Tailscale Serve admission. The port, control context, token, private thread and
turn IDs, task input, and Reply text never enter stdout or the safe proof-status
lines on stderr. Tailscale remains unconfigured and no phone or APNs action is
performed.

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
text is forwarded unchanged only in the in-memory App Server request. In the
explicit loopback proof mode, App Server may also hold that text in its
deletion-verified disposable state, just as it does for the initial task input.

This mock boundary is not a network protocol or phone feature. Its recent
in-process action-ID window remains deterministic duplicate protection, not
authentication or durable replay defense. The selected return layer below now
supplies those outer controls and a literal-loopback adapter. The executable's
opt-in proof mode wires that path to one disposable App Server task, but no
device, persistent service, or real credential is connected.

## Localhost return-path adapter

The selected return transport is tailnet-only HTTPS through
[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve), ending at
an action-ingress sidecar that can listen only on `127.0.0.1`. Tailscale
Funnel, a public tunnel, direct LAN or tailnet binding, and remote exposure of
Codex App Server are outside this design. App Server remains a private local
stdio child behind the existing one-task relay.

The intended path is:

```text
iPhone app / LiveActivityIntent
  -> HTTPS through tailnet-only Tailscale Serve
  -> localhost-only authenticated Mac ingress sidecar
  -> injected one-task action boundary
  -> Codex App Server over stdio
```

[`schema/relay-remote-action.v1.schema.json`](schema/relay-remote-action.v1.schema.json)
defines the phone-facing wire envelope. It carries an opaque, short-lived
`controlContextId` instead of a Codex thread ID or turn ID:

```json
{
  "schemaVersion": 1,
  "actionId": "remote-reply-1",
  "controlContextId": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "issuedAt": "2026-08-22T20:00:00.000Z",
  "expiresAt": "2026-08-22T20:01:00.000Z",
  "action": "reply",
  "text": "Please continue with the safe option."
}
```

`src/tailscale-turn-action-ingress.mjs` is a pure, injected request handler. It
opens no socket and changes no Tailscale state. Before resolving a context, it
requires both a forwarded `Tailscale-App-Capabilities` grant and a paired
per-install app-token verifier. `src/strict-json.mjs` rejects duplicate raw JSON
members, including escaped-equivalent names, in both the capability header and
action body before object validation. A live adapter must keep the paired token
in the iPhone and Mac Keychains; it must never place it in APNs, a URL, this
repository, or a log.

`src/remote-action-control.mjs` implements the private one-task context registry.
It issues exactly 32 random bytes as a 43-character base64url identifier, binds
that identifier to the authenticated installation and one exact owned thread
and active turn, enforces a caller-selected maximum lifetime, rotates on a new
turn, and exposes explicit terminal or disconnect revocation. The ingress
resolves the binding before and after the durable claim. Its dispatch wrapper
checks the live binding again without an intervening await, so revocation while
the claim is pending prevents dispatch.

`src/file-remote-action-replay-store.mjs` implements the injected atomic replay
contract in an owner-private external `0700` directory. It hashes the verified
installation/action pair into a filename, claims with exclusive no-follow file
creation, stores only `0600` records, syncs file and directory durability, and
commits a completed receipt through an adjacent temporary file and atomic
rename. Version 2 records bind the safe action kind as well as the action ID, so
a completion receipt cannot change either value. Identical completed retries
return that receipt; conflicting reuse rejects; incomplete, malformed,
permission-invalid, or durability-uncertain records never dispatch. Records are
not automatically deleted in this phase.

`src/remote-action-secrets.mjs` supplies the paired-token verifier and keyed-HMAC
fingerprinter from two separate, canonical base64url files. Each file must
encode exactly 32 bytes and must be an owner-owned, single-link, non-symlink
private file outside the repository; the two decoded values must also differ.
Verification uses constant-time comparison and returns only the configured safe
installation ID. The HMAC key remains Mac-only and both retained byte buffers
can be zeroed at shutdown. Tests use only
synthetic temporary values. This loader proves the startup boundary; it does not
generate a real credential, pair a phone, or replace the later Keychain-backed
provisioning step.

`src/localhost-turn-action-listener.mjs` is the only socket owner. Constructing
it opens nothing; an explicit one-shot `start()` binds with no host override to
`127.0.0.1`, verifies the bound address, and accepts only one exact HTTP/1.1
`POST /v1/turn-actions` request per connection. It requires the exact local
`Host`, one canonical bounded `Content-Length`, no transfer/content encoding or
trailers, and unique protected headers before it buffers at most 32 KiB. Only
the content type, paired bearer, and Tailscale capability header reach the pure
handler. Responses are content-free, non-cacheable, and connection-closing.
Shutdown stops acceptance, revokes controls, and bounds socket draining.

`src/remote-action-receipt.mjs` is the single public-receipt contract used by
the ingress, durable replay validation, and listener. Its table owns the exact
five-field shape, allowlisted reason, HTTP status, and correlation rule.
Accepted receipts and every domain or post-dispatch rejection must match the
submitted action ID and action kind exactly; `invalidAction` and `unauthorized`
must remain uncorrelated. Correlated `invalidRequest` is only `400`; its `404`
and `413` forms are pre-action only. The same table also limits handler receipts
to the content-type, invalid-action, or valid-action phase observed by the
listener. The listener independently parses the submitted envelope through the
ingress validator, rejects mismatched or semantically impossible handler
receipts, and emits fixed-order JSON bytes.

The adapter has no standalone CLI and is not a persistent service. Deterministic
tests and the relay's explicit composition-proof mode open it on an ephemeral
loopback port with synthetic temporary secrets and replay state, send real local
HTTP requests, then close it and remove that state. No real credential or
Keychain provisioning, Tailscale Serve or policy configuration, Swift control,
background daemon, or phone action exists. The later Serve phase must observe
and explicitly adopt its forwarded `Host`; it must not weaken the local proof by
guessing an authority.
Stop's future App Intent authentication policy is also unselected; the physical
Stop control must explicitly require authentication before it can be treated as
lock-screen-safe. Those are separately gated phases.

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
