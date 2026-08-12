# APNs Live Activity smoke

This isolated spike proves one boundary only: an ActivityKit push sent through
Apple Push Notification service updates a Live Activity while the physical
iPhone is locked and the smoke app remains unopened.

It does not connect to Codex, create a Mac relay, store APNs credentials, pair
devices, or implement the accepted production design.

## Privacy boundary

Every payload contains only synthetic state and the fixed marker
`CLA-APNS-SMOKE-20260812-A`. Do not paste Codex prompts, transcripts, commands,
tool payloads, or other private content into Apple’s Push Notifications Console.

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
