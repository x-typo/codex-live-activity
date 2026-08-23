import Foundation
import XCTest
@testable import CodexLiveActivitySmoke

final class RemoteStopClientTests: XCTestCase {
    private let token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    private let contextID = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"

    func testTransportConfigurationDisablesStatefulNetworkBehavior() {
        let configuration = URLSessionRemoteStopTransport.makeConfiguration(
            protocolClasses: [TransportURLProtocol.self]
        )

        XCTAssertEqual(configuration.requestCachePolicy, .reloadIgnoringLocalCacheData)
        XCTAssertEqual(configuration.timeoutIntervalForRequest, 5)
        XCTAssertEqual(configuration.timeoutIntervalForResource, 8)
        XCTAssertFalse(configuration.waitsForConnectivity)
        XCTAssertFalse(configuration.httpShouldSetCookies)
        XCTAssertNil(configuration.httpCookieStorage)
        XCTAssertNil(configuration.urlCache)
        XCTAssertEqual(configuration.protocolClasses?.count, 1)
        XCTAssertTrue(configuration.protocolClasses?.first === TransportURLProtocol.self)
    }

    func testRedirectDelegateRefusesRedirect() throws {
        let configuration = URLSessionConfiguration.ephemeral
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let source = URL(string: "https://transport.test/redirect-source")!
        let target = URL(string: "https://transport.test/redirect-target")!
        let response = try XCTUnwrap(
            HTTPURLResponse(
                url: source,
                statusCode: 302,
                httpVersion: "HTTP/1.1",
                headerFields: ["Location": target.absoluteString]
            )
        )
        let task = session.dataTask(with: source)
        let completion = expectation(description: "redirect decision")

        RejectRedirectsDelegate().urlSession(
            session,
            task: task,
            willPerformHTTPRedirection: response,
            newRequest: URLRequest(url: target)
        ) { redirectedRequest in
            XCTAssertNil(redirectedRequest)
            completion.fulfill()
        }
        wait(
            for: [completion],
            timeout: 1
        )
    }

    func testTransportStreamsExactlyFourKiBButRejectsOneAdditionalByte() async throws {
        defer { TransportURLProtocol.reset() }
        let transport = URLSessionRemoteStopTransport(
            testProtocolClasses: [TransportURLProtocol.self]
        )
        let request = URLRequest(
            url: URL(string: "https://transport.test/streamed-body")!
        )

        TransportURLProtocol.configureBody(chunks: [Data(repeating: 0x61, count: 4_096)])
        let accepted = try await transport.send(request)
        XCTAssertEqual(accepted.statusCode, 200)
        XCTAssertEqual(accepted.body.count, 4_096)

        TransportURLProtocol.configureBody(chunks: [
            Data(repeating: 0x61, count: 4_096),
            Data([0x62])
        ])
        do {
            _ = try await transport.send(request)
            XCTFail("expected the streamed response cap to reject one additional byte")
        } catch let error as URLError {
            XCTAssertEqual(error.code, .dataLengthExceedsMaximum)
        }
    }

