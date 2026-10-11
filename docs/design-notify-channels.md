# 通知渠道（ntfy / Bark / Webhook / Gotify）设计稿

状态：首批已实现（2026-10-11，见下「owner 拍板」）。目标：把「待你处理」等重要通知，除了现有的 Web Push / App 推送，再推到用户自己配置的渠道；
在「设置 · 连接与集成」加「通知」版块配置渠道和每个渠道收哪些通知；预研「在通知里直接回复」。

## owner 拍板（2026-10-11）

- 首批渠道：**ntfy、Bark、Webhook**；Gotify 不做。
- 首批类型：**待你处理、安全提醒、系统提醒、Talk @ 你**；「agent 回复了你」不做。
- **只推送，不做在通知里回复**（owner 原话：「本次就不做回复了，直接把信息推送给渠道，然后让用户自己回系统处理。我们主要做推送功能。」）。
  第 5 节的预研保留作以后的参考，不在本期范围。

实现位置：`src/lib/notify-channels.ts`（配置 / 视图 / 请求格式）、`src/lib/notify-store.ts`（0600 配置文件）、
`src/bridge/notify/sink.ts`（派发器的第三个出口）、`src/bridge/local-api/notify.ts`（API）、
`web/features/chat/components/settings/notify-section.tsx` + `notify-channel-form.tsx`（设置页）。
实测：ntfy.sh 随机 topic 发后拉回（中文标题、优先级 4、click 链接都在）；Bark 官方服务器认得请求形状（假 key 回「device token 不存在」）；
本机 webhook 收件验签通过。Bark 端到端加密、iOS 上 ntfy 动作按钮都没做 / 没测（只推送不需要）。

### 出站防线与已知局限（Codex 对抗审查 r1 后，2026-10-11）

- 发送不跟随重定向（3xx 算失败）；目的地址解析到本机（127.0.0.0/8、::1、0.0.0.0、::）不发——bridge 控制面对回环来源免鉴权，
  通知请求打到本机等于借 bridge 的身份调控制面。局域网地址照发（自建 ntfy / bark-server 常在局域网；局域网来源要控制令牌）。
- 出错回包最多读 4 KB；失败原因先脱敏（地址 → 主机名、密钥 → 尾四位）后截断。沙箱（含 lab）不建外部渠道，测试接口回 409。
- **已知局限**：解析与连接之间对方 DNS 换成 127.0.0.1（DNS rebinding）拦不住——要拦得把连接钉到解析出的 IP，
  而 fetch 没有这个口子；风险前提是用户自己填了一个由攻击者控制域名的地址。
- 服务器原样回显的是密钥的一部分（而不是整段）时脱敏不到；目前已知的 ntfy / Bark 回包都是整段回显。

## 1. 现状：已有一条推送管线，新渠道是它的第三个出口

- `src/bridge/push/dispatcher.ts` 订阅进程内事件，已经有三路输入：
  - **agent 回复 owner**（网页对话，计未读）；
  - **待你处理**（`onAsk`：开出 / 过期 / 再提醒，规则表 `src/lib/ask-push.ts`：卡活才推、验收不推、owner 正在用只弹横幅、急件一定推，每条每个状态最多推一次）；
  - **系统提醒**（`notice` / `pushOwnerNotice`：新设备配对、本机浏览器请求配对、状态文件消失、Talk @ 你、订阅额度快过期）。
- 现有出口两个：Web Push（经中继或直发）、APNs（原生壳）。全局开关「推送不带正文」（`pushNoContent`）。
- 新渠道 = 第三个出口，复用同一套「推不推」的判定和文案（`askPushMessage`、`notificationBody`），不另起一套规则。

## 2. 四个渠道对比（官方文档核对，2026-10）

| | ntfy | Bark | Webhook | Gotify |
|---|---|---|---|---|
| 平台 | Android / iOS / 网页 | 仅 iOS | 任意（接收方自己处理） | Android / 网页（无官方 iOS） |
| 服务端 | ntfy.sh 或自建 | api.day.app 或自建 bark-server | 用户自己的 URL | 必须自建 |
| 发送方式 | POST `<server>/<topic>`，头 Title / Priority / Tags / Click / Actions，Bearer token | POST JSON `<server>/push`（device_key）| POST JSON，HMAC 签名头 | POST `/message?token=`，JSON + extras |
| 正文加密 | 无（topic 名即口令，公共服务器能看到内容） | **有**：AES-128-CBC，`ciphertext` + `iv`，Bark 服务器和 APNs 都看不到明文 | 走 HTTPS，内容到用户自己的服务 | 无（自建服务器） |
| 点通知打开链接 | `Click` | `url` | 接收方决定 | `client::notification.click.url` |
| 动作按钮 | **最多 3 个**：view（开链接）/ http（直接发 HTTP 请求）/ copy / broadcast（仅 Android）。iOS 上 http 按钮能不能用文档没写明，要真机验证 | 无（只有点开打开 url） | 接收方渲染（飞书 / Slack / Telegram 卡片按钮） | 无 |
| 撤回 / 更新已发通知 | 无 | **有**：同 `id` 替换，`delete=1` 删除（ask 在别处答了就能撤掉通知） | 发「已处理」事件 | 无 |
| 强提醒 | Priority 5 | `level=timeSensitive / critical`（静音也响） | — | priority |

**首批推荐：ntfy + Bark + Webhook，Gotify 放第二批。**
- ntfy：跨平台、可自建、唯一自带「点按钮直接发 HTTP」的，是「通知里直接回复」最顺的落点。
- Bark：iOS 用户最常用，能端到端加密（内容不经第三方明文）、能撤回已处理的通知、能设「时效性」穿透专注模式。
- Webhook：通用口子，用户自己接飞书 / 钉钉 / Slack / Home Assistant / n8n；载荷里带动作链接，接收方能做按钮。
- Gotify：只有 Android，没有动作按钮，必须自建；能力是 ntfy 的子集。发送本身很简单（一个 POST），等有人要再加，成本小。

