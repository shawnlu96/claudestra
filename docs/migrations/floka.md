# Claudestra → Floka 迁移说明

这是改名的唯一迁移说明。机器可读的清单在 [`scripts/rename-floka/identifiers.json`](../../scripts/rename-floka/identifiers.json)，
清点脚本在 [`scripts/rename-floka/inventory.ts`](../../scripts/rename-floka/inventory.ts)。两处说法不一致时以清单为准，并回来改这里。

本卡（rename-floka-MAP1）只做清点和划边界：不改任何被扫文件，不接启动、合并、调度路径。

## 现状

- **新值是建议值。** 设计稿 `codex-last.md` 在写清单的机器上读不到，`new` 一列按固定规则推出：
  `Claudestra→Floka`、`claudestra` / `cstra`→`floka`、`CLAUDESTRA_→FLOKA_`、`com.claudestra.*→ai.floka.*`。PM 对设计稿核定后直接改清单。
- **负责卡是占位名。** `rename-floka-<区域>` 十二张卡都还没建，清单里写「待建」；建卡后把真实卡号填回 `card`。
- **两项要 owner 拍板**：iOS bundle id（`bundle.ios`，上架后不可改）、新仓库的归属与名字（`repo.slug`）。拍板前这两项不动。
- 基线 `772cda6e` 加上本卡四个文件，清点通过：4542 个文件，旧名出现 5944 处，其中 4927 处归到 75 个登记项（调用点 3354），
  1017 处在允许表里（548 处是本卡这四个文件自己），未登记 0。

## 开关

`rename.inventory` 取 `off` / `observe` / `on`，缺省 `observe`。本卡不切 `on`；切换由 PM 核过样本后另做。

| 值 | 行为 |
| --- | --- |
| `off` | 什么都不做，连目录都不看 |
| `observe` | 扫描并把报告写到标准输出；不写任何文件；退出码恒为 0，失败看报告里的 `ok` |
| `on` | 同上，另外把报告写到 `--out` 指定的那一个文件；报告失败时退出码 1 |

`on` 的输出必须显式给出、在被扫目录之外、不在状态 / 运行时目录里、目录已存在、文件尚不存在。三种模式都不修改被扫文件。

```bash
bun scripts/rename-floka/inventory.ts --root .                       # observe
bun scripts/rename-floka/inventory.ts --root . --mode on --out /tmp/floka-report.json
bun scripts/rename-floka/inventory.ts --root . --config ./some.json  # 读文件里的 rename.inventory
```

开关值只从 `--mode` 或显式给的 `--config` 文件读，不读 `~/.claude-orchestrator/config.json`：清点脚本不碰真实状态目录。
扫描根是状态目录、运行时目录或它们的上级时直接拒绝；落在状态目录里的只认带 `.git` 的检出（出借 worker 的工作副本）；软链一律不跟。

## 报告怎么读

- `failures`：清单自身不完整（缺类别、缺字段、缺允许类、缺「不改」项），或被扫目录里有没登记的旧名。同一种问题合并成一条，`count` 是次数。
- `identifiers[].textOccurrences` / `callSites`：**文本出现**是所有命中；**调用点**只算代码和配置文件里不在注释中的那些。
  文档、注释、对话记录里的只算文本出现。退出证据看的是调用点。
- `allowed`：按历史 / 协议 / 品牌三类分别计数并列出文件。
- `mechanical`：可以按清单机械替换的（文件，登记项，次数）。允许表里的命中和 `replace: manual` 的登记项永远不在这里。
- `warnings` 里的 `stale`：登记了但被扫目录里没出现，提示清单可能过期，不算失败。

「形状」是防兜底的：签名用途、环境变量、HTTP 头、浏览器持久化名、launchd / bundle id、URL scheme、MCP 工具前缀、外部安装路径各有一条形状规则，
命中形状的旧名必须由对应类别的登记项认领。新增一个 `claudestra-xxx-v1` 用途而没登记，不会被「小写裸词」这个兜底项吞掉，会报 `shape_unregistered`。

## 标识清单

