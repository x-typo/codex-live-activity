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

    func testConcurrentSavesSerializeAcrossStoreInstances() async throws {
        let firstPayload = pairingPayload()
        let secondPayload = pairingPayload(origin: "https://other.example.ts.net")
        let firstCopyGate = FirstCopyGate()
        let secondWriteProbe = WriteAttemptProbe(expected: secondPayload)
        let keychain = FakeKeychain(
            beforeCopyData: { firstCopyGate.beforeCopy() },
            onWriteAttempt: { data in secondWriteProbe.observe(data) }
        )
        let firstStore = RemoteControlPairingStore(operations: keychain.operations)
        let secondStore = RemoteControlPairingStore(operations: keychain.operations)

        let firstSave = Task {
            try await firstStore.save(pairingPayload: firstPayload)
        }
        XCTAssertEqual(
            firstCopyGate.started.wait(timeout: .now() + 2),
            .success
        )

        let secondSaveStarted = DispatchSemaphore(value: 0)
        let secondSave = Task {
            secondSaveStarted.signal()
            return try await secondStore.save(pairingPayload: secondPayload)
        }
        XCTAssertEqual(secondSaveStarted.wait(timeout: .now() + 2), .success)
        XCTAssertEqual(
            secondWriteProbe.observed.wait(timeout: .now() + 1),
            .timedOut
        )

        firstCopyGate.release.signal()
        let firstCredential = try await firstSave.value
        XCTAssertEqual(
            secondWriteProbe.observed.wait(timeout: .now() + 2),
            .success
        )
        let secondCredential = try await secondSave.value

        XCTAssertEqual(firstCredential.origin.absoluteString, "https://relay.example.ts.net")
        XCTAssertEqual(secondCredential.origin.absoluteString, "https://other.example.ts.net")
        let loaded = try await firstStore.load()
        XCTAssertEqual(loaded, secondCredential)
        XCTAssertEqual(keychain.deleteCount, 0)
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

private final class FirstCopyGate: @unchecked Sendable {
    let started = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)

    private let lock = NSLock()
    private var isFirstCopy = true

    func beforeCopy() {
        let shouldBlock = lock.withLock {
            guard isFirstCopy else { return false }
            isFirstCopy = false
            return true
        }
        if shouldBlock {
            started.signal()
            _ = release.wait(timeout: .now() + 5)
        }
    }
}

private final class WriteAttemptProbe: @unchecked Sendable {
    let observed = DispatchSemaphore(value: 0)

    private let expected: Data

    init(expected: Data) {
        self.expected = expected
    }

    func observe(_ data: Data) {
        if data == expected {
            observed.signal()
        }
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
    private let beforeCopyData: (@Sendable () -> Void)?
    private let onWriteAttempt: (@Sendable (Data) -> Void)?

    init(
        storedData: Data? = nil,
        copyStatus: OSStatus? = nil,
        deleteStatus: OSStatus? = nil,
        beforeCopyData: (@Sendable () -> Void)? = nil,
        onWriteAttempt: (@Sendable (Data) -> Void)? = nil
    ) {
        item = storedData
        self.copyStatus = copyStatus
        self.deleteStatus = deleteStatus
        self.beforeCopyData = beforeCopyData
        self.onWriteAttempt = onWriteAttempt
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
            guard let data = attributes[kSecValueData] as? Data else { return errSecParam }
            self.onWriteAttempt?(data)
            return self.lock.withLock {
                self.addCountValue += 1
                self.lastAccessibilityValue = attributes[kSecAttrAccessible] as? String
                guard self.item == nil else { return errSecDuplicateItem }
                self.item = data
                return errSecSuccess
            }
        },
        update: { [weak self] _, attributes in
            guard let self else { return errSecNotAvailable }
            guard let data = attributes[kSecValueData] as? Data else { return errSecParam }
            self.onWriteAttempt?(data)
            return self.lock.withLock {
                self.updateCountValue += 1
                self.lastAccessibilityValue = attributes[kSecAttrAccessible] as? String
                guard self.item != nil else {
                    return errSecItemNotFound
                }
                self.item = data
                return errSecSuccess
            }
        },
        copyData: { [weak self] _ in
            guard let self else { return (errSecNotAvailable, nil) }
            self.beforeCopyData?()
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
