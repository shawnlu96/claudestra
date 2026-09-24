# HTTP Peer 协作（v2.11）— 设计文档

> [English](./design-http-peers.en.md) · **简体中文**

owner 2026-07-19：「把强依赖 Discord 的 peer 协作拆出来……更方便做权限管理、聊天历史控制、协作流程。」

## 1. 核心理念

**Peer = 另一个 Claudestra 实例，作为 API 客户端互访。**

v2.6 的多前端 API 已经解决了 peer 协作的全部难题：Bearer token 鉴权、per-agent
scope、同步 wait / thread 轮询、审计镜像、history API。HTTP peer 不新造协议——
对方实例拿着我签发的 token 调我的 `/api/v1/agents/:name/messages`，和 web-ui
是同一条路。Discord peer 的全部复杂度（频道 scoping、bot 权限矩阵、HTML 注释编码
PeerEvent、#agent-exchange 共享信道、[EOT] 防 ack 循环）在 HTTP 模型下**不存在**。

下表对比的是**换掉它的理由**——Discord peer 那一列是 v1.9–v2.10 的历史方案，
已在 v2.11 整体移除，不再是可选路径：

| 关注点 | Discord peer（v1.9–v2.10，**已移除**） | HTTP peer（本设计，唯一现存传输） |
|---|---|---|
| 传输 | 共享 guild 的 #agent-exchange | HTTPS/Tailscale 直连对方 bridge |
| 权限 | 频道权限 + exposures 双层 | token scope 单层（`agents` 白名单） |
| 撤销 | peer-revoke + 频道权限清理 | token-revoke 即断 |
| 历史 | 混在共享频道里 | 入站走 mirror + history API；出站在 caller jsonl |
| 事件编码 | HTML 注释 PeerEvent | 无需编码——就是 HTTP 请求/响应 |
| 依赖 | 双方 bot 同 guild | 网络可达 + 一次 token 互换 |

## 2. 数据模型（peers.json 增量）

```ts
interface HttpPeer {
  name: string;      // 唯一人读名（"ahh"）
  baseUrl: string;   // 对方 bridge，如 http://100.x.y.z:3847（Tailscale IP）
  outToken: string;  // 我调对方 API 的 Bearer（对方签发给我）
  inTokenId?: string; // 我签给对方的 token 短 id（tok_xxx）——识别入站 + revoke 锚点
  addedAt: string;
  disabled?: boolean;
}
// PeersData 新增 httpPeers?: HttpPeer[]。
// （设计时保留了原 Discord 字段并存；v2.11 落地时它们随 Discord peer 机制一起删除了）
```

Principal 增量：`peer?: string`（peer 名）。签给 peer 的 token 打上此标记，
入站注入头据此渲染成「peer 请求」而非「Web 端用户」。

## 3. 握手（三步，每步幂等，串走任意私聊渠道）

```
A: bun src/manager.ts peer-http-invite ahh --agents fable-expert
   → 打印邀请串（base64 JSON {v,name,url,token}；token 是 A 现签、scope 已限）
B: bun src/manager.ts peer-http-join shawn '<邀请串>' --agents data-analyst
   → 存 A 入 httpPeers（outToken=邀请串里的）；签 B 侧 token；打印回执串
A: bun src/manager.ts peer-http-accept ahh '<回执串>'
   → 补全 A 侧 httpPeers[ahh].outToken。完成。
B: bun src/manager.ts peer-http-test shawn   # 双方各测一次连通
```

- 不做自动协商协议：多一轮 CLI 换来实现极简 + 每步可重跑可检查。
- `peer-http-test` = GET 对方 `/api/v1/agents`，打印 scope 内 agent 清单。
- 撤销：`peer-http-remove <name>`（删 httpPeers 条目 + revoke 我签出的 inTokenId）。
- 邀请串里的 url 由 `--url` 显式给出（bridge 不猜自己的公网地址）。

## 4. 出站（send_to_agent 对 agent 透明）

target 语法不变（`x@peer` / `peer:peer.x`）。解析：**httpPeers 名字命中 → 走 HTTP；
未命中即失败并报告调用方**——v2.11 起没有回落路径（原先的 Discord capabilities
老路随 Discord peer 机制一并移除）。

新模块 `src/bridge/http-peer.ts`：

1. `POST {baseUrl}/api/v1/agents/{x}/messages`，body `{text, wait: 120}`，
   `AbortSignal.timeout(135_000)`。text 是 caller 原文——**注入头由对方 bridge
   渲染**（它知道 principal 是 peer），我方不预拼头。
2. 同步拿到 reply → 合成 pushback 注入 caller ws：`[🤖 peer ahh/x 回复] ...`
   （与 Discord peer pushback 同款格式，caller 无感知差异）。
3. wait 超时（对方 202 / 网络超时）→ 记 `pendingHttpPeerCalls`，后台每 30s
   `GET /threads/:threadId` 轮询，10 分钟放弃；到货 pushback，放弃时通知 caller。