每项在清单里登记七样：旧值、新值、定义入口、消费者、兼容方式、负责卡、退出证据。下表是摘要（出现 / 调用点为基线 `772cda6e` 上的数），
定义入口、消费者、完整兼容说明和退出证据看清单。

| 登记项 | 旧值 | 新值（建议） | 兼容方式 | 替换 | 出现 / 调用点 |
| --- | --- | --- | --- | --- | --- |
| `daemon.bridge` | com.claudestra.bridge | ai.floka.bridge | migrate-once | 手工 | 53 / 28 |
| `daemon.cron` | com.claudestra.cron | ai.floka.cron | migrate-once | 手工 | 9 / 7 |
| `daemon.scheduler` | com.claudestra.scheduler | ai.floka.scheduler | migrate-once | 手工 | 6 / 5 |
| `daemon.launcher` | com.claudestra.launcher | ai.floka.launcher | migrate-once | 手工 | 14 / 8 |
| `daemon.fixture-label` | com.claudestra.x（测试里的占位 label） | ai.floka.x | rename-only | 机械 | 2 / 2 |
| `daemon.deploy-label-prefix` | com.claudestra.scheduler.deploy. | ai.floka.scheduler.deploy. | rename-only | 手工 | 12 / 12 |
| `legacy.launchd-labels` | com.claudestra.{autostart,web,web-launcher,web-bridge,tls-proxy} | （不改名，只清理） | retire | 手工 | 31 / 5 |
| `legacy.autostart-wrapper` | claudestra-autostart | （不改名，只清理） | retire | 手工 | 4 / 1 |
| `state.root` | ~/.claude-orchestrator | ~/.floka | migrate-once | 手工 | 315 / 92 |
| `runtime.dir` | /tmp/claude-orchestrator | /tmp/floka | migrate-once | 手工 | 32 / 10 |
| `runtime.tmux-ready-option` | @claudestra_ready | @floka_ready | dual-read | 机械 | 29 / 19 |
| `runtime.sandbox-dirs` | /tmp/claudestra-sandbox-<port> | /tmp/floka-sandbox-<port> | rename-only | 机械 | 2 / 1 |
| `runtime.log-files` | /tmp/claudestra-<daemon>.{out,err}、/tmp/claudestra-lab-<port> | /tmp/floka-<同名> | migrate-once | 手工 | 13 / 5 |
| `state.config-autoupdate-key` | config.json 的 autoUpdate.claudestra | autoUpdate.floka | dual-read | 手工 | 10 / 8 |
| `env.paths` | CLAUDESTRA_<名> | FLOKA_<同名> | dual-read | 机械 | 597 / 528 |
| `env.sandbox-test` | CLAUDESTRA_<名> | FLOKA_<同名> | dual-read | 机械 | 272 / 249 |
| `env.runtime-acp` | CLAUDESTRA_<名> | FLOKA_<同名> | dual-read | 机械 | 204 / 171 |
| `env.scheduler-lend` | CLAUDESTRA_<名> | FLOKA_<同名> | dual-read | 机械 | 139 / 127 |
| `env.install` | CLAUDESTRA_<名> | FLOKA_<同名> | dual-read | 机械 | 42 / 32 |
| `env.desktop-web` | CLAUDESTRA_<名> | FLOKA_<同名> | dual-read | 机械 | 16 / 4 |
| `env.test-fixtures` | CLAUDESTRA_<名> | FLOKA_<同名> | dual-read | 机械 | 23 / 20 |
| `env.misc` | CLAUDESTRA_<名> | FLOKA_<同名> | dual-read | 机械 | 6 / 4 |
| `mcp.tool-prefix` | mcp__claudestra__（及插件形态 mcp__plugin_claudestra_claudestra__） | mcp__floka__（mcp__plugin_floka_floka__） | dual-register | 手工 | 90 / 69 |
| `mcp.server-name` | claudestra（MCP server 名 / channel 名） | floka | migrate-once | 手工 | 64 / 29 |
| `mcp.agent-names` | claudestra-{reviewer,adversarial-reviewer,dispatcher,executor,pm,codex-acp,pi-acp,acp-host} | floka-<同名> | dual-read | 手工 | 30 / 9 |
| `mcp.pi-extension` | claudestra-extension.ts / /claudestra-model / /claudestra-thinking | floka-extension.ts / /floka-model / /floka-thinking | alias | 手工 | 43 / 17 |
| `http.signature-headers` | x-claudestra-{signature,timestamp,key,sig,ts,event} | x-floka-<同名> | dual-write + dual-read | 手工 | 45 / 39 |
| `http.relay-headers` | x-claudestra-relay-* / x-claudestra-tunnel-mark | x-floka-relay-* / x-floka-tunnel-mark | dual-write + dual-read | 手工 | 57 / 42 |
| `sign.req` | claudestra-req-v1 | floka-req-v1 | dual-verify | 手工 | 9 / 4 |
| `sign.relay-auth` | claudestra-relay-auth-v2 | floka-relay-auth-v2 | dual-verify | 手工 | 7 / 3 |
| `sign.invite-pop` | claudestra-invite-pop-v1 | floka-invite-pop-v1 | dual-verify | 手工 | 8 / 7 |
| `sign.lend-receipt` | claudestra-lend-receipt-v1 | floka-lend-receipt-v1 | dual-verify | 手工 | 6 / 6 |
| `sign.shared-ledger` | claudestra-shared-ledger-v1 | floka-shared-ledger-v1 | dual-verify | 手工 | 22 / 22 |
| `sign.lend-review-ticket` | claudestra-lend-review-ticket-v1 | floka-lend-review-ticket-v1 | dual-verify | 手工 | 3 / 2 |
| `sign.talk-ack` | claudestra-talk-ack-v1 | floka-talk-ack-v1 | dual-verify | 手工 | 5 / 3 |
| `sign.quota-hmac` | claudestra-quota-hmac-v1 | floka-quota-hmac-v1 | rename-only | 手工 | 1 / 1 |
| `sign.fixture-purposes` | claudestra-req-v2（设计稿候选）、claudestra-other-v1 / cstra-other-v1 / cstra-redeem-v1（测试反例） | floka-<同名> | rename-only | 机械 | 4 / 3 |
| `wire.relay-subprotocol` | claudestra-relay.v2 | floka-relay.v2 | dual-accept | 手工 | 4 / 2 |
| `wire.e2e-labels` | cstra-e2e-v1 / cstra-peer-e2e-v1 / cstra-peer-redeem-v1 / cstra-peer-redeem-response-v1 | （冻结，不改） | frozen | 手工 | 12 / 6 |
| `wire.acp-extensions` | _claudestra/cancel、_meta.claudestra、claudestra:context、claudestra:bootstrap、claudestra-meta | _floka/cancel、_meta.floka、floka:context、floka:bootstrap、floka-meta | rename-only | 机械 | 71 / 33 |
| `wire.file-formats` | claudestra.cjson/v2、claudestra.review-evidence、refs/claudestra/peer-pr、claudestra-web-commit、claudestra-send-refused、claudestra-mcp-mount | floka.cjson/v2、floka.review-evidence、refs/floka/peer-pr、floka-web-commit、floka-send-refused、floka-mcp-mount | dual-read | 手工 | 19 / 8 |
| `wire.webhook-source` | source: "claudestra"（通知 webhook 正文） | source: "floka" | announce | 手工 | 9 / 9 |
| `invite.landing` | 邀请落地页 / 剪贴板识别里的品牌字样（「在我的 Claudestra 中打开」） | 「在我的 Floka 中打开」 | rename-only（文案）+ 字段不动 | 手工 | 5 / 3 |
| `invite.ios-url-name` | claudestra-invite（iOS CFBundleURLName） | floka-invite | rename-only | 机械 | 1 / 1 |
| `cookie.device` | cstra_dev | floka_dev | dual-read + 换发 | 手工 | 58 / 34 |
| `cookie.local-claim` | cstra_local_claim | floka_local_claim | rename-only | 机械 | 5 / 4 |
| `cookie.relay-home` | cstra_home | floka_home | dual-read | 手工 | 16 / 10 |
| `cookie.legacy-session` | cstra_session | （不改名，只清理） | retire | 手工 | 22 / 14 |
| `csrf.device-header` | x-cstra-device | x-floka-device | dual-read | 手工 | 42 / 25 |
| `browser.idb` | IndexedDB 库「cstra」/ 通知 tag「cstra」 | floka | migrate-once | 手工 | 7 / 5 |
| `browser.local-storage` | cstra_<键>（localStorage / sessionStorage） | floka_<同键> | migrate-once | 手工 | 148 / 131 |
| `browser.sw-messages` | service worker ↔ 页面消息：cstra-open-ask / cstra-open-agent / cstra-resume；缓存表 cstra-msgs | floka-<同名> | dual-accept | 手工 | 15 / 11 |
| `scheme.app` | claudestra:// | floka:// | dual-register | 手工 | 4 / 1 |
| `scheme.web` | web+claudestra | web+floka | dual-register | 手工 | 11 / 3 |
| `bundle.ios` | com.claudestra.app（iOS bundle id / APNs topic） | （owner 拍板：bundle id 上架后不可改） | owner-decision | 手工 | 9 / 8 |
| `bundle.desktop` | com.claudestra.desktop / claudestra-desktop / Claudestra.app / Claudestra_*.dmg / claudestra-notary / claudestra-setup.command | ai.floka.desktop / floka-desktop / Floka.app / Floka_*.dmg / floka-notary / floka-setup.command | migrate-once | 手工 | 13 / 4 |
| `bundle.native-package` | claudestra-native（native/package.json） | floka-native | rename-only | 机械 | 1 / 1 |
| `repo.slug` | shawnlu96/claudestra | （owner 拍板：新仓库归属与名字） | redirect | 手工 | 166 / 110 |
| `repo.package-names` | "name": "claudestra" / claudestra-web | floka / floka-web | rename-only + dual-read | 手工 | 5 / 4 |
| `repo.branded-filenames` | .claude/agents/claudestra.md、deploy/relay/claudestra-relay.* | .claude/agents/floka.md、deploy/relay/floka-relay.* | rename-only | 机械 | 22 / 10 |
| `external.cli-wrapper` | ~/.local/bin/claudestra（及 ~/.bun/bin/claudestra 软链） | ~/.local/bin/floka（及 ~/.bun/bin/floka） | alias | 手工 | 12 / 7 |
| `external.launch-agents` | ~/Library/LaunchAgents/com.claudestra.*.plist | ~/Library/LaunchAgents/ai.floka.*.plist | migrate-once | 手工 | 6 / 2 |
| `external.profile-backup` | <profile>.bak-claudestra | （不改名：已有备份原样保留） | frozen | 手工 | 5 / 4 |
| `external.relay-server` | /etc/systemd/system/claudestra-relay.service、/etc/nginx/sites-available/claudestra-relay.conf、/opt/claudestra | floka-relay.service / floka-relay.conf / /opt/floka | migrate-once | 手工 | 25 / 13 |
| `external.desktop-app` | /Applications/Claudestra.app | /Applications/Floka.app | migrate-once | 手工 | 3 / 0 |
| `external.vendor-closure` | vendor/claudestra（云端私仓里 pin 住的本仓闭包） | vendor/floka | pin-then-move | 手工 | 52 / 4 |
| `external.sidecar-files` | <claude 二进制>.claudestra-new、.claudestra-statusline.bak、.claudestra-lab | 同位置换 floka | dual-read | 手工 | 7 / 7 |
| `external.systemd-and-discord` | systemd 用户单元 claudestra-bridge(.service)、Discord 频道 #claudestra-control / 📊-claudestra-stats | floka-bridge / #floka-control / 📊-floka-stats | dual-read | 手工 | 7 / 5 |
| `cli.command` | claudestra（命令名） | floka | alias | 手工 | 136 / 63 |
| `brand.symbols` | 代码符号里的 Claudestra（installClaudestraCli、ClaudestraViewController、claudestraHome、__claudestraNav…） | 对应位置换成 Floka | rename-only | 机械 | 52 / 45 |
| `brand.short-internal` | cstra 短前缀的进程内 / 包内名字（CSS 类与变量、DOM 事件、data- 属性、window.__cstra*、临时目录前缀） | floka 前缀 | rename-only | 机械 | 352 / 316 |
| `brand.display` | Claudestra | Floka | rename-only + 注记 | 机械 | 618 / 317 |
| `brand.lowercase` | claudestra（未归入专项的小写裸词：路径段、示例、文案） | floka | manual | 手工 | 743 / 529 |
| `brand.env-prefix` | CLAUDESTRA（未归入 env.* 的大写字样：前缀说明、通配写法） | FLOKA | manual | 手工 | 7 / 4 |
| `brand.short-bare` | cstra（未归入专项的裸词） | floka | manual | 手工 | 12 / 7 |

