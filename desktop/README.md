# Claudestra 菜单栏小程序（实验）

macOS 菜单栏里的一个小图标，负责 bridge 之外的那一半：bridge 没装、没起来或挂了的时候，网页什么都做不了，这个小程序照样能用。

- **菜单**：三个后台服务（bridge / launcher / cron）的状态灯、打开本机网页、体检、安装向导、重启服务（二级菜单确认）、打开日志目录、退出（服务继续运行）。
- **窗口**：「状态 / 体检 / 安装」三页。安装页用图形界面检测依赖，真正的安装交给「终端」里的 `bun run setup`（向导要一问一答，逻辑不重写）；还没有仓库时改跑官方 `install.sh`。
- **不做**：聊天（继续用网页）、自动更新、Windows、开机自启。

定位是实验，只给团队内部用，不承诺产品化。

## 结构

```
desktop/
  ui/            窗口界面：纯 TS + CSS，lucide 图标内联，bun build 打到 dist/
  src-tauri/     Rust 外壳：托盘菜单、窗口、固定的几条命令（commands.rs）
../src/desktop-cli.ts        外壳调用的 JSON 入口：status / deps / doctor / restart
../src/lib/desktop-status.ts  状态判定（纯函数，tests/desktop-status.test.ts）
```

**逻辑不进 Rust。** 外壳只做两件事：
1. 在仓库里跑 `bun src/desktop-cli.ts <子命令>`，把 JSON 原样交给窗口或菜单；
2. 调 `open`，打开网页、日志目录，以及给「终端」生成的 `.command` 脚本。

哪些服务、怎样算健康、网页端口是多少，都和 `doctor` / `install-cli` 共用 TS 里的同一套口径。

**菜单栏的状态灯不轮询 doctor。** doctor 跑一次十几秒，状态灯只读 `launchctl list`，一次约 70 ms，每 8 秒刷一次。体检是按需的。

**重启有三道闸：**
1. 菜单和窗口里都要二次确认，确认文案会提醒「会打断正在推送的消息」；
2. 同一时间只允许一次重启；重启后状态灯灰 15 秒，显示「正在重启…」。kickstart 之后马上读到的是新 pid，看着健康，其实服务还没起来；
3. 自动更新正在进行时（`update.lock` 的持有进程还活着），desktop-cli 拒绝重启，否则会把更新砍在半路。

**仓库和 bun 的位置从 bridge 的 launchd plist 里读**（`WorkingDirectory`、`ProgramArguments[0]`、`EnvironmentVariables.PATH`），所以小程序看到的就是守护进程看到的。没装过的机器默认用 `~/repos/claudestra`（和 install.sh 一致），PATH 取登录 shell 的。

## 开发构建（未签名）

需要：Rust stable（`rustup`，minimal profile 即可）、Xcode Command Line Tools、bun。

```bash
cd desktop
bun install                 # 只装 @tauri-apps/cli
bun run typecheck           # 窗口 TS 的类型检查
bun run build               # 打 ui → cargo release → src-tauri/target/release/bundle/macos/Claudestra.app
```

开发时直接跑 debug 二进制，可以用两个环境变量改指向。两者都只给开发实测用，生产不设：

| 变量 | 作用 |
|---|---|
| `CLAUDESTRA_DESKTOP_REPO=<checkout>` | 用这个 checkout，而不是 launchd 正在跑的那份（例如 worktree） |
| `CLAUDESTRA_DESKTOP_LABELS=<label,…>` | 状态和重启只针对这些 launchd label；实测「重启」要用一次性的假 LaunchAgent，**不要拿线上三个服务试** |

```bash
bun run build:ui
cd src-tauri && cargo build
CLAUDESTRA_DESKTOP_REPO=$PWD/../.. CLAUDESTRA_DESKTOP_LABELS=com.example-test.dummy ./target/debug/claudestra-desktop
cargo test                                     # 纯函数
CLAUDESTRA_DESKTOP_REPO=… CLAUDESTRA_DESKTOP_LABELS=<假 label> cargo test -- --ignored   # 真跑一次 restart
```

未签名的包拷到别的 Mac 上，会被 Gatekeeper 拦下（提示「无法验证开发者」）。团队内部试用时，右键 →「打开」，或者跑 `xattr -dr com.apple.quarantine Claudestra.app`。

## 签名和公证（只能在 owner 的 MacBook 上做）

签名要用登录钥匙串里的 Developer ID 证书，而钥匙串只有本机的图形会话能解锁，所以 SSH 进去签不了。下面每一步都在 MacBook 本机的「终端」里跑。

团队 ID 这类个人配置不进仓库。写在 `desktop/.env.local` 里（已被 git 忽略），`source` 进当前终端：

```bash
# desktop/.env.local
export APPLE_TEAM_ID=XXXXXXXXXX                                          # 10 位团队 ID
export APPLE_SIGNING_IDENTITY="Developer ID Application: <名字> (XXXXXXXXXX)"
```

1. **Developer ID Application 证书**（只需要做一次）
   - 先查有没有：`security find-identity -v -p codesigning | grep "Developer ID Application"`；
   - 没有的话，由账号持有人在 Xcode → Settings → Accounts → Manage Certificates → ＋ → Developer ID Application 创建。iOS 壳用的是 Apple Development 证书，两者不是同一张。
2. **公证凭据**（只需要做一次），存进钥匙串：
   ```bash
   xcrun notarytool store-credentials claudestra-notary \
     --apple-id <Apple ID 邮箱> --team-id "$APPLE_TEAM_ID" --password <App 专用密码>
   ```
   App 专用密码在 appleid.apple.com → 登录与安全 → App 专用密码里生成。
3. **签名构建**：设了 `APPLE_SIGNING_IDENTITY`，Tauri 会用它加 hardened runtime 签名。
   ```bash
   source desktop/.env.local
   cd desktop && bun run build:ui && ./node_modules/.bin/tauri build --bundles app,dmg
   ```
   第一次签名，钥匙串会弹窗问 codesign 能不能用这把私钥，点「始终允许」。
4. **公证并装订**：
   ```bash
   cd src-tauri/target/release/bundle
   xcrun notarytool submit dmg/Claudestra_*.dmg --keychain-profile claudestra-notary --wait
   xcrun stapler staple dmg/Claudestra_*.dmg
   ```
5. **验证**：
   ```bash
   codesign -dv --verbose=4 macos/Claudestra.app 2>&1 | grep -E "Authority|TeamIdentifier|flags"
   spctl -a -vvv -t exec macos/Claudestra.app          # 应显示 accepted / Notarized Developer ID
   xcrun stapler validate dmg/Claudestra_*.dmg
   ```

还没做的：把证书放进 CI 的临时钥匙串，在 CI 里签名；Homebrew cask；app 自己的自动更新。这些属于设计稿里的阶段 2，要等这一期试用有了结论再说。
