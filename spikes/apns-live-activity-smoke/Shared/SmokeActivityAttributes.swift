import ActivityKit
import Foundation

struct SmokeActivityAttributes: ActivityAttributes {
    struct StopControlContext: Codable, Hashable {
        let schemaVersion: Int
        let controlContextId: String
        let expiresAt: Date

        init(_ context: ControlContext) {
            schemaVersion = 1
            controlContextId = context.controlContextID
            expiresAt = context.expiresAt
        }
    }

    struct ContentState: Codable, Hashable {
        let status: String
        let detail: String
        let attentionRequired: Bool
        let marker: String
        let sequence: Int
        let stopControl: StopControlContext?

        init(
            status: String,
            detail: String,
            attentionRequired: Bool,
            marker: String,
            sequence: Int,
            stopControl: StopControlContext? = nil
        ) {
            self.status = status
            self.detail = detail
            self.attentionRequired = attentionRequired
            self.marker = marker
            self.sequence = sequence
            self.stopControl = stopControl
        }
    }

    let taskName: String
}
