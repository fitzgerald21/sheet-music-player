import SwiftUI
import UniformTypeIdentifiers
import WebKit
#if os(iOS)
import CoreAudioKit
#endif

struct WebView {
    func makeCoordinator() -> WebController { WebController() }
}

#if os(iOS)
extension WebView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView { context.coordinator.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
#else
extension WebView: NSViewRepresentable {
    func makeNSView(context: Context) -> WKWebView { context.coordinator.webView }
    func updateNSView(_ view: WKWebView, context: Context) {}
}
#endif

/// Owns the web view and answers the messages the web app sends (see src/native.ts).
final class WebController: NSObject {
    let webView: WKWebView
    private let midi = MIDIBridge()

    override init() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(AppSchemeHandler(), forURLScheme: AppSchemeHandler.scheme)
        config.mediaTypesRequiringUserActionForPlayback = []
        #if os(iOS)
        config.allowsInlineMediaPlayback = true
        let platform = "ios"
        #else
        let platform = "mac"
        #endif
        config.userContentController.addUserScript(
            WKUserScript(source: "window.__smpPlatform = '\(platform)';", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()

        config.userContentController.add(self, name: "smp")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isInspectable = true
        #if os(iOS)
        // the page lays itself out around the notch and home indicator (env(safe-area-inset-…))
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        #endif

        midi.onMessage = { [weak self] status, d1, d2 in
            self?.webView.evaluateJavaScript("window.__smpNative?.midi?.(\(status), \(d1), \(d2))")
        }
        midi.onDevices = { [weak self] names in
            guard let json = try? JSONEncoder().encode(names), let list = String(data: json, encoding: .utf8) else { return }
            self?.webView.evaluateJavaScript("window.__smpNative?.devices?.(\(list))")
        }
        webView.load(URLRequest(url: AppSchemeHandler.home))
    }

    private func open(_ url: URL) {
        #if os(iOS)
        UIApplication.shared.open(url)
        #else
        NSWorkspace.shared.open(url)
        #endif
    }

    #if os(iOS)
    private var presenter: UIViewController? {
        var top = webView.window?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }
    #endif

    // MARK: - What the web app asks for

    private func save(name: String, data: Data) {
        #if os(iOS)
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        guard (try? data.write(to: file)) != nil else { return }
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = webView
        sheet.popoverPresentationController?.sourceRect = CGRect(x: webView.bounds.midX, y: webView.bounds.midY, width: 0, height: 0)
        sheet.popoverPresentationController?.permittedArrowDirections = []
        presenter?.present(sheet, animated: true)
        #else
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        guard let window = webView.window else { return }
        panel.beginSheetModal(for: window) { answer in
            if answer == .OK, let url = panel.url { try? data.write(to: url) }
        }
        #endif
    }

    private func printPage() {
        #if os(iOS)
        let printer = UIPrintInteractionController.shared
        printer.printFormatter = webView.viewPrintFormatter()
        printer.present(animated: true)
        #else
        guard let window = webView.window else { return }
        let operation = webView.printOperation(with: NSPrintInfo.shared)
        operation.view?.frame = webView.bounds
        operation.runModal(for: window, delegate: nil, didRun: nil, contextInfo: nil)
        #endif
    }

    private func showBluetoothMIDI() {
        #if os(iOS)
        presenter?.present(UINavigationController(rootViewController: BluetoothMIDIController()), animated: true)
        #endif
    }
}

extension WebController: WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "midi.connect":
            midi.start()
        case "midi.bluetooth":
            showBluetoothMIDI()
        case "awake":
            #if os(iOS)
            UIApplication.shared.isIdleTimerDisabled = body["on"] as? Bool ?? false
            #endif
        case "save":
            if let name = body["name"] as? String, let base64 = body["base64"] as? String, let data = Data(base64Encoded: base64) {
                save(name: (name as NSString).lastPathComponent, data: data)
            }
        case "print":
            printPage()
        default:
            break
        }
    }
}

extension WebController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, let scheme = url.scheme?.lowercased() else { return decisionHandler(.cancel) }
        // links to other sites (IMSLP, The Session…) open in the browser, not inside the app
        if ["http", "https", "mailto"].contains(scheme), action.targetFrame?.isMainFrame ?? true {
            open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }
}

extension WebController: WKUIDelegate {
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { open(url) }
        return nil
    }

    // the system still asks the person once; this only skips WebKit's second question
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }

    #if os(iOS)
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, otherwise: completionHandler)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert) { completionHandler(false) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
        present(alert) { completionHandler(nil) }
    }

    /// WebKit insists that the completion handler is called, even when nothing can be shown.
    private func present(_ alert: UIAlertController, otherwise: () -> Void) {
        if let presenter { presenter.present(alert, animated: true) } else { otherwise() }
    }
    #else
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        completionHandler(alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }

    // <input type="file">
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.begin { answer in completionHandler(answer == .OK ? panel.urls : nil) }
    }
    #endif
}

#if os(iOS)
/// The system's list of nearby Bluetooth MIDI keyboards.
private final class BluetoothMIDIController: CABTMIDICentralViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(done))
    }

    @objc private func done() { dismiss(animated: true) }
}
#endif
