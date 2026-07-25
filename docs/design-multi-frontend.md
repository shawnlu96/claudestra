# 设计文档：多前端架构（Discord 解耦 → Web / Telegram / API）

> [English](./design-multi-frontend.en.md) · **简体中文**

> 状态：**已实现并发布**——A + B + C1 于 2026-07-09 通宵迭代完成，随 **v2.6.0** 发布。
> 本文覆盖 v2.6.0 起的多前端架构，并含后续版本的增补（§12 的 Claude Code agents 模式
> 适配随 v2.7 落地；§7 的决策条目按需追加 Update）。
> 实现与设计的偏差在 §11 记录。C2（Discord 全面收编）按 D8 渐进进行，不立项。
> 目标：Discord 从「系统的脸」降级为「第一个 adapter」。核心与任何聊天平台解耦，
> 使 Web 前端、Telegram bot、纯 HTTP 集成都是**同一套接口的消费者**，接入新前端
> 不需要动核心。

## 0. TL;DR

- 核心洞察：v2.0.0 的 `Envelope{from,to,intent}` + `deliver()` 已经是平台无关的路由内核，缺的只是三样东西：
  1. **中性消息格式**（NeutralMessage）与 **ChatAdapter 接口** —— 出入口的平台抽象；
  2. **带前缀的统一 chat_id keyspace**（`discord:<id>` / `telegram:<id>` / `api:<token>`）—— 让所有 pending/thread/registry 逻辑对新前端零改动；
  3. **结构化事件流**（event-bus + SSE）—— 只读前端（网页看板、监控）的数据源。
- agent 侧 **完全无感**：MCP 工具（reply / send_to_agent）的 chat_id 本来就是不透明字符串，前缀化后原样回传即可。
- 分四个阶段，每阶段独立可发布：A 事件流 → B 入站 API + token → C1 出站按 transport 分发 → C2 Discord 全面收编成 adapter（纯重构，可缓）。Telegram 在 C1 之后即可接入；Web 只需要 A+B。

## 1. 背景与动机

owner 的三个诉求（2026-07-08/09）：

1. **把某个 agent 开放给外部的人** —— Discord 权限模型做这件事很别扭；
2. **网页版 prototype** —— 本设计的接口就是网页版的全部后端；
3. **多前端演进** —— 未来能「轻松接入类似 Telegram 这样的软件」。

原则不变：**Keep it simple**。所有抽象都切在「加第二个实现时才付费」的位置，不做用不上的泛化。

## 2. 分层架构总览

```
                        ┌──────────────────────────────────────┐
   前端（每个一个 adapter）│              核心（平台无关）           │
                        │                                      │
 Discord ──────────────►│  Envelope / deliver() 路由内核        │
 Telegram（future）─────►│  registry / pending / thread 追踪     │◄──── channel-server (ws)
 Web / HTTP API ───────►│  agent 生命周期 (manager)             │◄──── jsonl-watcher
                        │  event-bus（结构化事件）              │◄──── hooks (Stop/Notification)
                        │  身份与授权（transport-scoped）       │
                        └──────────────────────────────────────┘
        入站：adapter 收平台消息 → InboundMessage → Envelope → deliver()
        出站：deliver() → NeutralMessage → adapterFor(dest).send()
        只读：event-bus → SSE（/events）→ 任何订阅者
```

三条数据通道，前端各取所需：

| 通道 | 协议 | 谁用 |
|------|------|------|
| 会话（收发消息） | adapter（Discord ws / Telegram long-poll / HTTP POST） | 有人机对话的前端 |
| 事件流（只读实时） | SSE `GET /events` | 网页看板、监控、任何想看 tool 流的 |
| 快照（只读拉取） | `GET /stats`（已存在）、`GET /api/v1/agents` | 看板初始化、健康检查 |

## 3. 核心抽象（本设计的合同，冻结部分）

### 3.1 统一 chat_id keyspace（决策 D7，D2 的推广）

所有「会话地址」是一个带 transport 前缀的字符串：

```
discord:<channelId>       Discord 频道
telegram:<chatId>         Telegram 会话（future）
api:<tokenId>             HTTP API 用户（Phase B）
web:<sessionId>           网页端会话（future，若 web 走 ws 而非纯 API）
<裸 snowflake>            兼容形态 = discord:<id>，永久支持
```