兼容方式的含义：

- **rename-only**：没有跨版本、跨进程的消费者，一个提交里换完。
- **dual-read / dual-write / dual-verify / dual-accept / dual-register**：新旧并存一段时间。先让读方（验签方、收方）两个都认，全部升级后写方才切新，最后摘旧。
- **alias**：旧名留成指向新名的薄转发。
- **migrate-once**：一次性搬迁，带回滚办法；搬完之前旧的不删。
- **retire**：遗留物，只清理不改名；清理代码要一直认得旧名。
- **frozen**：不改。改了会让已有数据解不开或已有备份被覆盖。
- **owner-decision / redirect / announce / pin-then-move / manual**：见清单里该项的说明。

## 明确不改

| 值 | 为什么不改 |
| --- | --- |
| tok_ | API token id 前缀（src/lib/principals.ts）：无品牌，已发出的 token 靠它识别 |
| dev_ | 设备凭据前缀（src/lib/devices.ts）：无品牌，已配对设备靠它识别 |
| 邀请正文字段（name / url / token / join / iid / fp / keys）与 v:1、v:2 | 邀请是跨实例协议（src/lib/peers.ts）：字段名和版本号与品牌无关，改了新旧版本互不兑换 |
| relay://<指纹> | peer 地址 scheme（src/bridge/relay-link.ts）：无品牌，写在每个实例的 peers.json 里 |
| master.sock、registry.json、projects.json、peers.json、config.json、cron.json 等 | 无品牌文件名：只随状态根 / runtime 目录整体搬家，文件名不动 |
| BRIDGE_URL、BRIDGE_PORT、BRIDGE_STATIC_DIR、MCP_NAME、DISCORD_*、CODEX_HOME 等 | 无品牌环境变量：不属于 CLAUDESTRA_* 族，不改 |

