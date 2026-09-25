import Foundation
import UIKit
import WebKit
import Capacitor

/// 服务器地址的运行时配置(owner 2026-09-04:「不希望把我的 Tailscale 地址写死在代码里,
/// 这个 App 还要拿出去给别人用」)。
///
/// 此前地址编译进 capacitor.config 的 server.url,一份包只能连一台服务器。现在:
///   - 地址存 UserDefaults;未设置 → Capacitor 加载本地 www/index.html(首次设置页)
///   - 设置后 → 重建整个 bridge/WKWebView,直接以远端为 server.url 加载(bridge 照常注入,
///     推送等插件在远端页面里可用,与原来编译进去的效果完全一致)
///   - 换服务器 = clear 后再重建,回到设置页
/// serverURL 只在 CAPBridgeViewController.instanceDescriptor() 里读一次,所以改完必须
/// 重建 VC,不能 reload。
enum ServerConfig {
    static let key = "cstra.serverURL"

    static var url: String? {
        get {
            guard let v = UserDefaults.standard.string(forKey: key), !v.isEmpty else { return nil }
            return v
        }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }

    /// 只认 http(s) 且带主机名;末尾斜杠去掉(Capacitor 会自己拼路径)。
    static func normalize(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var comps = URLComponents(string: trimmed),
              let scheme = comps.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = comps.host, !host.isEmpty else { return nil }
        comps.scheme = scheme
        if comps.path == "/" { comps.path = "" }
        comps.query = nil
        comps.fragment = nil
        return comps.string
    }

    /// 重建 bridge:换掉 window 的 rootViewController(新 VC 会重新走 instanceDescriptor)。
    static func relaunch() {
        DispatchQueue.main.async {
            guard let window = (UIApplication.shared.delegate as? AppDelegate)?.window else { return }
            let old = (window.rootViewController as? CAPBridgeViewController)?.webView
            let vc = ClaudestraViewController()
            window.rootViewController = vc
            window.makeKeyAndVisible()
            retire(old)
        }
    }

    /// 换掉的旧 WebView 不会随 VC 释放(实测回前台时几个页面同时重载),它在后台照样连流;
    /// WebContent 进程被系统回收后 Capacitor 会自动重载它,而它判站外用的还是旧地址 →
    /// 重载被当成站外导航、App 一激活就踢去 Chrome。摘掉代理(不再判站外 / 不再自动重载)并清空页面。
    private static func retire(_ webView: WKWebView?) {
        guard let webView else { return }
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.stopLoading()
        webView.configuration.userContentController.removeAllScriptMessageHandlers()
        webView.loadHTMLString("", baseURL: nil)
        webView.removeFromSuperview()
    }
}

/// JS 侧:window.Capacitor.Plugins.ServerConfig.{get,set,clear}
///   get()            → { url: string }   (空串 = 未设置)
///   set({ url })     → 存下并重建 bridge 加载它;非法地址 reject
///   clear()          → 清掉并重建 bridge 回到设置页
@objc(ServerConfigPlugin)
public class ServerConfigPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ServerConfigPlugin"
    public let jsName = "ServerConfig"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
    ]

    @objc func get(_ call: CAPPluginCall) {
        call.resolve(["url": ServerConfig.url ?? ""])
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = ServerConfig.normalize(raw) else {
            call.reject("invalid url: expected http(s)://host[:port]")
            return
        }
        ServerConfig.url = url
        call.resolve(["url": url])
        ServerConfig.relaunch()
    }

    @objc func clear(_ call: CAPPluginCall) {
        ServerConfig.url = nil
        call.resolve()
        ServerConfig.relaunch()
    }
}
