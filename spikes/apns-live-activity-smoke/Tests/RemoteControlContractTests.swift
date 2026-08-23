import Foundation
import XCTest
@testable import CodexLiveActivitySmoke

final class RemoteControlContractTests: XCTestCase {
    private let token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    private let expiry = "2030-01-02T03:06:05.000Z"

    func testDecodesExactPrivatePairingFixture() throws {
        let credential = try RemoteControlContract.decodePairingCredential(from: json([
            "schemaVersion": 1,
            "kind": "pairing",
            "origin": "https://relay.example.ts.net/",
            "appToken": token
        ]))

        XCTAssertEqual(credential.origin.absoluteString, "https://relay.example.ts.net")
        XCTAssertEqual(credential.appToken, token)
    }

    func testRejectsMalformedJSONAndWrongSchema() {
        XCTAssertThrowsError(try RemoteControlContract.decodePairingCredential(from: Data("[]".utf8))) {
            XCTAssertEqual($0 as? RemoteControlContractError, .malformedJSON)
        }
        XCTAssertThrowsError(try RemoteControlContract.decodePairingCredential(from: json([
            "schemaVersion": true, "kind": "pairing", "origin": "https://relay.example.ts.net", "appToken": token
        ]))) { XCTAssertEqual($0 as? RemoteControlContractError, .invalidSchemaVersion) }
    }

    func testRejectsOrdinaryAndEscapedEquivalentDuplicateKeys() {
        XCTAssertThrowsError(try RemoteControlContract.decodePairingCredential(from: Data("{\"schemaVersion\":1,\"schemaVersion\":1,\"kind\":\"pairing\",\"origin\":\"https://relay.example.ts.net\",\"appToken\":\"\(token)\"}".utf8))) {
            XCTAssertEqual($0 as? RemoteControlContractError, .malformedJSON)
        }
        XCTAssertThrowsError(try RemoteControlContract.validateReceipt(Data("{\"schemaVersion\":1,\"actionId\":\"stop-1\",\"action\\u0049d\":\"stop-1\",\"action\":\"stop\",\"outcome\":\"accepted\",\"reason\":null}".utf8), httpStatus: 200, for: try! request())) {
            XCTAssertEqual($0 as? RemoteControlContractError, .malformedJSON)
        }
    }

    func testRejectsPairingExtraKeyAndNonCanonicalCredential() {
        XCTAssertThrowsError(try RemoteControlContract.decodePairingCredential(from: json([
            "schemaVersion": 1, "kind": "pairing", "origin": "https://relay.example.ts.net", "appToken": token, "extra": true
        ]))) { XCTAssertEqual($0 as? RemoteControlContractError, .unexpectedKeys) }

        XCTAssertThrowsError(try RemoteControlContract.decodePairingCredential(from: json([
            "schemaVersion": 1, "kind": "pairing", "origin": "https://relay.example.ts.net", "appToken": String(repeating: "A", count: 42) + "="
        ]))) { XCTAssertEqual($0 as? RemoteControlContractError, .invalidCredential) }
    }

    func testRejectsOriginAttacks() {
        for origin in [
            "http://relay.example.ts.net",
            "https://user@relay.example.ts.net",
            "https://relay.example.ts.net/path",
            "https://relay.example.ts.net?x=1",
            "https://relay.example.ts.net#fragment",
            "https://relay.example.ts.net:444",
            "https://relay.example.com",
            "https://relay.example.ts.net.evil.example"
        ] {
            XCTAssertThrowsError(try RemoteControlContract.decodePairingCredential(from: json([
                "schemaVersion": 1, "kind": "pairing", "origin": origin, "appToken": token
            ]))) { XCTAssertEqual($0 as? RemoteControlContractError, .invalidOrigin) }
        }
    }