- registry / clients / pendingReplies / thread 的 key 全部沿用这个 keyspace——它们只把 key 当不透明字符串，**零改动**。
- agent 的 MCP `reply(chat_id)` 原样回传，**agent 与 channel-server 零改动**。
- 解析集中在一处：`parseChatId(s) → { transport, id }`（router.ts），核心里禁止再出现对裸 id 的 Discord 假设。

### 3.2 NeutralMessage（中性消息格式，additive-only）

现有 reply 工具的入参已经基本是中性的，正式定义并冻结：

```ts
interface NeutralMessage {
  text: string;
  /** 中性 UI 组件。现有 {type:"buttons"|"select"} JSON 原样采用 */
  components?: NeutralComponent[];
  /** 本地文件绝对路径（出站附件） */
  files?: string[];
  /** 同 keyspace 的消息引用（回复哪条） */
  replyTo?: string;
}
// NeutralComponent = 现有 buttons/select 的 raw JSON schema，唯一标准形态。
// 交互回传语义（冻结）：用户点按钮 → 入站一条 text 为 "[button:<id>]" 的消息；
// 选菜单 → "[select:<id>:<value>]"。所有 transport 一致，agent 无感。
```

兼容承诺：NeutralMessage / NeutralComponent / BridgeEvent 三个 schema **只加字段不删不改语义**（additive-only）。

### 3.3 ChatAdapter 接口（Phase C1 引入，Discord 先做隐式实现）

```ts
interface ChatAdapter {
  transport: string;                 // "discord" | "telegram" | ...
  caps: {
    maxTextLen: number;              // Discord 2000 / Telegram 4096
    buttons: boolean;                // 不支持 → 降级为文本编号列表
    edit: boolean;                   // 支持编辑已发消息（tool 流的合并编辑用）
    files: boolean;
    typing: boolean;
  };
  /** 出站。分块、组件渲染、平台限速都是 adapter 内部职责 */
  send(destId: string, msg: NeutralMessage): Promise<{ messageIds: string[] }>;
  edit?(destId: string, messageId: string, msg: NeutralMessage): Promise<void>;
  typing?(destId: string, on: boolean): void;
  /** 入站。adapter 收到平台消息后回调核心；核心负责建 Envelope + deliver */
  onInbound(cb: (m: InboundMessage) => void): void;
}

interface InboundMessage {
  chatId: string;                    // 带前缀，如 "telegram:12345"
  userId: string;                    // transport 内的用户 id
  username?: string;
  text: string;
  attachments?: string[];            // 已下载到本地 inbox 的绝对路径
  messageId: string;
  replyToMessageId?: string;
}
```

降级规则（写死在各 adapter，不做运行时协商）：
- 无 buttons 能力 → 组件渲染为 `1) label  2) label` 文本，用户回数字，adapter 回传 `[button:<对应id>]`；
- 超长 → 按 caps.maxTextLen 分块（沿用 discordReply 的按行切分算法，抽到 lib）；
- 无 edit → tool 流每次发新消息（或该 transport 干脆不订阅 tool 流，见 §6）。

### 3.4 身份与授权（transport-scoped identity）

```
principal =  discord:<userId>   ← 现 ALLOWED_USER_IDS，迁移为此形态
          |  telegram:<userId>  ← future
          |  token:<tokenId>    ← Phase B
```

授权表统一为 per-principal 的 agent 白名单（`"*"` = 全部，master 需显式列名）：

```json
// ~/.claude-orchestrator/principals.json  (Phase B 落地，0600)
{
  "principals": [
    { "id": "discord:535144625355096076", "role": "owner", "agents": ["*", "master"] },
    { "id": "token:tok_a1b2c3", "name": "外包-张三", "agents": ["worker-alpha"],
      "secret": "<hex>", "disabled": false, "createdAt": "..." }
  ]
}
```

