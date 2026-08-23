# APNs Live Activity and iPhone Stop-control smoke

This isolated spike contains two separately gated boundaries:

- the completed physical proof that an ActivityKit push sent through Apple Push
  Notification service updates a Live Activity while the iPhone is locked and
  the smoke app remains unopened; and
- an iPhone pairing and authenticated Stop prototype, validated with synthetic
  fixtures, an iOS Simulator, and one separately approved locked-phone physical
  proof.

It does not itself create a Mac relay or store APNs credentials. The new Stop
prototype is a client for the repository's existing one-task relay boundary; no
real pairing credential, live Serve target, relay task, or phone action is part
of the repository-only proof.

## Privacy boundary

Every payload contains only synthetic state and the fixed marker
`CLA-APNS-SMOKE-20260812-A`. Do not paste Codex prompts, transcripts, commands,
tool payloads, or other private content into Apple’s Push Notifications Console.

The pairing prototype accepts two exact QR shapes. The private pairing QR holds
only the tailnet HTTPS origin and one 32-byte app token and is stored in the
app-private Keychain with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. The
separate public control QR holds only one opaque context ID and expiry. Never
place the private pairing QR in screenshots, arguments, files, logs, APNs, or
ActivityKit state.

## Stop-control prototype

The app's **Scan pairing or control QR** flow accepts either the private pairing
QR or the public control-context QR. A valid public context starts one synthetic
Live Activity and enables Stop on the Lock Screen and expanded Dynamic Island.
The Stop intent explicitly requires local-device authentication, sends one exact
request through the paired tailnet HTTPS origin, accepts only a correlated
success receipt, and never retries an uncertain result. The control activity is
local-only and has no ActivityKit push token in this phase. After the matching
Mac lifecycle proves the task stopped, reopen the app and use **End Locally**;
terminal APNs presentation remains a later integration. A physical proof may
keep the public context available for up to 120 seconds, but the Stop request
itself remains limited to 60 seconds or the remaining context lifetime,
whichever is shorter.

The Mac presenter reads a bounded payload only from a noninteractive standard
input stream. It refuses a terminal because typed input would normally echo into
terminal output and scrollback. A later owner-private generator must pipe the
payload directly; do not pass it in arguments, paste it from the clipboard, or
type it interactively. Use it with a real credential only inside a separately
approved bounded proof after owner-private server state already exists. The
current deterministic tests use synthetic values only.

The completed physical Stop proof imported the private pairing and one public
context, required local authentication on the locked iPhone, accepted one exact
Stop on the Mac, and observed the matching terminal `interrupted` lifecycle. It
used no APNs request or token. Temporary Serve/grant state was restored after the
proof; the paired credential and one content-free replay receipt remain in their
owner-private stores and are not part of this repository.

## Prerequisites

- An active Apple Developer Program membership.
- A physical iPhone signed into the test environment.
- The explicit App ID `com.xtypo.CodexLiveActivitySmoke`, or a deliberate local
  replacement applied to both bundle identifiers before signing.
- Push Notifications enabled for the App ID and the matching development
  provisioning profile.

## Build and install

1. Open `CodexLiveActivitySmoke.xcodeproj` in Xcode.
2. Select the `CodexLiveActivitySmoke` app target and the
   `CodexLiveActivitySmokeWidget` extension target, then choose the same Apple
   development team for both targets.
3. Confirm that Xcode resolves automatic signing for both targets.
4. Run the app on the physical iPhone.
5. Select **Start Live Activity** and wait for the ActivityKit push token.
6. Select **Copy Push Token**.

Choosing a development team can register the App ID and provisioning profile in
the Apple developer account. That external change is intentionally outside the
repository-only setup.

## Send the three test updates

Open Apple’s Push Notifications Console, select the development environment and
the app bundle ID, choose the `liveactivity` push type, and paste the ActivityKit
push token from the app.

Generate each fresh payload immediately before sending it:

```sh
node spikes/apns-live-activity-smoke/scripts/render-payload.mjs attention
node spikes/apns-live-activity-smoke/scripts/render-payload.mjs ready
node spikes/apns-live-activity-smoke/scripts/render-payload.mjs end
```

The topic is the main app's configured bundle identifier followed by
`.push-type.liveactivity`. With the default bundle identifier, use:

```text
com.xtypo.CodexLiveActivitySmoke.push-type.liveactivity
```

If you replaced the bundle identifiers before signing, substitute the actual
main-app bundle identifier in that topic. Do not use the widget extension's
bundle identifier.

Use priority `10` for the bounded smoke. Send the payloads in order while the
iPhone is locked and the app remains unopened.

## Pass contract

- The initial Lock Screen Live Activity shows `Working` and sequence `#0`.
- The attention push changes it to amber `Needs attention` and sequence `#1`.
- The ready push changes it to green `Ready` and sequence `#2`.
- The end push shows sequence `#3`, ends the activity, and dismisses it after
  approximately 30 seconds.
- The fixed marker distinguishes this run from stale or unrelated pushes.
- No sensitive Codex content is sent.

An APNs console acceptance or delivery-log entry is supporting evidence, not the
final verdict. The smoke passes only after the physical locked iPhone visibly
renders each transition.
