import Foundation

enum RemoteStopAttemptOutcome: Equatable, Sendable {
    case accepted
    case notAttempted
    case outcomeUnknown
}

struct RemoteStopHTTPResponse: Sendable {
    let statusCode: Int
    let body: Data
}

protocol RemoteStopTransport: Sendable {
    func send(_ request: URLRequest) async throws -> RemoteStopHTTPResponse
}

struct URLSessionRemoteStopTransport: RemoteStopTransport {
    private static let maximumResponseBytes = 4_096
    private let testProtocolClasses: [AnyClass]?

    init(testProtocolClasses: [AnyClass]? = nil) {
        self.testProtocolClasses = testProtocolClasses
    }

    static func makeConfiguration(protocolClasses: [AnyClass]? = nil) -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = protocolClasses
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 5
        configuration.timeoutIntervalForResource = 8
        configuration.waitsForConnectivity = false
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        return configuration
    }

    func send(_ request: URLRequest) async throws -> RemoteStopHTTPResponse {
        let configuration = Self.makeConfiguration(
            protocolClasses: testProtocolClasses
        )

        let delegate = RejectRedirectsDelegate()
        let session = URLSession(
            configuration: configuration,
            delegate: delegate,
            delegateQueue: nil
        )
        defer { session.invalidateAndCancel() }

        let (bytes, response) = try await session.bytes(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        if response.expectedContentLength > Int64(Self.maximumResponseBytes) {
            throw URLError(.dataLengthExceedsMaximum)
        }

        var body = Data()
        body.reserveCapacity(
            response.expectedContentLength > 0
                ? min(Int(response.expectedContentLength), Self.maximumResponseBytes)
                : 0
        )
        for try await byte in bytes {
            guard body.count < Self.maximumResponseBytes else {
                throw URLError(.dataLengthExceedsMaximum)
            }
            body.append(byte)
        }
        return RemoteStopHTTPResponse(statusCode: response.statusCode, body: body)
    }
}

final class RejectRedirectsDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

struct RemoteStopClient: Sendable {
    private let loadPairing: @Sendable () async throws -> PairingCredential
    private let transport: any RemoteStopTransport
    private let now: @Sendable () -> Date
    private let makeActionID: @Sendable () -> String

    init(
        loadPairing: @escaping @Sendable () async throws -> PairingCredential,
        transport: any RemoteStopTransport,
        now: @escaping @Sendable () -> Date = { Date() },
        makeActionID: @escaping @Sendable () -> String = {
            "ios_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
        }
    ) {
        self.loadPairing = loadPairing
        self.transport = transport
        self.now = now
        self.makeActionID = makeActionID
    }

    static let live = RemoteStopClient(
        loadPairing: { try await RemoteControlPairingStore().load() },
        transport: URLSessionRemoteStopTransport()
    )

    func stop(controlContextID: String, contextExpiresAt: Date) async -> RemoteStopAttemptOutcome {
        let context: ControlContext
        let action: StopActionRequest
        do {
            context = try RemoteControlContract.controlContext(
                controlContextID: controlContextID,
                expiresAt: contextExpiresAt
            )
            action = try RemoteControlContract.makeStopAction(
                actionID: makeActionID(),
                context: context,
                now: now()
            )
        } catch {
            return .notAttempted
        }

        let pairing: PairingCredential
        do {
            pairing = try await loadPairing()
        } catch {
            return .notAttempted
        }

        guard let endpoint = Self.endpoint(for: pairing.origin) else {
            return .notAttempted
        }

        var request = URLRequest(
            url: endpoint,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: 5
        )
        request.httpMethod = "POST"
        request.httpBody = try? action.encodedJSON()
        guard request.httpBody != nil else {
            return .notAttempted
        }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(pairing.appToken)", forHTTPHeaderField: "Authorization")

        do {
            let response = try await transport.send(request)
            _ = try RemoteControlContract.validateReceipt(
                response.body,
                httpStatus: response.statusCode,
                for: action
            )
            return .accepted
        } catch {
            return .outcomeUnknown
        }
    }

    private static func endpoint(for origin: URL) -> URL? {
        guard var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.path = "/v1/turn-actions"
        return components.url
    }
}