- owner 的 Discord id 从 .env 迁入（.env 保留读取作为 fallback，不 break 现有安装）。
- **管理能力按 role 走**：`role: "owner"` 才能 create/kill/cron；token 默认只有会话权。管理面 API 化是 future（D6 不变），但授权模型现在就分出 role 字段，避免以后重构。
- 每 principal 限流 **120 req/min**（HTTP 入口，60s 内存滑动窗口，bridge 重启清零）。
  设计初值是 30，实测 web 端重度使用（SSE 重连风暴：连流 + 历史 + 列表轮询 + pending
  一整套）会打爆并循环触发 429，已提到 120。当前为源码硬编码（`SlidingWindowLimiter(120)`），
  无 env 开关。

**⚠️ 共享上下文风险（遗漏补遗 R1，最重要的一条）**：token scope 控制的是「能不能
跟某 agent 说话」，管不了「agent 上下文里已有什么」。Claude Code 一个 session 一份
上下文——把 owner 日常在用的 agent 开放给外部 token，外部用户的提问可能让 agent
把 owner 之前对话里的机密内容复述出去；反向地，外部输入也会污染 owner 的工作上下文。
这与 peer 协作的哲学一致：**暴露必须是显式的、面向专用 agent 的**。落地三件事：
1. 文档与 `token-add` CLI 输出都印警告：「建议只暴露为此目的新建的专用 agent」；
2. `token-add` 时若目标 agent 未标 `external: true`（registry 字段，create 时
   `--external` 设置），要求 `--force` 确认；
3. agent 收到 API 消息时 header 明示 `[🌐 来自 API 用户 张三]`（§5.2），agent 的
   系统提示可据此拒答敏感内容——但这只是纵深防御，不是边界本身。

## 4. Phase A — 事件流（多前端的只读地基）

### 4.1 event-bus（`src/bridge/event-bus.ts`）

进程内总线 + 每 agent 500 条环形缓冲，seq 单调递增，无持久化（权威历史 = jsonl，已有纯库可查）。

```ts
interface BridgeEvent {
  seq: number; ts: string;
  agent: string;                     // registry 名，master = "master"
  chatId: string;                    // 该 agent 的主会话地址（带前缀）
  type: "tool_start" | "tool_done" | "assistant_text" | "turn_duration"
      | "agent_status" | "auto_deny" | "question" | "chat_message";
  data: Record<string, unknown>;
}
```

负载明细（additive-only）：
- `tool_start` `{toolId, name, summary}` / `tool_done` `{toolId, error}`
- `assistant_text` `{text, rateLimited?}`
- `turn_duration` `{durationMs}`
- `agent_status` `{status: "thinking"|"done"}`
- `auto_deny` `{reason}` / `question` `{questions}`（AskUserQuestion 原始结构）
- `chat_message` `{direction:"in"|"out", from, text, threadId}` —— 正式会话消息的镜像

### 4.2 埋点：旁路镜像，不拆 watcher（决策 D1，理由见 git 史）

在 `processNewData` / `drainChannelWatcher` / Stop-hook / deliver 成功处**各加一行 emit**，
Discord 渲染管线一字不动。事件流是镜像不是管线上游——零回归，且新前端（Telegram/Web）
的「tool 流」直接订阅 bus 自行渲染，不复用 Discord 的 debounce/edit 逻辑（那是 Discord
限速的产物，Telegram 有自己的限速节奏）。

### 4.3 SSE 端点

```
GET /events?agent=<name>&since=<seq>     # Last-Event-ID 亦可
```

标准 SSE：`id:` = seq，`data:` = BridgeEvent JSON，30s 心跳注释。本机免鉴权；
Phase B 后同逻辑挂 `/api/v1/events`，token 鉴权 + 按 principal 的 agent 白名单过滤。

### 4.4 绑定收紧

改动前 `Bun.serve` 默认绑 0.0.0.0（/hook /stats 暴露在内网）。已改为
`hostname: "127.0.0.1"`（现状：默认只绑回环），并新增 env `BRIDGE_BIND` 放开。对公网暴露 = 用户自己上反代（Caddy / Tailscale Funnel），
TLS 与网络边界不是 bridge 职责。release notes 提醒自定义 BRIDGE_URL 跨机器的用户。

## 5. Phase B — 入站 HTTP API（Web prototype 的后端）

### 5.1 端点（挂 `/api/v1/`，路径版本化一次到位）

