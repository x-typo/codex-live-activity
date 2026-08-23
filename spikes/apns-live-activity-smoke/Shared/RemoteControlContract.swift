import Foundation

enum RemoteControlContractError: Error, Equatable {
    case malformedJSON
    case unexpectedKeys
    case invalidSchemaVersion
    case invalidKind
    case invalidString
    case invalidOrigin
    case invalidCredential
    case invalidDate
    case expiredContext
    case invalidActionID
    case unexpectedHTTPStatus
    case receiptMismatch
    case rejectedReceipt
}

struct PairingCredential: Equatable {
    let origin: URL
    let appToken: String
}

struct ControlContext: Equatable {
    let controlContextID: String
    let expiresAt: Date

    fileprivate init(controlContextID: String, expiresAt: Date) {
        self.controlContextID = controlContextID
        self.expiresAt = expiresAt
    }
}

struct StopActionRequest: Equatable {
    let actionID: String
    let controlContextID: String
    let issuedAt: Date
    let expiresAt: Date

    func encodedJSON() throws -> Data {
        try RemoteControlJSON.encodedObject([
            "schemaVersion": 1,
            "actionId": actionID,
            "controlContextId": controlContextID,
            "issuedAt": RemoteControlDate.string(from: issuedAt),
            "expiresAt": RemoteControlDate.string(from: expiresAt),
            "action": "stop"
        ])
    }
}

struct ControlReceipt: Equatable {
    let actionID: String
}

enum RemoteControlContract {
    static func decodePairingCredential(from data: Data) throws -> PairingCredential {
        let object = try RemoteControlJSON.object(from: data)
        try RemoteControlJSON.requireExactKeys(
            object,
            ["schemaVersion", "kind", "origin", "appToken"]
        )
        try RemoteControlJSON.requireSchemaVersion(object)
        guard try RemoteControlJSON.requiredString("kind", in: object) == "pairing" else {
            throw RemoteControlContractError.invalidKind
        }

        let origin = try RemoteControlOrigin.decode(try RemoteControlJSON.requiredString("origin", in: object))
        let appToken = try RemoteControlCredential.decode(
            try RemoteControlJSON.requiredString("appToken", in: object)
        )
        return PairingCredential(origin: origin, appToken: appToken)
    }

    static func decodeControlContext(from data: Data) throws -> ControlContext {
        let object = try RemoteControlJSON.object(from: data)
        try RemoteControlJSON.requireExactKeys(
            object,
            ["schemaVersion", "kind", "controlContextId", "expiresAt"]
        )
        try RemoteControlJSON.requireSchemaVersion(object)
        guard try RemoteControlJSON.requiredString("kind", in: object) == "controlContext" else {
            throw RemoteControlContractError.invalidKind
        }

        let controlContextID = try RemoteControlJSON.requiredString("controlContextId", in: object)
        let expiresAt = try RemoteControlDate.decode(
            try RemoteControlJSON.requiredString("expiresAt", in: object)
        )
        return try controlContext(controlContextID: controlContextID, expiresAt: expiresAt)
    }

    static func controlContext(controlContextID: String, expiresAt: Date) throws -> ControlContext {
        let validatedID = try RemoteControlCredential.decode(controlContextID)
        return ControlContext(controlContextID: validatedID, expiresAt: expiresAt)
    }

    static func makeStopAction(
        actionID: String,
        context: ControlContext,
        now: Date
    ) throws -> StopActionRequest {
        guard RemoteControlActionID.isValid(actionID) else {
            throw RemoteControlContractError.invalidActionID
        }
        guard now < context.expiresAt else {
            throw RemoteControlContractError.expiredContext
        }

        return StopActionRequest(
            actionID: actionID,
            controlContextID: context.controlContextID,
            issuedAt: now,
            expiresAt: min(now.addingTimeInterval(60), context.expiresAt)
        )
    }