另有三项带旧名但冻结：E2E 标签（`wire.e2e-labels`，密钥派生标签）、`<profile>.bak-claudestra`（`external.profile-backup`）、
以及只清理不改名的遗留项（`legacy.*`、`cookie.legacy-session`）。

## 三类允许表

允许表里的命中不算未登记，也永远不进机械替换名单。

| 类别 | 条目 | 说明 |
| --- | --- | --- |
| history | `history.transcripts` | 历史 transcript / 会话归档：记录当时发生了什么，旧名是事实，永不替换 |
| history | `history.records` | 退役代码、账本审查记录、已结任务文档、变更日志：历史文本 |
| history | `history.github-refs` | 指向旧仓库地址下既有 PR / issue / 提交的链接：GitHub 改名后自动跳转，不改写 |
| protocol | `protocol.identity-files` | 身份、peer URL / slug、agent 登记：各实例的数据，值由对端和历史决定 |
| protocol | `protocol.agent-and-peer-names` | agent 名、peer 句柄、中继 slug（含 slug 兜底值）：是身份而不是品牌字样，改了就是换了一个身份 |
| protocol | `protocol.checkout-and-project-id` | 不带点的 claude-orchestrator：检出目录名、项目 id、会话目录 slug——各机器 / 账本里的既有标识，不随品牌改 |
| brand | `brand.migration-tooling` | 迁移说明、清单、清点脚本自己：必须写旧名才能描述迁移 |
| brand | `brand.former-name` | 「原名 Claudestra」注记：有意保留的旧品牌 |
| brand | `brand.license` | 许可证里的版权署名按法律文本保留 |