```
POST /api/v1/agents/:name/messages    { text, wait?: seconds≤300 }
GET  /api/v1/agents                   agent 列表 + 状态（scope 过滤）
GET  /api/v1/events?agent=&since=     token 版 SSE
GET  /api/v1/threads/:threadId        wait 超时后的轮询兜底（读 ring buffer）
GET  /api/v1/files/:opaqueId          出站附件下载（bridge 登记过的路径才发）
```

鉴权 `Authorization: Bearer <secret>`；CLI `manager.ts token-add <name> --agents a,b` /
`token-list` / `token-revoke`，secret 只在 add 时显示一次。

### 5.2 入站流程

鉴权 → scope 检查（403）→ 查 clients（agent 离线 409）→
`Envelope{ from: {kind:"api", tokenId, name}, to: local, intent:"request" }` → `deliver()`。
`resolveReplyBackChannel` 返回 `api:<tokenId>` → agent 的 chat_id 就是它，reply 原样回传。
`renderContentForLocal` 加 from.kind==="api" 分支，header 形如 `[🌐 来自 API 用户 张三]`，
让 agent 知道对话方不是 Discord 用户（没有 @mention / push 语义）。

### 5.3 回复路径

`deliver()` 加 `case "api"` → `deliverToApi`：
1. resolve 同步 waiter（`threadId → resolver` map）→ `POST` 的 `wait` 模式直接拿到 `{reply, components, files}`；
2. emit `chat_message(out)` 事件（SSE 订阅者收到）；
3. 写 ring buffer（threads 轮询兜底）。**不碰 Discord。**

按钮：components 原样进响应 JSON；网页渲染成真按钮，点击 = `POST` 一条 `[button:<id>]`。
与 Discord 的回传格式一致（§3.2 冻结语义），agent 无感。

### 5.4 审计镜像（owner 可见性，遗漏补遗 R2）

peer 协作特意让跨界对话过 `#agent-exchange` 以便审计（Update v2.11：Discord peer
已移除，HTTP peer 的审计正是靠本节的镜像机制，见 `docs/design-http-peers.md`）；API
对话若完全不碰 Discord，
owner 就失去了「外部人跟我的 agent 聊了什么」的视野。因此 **deliverToApi 默认把
双向对话镜像到该 agent 的 Discord 频道**（入站 `[🌐 API←张三] ...`、出站
`[🌐 API→张三] ...`，走 deliver(bridge→user) 的 UI 类通道，不进 agent 上下文）。
per-token `mirror: false` 可关（本机自动化这类高频调用不刷屏）。

### 5.5 wait 模式与 Stop hook 的兜底（遗漏补遗 R3）

agent 可能 end_turn 而不调 reply()（Discord 靠 watcher 💬 流兜底）。API 的同步
waiter 若只等 reply 会干等到超时。**Stop hook 处理时检查该 agent ws 名下的 API
waiter**：还挂着 → 用 drain 捕获的 assistant_text resolve，响应标
`{ viaFallback: true }`；连文本都没有 → resolve 成 `{ done: true, reply: null }`。
挂靠现有 Stop hook 的 per-ws pending 清理点，与 pendingPeerInbound 兜底同构。

### 5.6 入站附件（遗漏补遗 R5）

发截图/文件给 agent 是高频操作，v1 就做：`POST /api/v1/agents/:name/messages`
支持 `multipart/form-data`（`text` 字段 + `files` ≤5 个、单个 ≤10MB），落到
现有 inbox 目录后走 Envelope 的 `meta.attachments` —— 与 Discord 附件同一条路。

### 5.7 网页版 prototype 用法（验证接口够用）

```
初始化   GET /api/v1/agents            → 侧边栏 agent 列表
选中     GET /api/v1/events?agent=x    → SSE 挂上，实时渲染 tool 流 + 💬
发消息   POST /api/v1/agents/x/messages {text, wait:120} → 渲染 reply + 按钮
点按钮   POST {text: "[button:approve_xxx]"}
历史     不做 —— prototype 只做实时；历史回放是 future（D5，权威数据在 jsonl）
```

网页本身 = 一个静态页（可以就放 bridge 的 `GET /` 返回，也可以独立部署），**没有独立后端**。