    static func validateReceipt(
        _ data: Data,
        httpStatus: Int,
        for request: StopActionRequest
    ) throws -> ControlReceipt {
        guard httpStatus == 200 else {
            throw RemoteControlContractError.unexpectedHTTPStatus
        }

        let object = try RemoteControlJSON.object(from: data)
        try RemoteControlJSON.requireExactKeys(
            object,
            ["schemaVersion", "actionId", "action", "outcome", "reason"]
        )
        try RemoteControlJSON.requireSchemaVersion(object)

        let actionID = try RemoteControlJSON.requiredString("actionId", in: object)
        guard actionID == request.actionID else {
            throw RemoteControlContractError.receiptMismatch
        }
        guard try RemoteControlJSON.requiredString("action", in: object) == "stop",
              try RemoteControlJSON.requiredString("outcome", in: object) == "accepted",
              object["reason"] is NSNull else {
            throw RemoteControlContractError.rejectedReceipt
        }

        return ControlReceipt(actionID: actionID)
    }
}

private enum RemoteControlJSON {
    static func object(from data: Data) throws -> [String: Any] {
        do {
            try FlatJSONObjectValidator.validate(data)
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw RemoteControlContractError.malformedJSON
            }
            return object
        } catch let error as RemoteControlContractError {
            throw error
        } catch {
            throw RemoteControlContractError.malformedJSON
        }
    }

    static func encodedObject(_ object: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    static func requireExactKeys(_ object: [String: Any], _ expected: Set<String>) throws {
        guard Set(object.keys) == expected else {
            throw RemoteControlContractError.unexpectedKeys
        }
    }

    static func requireSchemaVersion(_ object: [String: Any]) throws {
        guard let value = object["schemaVersion"] as? NSNumber,
              CFGetTypeID(value) != CFBooleanGetTypeID(),
              value.intValue == 1,
              value.doubleValue == 1 else {
            throw RemoteControlContractError.invalidSchemaVersion
        }
    }

    static func requiredString(_ key: String, in object: [String: Any]) throws -> String {
        guard let value = object[key] as? String, !value.isEmpty else {
            throw RemoteControlContractError.invalidString
        }
        return value
    }
}

private enum RemoteControlOrigin {
    static func decode(_ value: String) throws -> URL {
        guard let components = URLComponents(string: value),
              components.scheme == "https",
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              components.percentEncodedPath.isEmpty || components.percentEncodedPath == "/",
              components.port == nil || components.port == 443,
              let host = components.host,
              host == host.lowercased(),
              isTailnetDNSName(host) else {
            throw RemoteControlContractError.invalidOrigin
        }

        guard let origin = URL(string: "https://\(host)") else {
            throw RemoteControlContractError.invalidOrigin
        }
        return origin
    }

    private static func isTailnetDNSName(_ host: String) -> Bool {
        guard host.utf8.count <= 253,
              host.hasSuffix(".ts.net"),
              host != "ts.net" else {
            return false
        }
        return host.split(separator: ".", omittingEmptySubsequences: false).allSatisfy { label in
            !label.isEmpty && label.count <= 63 &&
                label.first != "-" && label.last != "-" &&
                label.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
        }
    }
}

private enum RemoteControlCredential {
    static func decode(_ value: String) throws -> String {
        guard value.count == 43,
              value.unicodeScalars.allSatisfy({ scalar in
                  (scalar.value >= 65 && scalar.value <= 90) ||
                      (scalar.value >= 97 && scalar.value <= 122) ||
                      (scalar.value >= 48 && scalar.value <= 57) ||
                      scalar == "-" || scalar == "_"
              }),
              let bytes = Data(base64Encoded: value.replacingOccurrences(of: "-", with: "+")
                  .replacingOccurrences(of: "_", with: "/") + "="),
              bytes.count == 32,
              canonicalString(for: bytes) == value else {
            throw RemoteControlContractError.invalidCredential
        }
        return value
    }

