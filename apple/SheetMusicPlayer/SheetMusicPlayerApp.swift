import SwiftUI
#if os(iOS)
import AVFAudio
#endif

/// The web app (the same one that is on GitHub Pages) in a web view, with the things Safari
/// does not offer added natively: MIDI keyboards, saving files, printing, keeping the screen awake.
@main
struct SheetMusicPlayerApp: App {
    #if os(macOS)
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    #endif

    init() {
        #if os(iOS)
        // play even when the ring/silent switch is set to silent
        try? AVAudioSession.sharedInstance().setCategory(.playback)
        #endif
    }

    var body: some Scene {
        #if os(macOS)
        Window("Sheet Music Player", id: "main") {
            WebView().frame(minWidth: 480, minHeight: 480)
        }
        .defaultSize(width: 1200, height: 860)
        #else
        WindowGroup {
            WebView().ignoresSafeArea()
        }
        #endif
    }
}

#if os(macOS)
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
#endif
