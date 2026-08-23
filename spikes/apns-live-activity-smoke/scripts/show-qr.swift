#!/usr/bin/swift

import AppKit
import CoreImage
import Darwin

private enum PresenterError: Error {
    case invalidInput
    case qrGenerationFailed
}

private func readPayload() throws -> Data {
    var inputStatus = stat()
    guard fstat(STDIN_FILENO, &inputStatus) == 0,
          inputStatus.st_mode & S_IFMT == S_IFIFO else {
        throw PresenterError.invalidInput
    }

    // Read only enough to validate the maximum permitted payload plus its newline.
    let maximumBufferedBytes = 1_026
    var payload = Data()
    while payload.count < maximumBufferedBytes {
        let remainingBytes = maximumBufferedBytes - payload.count
        guard let chunk = try FileHandle.standardInput.read(upToCount: remainingBytes),
              !chunk.isEmpty else {
            break
        }
        payload.append(chunk)
    }
    guard !payload.isEmpty else { throw PresenterError.invalidInput }

    if payload.last == 0x0A {
        payload.removeLast()
    }

    guard !payload.isEmpty, payload.count <= 1_024,
          String(data: payload, encoding: .utf8) != nil else {
        throw PresenterError.invalidInput
    }
    return payload
}

private func makeQRImage(payload: Data) throws -> NSImage {
    guard let filter = CIFilter(name: "CIQRCodeGenerator") else {
        throw PresenterError.qrGenerationFailed
    }
    filter.setValue(payload, forKey: "inputMessage")
    filter.setValue("Q", forKey: "inputCorrectionLevel")
    guard let output = filter.outputImage else {
        throw PresenterError.qrGenerationFailed
    }

    let scale = CGFloat(12)
    let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let context = CIContext(options: [.useSoftwareRenderer: false])
    guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else {
        throw PresenterError.qrGenerationFailed
    }
    return NSImage(cgImage: cgImage, size: scaled.extent.size)
}

private final class PresenterDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let image: NSImage
    private var window: NSWindow?

    init(image: NSImage) {
        self.image = image
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let contentSize = NSSize(width: 520, height: 590)
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: contentSize),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Codex Live Activity"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.backgroundColor = .white
        window.center()

        let container = NSView(frame: NSRect(origin: .zero, size: contentSize))
        let instruction = NSTextField(labelWithString: "Scan this owner-generated code with the iPhone app.")
        instruction.alignment = .center
        instruction.textColor = .black
        instruction.frame = NSRect(x: 20, y: 545, width: 480, height: 24)
        container.addSubview(instruction)

        let imageView = NSImageView(frame: NSRect(x: 20, y: 25, width: 480, height: 500))
        imageView.image = image
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.imageAlignment = .alignCenter
        imageView.wantsLayer = true
        imageView.layer?.magnificationFilter = .nearest
        imageView.layer?.minificationFilter = .nearest
        container.addSubview(imageView)

        window.contentView = container
        self.window = window
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        NSApp.terminate(nil)
    }
}

do {
    var payload = try readPayload()
    defer {
        payload.resetBytes(in: payload.startIndex ..< payload.endIndex)
    }
    let image = try makeQRImage(payload: payload)
    payload.resetBytes(in: payload.startIndex ..< payload.endIndex)
    let app = NSApplication.shared
    let delegate = PresenterDelegate(image: image)
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
} catch {
    FileHandle.standardError.write(Data("Unable to display code.\n".utf8))
    exit(1)
}
