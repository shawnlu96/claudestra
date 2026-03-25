import AppKit
import ScreenCaptureKit
import CoreGraphics
import ImageIO
import Foundation
import CoreImage
import CoreMedia

let outputPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/claude-orchestrator/screenshot.png"
let keyword = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "[tmux]"

// 需要 RunLoop 来让 ScreenCaptureKit 的回调工作
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

@available(macOS 14.0, *)
func run() {
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            
            var targetWindow: SCWindow? = nil
            for window in content.windows {
                guard let app = window.owningApplication else { continue }
                if app.applicationName.contains("iTerm") && (window.title?.contains(keyword) ?? false) {
                    targetWindow = window
                    break
                }
            }
            if targetWindow == nil {
                for window in content.windows {
                    guard let app = window.owningApplication else { continue }
                    if app.applicationName.contains("iTerm") && window.frame.height > 200 {
                        targetWindow = window
                        break
                    }
                }
            }
            
            guard let window = targetWindow else {
                print("ERROR: no iTerm2 window found")
                NSApplication.shared.terminate(nil)
                return
            }
            
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let config = SCStreamConfiguration()
            config.width = Int(window.frame.width) * 2
            config.height = Int(window.frame.height) * 2
            config.showsCursor = false

            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            
            let url = URL(fileURLWithPath: outputPath)
            guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
                print("ERROR: cannot create destination")
                NSApplication.shared.terminate(nil)
                return
            }
            CGImageDestinationAddImage(dest, image, nil)
            CGImageDestinationFinalize(dest)
            print("OK: \(image.width)x\(image.height)")
        } catch {
            print("ERROR: \(error)")
        }
        NSApplication.shared.terminate(nil)
    }
}

if #available(macOS 14.0, *) {
    DispatchQueue.main.async { run() }
    app.run()
} else {
    print("ERROR: macOS 14+ required")
}
