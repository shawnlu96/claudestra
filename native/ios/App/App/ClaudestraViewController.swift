import UIKit
import Capacitor

/// 自定义 bridge VC(Main.storyboard 的根 VC,也是 ServerConfig.relaunch() 重建的对象)。
/// 唯一职责:把运行时保存的服务器地址塞进 InstanceDescriptor,并注册 ServerConfig 插件。
class ClaudestraViewController: CAPBridgeViewController {
    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        // 未设置 → serverURL 为 nil,Capacitor 加载本地 www/index.html(首次设置页);
        // 已设置 → 等价于把它写进 capacitor.config 的 server.url。
        descriptor.serverURL = ServerConfig.url
        return descriptor
    }

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ServerConfigPlugin())
        // iOS 原生边缘右滑返回(PWA 里是系统给的,WKWebView 默认关着;owner 2026-09-03
        // 「壳里返回失效」)。web 端在壳内关掉自己的 JS 右滑返回,避免双重后退。
        webView?.allowsBackForwardNavigationGestures = true
    }
}
