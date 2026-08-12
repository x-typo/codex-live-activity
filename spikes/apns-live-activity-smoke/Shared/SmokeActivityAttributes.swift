import ActivityKit

struct SmokeActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        let status: String
        let detail: String
        let attentionRequired: Bool
        let marker: String
        let sequence: Int
    }

    let taskName: String
}
