import ActivityKit
import SwiftUI
import UIKit

@MainActor
final class SmokeActivityModel: ObservableObject {
    @Published private(set) var activityID: String?
    @Published private(set) var pushToken: String?
    @Published private(set) var errorMessage: String?

    private var activity: Activity<SmokeActivityAttributes>?
    private var tokenTask: Task<Void, Never>?

    var canStart: Bool { activity == nil }

    func start() {
        guard activity == nil else { return }

        let attributes = SmokeActivityAttributes(taskName: "APNs delivery smoke")
        let state = SmokeActivityAttributes.ContentState(
            status: "Working",
            detail: "Waiting for a remote APNs update",
            attentionRequired: false,
            marker: "CLA-APNS-SMOKE-20260812-A",
            sequence: 0
        )
        let content = ActivityContent(
            state: state,
            staleDate: Date().addingTimeInterval(300)
        )

        do {
            let activity = try Activity.request(
                attributes: attributes,
                content: content,
                pushType: .token
            )
            self.activity = activity
            activityID = activity.id
            pushToken = nil
            errorMessage = nil
            observePushToken(for: activity)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func copyPushToken() {
        guard let pushToken else { return }
        UIPasteboard.general.string = pushToken
    }

    func endLocally() async {
        guard let activity else { return }
        let finalState = SmokeActivityAttributes.ContentState(
            status: "Ended locally",
            detail: "Start a new activity for another APNs test",
            attentionRequired: false,
            marker: "CLA-APNS-SMOKE-20260812-A",
            sequence: 99
        )
        await activity.end(
            ActivityContent(state: finalState, staleDate: nil),
            dismissalPolicy: .immediate
        )
        tokenTask?.cancel()
        tokenTask = nil
        self.activity = nil
        activityID = nil
        pushToken = nil
    }

    private func observePushToken(for activity: Activity<SmokeActivityAttributes>) {
        tokenTask?.cancel()
        tokenTask = Task { @MainActor [weak self] in
            for await tokenData in activity.pushTokenUpdates {
                guard !Task.isCancelled else { return }
                self?.pushToken = tokenData.map { String(format: "%02x", $0) }.joined()
            }
        }
    }
}

struct ContentView: View {
    @StateObject private var model = SmokeActivityModel()

    var body: some View {
        NavigationStack {
            Form {
                Section("Purpose") {
                    Text("Prove that APNs can update a Live Activity while this app stays closed and the iPhone is locked.")
                }

                Section("Activity") {
                    Button("Start Live Activity") {
                        model.start()
                    }
                    .disabled(!model.canStart)

                    if let activityID = model.activityID {
                        LabeledContent("Activity ID", value: activityID)
                    }

                    if let pushToken = model.pushToken {
                        Text(pushToken)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)

                        Button("Copy Push Token") {
                            model.copyPushToken()
                        }
                    } else if model.activityID != nil {
                        ProgressView("Waiting for ActivityKit push token")
                    }

                    if model.activityID != nil {
                        Button("End Locally", role: .destructive) {
                            Task {
                                await model.endLocally()
                            }
                        }
                    }
                }

                if let errorMessage = model.errorMessage {
                    Section("Error") {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                    }
                }

                Section("Pass condition") {
                    Text("Lock the phone, keep this app unopened, and send the synthetic attention, ready, and end payloads through Apple’s Push Notifications Console.")
                }
            }
            .navigationTitle("APNs Smoke")
        }
    }
}