4. 任何错误（403 scope / 409 offline / 网络不可达）→ 立即以
   `[⚠️ peer 调用失败] ...` 合成消息告知 caller，不静默。
5. **不自动重试**——消息投递非幂等，重试=双发；一次失败即报。

## 5. 入站（零新代码路径）

对方 POST 我的 messages 端点，Bearer=我签的 token。scope 403、offline 409、
wait resolver、mirror 审计、history 记录**全部现成**。唯一改动：

- `renderContentForLocal` 注入头按 `principal.peer` 分流：
  `[🤝 来自 peer 实例「ahh」的跨机请求（HTTP，非本机用户）。对方是另一个
  Claudestra 的 agent/用户；用 reply() 回答，回复会自动转交对方调用方。]`
- rate limit 沿用 per-token 120/min。

## 6. 安全

- 建议传输：Tailscale / 内网；公网必须 HTTPS 反代（同 BRIDGE_BIND 文档口径）。
- peers.json / principals.json 0600（principals 已有，peers 本次补上）。
- token 互相独立：A→B 与 B→A 各自 revoke 互不影响。
- 无 ack 循环风险（HTTP 一问一答，无广播信道）；pending 有 TTL 清理。
- R1 共享上下文守卫沿用：给 peer 签 token 时非 `--external` agent 要 `--force`。

## 6b. 走 HTTPS 入口（2026-09-23）

peer 可以不连 bridge 端口，改走网页的 HTTPS 入口：反代（Caddy `handle /api/v1/*` / tailscale serve
`--set-path /api/v1`）转到 bridge 在回环上另开的 **peer 专用入口**（`src/bridge/peer-ingress.ts`，
端口 = `.env` 的 `PEER_INGRESS_PORT`，没配就不开——升级不凭空多占端口）。入口只调 /api/v1 处理函数、
带凭据必须是 peer token、拒 ws；反代绝不能直接指 bridge 主端口（回环对控制面一律放行）。
`peer-invite-new` 先实测 `https://<ts.net>/api/v1/agents` 回 bridge 的 401 JSON 才写 HTTPS 地址
（`src/lib/peer-url.ts`，`PEER_PUBLIC_URL` 可强制），否则按 6c 退回直连地址。
已有 peer 记的 baseUrl 不受影响。
⚠ 同一台机器上「自己邀请自己」测不了 peer-join-auto：join 持有 manager 写锁等 redeem，而 bridge 处理 redeem
要跑同一把锁的 peer-redeem → 10 秒超时后 redeem 才执行（邀请被用掉、留下一个半截 peer）。本机冒烟改为：
生成邀请 → curl 带邀请里的 token 打 `https://<ts.net>/api/v1/agents` 与 `…/agents/<x>/messages`（2026-09-23 实测 5 秒拿到回复）。

## 6c. 没有 HTTPS 时：peer 专用端口直连（2026-09-24）

bridge 主端口默认只听本机（`BRIDGE_BIND` 未设），以前在这种机器上生成的邀请写的是 `http://<IP>:<主端口>`，
对方必然 ConnectionRefused（owner 的朋友实遇：邀请生成时只有一行黄字提醒）。现在邀请地址的顺序是：
HTTPS 入口（6b）→ **主端口只听本机时，peer 专用入口直连** → 主端口地址（用户自己开放了 `BRIDGE_BIND` 的机器照旧）。

直连（`openDirectPeerIngress`，`src/lib/peer-ingress-config.ts`）：定好 `PEER_INGRESS_PORT`、在 `.env` 标
`PEER_INGRESS_PUBLIC=1`、POST 回环控制面 `/peer-ingress/sync {hold:true}`，bridge 把专用入口从 `127.0.0.1`
重绑到 `0.0.0.0`，再实测 `http://<tailnet IP>:<端口>/api/v1/agents` 回 401 JSON 才算通（不通照写地址，
提示里说明）。对外的只有 6b 那一小块（peer token + 兑换邀请），控制面 / ws / 网页全权 token 仍只在主端口的本机上。

对外与否 bridge 每分钟重算（`ingressHost`）：标了直连且还有未吊销的 peer token（兑换前的邀请也算）才对外，
peer 全删了就退回本机；`hold` 顶住「邀请 token 还没签出来」那几毫秒（10 分钟）。
⚠ 本机实测走的是自己的网卡，挡不住对方那侧的问题：Tailscale 共享是单向的，macOS 应用防火墙若开着「阻止所有传入」
也会静默丢包——对方超时就先查这两处。

## 7. 测试策略（owner：流程难测，想一套办法）

1. **纯逻辑单测**（`tests/http-peer.test.ts`）：邀请/回执串 encode/parse 往返、
   target 解析优先级（http 命中/同名冲突；「落回 Discord」一项随 v2.11 移除该机制作废）、pending 轮询状态机
   （注入 fake fetch）、HttpPeer 读写兼容（老 peers.json 无 httpPeers 字段）。
