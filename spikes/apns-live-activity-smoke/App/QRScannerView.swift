import SwiftUI
import VisionKit

struct QRScannerView: View {
    let onScan: (String) -> Void

    @State private var scannerFailedToStart = false

    var body: some View {
        Group {
            if DataScannerViewController.isSupported,
               DataScannerViewController.isAvailable,
               !scannerFailedToStart {
                QRScannerController(
                    onScan: onScan,
                    onUnavailable: { scannerFailedToStart = true }
                )
                .accessibilityLabel("QR code scanner")
            } else {
                ContentUnavailableView(
                    "QR Scanner Unavailable",
                    systemImage: "qrcode.viewfinder",
                    description: Text("This device cannot scan QR codes right now.")
                )
            }
        }
    }
}

private struct QRScannerController: UIViewControllerRepresentable {
    let onScan: (String) -> Void
    let onUnavailable: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onScan: onScan, onUnavailable: onUnavailable)
    }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: false,
            isGuidanceEnabled: true
        )
        scanner.delegate = context.coordinator
        DispatchQueue.main.async {
            context.coordinator.start(scanner)
        }
        return scanner
    }

    func updateUIViewController(_ uiViewController: DataScannerViewController, context: Context) {}

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        private let onScan: (String) -> Void
        private let onUnavailable: () -> Void
        private var didScan = false

        init(onScan: @escaping (String) -> Void, onUnavailable: @escaping () -> Void) {
            self.onScan = onScan
            self.onUnavailable = onUnavailable
        }

        func start(_ scanner: DataScannerViewController) {
            do {
                try scanner.startScanning()
            } catch {
                onUnavailable()
            }
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            guard !didScan,
                  let payload = addedItems.compactMap({ item -> String? in
                      guard case let .barcode(barcode) = item else { return nil }
                      return barcode.payloadStringValue
                  }).first else {
                return
            }

            didScan = true
            dataScanner.stopScanning()
            onScan(payload)
        }
    }
}