    func testSendsExactAuthenticatedStopWithoutLeakingBearerIntoBody() async throws {
        let response = RemoteStopHTTPResponse(
            statusCode: 200,
            body: json([
                "schemaVersion": 1,
                "actionId": "ios_action_1",
                "action": "stop",
                "outcome": "accepted",
                "reason": NSNull()
            ])
        )
        let transport = RecordingRemoteStopTransport(response: response)
        let client = RemoteStopClient(
            loadPairing: { self.pairing() },
            transport: transport,
            now: { self.date("2030-01-02T03:04:05.000Z") },
            makeActionID: { "ios_action_1" }
        )

        let outcome = await client.stop(
            controlContextID: contextID,
            contextExpiresAt: date("2030-01-02T03:06:05.000Z")
        )

        XCTAssertEqual(outcome, .accepted)
        let recordedRequest = await transport.onlyRequest()
        let request = try XCTUnwrap(recordedRequest)
        XCTAssertEqual(request.url?.absoluteString, "https://relay.example.ts.net/v1/turn-actions")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(token)")
        XCTAssertNil(request.value(forHTTPHeaderField: "Tailscale-App-Capabilities"))

        let body = try XCTUnwrap(request.httpBody)
        XCTAssertFalse(String(decoding: body, as: UTF8.self).contains(token))
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: body) as? [String: Any]
        )
        XCTAssertEqual(
            Set(object.keys),
            ["schemaVersion", "actionId", "controlContextId", "issuedAt", "expiresAt", "action"]
        )
        XCTAssertEqual(object["actionId"] as? String, "ios_action_1")
        XCTAssertEqual(object["controlContextId"] as? String, contextID)
        XCTAssertEqual(object["issuedAt"] as? String, "2030-01-02T03:04:05.000Z")
        XCTAssertEqual(object["expiresAt"] as? String, "2030-01-02T03:05:05.000Z")
        XCTAssertEqual(object["action"] as? String, "stop")
    }

    func testExpiredContextDoesNotReadPairingOrUseTransport() async {
        let pairingReads = Counter()
        let transport = RecordingRemoteStopTransport(response: nil)
        let client = RemoteStopClient(
            loadPairing: {
                await pairingReads.increment()
                return self.pairing()
            },
            transport: transport,
            now: { self.date("2030-01-02T03:04:05.000Z") },
            makeActionID: { "ios_action_1" }
        )

        let outcome = await client.stop(
            controlContextID: contextID,
            contextExpiresAt: date("2030-01-02T03:04:05.000Z")
        )

        XCTAssertEqual(outcome, .notAttempted)
        let pairingReadCount = await pairingReads.value()
        let requestCount = await transport.requestCount()
        XCTAssertEqual(pairingReadCount, 0)
        XCTAssertEqual(requestCount, 0)
    }

    func testMissingPairingDoesNotUseTransport() async {
        let transport = RecordingRemoteStopTransport(response: nil)
        let client = RemoteStopClient(
            loadPairing: { throw RemoteControlPairingStoreError.notPaired },
            transport: transport,
            now: { self.date("2030-01-02T03:04:05.000Z") },
            makeActionID: { "ios_action_1" }
        )

        let outcome = await client.stop(
            controlContextID: contextID,
            contextExpiresAt: date("2030-01-02T03:05:05.000Z")
        )

        XCTAssertEqual(outcome, .notAttempted)
        let requestCount = await transport.requestCount()
        XCTAssertEqual(requestCount, 0)
    }

    func testWrongStatusOrReceiptCorrelationIsOutcomeUnknown() async {
        let responses = [
            RemoteStopHTTPResponse(
                statusCode: 202,
                body: acceptedReceipt(actionID: "ios_action_1")
            ),
            RemoteStopHTTPResponse(
                statusCode: 200,
                body: acceptedReceipt(actionID: "other_action")
            ),
            RemoteStopHTTPResponse(
                statusCode: 200,
                body: json([
                    "schemaVersion": 1,
                    "actionId": "ios_action_1",
                    "action": "stop",
                    "outcome": "accepted",
                    "reason": NSNull(),
                    "extra": true
                ])
            )
        ]

        for response in responses {
            let client = RemoteStopClient(
                loadPairing: { self.pairing() },
                transport: RecordingRemoteStopTransport(response: response),
                now: { self.date("2030-01-02T03:04:05.000Z") },
                makeActionID: { "ios_action_1" }
            )
            let outcome = await client.stop(
                controlContextID: contextID,
                contextExpiresAt: date("2030-01-02T03:05:05.000Z")
            )
            XCTAssertEqual(outcome, .outcomeUnknown)
        }
    }

    func testTransportFailureIsOutcomeUnknownAndIsNotRetried() async {
        let transport = RecordingRemoteStopTransport(response: nil)
        let client = RemoteStopClient(
            loadPairing: { self.pairing() },
            transport: transport,
            now: { self.date("2030-01-02T03:04:05.000Z") },
            makeActionID: { "ios_action_1" }
        )

        let outcome = await client.stop(
            controlContextID: contextID,
            contextExpiresAt: date("2030-01-02T03:05:05.000Z")
        )

        XCTAssertEqual(outcome, .outcomeUnknown)
        let requestCount = await transport.requestCount()
        XCTAssertEqual(requestCount, 1)
    }

    func testConcurrentStopsClaimOneTransportAttemptPerContext() async throws {
        let transport = SuspendingFirstRemoteStopTransport(
            response: RemoteStopHTTPResponse(
                statusCode: 200,
                body: acceptedReceipt(actionID: "ios_action_1")
            )
        )
        let actionIDs = ActionIDSequence([
            "ios_action_1",
            "ios_action_2",
            "ios_action_3"
        ])
        let client = RemoteStopClient(
            loadPairing: { self.pairing() },
            transport: transport,
            now: { self.date("2030-01-02T03:04:05.000Z") },
            makeActionID: { actionIDs.next() }
        )
        let expiresAt = date("2030-01-02T03:05:05.000Z")

        let first = Task {
            await client.stop(
                controlContextID: contextID,
                contextExpiresAt: expiresAt
            )
        }
        defer {
            first.cancel()
            transport.releaseFirstRequest()
        }
        let firstRequestStarted = await transport.waitUntilFirstRequestStarts(
            timeout: .seconds(2)
        )
        guard firstRequestStarted else {
            XCTFail("The first Stop never reached the transport")
            return
        }

        let overlapping = await client.stop(
            controlContextID: contextID,
            contextExpiresAt: expiresAt
        )
        XCTAssertEqual(overlapping, .notAttempted)
        XCTAssertEqual(transport.requestCount(), 1)

        transport.releaseFirstRequest()
        let firstOutcome = await first.value
        XCTAssertEqual(firstOutcome, .accepted)

        let later = await client.stop(
            controlContextID: contextID,
            contextExpiresAt: expiresAt
        )
        XCTAssertEqual(later, .notAttempted)
        XCTAssertEqual(transport.requestCount(), 1)
        XCTAssertEqual(actionIDs.issuedCount, 3)
    }

    private func pairing() -> PairingCredential {
        PairingCredential(
            origin: URL(string: "https://relay.example.ts.net")!,
            appToken: token
        )
    }

    private func acceptedReceipt(actionID: String) -> Data {
        json([
            "schemaVersion": 1,
            "actionId": actionID,
            "action": "stop",
            "outcome": "accepted",
            "reason": NSNull()
        ])
    }

    private func json(_ object: [String: Any]) -> Data {
        try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    private func date(_ value: String) -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)!
    }
}