- **历史**：记录当时发生了什么，旧名是事实。历史 transcript 里出现清单没有的字样也不追认。
- **协议**：身份、agent 名、peer URL / slug、项目 id。改了就是换了一个身份，不是换品牌。
- **品牌**：有意保留的旧品牌字样，包括本说明和清点工具自己。

## 迁移边界与顺序

1. **先读后写。** 所有 dual-* 项都分两个发布：第一个发布只加「也认新名」，第二个发布才切到写新名。两步不合在一个版本里。
2. **线上协议跟着最低版本走。** 签名用途、HTTP 头、中继子协议要等对端（peer、中继、旧前端、旧 service worker）都认新名之后才切；
   peer 侧的期限参照 `LEGACY_PEER_DEADLINE`。已落盘、已落账的旧签名按旧用途验，不重签。
3. **本机一次性搬迁放在同一次停机里。** 状态根、runtime 目录 / tmux socket、四个 daemon 的 label 和日志路径互相引用，停四个 daemon 后一起换，
   再全量 restart（含 master）。socket 路径一换，旧 tmux server 上的会话就连不上，切之前导出窗口清单。
4. **浏览器侧不能丢配对。** IndexedDB `cstra` 库里是配对凭据，新库没拷完不删旧库；cookie 认到旧名就顺手换发新名；
   CSRF 头的旧名留到旧 service worker 都被替换。