> **Update（v2.9）**：上表「历史 不做」这一行已被推翻——只读历史 API 已落地：
> `GET /api/v1/agents/:name/history` 列该 agent 的会话（live + archive 快照合并），
> `GET /api/v1/agents/:name/history/:sessionId` 返回分页的中性消息
> （`?limit=100&before=<seq>` 向前翻页，`?subagent=agent-xxx` 读子 agent 会话）。
> 解析在 `src/lib/session-history.ts`。权威数据仍在 jsonl（D5 不变，仍无事件持久化），
> 端点只是它之上的只读解析层。

## 6. Phase C — 出站抽象与 Discord 收编

### C1（小步，先行）：deliverToUser 按 transport 分发

```ts
async function deliverToUser(env, to) {
  const { transport } = parseChatId(to.channelId);
  const adapter = adapters.get(transport);      // 现阶段只有 discord
  return adapter.send(...)
}
```

一个 `adapters` 注册表 + Discord 的 send/edit/typing 包成第一个 `ChatAdapter`
（内部还是现在的 discordReply，只是挪个壳）。**C1 之后接入 Telegram 就是纯增量**：
实现 ChatAdapter + 在 principals.json 加身份 + 配置 agent 绑定，核心零改动。

### C2（owner 2026-07-09 提前立项，首批已完成）：全面收编

原计划渐进（D8），owner 审阅「真残留清单」后要求立项清理。首批五项已落地：
- **C2-1** master 身份判断集中（isMasterChannel / isMasterWs / agentLabelForChannel）
- **C2-2** fetch_messages/react/edit_message 对非 discord 会话明确报错（原静默失败）
- **C2-3** Discord 用户鉴权统一走 principals.json（.env ALLOWED_USER_IDS 启动幂等
  seed 成 discord:<uid> role:owner，保留 fallback；加/禁用户改 principals 即可）
- **C2-4** typing 生命周期 / 💭 status 消息簿记 / uma 完成语录 / 操作按钮全部迁入
  `bridge/discord-adapter.ts`，bridge.ts 只留薄包装
- **C2-5** ChatAdapter 加 provisionConversation：create 的建频道走 adapter 接口
  （ws 协议名不变），纯 API agent 只差一个 provisioner

仍留在 bridge.ts 的 Discord 逻辑（messageCreate 入站、slash、管理按钮 interaction）
继续按「顺手改到就挪」处理。已知无解：AUQ/权限确认的 tmux modal 只有 owner 能按。

### Telegram adapter 蓝图（future，不在本次范围，写此证明接口够用）

- 库：grammY（Bun 兼容），long-polling（无需公网回调）；
- `caps: { maxTextLen: 4096, buttons: true(inline keyboard), edit: true, files: true, typing: true }`；
- inline keyboard 的 callback_data = 我们的 button id，点击回传 `[button:<id>]`；
- agent 绑定：registry 的 agent 条目加可选 `bindings: ["telegram:<chatId>"]`，
  inbound 命中绑定 → 正常 deliver；agent 的 tool 流由 tg-adapter 订阅 event-bus 自行渲染
  （节流粒度自定，不复用 Discord watcher）；
- 身份：`telegram:<userId>` 进 principals.json，role/agents 白名单同一套。

## 7. 决策记录

- **D1 旁路镜像不拆 watcher**：零回归；且多前端各自订阅 bus 渲染，Discord 渲染管线本就不该被复用。
- **D2→D7 带前缀 chat_id 统一 keyspace**：pending/thread/registry/agent 全部零改动；裸 id = discord 永久兼容。
- **D3 不改 registry 主键**：agent 仍以 Discord 频道为主会话（Discord 是 primary transport）。「无 Discord 频道的 agent」等真需求出现再引入内部 id。
- **D4 peer 协作不动**：`#agent-exchange` 的信任模型就是 Discord 频道成员资格，是特性不是耦合。
  - **Update（v2.11）**：本条已失效——Discord peer 机制（含 `#agent-exchange`）整体移除，跨实例协作改为基于本 API 的 HTTP peer（互签 scoped token），见 `docs/design-http-peers.md`。
- **D5 无持久化事件存储**：实时走 bus，历史读 jsonl（纯库已有）。网页版历史回放是 future。
  - **Update（v2.9）**：「历史回放是 future」这半句已作废——只读历史 API 已落地（见 §5.7 的 Update）。D5 的核心结论不变：仍然没有持久化事件存储，历史依旧是在 jsonl 之上现读现解析。