## 3. 通知类型

| 类型 | 来源（已有钩子） | 默认 | 说明 |
|---|---|---|---|
| **待你处理** | `dispatcher.onAsk` | 开 | 首批实现。沿用规则表：owner 在用时只弹横幅不推；渠道可另选「始终推」 |
| 安全提醒 | `pushOwnerNotice`：新设备配对、浏览器请求配对 | 开 | 有人配对你的电脑，应当第一时间知道 |
| 守门拦下（Chat Guard） | `chat-guard` 的 quarantined 事件 | 开 | #1141 合并后可接；等你放行的消息 |
| 系统提醒 | 状态文件消失、订阅额度快过期 | 开 | 低频、重要 |
| Talk @ 你 | `talk-msgs.ts` | 关 | |
| agent 回复了你 | dispatcher 的 chat_message | 关 | 量大，适合只在离开时推 |
| 第二批候选（要新加钩子） | agent 卡死 / 崩溃、定时任务失败、自动更新失败、bridge 重启 | — | 需要在各 watcher 里补事件 |

每个渠道独立勾选类型；另有两个开关：「只在我离开时推」（沿用 owner-presence）、「不带正文」（只推标题，渠道级，覆盖全局）。

## 4. 架构

- 新模块 `src/bridge/notify/`：
  - `channels.ts`：每种渠道一个 `send(cfg, msg)`，把统一的 `NotifyMessage {type, title, body, url, tag, ask?: {id, options}}` 翻成各家格式；纯函数可单测；
  - `sink.ts`：挂到 dispatcher 的三路输入上（和 Web Push / APNs 并列），按渠道的类型勾选、离开判定、频控过滤后发；每条 10 s 超时、失败重试 1 次、不阻塞其它出口；
  - 记每个渠道最近 20 次结果（时间、类型、成功 / 状态码），给设置页看。
- 配置存 `config.json` 的 `notifyChannels[]`：`{id, kind, name, enabled, types[], onlyWhenAway, hideContent, settings}`。
  - 密钥（ntfy token、Bark device_key 与加密 key、Webhook secret、Gotify app token）只进 bridge；GET 只回尾四位；文件权限 0600。
- API（只给全权设备，同「连接与集成」整页）：`GET/PUT /api/v1/notify/channels`、`POST /api/v1/notify/channels/:id/test`（发一条测试通知，回结果）。
- 沙箱：不发（同现有推送，出站闸门）。
- 网页：「设置 · 连接与集成」下新增「通知」分区：渠道列表 → 添加（选类型）→ 表单（地址、密钥、类型勾选、两个开关）→「发测试通知」→ 最近结果。

## 5. 预研：在通知里直接回复

**能做到的程度：对「多选一」的待你处理一键作答；自由文字回复这四个渠道都不支持。**

- 机制：签名动作链接。
  - 每个选项生成一个链接 `<入口>/m/<fp>/api/v1/notify/act/<token>`；token = `{askId, 选项, 过期时间, 随机数}` + HMAC（密钥只在本机）。
  - 新增一个公开端点（同现有的设备配对、peer redeem 公开端点）：校验签名 → 一次性（随机数记账）→ ask 还开着 → 按 owner 身份作答，`via` 记为 `notify`。已作答或已过期回明确提示。
  - 依赖「手机能访问到本机」：中继模式（relay.floka.ai 转发 `/m/<fp>/`）或你配了外网入口；只有本机回环时不出按钮，只给「打开 Claudestra」链接。
- 各渠道的落点：
  - ntfy：最多 3 个 http 按钮，点了直接作答，不用开 App（iOS 待真机验证；不行就退回 view 按钮打开下面的确认页）；
  - Bark / Gotify：没有按钮，点通知打开一个本机签发的极简确认页（无需登录，只能答这一条），一点即答；
  - Webhook：载荷带 `actions[{label, url}]`，接收方（飞书卡片、Telegram 按钮等）自己渲染。
- 边界（安全）：
  - `authorize` 类（发版、打 tag、删东西、改机器级设置）**不给动作链接**，只能回网页里批——那类要二次核对参数（ask-check），不能一点了之；
  - 运行时弹框（AUQ、权限请求）首批不接，走的是另一条作答路径；
  - 链接 = 能替你作答这一条的凭据：不写日志、过期即失效、答一次即失效；频控；
  - 真正的双向文字回复要接聊天类应用（Telegram Bot、飞书机器人）：可以收文字、按钮回调，是另一个量级的工作，建议单独立项。

## 6. 隐私与安全

- 推到第三方服务器（ntfy.sh、api.day.app）= 内容出了本机。默认建议：ntfy 用自建或随机长 topic + token；Bark 开加密；「不带正文」随时可开。
- 正文只发摘要（复用 `notificationBody`：去 Markdown、压一行、最多 180 字），不发附件、不发路径。
- 只推 owner 的通知；guest 的「指给你」那一路首批不接（guest 没有渠道配置）。

## 7. 分期

1. 首批：框架 + ntfy / Bark / Webhook + 「待你处理」与安全提醒、系统提醒 + 设置页 + 测试发送 + 最近结果。只发不收。
2. 第二批：签名动作链接 + ntfy 按钮一键作答 + Bark / Gotify 确认页 + Webhook actions；Bark 已处理撤回；守门拦下（#1141 合并后）。
3. 之后：Gotify；更多通知类型（agent 卡死、定时任务失败等）；聊天类双向渠道（Telegram / 飞书）单独立项。
