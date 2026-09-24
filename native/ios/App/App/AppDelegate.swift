import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    // Claudestra:APNs 注册结果转给 Capacitor PushNotifications 插件(插件文档要求的两段样板)
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
        // Claudestra:开启 iOS 原生边缘右滑返回(PWA 里是系统给的,WKWebView 默认关着;
        // owner 2026-09-03「壳里返回失效」)。web 端在壳内关掉自己的 JS 右滑返回,避免双重后退。
        // webView 在 rootVC 的 viewDidLoad 后才存在,这里每次激活都设一遍(幂等)。
        (window?.rootViewController as? CAPBridgeViewController)?.webView?.allowsBackForwardNavigationGestures = true
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // claudestra://join#<邀请码>：别人发来的 peer 邀请（邀请落地页 src/bridge/invite-page.ts 的「在 Claudestra App 中打开」）
        // → 在本 App 已配置的服务器上打开 /join 确认页（web/app/join/page.tsx）。邀请码只放在 # 里，不上服务器。
        // 还没配置服务器（首次设置页）就不处理；其余链接照旧交给 Capacitor。
        if url.scheme == "claudestra", url.host == "join", let code = url.fragment, !code.isEmpty,
           let server = ServerConfig.url,
           let target = URL(string: server.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/join#" + code),
           let vc = window?.rootViewController as? CAPBridgeViewController {
            vc.webView?.load(URLRequest(url: target))
            return true
        }
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
