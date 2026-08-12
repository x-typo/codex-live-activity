import ActivityKit
import SwiftUI
import WidgetKit

struct SmokeLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SmokeActivityAttributes.self) { context in
            HStack(spacing: 12) {
                Circle()
                    .fill(color(for: context.state))
                    .frame(width: 14, height: 14)

                VStack(alignment: .leading, spacing: 3) {
                    Text(context.attributes.taskName)
                        .font(.headline)
                    Text(context.state.status)
                        .font(.subheadline.weight(.semibold))
                    Text(context.state.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Text("#\(context.state.sequence)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .padding()
            .activityBackgroundTint(Color.black.opacity(0.88))
            .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: symbol(for: context.state))
                        .foregroundStyle(color(for: context.state))
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.status)
                        .font(.headline)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(context.state.detail)
                        .font(.caption)
                }
            } compactLeading: {
                Image(systemName: symbol(for: context.state))
                    .foregroundStyle(color(for: context.state))
            } compactTrailing: {
                Text("#\(context.state.sequence)")
                    .font(.caption2.monospacedDigit())
            } minimal: {
                Circle()
                    .fill(color(for: context.state))
            }
        }
    }

    private func color(for state: SmokeActivityAttributes.ContentState) -> Color {
        if state.attentionRequired { return .orange }
        return state.status == "Ready" ? .green : .blue
    }

    private func symbol(for state: SmokeActivityAttributes.ContentState) -> String {
        if state.attentionRequired { return "exclamationmark.triangle.fill" }
        return state.status == "Ready" ? "checkmark.circle.fill" : "bolt.fill"
    }
}
