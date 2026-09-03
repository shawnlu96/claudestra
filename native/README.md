# Claudestra iOS 壳(Capacitor)

WKWebView 直接加载自托管的 web 客户端,不打包前端;壳只负责图标/启动图、状态栏与安全区、
原生键盘、APNs 推送(WKWebView 无 Service Worker,Web Push 不可用)、离线错误页。

**服务器地址不编进包**:首次启动显示本地设置页(`www/index.html`),填入你自己部署的
Claudestra 地址后存在本机(UserDefaults),之后直接加载它;web 设置里可「更换服务器」。
实现:`ios/App/App/ServerConfig.swift`(`ServerConfig` 插件)+ `ClaudestraViewController.swift`
(运行时把地址塞进 Capacitor 的 serverURL)。同一份包可以分发给任何人连各自的服务器。

个人构建配置写在 `native/.env.local`(git 忽略):

```
TEAM_ID=XXXXXXXXXX   # Apple 开发者团队 ID,10 位;build-ios.sh 必填
```

```bash
# 装依赖 / 同步插件到 iOS 工程 / 从 assets/ 铺图标启动图(源文件由 web/scripts/make-native-assets.mjs 生成)
npm install && npx cap sync ios && npm run assets
# 编译 Debug 包并无线装到已配对的 iPhone(需 Xcode;首次在本机终端跑,给 codesign 钥匙串授权「始终允许」)
bash scripts/build-ios.sh
```

签名:自动签名**离线**复用本机缓存的团队托管描述文件(通配 `TEAM.*`,付费账号一年有效),
不联网、不需要 Xcode 里的 Apple ID 会话;失败时回退为未签名构建 + 手工 codesign。
`PROFILE_FILE` / `DEVICE_ID` / `DEVELOPER_DIR` 可用环境变量覆盖;`TEAM_ID` 必填(环境变量或 `.env.local`)。
Capacitor CLI 7.6.9 的 `--packagemanager SPM` 有大小写 bug 永远不生效,工程走 CocoaPods。
