import ActivityKit
import SwiftUI
import UIKit

@MainActor
final class SmokeActivityModel: ObservableObject {
    @Published private(set) var activityID: String?
    @Published private(set) var pushToken: String?
    @Published private(set) var expectsPushToken = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var pairingStatus = "Not paired"
    @Published private(set) var importMessage: String?

    private var activity: Activity<SmokeActivityAttributes>?
    private var tokenTask: Task<Void, Never>?
    private var stateTask: Task<Void, Never>?

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
            expectsPushToken = true
            errorMessage = nil
            observePushToken(for: activity)
            observeState(for: activity)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func refreshPairingStatus() async {
        do {
            _ = try await RemoteControlPairingStore().load()
            pairingStatus = "Paired"
        } catch RemoteControlPairingStoreError.notPaired {
            pairingStatus = "Not paired"
        } catch {
            pairingStatus = "Pairing unavailable"
        }
    }

    func importScannedPayload(_ payload: String) async {
        let data = Data(payload.utf8)
        if (try? RemoteControlContract.decodePairingCredential(from: data)) != nil {
            do {
                _ = try await RemoteControlPairingStore().save(pairingPayload: data)
                pairingStatus = "Paired"
                importMessage = "Pairing stored securely"
                errorMessage = nil
            } catch {
                await refreshPairingStatus()
                importMessage = nil
                if error as? RemoteControlPairingStoreError == .writeOutcomeUnknown {
                    errorMessage = "Pairing status is uncertain. Do not use Stop until it is repaired."
                } else {
                    errorMessage = "Pairing could not be stored."
                }
            }
            return
        }

        if let context = try? RemoteControlContract.decodeControlContext(from: data) {
            startControlActivity(context)
            return
        }

        importMessage = nil
        errorMessage = "That QR code is not a supported pairing or control context."
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
        clearActivity(matching: activity.id)
    }

    func reconcileActivityState() {
        if activity == nil,
           let existing = Activity<SmokeActivityAttributes>.activities.first(where: {
               $0.activityState != .ended && $0.activityState != .dismissed
           }) {
            activity = existing
            activityID = existing.id
            expectsPushToken =
                existing.content.state.marker == "CLA-APNS-SMOKE-20260812-A"
            if expectsPushToken {
                observePushToken(for: existing)
            }
            observeState(for: existing)
        }
        guard let activity else { return }
        if activity.activityState == .ended || activity.activityState == .dismissed {
            clearActivity(matching: activity.id)
        }
    }

    private func startControlActivity(_ context: ControlContext) {
        guard activity == nil else {
            importMessage = nil
            errorMessage = "End the current Live Activity before importing a control context."
            return
        }
        guard context.expiresAt > Date() else {
            importMessage = nil
            errorMessage = "That control context has expired."
            return
        }

        let attributes = SmokeActivityAttributes(taskName: "Codex control smoke")
        let state = SmokeActivityAttributes.ContentState(
            status: "Working",
            detail: "Ready for authenticated Stop",
            attentionRequired: false,
            marker: "CLA-IPHONE-STOP-SMOKE-20260823-A",
            sequence: 0,
            stopControl: SmokeActivityAttributes.StopControlContext(context)
        )
        let content = ActivityContent(state: state, staleDate: context.expiresAt)

        do {
            let activity = try Activity.request(
                attributes: attributes,
                content: content,
                pushType: nil
            )
            self.activity = activity
            activityID = activity.id
            pushToken = nil
            expectsPushToken = false
            importMessage = "Control Live Activity started"
            errorMessage = nil
            observeState(for: activity)
        } catch {
            importMessage = nil
            errorMessage = "The control Live Activity could not start."
        }
    }

    private func observePushToken(for activity: Activity<SmokeActivityAttributes>) {
        tokenTask?.cancel()
        tokenTask = Task { @MainActor [weak self] in
            for await tokenData in activity.pushTokenUpdates {
                guard !Task.isCancelled, self?.activity?.id == activity.id else { return }
                self?.pushToken = tokenData.map { String(format: "%02x", $0) }.joined()
            }
        }
    }

    private func observeState(for activity: Activity<SmokeActivityAttributes>) {
        stateTask?.cancel()
        stateTask = Task { @MainActor [weak self] in
            for await state in activity.activityStateUpdates {
                guard !Task.isCancelled else { return }
                if state == .ended || state == .dismissed {
                    self?.clearActivity(matching: activity.id)
                    return
                }
            }
        }
    }

    private func clearActivity(matching id: String) {
        guard activity?.id == id else { return }
        tokenTask?.cancel()
        stateTask?.cancel()
        tokenTask = nil
        stateTask = nil
        activity = nil
        activityID = nil
        pushToken = nil
        expectsPushToken = false
    }
}

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = SmokeActivityModel()
    @State private var showingScanner = false

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
                    } else if model.activityID != nil && model.expectsPushToken {
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

                Section("Authenticated Stop proof") {
                    LabeledContent("Pairing", value: model.pairingStatus)

                    Button("Scan pairing or control QR") {
                        showingScanner = true
                    }

                    Text("Scan the private pairing code once, then scan a public short-lived control context for each proof task.")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    if let importMessage = model.importMessage {
                        Text(importMessage)
                            .foregroundStyle(.green)
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
            .onAppear {
                model.reconcileActivityState()
                Task {
                    await model.refreshPairingStatus()
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    model.reconcileActivityState()
                }
            }
            .sheet(isPresented: $showingScanner) {
                NavigationStack {
                    QRScannerView { payload in
                        showingScanner = false
                        Task {
                            await model.importScannedPayload(payload)
                        }
                    }
                    .navigationTitle("Scan secure code")
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") {
                                showingScanner = false
                            }
                        }
                    }
                }
            }
        }
    }
}