    func testDecodesExactContentFreeContextAndRejectsPrivateFields() throws {
        let context = try RemoteControlContract.decodeControlContext(from: json([
            "schemaVersion": 1,
            "kind": "controlContext",
            "controlContextId": token,
            "expiresAt": expiry
        ]))
        XCTAssertEqual(context.controlContextID, token)

        XCTAssertThrowsError(try RemoteControlContract.decodeControlContext(from: json([
            "schemaVersion": 1, "kind": "controlContext", "controlContextId": token, "expiresAt": expiry, "origin": "https://relay.example.ts.net"
        ]))) { XCTAssertEqual($0 as? RemoteControlContractError, .unexpectedKeys) }
    }

    func testRejectsInvalidContextDateAndCredential() {
        XCTAssertThrowsError(try RemoteControlContract.decodeControlContext(from: json([
            "schemaVersion": 1, "kind": "controlContext", "controlContextId": token, "expiresAt": "2030-01-02"
        ]))) { XCTAssertEqual($0 as? RemoteControlContractError, .invalidDate) }

        XCTAssertThrowsError(try RemoteControlContract.decodeControlContext(from: json([
            "schemaVersion": 1, "kind": "controlContext", "controlContextId": "bad", "expiresAt": expiry
        ]))) { XCTAssertEqual($0 as? RemoteControlContractError, .invalidCredential) }
        XCTAssertThrowsError(try RemoteControlContract.decodeControlContext(from: json([
            "schemaVersion": 1, "kind": "controlContext", "controlContextId": String(repeating: "A", count: 42), "expiresAt": expiry
        ]))) { XCTAssertEqual($0 as? RemoteControlContractError, .invalidCredential) }
    }

    func testStopActionHasExactWireShapeAndBoundedExpiry() throws {
        let now = try date("2030-01-02T03:04:05.000Z")
        let context = try RemoteControlContract.controlContext(
            controlContextID: token,
            expiresAt: try date(expiry)
        )
        let request = try RemoteControlContract.makeStopAction(actionID: "stop-1", context: context, now: now)
        let object = try JSONSerialization.jsonObject(with: request.encodedJSON()) as! [String: Any]

        XCTAssertEqual(Set(object.keys), ["schemaVersion", "actionId", "controlContextId", "issuedAt", "expiresAt", "action"])
        XCTAssertEqual(object["action"] as? String, "stop")
        XCTAssertEqual(object["actionId"] as? String, "stop-1")
        XCTAssertEqual(object["controlContextId"] as? String, token)
        XCTAssertEqual(object["issuedAt"] as? String, "2030-01-02T03:04:05.000Z")
        XCTAssertEqual(object["expiresAt"] as? String, "2030-01-02T03:05:05.000Z")
    }

    func testStopActionUsesContextExpiryAndRejectsExpiredOrUnsafeAction() throws {
        let now = try date("2030-01-02T03:04:05.000Z")
        let shortContext = try RemoteControlContract.controlContext(controlContextID: token, expiresAt: try date("2030-01-02T03:04:35.000Z"))
        XCTAssertEqual(try RemoteControlContract.makeStopAction(actionID: "a", context: shortContext, now: now).expiresAt, shortContext.expiresAt)
        XCTAssertThrowsError(try RemoteControlContract.makeStopAction(actionID: "bad/action", context: shortContext, now: now)) { XCTAssertEqual($0 as? RemoteControlContractError, .invalidActionID) }
        XCTAssertThrowsError(try RemoteControlContract.makeStopAction(actionID: "bad.id", context: shortContext, now: now)) { XCTAssertEqual($0 as? RemoteControlContractError, .invalidActionID) }
        XCTAssertThrowsError(try RemoteControlContract.makeStopAction(actionID: "_bad", context: shortContext, now: now)) { XCTAssertEqual($0 as? RemoteControlContractError, .invalidActionID) }
        XCTAssertThrowsError(try RemoteControlContract.makeStopAction(actionID: "-bad", context: shortContext, now: now)) { XCTAssertEqual($0 as? RemoteControlContractError, .invalidActionID) }
        XCTAssertThrowsError(try RemoteControlContract.makeStopAction(actionID: "", context: shortContext, now: now)) { XCTAssertEqual($0 as? RemoteControlContractError, .invalidActionID) }
        XCTAssertThrowsError(try RemoteControlContract.makeStopAction(actionID: "a", context: shortContext, now: shortContext.expiresAt)) { XCTAssertEqual($0 as? RemoteControlContractError, .expiredContext) }
        XCTAssertThrowsError(try RemoteControlContract.makeStopAction(actionID: String(repeating: "a", count: 65), context: shortContext, now: now)) { XCTAssertEqual($0 as? RemoteControlContractError, .invalidActionID) }
    }

