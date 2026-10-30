import SwiftUI
import WebKit

@main
struct ForestRTApp: App {
    var body: some Scene {
        WindowGroup {
            BenchmarkView()
                .ignoresSafeArea()
                .statusBarHidden()
                .persistentSystemOverlays(.hidden)
                .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        }
    }
}

/// Hosts the WebGL2 ray-marching benchmark (bundled under `web/`) full screen.
struct BenchmarkView: UIViewRepresentable {
    func makeCoordinator() -> Bridge { Bridge() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let content = config.userContentController
        content.add(context.coordinator, name: "native")
        // Lets the page switch to touch controls before any of its scripts run.
        content.addUserScript(WKUserScript(
            source: "window.__FOREST_IOS__ = true;",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        if #available(iOS 16.4, *) { webView.isInspectable = true }

        if let index = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web") {
            webView.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
        }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    /// Receives `window.webkit.messageHandlers.native.postMessage(...)` from the page.
    final class Bridge: NSObject, WKScriptMessageHandler {
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            switch type {
            case "copy":
                UIPasteboard.general.string = body["text"] as? String
            case "shot":
                guard let dataURL = body["data"] as? String,
                      let comma = dataURL.firstIndex(of: ","),
                      let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...])),
                      let image = UIImage(data: data) else { return }
                UIImageWriteToSavedPhotosAlbum(image, nil, nil, nil)
            default:
                break
            }
        }
    }
}
