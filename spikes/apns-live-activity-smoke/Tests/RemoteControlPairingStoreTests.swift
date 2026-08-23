import Foundation
import Security
import XCTest
@testable import CodexLiveActivitySmoke

final class RemoteControlPairingStoreTests: XCTestCase {
    private let token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

    func testSaveUsesUnlockedThisDeviceOnlyAndReadsBackExactPairing() async throws {
        let keychain = FakeKeychain()
        let store = RemoteControlPairingStore(operations: keychain.operations)
        let payload = pairingPayload()

        let credential = try await store.save(pairingPayload: payload)

        XCTAssertEqual(credential.origin.absoluteString, "https://relay.example.ts.net")
        XCTAssertEqual(credential.appToken, token)
        XCTAssertEqual(keychain.storedData, payload)
        XCTAssertEqual(
            keychain.lastAccessibility,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String
        )
        XCTAssertEqual(keychain.addCount, 1)
        XCTAssertEqual(keychain.updateCount, 0)
    }

    func testDuplicateSaveUpdatesThenReadsBack() async throws {
        let keychain = FakeKeychain(storedData: pairingPayload())
        let store = RemoteControlPairingStore(operations: keychain.operations)

        _ = try await store.save(pairingPayload: pairingPayload(origin: "https://other.example.ts.net"))

        XCTAssertEqual(keychain.addCount, 1)
        XCTAssertEqual(keychain.updateCount, 1)
        let loaded = try await store.load()
        XCTAssertEqual(loaded.origin.absoluteString, "https://other.example.ts.net")
    }

    func testInvalidPayloadDoesNotTouchKeychain() async {
        let keychain = FakeKeychain()
        let store = RemoteControlPairingStore(operations: keychain.operations)

        do {
            _ = try await store.save(pairingPayload: Data("{}".utf8))
            XCTFail("Expected invalid pairing to fail")
        } catch {
            XCTAssertEqual(error as? RemoteControlPairingStoreError, .writeFailed)
        }

        XCTAssertEqual(keychain.addCount, 0)
        XCTAssertEqual(keychain.updateCount, 0)
        XCTAssertNil(keychain.storedData)
    }

    func testMissingAndMalformedStoredPairingFailClosed() async {
        let emptyKeychain = FakeKeychain()
        let emptyStore = RemoteControlPairingStore(operations: emptyKeychain.operations)
        do {
            _ = try await emptyStore.load()
            XCTFail("Expected missing pairing to fail")
        } catch {
            XCTAssertEqual(error as? RemoteControlPairingStoreError, .notPaired)
        }

        let malformedKeychain = FakeKeychain(storedData: Data("{}".utf8))
        let malformedStore = RemoteControlPairingStore(operations: malformedKeychain.operations)
        do {
            _ = try await malformedStore.load()
            XCTFail("Expected malformed pairing to fail")
        } catch {
            XCTAssertEqual(error as? RemoteControlPairingStoreError, .invalidStoredPairing)
        }
    }

    func testRemoveIsIdempotent() async throws {
        let keychain = FakeKeychain(storedData: pairingPayload())
        let store = RemoteControlPairingStore(operations: keychain.operations)

        try await store.remove()
        try await store.remove()

        XCTAssertNil(keychain.storedData)
        XCTAssertEqual(keychain.deleteCount, 2)
    }

    func testReadbackFailureAfterAddDeletesCredential() async {
        let keychain = FakeKeychain(copyStatus: errSecInteractionNotAllowed)
        let store = RemoteControlPairingStore(operations: keychain.operations)

        await XCTAssertThrowsPairingStoreError(.writeFailed) {
            _ = try await store.save(pairingPayload: self.pairingPayload())
        }

        XCTAssertNil(keychain.storedData)
        XCTAssertEqual(keychain.addCount, 1)
        XCTAssertEqual(keychain.deleteCount, 1)
    }