    private static func canonicalString(for bytes: Data) -> String {
        bytes.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

private enum RemoteControlActionID {
    static func isValid(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= 64, let first = value.unicodeScalars.first,
              isASCIIAlphaNumeric(first) else {
            return false
        }
        return value.unicodeScalars.dropFirst().allSatisfy {
            isASCIIAlphaNumeric($0) || $0 == "_" || $0 == "-"
        }
    }

    private static func isASCIIAlphaNumeric(_ scalar: Unicode.Scalar) -> Bool {
        (scalar.value >= 65 && scalar.value <= 90) ||
            (scalar.value >= 97 && scalar.value <= 122) ||
            (scalar.value >= 48 && scalar.value <= 57)
    }
}

private enum FlatJSONObjectValidator {
    static func validate(_ data: Data) throws {
        var scanner = Scanner(bytes: Array(data))
        try scanner.skipWhitespace()
        try scanner.expect("{")
        try scanner.skipWhitespace()
        if scanner.consume("}") {
            try scanner.skipWhitespace()
            guard scanner.isAtEnd else { throw RemoteControlContractError.malformedJSON }
            return
        }

        var keys = Set<String>()
        while true {
            let key = try scanner.string()
            guard keys.insert(key).inserted else {
                throw RemoteControlContractError.malformedJSON
            }
            try scanner.skipWhitespace()
            try scanner.expect(":")
            try scanner.skipWhitespace()
            try scanner.flatValue()
            try scanner.skipWhitespace()

            if scanner.consume("}") {
                try scanner.skipWhitespace()
                guard scanner.isAtEnd else { throw RemoteControlContractError.malformedJSON }
                return
            }
            try scanner.expect(",")
            try scanner.skipWhitespace()
        }
    }

    private struct Scanner {
        let bytes: [UInt8]
        var index = 0

        var isAtEnd: Bool { index == bytes.count }

        mutating func skipWhitespace() throws {
            while index < bytes.count, bytes[index] == 0x20 || bytes[index] == 0x09 || bytes[index] == 0x0A || bytes[index] == 0x0D {
                index += 1
            }
        }

        mutating func expect(_ character: Character) throws {
            guard consume(character) else { throw RemoteControlContractError.malformedJSON }
        }

        mutating func consume(_ character: Character) -> Bool {
            guard let byte = character.asciiValue, index < bytes.count, bytes[index] == byte else {
                return false
            }
            index += 1
            return true
        }

        mutating func string() throws -> String {
            guard index < bytes.count, bytes[index] == 0x22 else {
                throw RemoteControlContractError.malformedJSON
            }
            let start = index
            index += 1
            while index < bytes.count {
                switch bytes[index] {
                case 0x22:
                    index += 1
                    let literal = Data(bytes[start..<index])
                    guard let value = try? JSONSerialization.jsonObject(with: literal, options: [.fragmentsAllowed]) as? String else {
                        throw RemoteControlContractError.malformedJSON
                    }
                    return value
                case 0x5C:
                    index += 1
                    guard index < bytes.count else { throw RemoteControlContractError.malformedJSON }
                    if bytes[index] == 0x75 {
                        guard index + 4 < bytes.count else { throw RemoteControlContractError.malformedJSON }
                        index += 5
                    } else {
                        index += 1
                    }
                default:
                    guard bytes[index] >= 0x20 else { throw RemoteControlContractError.malformedJSON }
                    index += 1
                }
            }
            throw RemoteControlContractError.malformedJSON
        }

        mutating func flatValue() throws {
            guard index < bytes.count else { throw RemoteControlContractError.malformedJSON }
            if bytes[index] == 0x22 {
                _ = try string()
                return
            }
            guard bytes[index] != 0x7B, bytes[index] != 0x5B else {
                throw RemoteControlContractError.malformedJSON
            }

            let start = index
            while index < bytes.count, bytes[index] != 0x2C, bytes[index] != 0x7D {
                guard bytes[index] != 0x7B, bytes[index] != 0x5B, bytes[index] != 0x5D else {
                    throw RemoteControlContractError.malformedJSON
                }
                index += 1
            }
            guard index > start else { throw RemoteControlContractError.malformedJSON }
        }
    }
}

private enum RemoteControlDate {
    static func decode(_ value: String) throws -> Date {
        let expression = #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"#
        guard value.range(of: expression, options: .regularExpression) != nil else {
            throw RemoteControlContractError.invalidDate
        }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) {
            return date
        }
        formatter.formatOptions = [.withInternetDateTime]
        guard let date = formatter.date(from: value) else {
            throw RemoteControlContractError.invalidDate
        }
        return date
    }

    static func string(from value: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: value)
    }
}
