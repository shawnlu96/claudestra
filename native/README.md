# Claudestra iOS 壳(Capacitor)

WKWebView 直接加载自托管的 web 客户端(`capacitor.config.ts` 的 `server.url`),不打包前端;
壳只负责图标/启动图、状态栏与安全区、原生键盘、离线错误页。**没有推送**:WKWebView 无
Service Worker,Web Push 不可用;APNs 需要开发者账号里的推送凭证(账号非本人,未做)。

```bash
# 装依赖 / 同步插件到 iOS 工程 / 从 assets/ 铺图标启动图(源文件由 web/scripts/make-native-assets.mjs 生成)
npm install && npx cap sync ios && npm run assets
# 编译 Debug 包并无线装到已配对的 iPhone(需 Xcode;首次在本机终端跑,给 codesign 钥匙串授权「始终允许」)
bash scripts/build-ios.sh
```

签名:自动签名**离线**复用本机缓存的团队托管描述文件(通配 `TEAM.*`,付费账号一年有效),
不联网、不需要 Xcode 里的 Apple ID 会话;失败时回退为未签名构建 + 手工 codesign。
`TEAM_ID` / `PROFILE_FILE` / `DEVICE_ID` / `DEVELOPER_DIR` 可用环境变量覆盖。
Capacitor CLI 7.6.9 的 `--packagemanager SPM` 有大小写 bug 永远不生效,工程走 CocoaPods。