    func testReadbackFailureAfterUpdateDeletesCredential() async {
        let keychain = FakeKeychain(
            storedData: pairingPayload(),
            copyStatus: errSecInteractionNotAllowed
        )
        let store = RemoteControlPairingStore(operations: keychain.operations)

        await XCTAssertThrowsPairingStoreError(.writeFailed) {
            _ = try await store.save(
                pairingPayload: self.pairingPayload(origin: "https://other.example.ts.net")
            )
        }

        XCTAssertNil(keychain.storedData)
        XCTAssertEqual(keychain.updateCount, 1)
        XCTAssertEqual(keychain.deleteCount, 1)
    }

    func testFailedCleanupReportsUnknownPersistedState() async {
        let keychain = FakeKeychain(
            copyStatus: errSecInteractionNotAllowed,
            deleteStatus: errSecInteractionNotAllowed
        )
        let store = RemoteControlPairingStore(operations: keychain.operations)

        await XCTAssertThrowsPairingStoreError(.writeOutcomeUnknown) {
            _ = try await store.save(pairingPayload: self.pairingPayload())
        }

        XCTAssertNotNil(keychain.storedData)
        XCTAssertEqual(keychain.deleteCount, 1)
    }

    private func pairingPayload(
        origin: String = "https://relay.example.ts.net"
    ) -> Data {
        try! JSONSerialization.data(withJSONObject: [
            "schemaVersion": 1,
            "kind": "pairing",
            "origin": origin,
            "appToken": token
        ], options: [.sortedKeys])
    }
}

private func XCTAssertThrowsPairingStoreError(
    _ expected: RemoteControlPairingStoreError,
    operation: () async throws -> Void,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        try await operation()
        XCTFail("Expected pairing-store error", file: file, line: line)
    } catch {
        XCTAssertEqual(error as? RemoteControlPairingStoreError, expected, file: file, line: line)
    }
}

private final class FakeKeychain: @unchecked Sendable {
    private let lock = NSLock()
    private var item: Data?
    private var addCountValue = 0
    private var updateCountValue = 0
    private var deleteCountValue = 0
    private var lastAccessibilityValue: String?
    private let copyStatus: OSStatus?
    private let deleteStatus: OSStatus?

    init(
        storedData: Data? = nil,
        copyStatus: OSStatus? = nil,
        deleteStatus: OSStatus? = nil
    ) {
        item = storedData
        self.copyStatus = copyStatus
        self.deleteStatus = deleteStatus
    }

    var storedData: Data? {
        lock.withLock { item }
    }

    var addCount: Int {
        lock.withLock { addCountValue }
    }

    var updateCount: Int {
        lock.withLock { updateCountValue }
    }

    var deleteCount: Int {
        lock.withLock { deleteCountValue }
    }

    var lastAccessibility: String? {
        lock.withLock { lastAccessibilityValue }
    }

    lazy var operations = RemoteControlKeychainOperations(
        add: { [weak self] attributes in
            guard let self else { return errSecNotAvailable }
            return self.lock.withLock {
                self.addCountValue += 1
                self.lastAccessibilityValue = attributes[kSecAttrAccessible] as? String
                guard self.item == nil else { return errSecDuplicateItem }
                guard let data = attributes[kSecValueData] as? Data else { return errSecParam }
                self.item = data
                return errSecSuccess
            }
        },
        update: { [weak self] _, attributes in
            guard let self else { return errSecNotAvailable }
            return self.lock.withLock {
                self.updateCountValue += 1
                self.lastAccessibilityValue = attributes[kSecAttrAccessible] as? String
                guard self.item != nil,
                      let data = attributes[kSecValueData] as? Data else {
                    return errSecItemNotFound
                }
                self.item = data
                return errSecSuccess
            }
        },
        copyData: { [weak self] _ in
            guard let self else { return (errSecNotAvailable, nil) }
            return self.lock.withLock {
                if let copyStatus = self.copyStatus {
                    return (copyStatus, nil)
                }
                guard let item = self.item else { return (errSecItemNotFound, nil) }
                return (errSecSuccess, item)
            }
        },
        delete: { [weak self] _ in
            guard let self else { return errSecNotAvailable }
            return self.lock.withLock {
                self.deleteCountValue += 1
                if let deleteStatus = self.deleteStatus {
                    return deleteStatus
                }
                guard self.item != nil else { return errSecItemNotFound }
                self.item = nil
                return errSecSuccess
            }
        }
    )
}
