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
