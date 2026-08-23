import ActivityKit
import AppIntents
import Foundation

struct StopLiveActivityIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Stop Codex task"
    static let description = IntentDescription(
        "Requests that the paired Mac interrupt the active relay-owned Codex turn."
    )
    static let authenticationPolicy: IntentAuthenticationPolicy =
        .requiresLocalDeviceAuthentication
    static let isDiscoverable = false

    @Parameter(title: "Control context")
    var controlContextID: String

    @Parameter(title: "Control expiry")
    var contextExpiresAt: Date

    init() {}

    init(controlContextID: String, contextExpiresAt: Date) {
        self.controlContextID = controlContextID
        self.contextExpiresAt = contextExpiresAt
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let outcome = await RemoteStopClient.live.stop(
            controlContextID: controlContextID,
            contextExpiresAt: contextExpiresAt
        )

        switch outcome {
        case .accepted:
            await updateMatchingActivity(
                status: "Stop requested",
                detail: "Waiting for Codex to stop"
            )
            return .result(dialog: "Stop request accepted.")
        case .outcomeUnknown:
            await updateMatchingActivity(
                status: "Stop not confirmed",
                detail: "Check the Mac before trying again"
            )
            return .result(dialog: "Stop delivery could not be confirmed.")
        case .notAttempted:
            if Date() >= contextExpiresAt {
                await updateMatchingActivity(
                    status: "Control expired",
                    detail: "Start a new control proof from the Mac"
                )
            }
            return .result(dialog: "Stop was not sent.")
        }
    }

    private func updateMatchingActivity(status: String, detail: String) async {
        guard let activity = Activity<SmokeActivityAttributes>.activities.first(where: {
            $0.content.state.stopControl?.controlContextId == controlContextID
        }) else {
            return
        }

        let previous = activity.content
        let state = previous.state
        let nextSequence = state.sequence == Int.max ? state.sequence : state.sequence + 1
        let updated = SmokeActivityAttributes.ContentState(
            status: status,
            detail: detail,
            attentionRequired: false,
            marker: state.marker,
            sequence: nextSequence
        )
        await activity.update(
            ActivityContent(
                state: updated,
                staleDate: nil,
                relevanceScore: previous.relevanceScore
            )
        )
    }
}