- **D6 管理面不进 API（v1）**：但 principals 授权模型现在就带 role 字段，为 future 管理 API 留位。
- **D7 路径版本化 `/api/v1/`** + **三个 schema additive-only**（NeutralMessage / NeutralComponent / BridgeEvent）：这是对前端作者的兼容承诺。
- **D8 C2 收编不立项**：跟随日常改动渐进迁移，避免大爆炸。

## 8. 带外交互与已知限制（遗漏补遗 R4 / R6）

**AskUserQuestion / auto-deny / 权限确认（R4）**：这些交互的本体是 tmux 里的 TUI
modal，选择动作只能由 owner 完成。API/Telegram 用户触发它们时：
- 现有 watcher 机制**天然兜底**——AUQ 选单、auto-deny 放行按钮照常弹到该 agent 的
  Discord 频道，owner 代为处理；
- 事件流里的 `question` / `auto_deny` 事件让非 Discord 前端**看得到**卡点（网页可
  渲染「等待 owner 确认」占位），但 v1 不提供非 Discord 的作答通道；
- API wait 请求会因此等到超时（202 + threadId，事后轮询）。文档向 token 用户说明
  这一语义。作答通道 API 化是 future（依赖管理面 API，D6）。

**同 agent 多会话并发**：Discord 用户与 API 用户同时说话时消息按到达顺序排队进同
一个 session（master 早就同时挂 #control 与 #agent-exchange，机制成熟）。副作用是
上下文互见——这正是 R1 要求专用 agent 的另一个理由。不做会话隔离（那等于每 token
一个 agent，用 create 就能做到）。

**bridge 重启语义（R6，已知限制）**：event-bus ring buffer 与 API waiter 都是进程
内存——bridge 重启后 SSE 断连（客户端应自动重连 + since 补发会丢失重启前的 seq）、
进行中的 wait 请求连接直接断。这与 Discord 前端在 bridge 重启时的体验一致，不做
持久化补偿（D5）。文档写明即可。

## 9. 测试与验收

- 单测：event-bus（emit/subscribe/replay/环形淘汰）、parseChatId、principals（scope/role/限流纯逻辑）、NeutralMessage 降级渲染（buttons→文本编号）。
- router.test.ts 扩展：ApiUserEndpoint、`resolveReplyTarget("api:...")`、前缀兼容（裸 id = discord）。
- live（sandbox 惯例）：
  - `curl -N /events` + agent 跑一轮工具：事件齐全、seq 连续、断线补发正确；
  - token 全链路：POST→reply（wait 与 SSE 两路）；越权 403；revoke 后 401；
  - Discord 回归：tool 流、💬、drain、按钮、peer 路由、管理面全部行为不变。

## 10. 工作量与发布

| 阶段 | 内容 | 预估 | 风险 |
|------|------|------|------|
| A | event-bus + 埋点 + SSE + 绑定收紧 | ~400 行 | 低（纯旁路） |
| B | principals/token + /api/v1 五个端点 + deliverToApi + CLI | ~700 行 | 中（reply 回路加分支） |
| C1 | parseChatId + adapters 注册表 + Discord send 包壳 | ~150 行 | 低 |
| C2 | Discord 全面收编 | 渐进，不计 | — |

- 发布：A 可单独发；A+B+C1 合并为一个 **minor**（headline：「Claudestra 现在有开放的
  HTTP API 与实时事件流——网页端、Telegram、任何前端都能接入」）。遵守攒批规则。

> **已完成（v2.6.0）**：本节是当时的排期，A/B/C1 最终随 v2.6.0 一起发布。之后
> 的增补（§12 的 agents-mode 适配是 v2.7、只读历史 API 是 v2.9）不在这份排期里。
- Telegram adapter 与网页端本体：**不在本次范围**，等接口落地后按需求另开。

## 11. 实现记录（2026-07-09，与设计的偏差）

- **owner 的 discord principal 未迁入 principals.json**（§3.4 原计划迁入 + .env
  fallback）：Discord 主链路鉴权照旧走 ALLOWED_USER_IDS，principals.json 现阶段只
  管 token。理由：不动 Discord 主链路 = 零回归；统一身份等管理面 API 化（future）
  时一起做。