2. **Self-peer 回环（杀手锏）**：把本机注册成自己的 http peer
   （baseUrl=127.0.0.1:3847，token 真签）→ agent-temp `send_to_agent("router@self")`
   → 出站 HTTP → 入站 API → 注入 router → router reply → wait 返回 → pushback 回
   temp。**一台机器验证全链路真实网络+鉴权+双向路由**，不需要第二台部署。
3. **故障注入**：错 token（403）、stopped agent（409）、端口不通（网络错）、
   wait 超时→thread 轮询兑现。全用 agent-temp/router，不碰真实 worker。

## 8. 兼容与范围

- Discord peer 机制已在 v2.11 整体移除（#agent-exchange 共享信道、exposures、
  bot-to-bot 路由全部删除，不再是可用路径）；HTTP peer 是唯一的跨实例传输。
- v1 范围：CLI 全流程 + bridge transport + 注入头 + 测试。Web 管理页（可视化
  暴露/历史）v2 再做——CLI 先把地基打对。
- 版本：v2.11.0（minor，新用户能力）。

## 6d. 一个对方一条记录（instanceId）+ 整理旧重复（2026-09-24）

owner：「peer 界面乱的要死……Alex 两边都握手了，为什么一个已握手一个单向？」根子是同一个对方被存成多条：
他兑换我的邀请 → 只有入站的记录；我加入他的邀请撞名 → 只有出站的 `-2`；他重新加入 → `-3`。

- **实例 id**：每个 Claudestra 在 `STATE_DIR/instance-id` 有一个固定随机 id（`lib/instance-id.ts`）。邀请串带 `iid`，
  兑换回调 body 带 `iid`，记录存 `instanceId`。加入（`isSameInviter`）：同出站地址，或同实例 id 且还没有我→他 = 同一对方，
  补进原记录；兑换（`isSameRedeemer`）：同实例 id = 他重新加入，合进原记录并吊销被取代的旧入站 token。
  已有别的出站地址时不合并——实例 id 是自报的，一张邀请不能把既有 peer 的流量改道。
- **旧重复整理**：`peer-http-tidy`（默认只出计划，`--apply` 才写；`lib/peer-tidy.ts` 纯规划）。按去掉 `-N` 的名字分组：
  出站多条只在 host 相同时合并（不同 host 可能是两个人，整组不动）；入站 token 留最新签的、更早的吊销；两个方向都没有的删掉。
  GET /api/v1/peers 带 `tidy` 预览，Peer 弹窗顶部显示并二次确认后执行（POST /api/v1/peers/tidy）。
- **卡片**：一个对方一张，两行「他 → 我」（我签给他的有效 token、最近来访）/「我 → 他」（在线状态、他开放给我的 agent），
  不再用「握手完成 / 单向 / 等待回执」这些说法。/peers 路由整体搬到 `src/bridge/peers-routes.ts`。

## 6e. 邀请链接：点开 → 回自己的 Claudestra 确认（2026-09-24）

owner：「像 Tailscale 邀请那样点开链接、点一下确认」，而且**绝不让对方填自己的地址**。没有中心服务器，所以链接指向
**邀请方**机器上的落地页 `GET /api/v1/invite#<邀请码>`（`src/bridge/invite-page.ts`，不要 token，# 不进服务器日志，
页面不发请求不存东西；挂 /api/v1 是因为 HTTPS 反代和 peer 专用端口只转发这段）。落地页只负责把人送回**他自己的**
Claudestra（加入必须由他那边的 bridge 做）：

- 手机：`claudestra://join#码` → iOS App（`native/ios/App/App/AppDelegate.swift`）在已配置的服务器上打开 `/join#码`；
- 电脑：`web+claudestra:码` → 他的 Claudestra 向浏览器登记过（`web/features/chat/components/invite-intake.tsx`，
  没确认前隔 3 天提醒一次；桌面 PWA 由 manifest `protocol_handlers` 接）→ `/join?i=…`（进来即视为登记生效）；
- 都不行：「复制邀请」，他打开自己的 Claudestra 时从剪贴板认出来（已授权才自动读；否则 Peer 面板「粘贴邀请」），
  或在任意输入框粘贴带邀请的文字直接弹确认。

`/join` 页 = 加入确认卡（`peers-join-confirm.tsx`）：先 `POST /api/v1/peers/inspect` → `peer-invite-inspect`
（只读，用邀请里的 token 探对方 /agents：通 = 顺带拿到能找的 agent；不通给原因与下一步），能连上才让点「加入」。
没登录时 proxy 送 `/login?next=`，登录后带着 # 回来。已知限制：邀请码里仍是预签的长期 token（Codex 建议改成短期
一次性票据，确认后再换长期 token——待双方都升级后做）。