5. **文案和符号最后做。** 品牌显示名、代码符号、CSS 类这些机械替换放在兼容层都就位之后，免得把还要保留的旧名一起换掉。
6. **不做全文替换。** 只按报告的 `mechanical` 名单改；`brand.lowercase` 这类兜底项逐处看，发现新的专项含义先登记成独立条目。

## 在途占用

本卡只记录占用，不改这些文件。卡的当前状态和实际 fileGlobs 由 PM 核；下表只说明仓库里搜得到什么，搜得到不代表仍在途。

| 卡 | 范围 | 仓库里的痕迹 | 撞到的登记项 | 备注 |
| --- | --- | --- | --- | --- |
| T1 / T45 | 路径与测试隔离约束 | `src/lib/test-guard.ts`、`tests/test-env.ts`、`scripts/guard/rules/test-env.ts`、`tests/paths-guard.test.ts` | `state.root`、`runtime.dir`、`env.paths`、`env.sandbox-test` | 仓库里有痕迹 |
| hardening-CLI / hardening-CLIP / hardening-PLIST | CLI 与 plist 的安装范围 | `src/lib/cli-install.ts`、`src/lib/cli-wrapper.ts`、`src/lib/cli-path.ts`、`src/lib/daemon-plist.ts`、`tests/daemon-plist.test.ts` | `cli.command`、`external.cli-wrapper`、`external.launch-agents`、`daemon.bridge`、`daemon.cron`、`daemon.scheduler`、`daemon.launcher` | 仓库里有痕迹 |
| cloud-PP1 | 身份 / 签名范围 | `tests/cloud-protocol-core-boundary.test.ts`、`tests/cloud-protocol-core-compat.test.ts`、`src/lib/instance-signature.ts` | `sign.req`、`sign.invite-pop`、`http.signature-headers` | 仓库里有痕迹 |
| i28-RD12 / relay-direct-RD12 | relay 范围 | `src/lib/relay-protocol.ts`、`src/relay/**`、`src/bridge/relay-link.ts` | `sign.relay-auth`、`wire.relay-subprotocol`、`http.relay-headers`、`cookie.relay-home` | 仓库里搜不到 |
| team-project-N7C | 私仓闭包 pin | — | `repo.slug` | 仓库里搜不到 |

## 退出

每个登记项的退出证据写在清单的 `exitEvidence` 里。整体退出的判据：

- 清点报告 `ok: true`，且所有非冻结、非遗留登记项的调用点为 0（文本出现只剩允许表里的）。
- 旧名只留在三处：允许表、冻结项、仍在兼容期内的回落读取（每处都有摘除条件）。
- 兼容期满后回落读取摘掉，对应登记项从清单删除；届时本说明和清点工具一并归档。
