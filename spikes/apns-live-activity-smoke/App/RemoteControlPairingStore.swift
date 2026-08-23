import Foundation
import Security

enum RemoteControlPairingStoreError: Error, Equatable {
    case unavailable
    case notPaired
    case invalidStoredPairing
    case writeFailed
    case writeOutcomeUnknown
}

struct RemoteControlKeychainOperations: @unchecked Sendable {
    let add: @Sendable ([CFString: Any]) -> OSStatus
    let update: @Sendable ([CFString: Any], [CFString: Any]) -> OSStatus
    let copyData: @Sendable ([CFString: Any]) -> (OSStatus, Data?)
    let delete: @Sendable ([CFString: Any]) -> OSStatus

    static let live = RemoteControlKeychainOperations(
        add: { attributes in
            SecItemAdd(attributes as CFDictionary, nil)
        },
        update: { query, attributes in
            SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        },
        copyData: { query in
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            return (status, result as? Data)
        },
        delete: { query in
            SecItemDelete(query as CFDictionary)
        }
    )
}

struct RemoteControlPairingStore: Sendable {
    private static let service = "com.xtypo.CodexLiveActivitySmoke.remote-control"
    private static let account = "paired-installation-v1"

    private let operations: RemoteControlKeychainOperations

    init(operations: RemoteControlKeychainOperations = .live) {
        self.operations = operations
    }

    func save(pairingPayload: Data) async throws -> PairingCredential {
        let operations = operations
        return try await Task.detached(priority: .userInitiated) {
            let credential: PairingCredential
            do {
                credential = try RemoteControlContract.decodePairingCredential(from: pairingPayload)
            } catch {
                throw RemoteControlPairingStoreError.writeFailed
            }

            var attributes = Self.baseQuery()
            attributes[kSecValueData] = pairingPayload
            attributes[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly

            let status = operations.add(attributes)
            if status == errSecDuplicateItem {
                let updateStatus = operations.update(
                    Self.baseQuery(),
                    [
                        kSecValueData: pairingPayload,
                        kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
                    ]
                )
                guard updateStatus == errSecSuccess else {
                    throw RemoteControlPairingStoreError.writeFailed
                }
            } else if status != errSecSuccess {
                throw RemoteControlPairingStoreError.writeFailed
            }

            do {
                let stored = try Self.load(operations: operations)
                guard stored == credential else {
                    throw RemoteControlPairingStoreError.writeFailed
                }
                return stored
            } catch {
                let cleanupStatus = operations.delete(Self.baseQuery())
                guard cleanupStatus == errSecSuccess || cleanupStatus == errSecItemNotFound else {
                    throw RemoteControlPairingStoreError.writeOutcomeUnknown
                }
                throw RemoteControlPairingStoreError.writeFailed
            }
        }.value
    }

    func load() async throws -> PairingCredential {
        let operations = operations
        return try await Task.detached(priority: .userInitiated) {
            try Self.load(operations: operations)
        }.value
    }

    func remove() async throws {
        let operations = operations
        try await Task.detached(priority: .userInitiated) {
            let status = operations.delete(Self.baseQuery())
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw RemoteControlPairingStoreError.unavailable
            }
        }.value
    }

    private static func load(
        operations: RemoteControlKeychainOperations
    ) throws -> PairingCredential {
        var query = baseQuery()
        query[kSecReturnData] = kCFBooleanTrue
        query[kSecMatchLimit] = kSecMatchLimitOne
        let (status, data) = operations.copyData(query)
        if status == errSecItemNotFound {
            throw RemoteControlPairingStoreError.notPaired
        }
        guard status == errSecSuccess, let data else {
            throw RemoteControlPairingStoreError.unavailable
        }
        do {
            return try RemoteControlContract.decodePairingCredential(from: data)
        } catch {
            throw RemoteControlPairingStoreError.invalidStoredPairing
        }
    }

    private static func baseQuery() -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecAttrSynchronizable: kCFBooleanFalse as Any
        ]
    }
}
