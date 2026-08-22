# Direct APNs delivery from the Mac

This is the smallest direct path from the merged one-task relay to the existing
ActivityKit smoke app. It updates one Live Activity that the user deliberately
starts on the iPhone. It does not remotely start an activity, observe stock
desktop tasks, host a service, install an app, create an Apple key, or send a
notification by itself.

## Proven locally

The dependency-free sender:

- accepts only the exact redacted JSONL body produced by the one-task relay;
- pins `api.sandbox.push.apple.com:443` or `api.push.apple.com:443` from an
  explicit environment enum;
- uses `POST /3/device/<ActivityKit update token>` over HTTP/2 and TLS 1.2 or
  later;
- derives `<main bundle ID>.push-type.liveactivity` and fixes the push type to
  `liveactivity`;
- creates an ES256 provider JWT in memory and reuses it on the connection;
- coalesces duplicate working heartbeats, preserves ordering, and emits only
  generic receipts;
- makes no automatic retry and stops after the first uncertain or rejected
  delivery; and
- keeps the signing key, provider JWT, and ActivityKit token out of arguments,
  environment variables, stdout, stderr, repository files, and retry state.

The test suite uses only a synthetic P-256 key and an in-memory HTTP/2 stream
double. Passing tests alone do not prove Apple accepted or delivered a
notification.

The separately approved physical proof also passed. Three content-free
relay-owned runs received APNs HTTP `200`; the deliberate 20-second run visibly
showed blue `Working` sequence `#1` and green terminal `Ready` sequence `#18` on
the same locked-iPhone Live Activity. The temporary sandbox key was revoked, and
the external key, ActivityKit token, and configuration files were removed after
the proof. No credential or token is retained in the repository.

## Apple contract used

Apple requires an ActivityKit update request to use:

- `apns-push-type: liveactivity`;
- `apns-topic: <main bundle ID>.push-type.liveactivity`;
- `apns-priority: 5` or `10`;
- an `aps.timestamp` in epoch seconds;
- `aps.event: update` for an update; and
- an `aps.content-state` that exactly matches the app's Swift `ContentState`.

The current smoke app already requests a local activity with `pushType: .token`,
observes token updates, and displays the current token for an intentional manual
copy. Its committed entitlement is `development`, so the existing signed smoke
build uses the APNs `sandbox` environment. Always use the main app bundle ID,
never the widget extension's bundle ID.

Official references:

- [Starting and updating Live Activities with ActivityKit push notifications](https://developer.apple.com/documentation/ActivityKit/starting-and-updating-live-activities-with-activitykit-push-notifications)
- [Sending notification requests to APNs](https://developer.apple.com/documentation/UserNotifications/sending-notification-requests-to-apns)
- [Establishing a token-based connection to APNs](https://developer.apple.com/documentation/UserNotifications/establishing-a-token-based-connection-to-apns)
- [Handling notification responses from APNs](https://developer.apple.com/documentation/UserNotifications/handling-notification-responses-from-apns)

## Protected local configuration

Do not create these files in the repository. Use a private directory outside the
checkout, owned by the current macOS user with mode `0700`, and make every file
mode `0600`. The sender rejects a relative path, symlink, non-regular file,
group/world-accessible file, wrong-owner file, repository-contained file, unknown
configuration key, or oversized file.

The configuration contains references, not key or token values:

```json
{
  "version": 1,
  "environment": "sandbox",
  "bundleId": "com.xtypo.CodexLiveActivitySmoke",
  "teamId": "YOUR10CHAR",
  "keyId": "YOUR10CHAR",
  "privateKeyPath": "/absolute/private/path/AuthKey_KEYID.p8",
  "activityTokenPath": "/absolute/private/path/activity-token.txt"
}
```

`teamId` and `keyId` must each be the exact 10-character Apple identifier. The
private key must be an APNs P-256 `.p8` key. The activity-token file contains
only the current lowercase or uppercase hexadecimal token emitted for the one
running Live Activity. ActivityKit can rotate this token; a newly displayed
token replaces the old file value for the next run.

Never paste the `.p8` contents, provider JWT, or ActivityKit token into Codex,
chat, terminal arguments, the record, a commit, or a pull request.

## Completed live proof and repeat boundary

The completed proof used this bounded pipeline only after the credential, token,
signed-app environment, and physical-device gates were separately approved:

```sh
set -o pipefail
printf '%s' 'Reply with exactly SMOKE_OK. Do not use tools.' \
  | npm run --silent relay -- --cwd "$PWD" \
  | npm run --silent apns-sender -- --config "/absolute/private/path/apns-config.json"
```

The sender prints one JSON receipt per relay payload. `accepted: true` means APNs
returned HTTP `200`; it is not proof that the iPhone rendered the update.
`accepted: false` with `reason: "coalesced"` means the payload was a duplicate
presentation that did not need another push before the current stale deadline.

Do not repeat it or recreate its credentials without a new, explicitly approved
physical-proof need. The accepted APNs responses were transport receipts; the
user-provided locked-phone screenshots are the evidence that `Working` and
terminal `Ready` rendered on the same activity.

This sender intentionally remains update-only. A separate lifecycle-policy phase
must decide when to send `end`, how dismissal should work, and whether a future
acknowledgement contract can support true unread retention. Packaging a daemon
and building the broader iPhone UI also remain out of scope.
