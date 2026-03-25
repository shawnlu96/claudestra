import AppKit
import ScreenCaptureKit
import CoreGraphics
import ImageIO
import Foundation

let outputPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/claude-orchestrator/screenshot.png"

let nsApp = NSApplication.shared
nsApp.setActivationPolicy(.accessory)

@available(macOS 14.0, *)
func run() {
    Task {
        do {
            // 隐藏其他所有应用，只留 iTerm2
            let workspace = NSWorkspace.shared
            for app in workspace.runningApplications {
                if app.isActive || (app.localizedName?.contains("iTerm") ?? false) { continue }
                if app.activationPolicy == .regular {
                    app.hide()
                }
            }
            
            // 激活 iTerm2
            for app in workspace.runningApplications {
                if app.localizedName?.contains("iTerm") ?? false {
                    app.unhide()
                    app.activate()
                    break
                }
            }
            
            try await Task.sleep(nanoseconds: 1_500_000_000)
            
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let display = content.displays.first else {
                print("ERROR: no display")
                exit(1)
            }
            
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            config.width = Int(display.width) * 2
            config.height = Int(display.height) * 2
            config.showsCursor = false
            config.captureResolution = .best
            
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            
            // 恢复隐藏的应用
            for app in workspace.runningApplications {
                if app.activationPolicy == .regular && app.isHidden {
                    app.unhide()
                }
            }
            
            let url = URL(fileURLWithPath: outputPath)
            guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
                print("ERROR: cannot create destination")
                exit(1)
            }
            CGImageDestinationAddImage(dest, image, nil)
            CGImageDestinationFinalize(dest)
            print("OK: \(image.width)x\(image.height)")
        } catch {
            print("ERROR: \(error)")
        }
        exit(0)
    }
}

if #available(macOS 14.0, *) {
    DispatchQueue.main.async { run() }
    nsApp.run()
} else {
    print("ERROR: macOS 14+ required")
}
