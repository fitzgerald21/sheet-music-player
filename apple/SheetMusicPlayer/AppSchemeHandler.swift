import Foundation
import UniformTypeIdentifiers
import WebKit

/// Serves the built web app (the `web` folder in the bundle) at smp://localhost/, so that modules,
/// workers and fetch() behave as they do on a web server.
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "smp"
    static let home = URL(string: "smp://localhost/")!

    private let root = Bundle.main.resourceURL!.appendingPathComponent("web").standardizedFileURL

    private static let types: [String: String] = [
        "html": "text/html; charset=utf-8",
        "js": "text/javascript; charset=utf-8",
        "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "json": "application/json",
        "webmanifest": "application/manifest+json",
        "svg": "image/svg+xml",
        "wasm": "application/wasm",
        "mp3": "audio/mpeg",
        "txt": "text/plain; charset=utf-8",
    ]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        let path = url.path.isEmpty || url.path == "/" ? "/index.html" : url.path
        let file = root.appendingPathComponent(path).standardizedFileURL
        // the app has no server: /api/… and anything else that is not a file is simply not there
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file, options: .mappedIfSafe) else {
            respond(task, url: url, status: 404, type: "text/plain; charset=utf-8", data: Data("Not found".utf8))
            return
        }
        let ext = file.pathExtension.lowercased()
        let type = Self.types[ext] ?? UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        respond(task, url: url, status: 200, type: type, data: data)
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func respond(_ task: WKURLSchemeTask, url: URL, status: Int, type: String, data: Data) {
        let headers = ["Content-Type": type, "Content-Length": String(data.count), "Cache-Control": "no-cache"]
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else { return }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }
}