- **限流实现为「鉴权成功后计数」**：无效 secret 不占限流窗口（64-hex 随机 secret
  没有实际爆破面）。
- **POST 无论是否 wait 都登记 pendingApiRequest**：deliverToApi 靠它把 reply 关联
  回原请求 threadId（reply handler 对每条 reply 新造 threadId，不能直接用）。
- **API 触发的 turn 不发 Stop 完成通知**（lastMessageSource=agent）：回复走 API
  回路 + R2 镜像已可见，@ owner 是噪音（live 验证时发现补上）。
- live 验证全项通过：token 全链路（200 wait / 202 / 401 / 403 / revoke）、R2 双向
  镜像、R3 viaFallback（agent 静默 end_turn 秒返回）、R5 multipart（agent 能读到
  上传文件）、SSE scope 过滤与断线补发、Discord 回归（watcher 流 / 完成通知 /
  按钮）。测试用一次性 agent（test-api），验证后已销毁。

## 12. Claude Code agents 模式适配（2026-07-09 追加，owner 立项）

CC 2.1.x 的 bg agent 体系（daemon、respawn-on-kill、每个 TUI 的 ← 键 agents 视图）
与 Claudestra 的 tmux 前台模型冲突：误按 ← 可把前台会话 fork 成 bg 分身、窗口变
attach 旁观视图、Discord/MCP 链路静默断掉（当日事故三连环，见 mem0）。上游无禁用
开关（keybindings 不覆盖 agents 视图、settings 无相关键）。

适配沿用本设计的 transport 解耦原则 —— 管理可见性也是中性服务 + 多端渲染：

- **SessionsInventory**（`bridge/sessions-inventory.ts`）：`claude agents --json`
  （官方脚本接口）+ `~/.claude/jobs/*/state.json` + registry 三源对账 → 中性
  `NeutralSessionInfo[]`；分身判定 = 未注册 bg 会话与正式 agent 同名/同 cwd。
  纯对账逻辑独立可测（tests/sessions-inventory.test.ts）。
- **三个消费端共用**：Discord `/agents` 面板（management.ts，LLM-free 按钮：
  详情/收编/清理）、`GET /api/v1/sessions`（scope 过滤：受限 token 只见 scope 内
  agent 的会话与分身）、`POST /api/v1/sessions/:id/cleanup|adopt`（全权 token，
  202 + `session_anomaly` SSE 事件回报结果）。
- **自愈**：`startClaudeInWindow` 识别「currently running as a background agent」
  报错 → `cmdRestart` 自动改 `--fork-session` 重试 → 启动前后 diff projects 目录
  探测 fork 出的新 session id → 回写 registry（此前 bridge 的 session 跟踪对
  fork 不可靠，事故中 registry 两次漂移）。`adopt <name> <sessionId>` = 改
  registry + 走 restart（复用自愈全链路）；`resume --fork` 收编野生会话。
- **守护三件套**：permission-watcher 8s 轮询检测 agents 派发界面特征 → 自动 Esc
  + 频道通知；wedge-watcher 链路哨兵（窗口活着 + channel-server 掉线 >5min →
  修复按钮，idle 也检测 —— idle+掉线意味着用户消息进不来）；session-reconciler
  10min 对账 → 新分身告警带 [清理][收编] 按钮 + `session_anomaly` 事件。
- **清理配方**（`lib/bg-jobs.ts`，事故实证）：杀 bg 进程 → 等 daemon 静默
  （state.json mtime 稳定 + 无进程）→ mv 隔离 job 目录（不删，可回滚）→ 重建
  检测重试。两个关键坑：pgrep 匹配必须排除 `--fork-session` 正主（fork 引用者
  命令行含源 session id，裸杀会干掉正式 agent）；被 attach/fork 引用的 job 会被
  daemon 无限 respawn → stubborn 检测放弃打地鼠，转官方 TUI 手动删。
- live 验证：inventory 对账（12 前台 + 1 分身精准检出）、/agents 面板渲染、
  对账器首轮告警、sessions API（200/401/scope）、cleanupBgJob stubborn 路径
  （d170ecbc 被前台 fork 引用，正确拒杀正主并给出指引）。