    func testAcceptsOnlyExactSuccessfulCorrelatedReceipt() throws {
        let request = try request()
        let receipt = try RemoteControlContract.validateReceipt(json([
            "schemaVersion": 1,
            "actionId": request.actionID,
            "action": "stop",
            "outcome": "accepted",
            "reason": NSNull()
        ]), httpStatus: 200, for: request)
        XCTAssertEqual(receipt.actionID, request.actionID)

        XCTAssertThrowsError(try RemoteControlContract.validateReceipt(json([
            "schemaVersion": 1, "actionId": request.actionID, "action": "stop", "outcome": "accepted", "reason": NSNull()
        ]), httpStatus: 202, for: request)) { XCTAssertEqual($0 as? RemoteControlContractError, .unexpectedHTTPStatus) }
        XCTAssertThrowsError(try RemoteControlContract.validateReceipt(json([
            "schemaVersion": 1, "actionId": "other", "action": "stop", "outcome": "accepted", "reason": NSNull()
        ]), httpStatus: 200, for: request)) { XCTAssertEqual($0 as? RemoteControlContractError, .receiptMismatch) }
        XCTAssertThrowsError(try RemoteControlContract.validateReceipt(json([
            "schemaVersion": 1, "actionId": request.actionID, "action": "stop", "outcome": "rejected", "reason": "no"
        ]), httpStatus: 200, for: request)) { XCTAssertEqual($0 as? RemoteControlContractError, .rejectedReceipt) }
        XCTAssertThrowsError(try RemoteControlContract.validateReceipt(json([
            "schemaVersion": 1, "actionId": request.actionID, "action": "stop", "outcome": "accepted", "reason": NSNull(), "extra": true
        ]), httpStatus: 200, for: request)) { XCTAssertEqual($0 as? RemoteControlContractError, .unexpectedKeys) }
        XCTAssertThrowsError(try RemoteControlContract.validateReceipt(json([
            "schemaVersion": 1, "actionId": request.actionID, "action": "reply", "outcome": "accepted", "reason": NSNull()
        ]), httpStatus: 200, for: request)) { XCTAssertEqual($0 as? RemoteControlContractError, .rejectedReceipt) }
    }

    func testDirectControlContextConstructionValidatesCanonicalID() throws {
        let expiresAt = try date(expiry)
        let context = try RemoteControlContract.controlContext(controlContextID: token, expiresAt: expiresAt)
        XCTAssertEqual(context.controlContextID, token)
        XCTAssertEqual(context.expiresAt, expiresAt)

        XCTAssertThrowsError(try RemoteControlContract.controlContext(controlContextID: "invalid", expiresAt: expiresAt)) {
            XCTAssertEqual($0 as? RemoteControlContractError, .invalidCredential)
        }
    }

    private func request() throws -> StopActionRequest {
        try RemoteControlContract.makeStopAction(
            actionID: "stop-1",
            context: try RemoteControlContract.controlContext(controlContextID: token, expiresAt: try date(expiry)),
            now: try date("2030-01-02T03:04:05.000Z")
        )
    }

    private func json(_ object: [String: Any]) -> Data {
        try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    private func date(_ value: String) throws -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return try XCTUnwrap(formatter.date(from: value))
    }
}
