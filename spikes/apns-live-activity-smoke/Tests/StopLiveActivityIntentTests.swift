import AppIntents
import XCTest
@testable import CodexLiveActivitySmoke

final class StopLiveActivityIntentTests: XCTestCase {
    func testStopRequiresAuthenticationOnTheExecutingIPhone() {
        XCTAssertEqual(
            StopLiveActivityIntent.authenticationPolicy,
            .requiresLocalDeviceAuthentication
        )
        XCTAssertFalse(StopLiveActivityIntent.isDiscoverable)
    }
}