private actor RecordingRemoteStopTransport: RemoteStopTransport {
    private let response: RemoteStopHTTPResponse?
    private var requests: [URLRequest] = []

    init(response: RemoteStopHTTPResponse?) {
        self.response = response
    }

    func send(_ request: URLRequest) async throws -> RemoteStopHTTPResponse {
        requests.append(request)
        guard let response else { throw URLError(.cannotConnectToHost) }
        return response
    }

    func onlyRequest() -> URLRequest? {
        requests.count == 1 ? requests[0] : nil
    }

    func requestCount() -> Int {
        requests.count
    }
}

private final class SuspendingFirstRemoteStopTransport: RemoteStopTransport, @unchecked Sendable {
    private let response: RemoteStopHTTPResponse
    private let lock = NSLock()
    private var requests: [URLRequest] = []
    private var isFirstRequestReleased = false

    init(response: RemoteStopHTTPResponse) {
        self.response = response
    }

    func send(_ request: URLRequest) async throws -> RemoteStopHTTPResponse {
        let isFirst = lock.withLock {
            requests.append(request)
            return requests.count == 1
        }
        if isFirst {
            while !firstRequestWasReleased(), !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(10))
            }
        }
        return response
    }

    func waitUntilFirstRequestStarts(
        timeout: Duration
    ) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while requestCount() == 0, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
        return requestCount() == 1
    }

    func releaseFirstRequest() {
        lock.withLock {
            isFirstRequestReleased = true
        }
    }

    func requestCount() -> Int {
        lock.withLock { requests.count }
    }

    private func firstRequestWasReleased() -> Bool {
        lock.withLock { isFirstRequestReleased }
    }
}

private final class ActionIDSequence: @unchecked Sendable {
    private let lock = NSLock()
    private var actionIDs: [String]
    private var issuedCountValue = 0

    init(_ actionIDs: [String]) {
        self.actionIDs = actionIDs
    }

    var issuedCount: Int {
        lock.withLock { issuedCountValue }
    }

    func next() -> String {
        lock.withLock {
            issuedCountValue += 1
            return actionIDs.removeFirst()
        }
    }
}

private actor Counter {
    private var count = 0

    func increment() {
        count += 1
    }

    func value() -> Int {
        count
    }
}

private final class TransportURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var chunks: [Data]?

    static func configureBody(chunks: [Data]) {
        lock.lock()
        self.chunks = chunks
        lock.unlock()
    }

    static func reset() {
        lock.lock()
        chunks = nil
        lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "transport.test"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let url = request.url, let chunks = Self.readChunks() else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }

        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [:]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        for chunk in chunks {
            client?.urlProtocol(self, didLoad: chunk)
        }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func readChunks() -> [Data]? {
        lock.lock()
        defer { lock.unlock() }
        return chunks
    }
}
