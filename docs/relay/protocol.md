# Claudestra 中继协议 v2

一台装了 bridge 的机器（**实例**）只向外连一条 WebSocket 到中继；中继之后能做三件事：把浏览器打到 `https://<slug>.<base>/…` 的请求送给这台实例的本机 Web（**隧道**），把别的实例对它 `/api/v1/*` 的调用送过去（**peer**），以及告诉它联系人在不在线（**在线状态**）。实例不需要公网 IP、不开端口、不装 Tailscale。

本文是 `src/relay/`（服务端）、`src/lib/relay-client.ts`（客户端）与 `src/bridge/relay-link.ts`（bridge 接入）的唯一依据；共享常量与帧校验在 `src/lib/relay-protocol.ts`，测试向量在 `tests/relay-protocol.test.ts`。改协议先改这里。

术语：**fp / 指纹** = 实例公钥 sha256 前 16 位十六进制四位一组（`16f9-b5d1-30fb-8923`，`src/lib/instance-key.ts` 的 `keyFingerprint`）；**slug** = 实例在中继上的子域名标签（`mini`），实例自报、中继保证唯一；**base** = 中继的公网主机名（`relay.example.com`）；**front** = 中继的 HTTPS 入口；**contacts / 联系人** = 一台实例允许谁给它发帧的指纹清单。

关键字 MUST / SHOULD / MAY 按 RFC 2119 理解。

## 1. 传输层

| 项 | 规定 |
|---|---|
| 端点 | `wss://<base>/v1/ws`，实例出站连接；中继在 TLS 反代之后时反代到中继这一跳走 `ws://`，对外 MUST 是 TLS |
| 子协议 | `Sec-WebSocket-Protocol: claudestra-relay.v2`。缺失或不认识 → HTTP 426。大版本升级换子协议名，不做帧内协商 |
| 帧编码 | 每个 WebSocket **文本帧**是一个 UTF-8 JSON 对象，`t` 是帧类型。二进制帧 → 关闭 4400 |
| 帧上限 | 默认 256 KiB（`RELAY_MAX_FRAME_BYTES`）。正文分块走 `data` 帧，单块原始字节 ≤ `maxChunkBytes`（默认 64 KiB：一条连接上多路复用，小块让并发的小响应能插空，base64 后也远在帧上限内） |
| 未知字段 | 双方 MUST 忽略不认识的字段；未知 `t` → 回 `error frame_invalid`（有 `id` 就带上），不断线。**服务端只加字段不改字段**：实例各自升级，中继必须兼容上一版实例 |

中继只读信封字段（`t` `id` `to` `from` `timeoutMs` `more` 与 `req` 的 `method` / `path`）。`headers` / `body` 原样搬运、不记日志。

## 2. 握手

```
实例 → 中继   WSS 连接（子协议 claudestra-relay.v2）
中继 → 实例   {t:"hello", v:2, nonce, ts, limits}
实例 → 中继   {t:"auth", v:2, key, name, slug, sig}
中继 → 实例   {t:"welcome", v:2, fp, slug, name, base}      // 成功；slug 可能与请求的不同
实例 → 中继   {t:"contacts", fps:[…]}                        // 之后随时可重发（全量替换）
中继 → 实例   {t:"peers", peers:[…]}                         // 联系人的目录记录 + 在线状态
```

### 2.1 hello

```json
{ "t": "hello", "v": 2, "nonce": "<base64url 32 字节>", "ts": 1790000000,
  "limits": { "maxFrameBytes": 262144, "maxChunkBytes": 65536, "maxReqTimeoutMs": 180000, "heartbeatMs": 25000 } }
```

nonce 每连接一个、60 秒内有效、只能用一次。实例 MUST 在 10 秒内发 `auth`，否则关闭 4408。`ts` 供实例比对本机时钟（偏差 > 300 秒 SHOULD 在日志里警告——请求签名允许的偏差就是 ±300 秒）。

### 2.2 auth

```json
{ "t": "auth", "v": 2, "key": "<Ed25519 公钥 32 字节的 base64url，43 字符>",
  "name": "Shawn 的 Mac mini", "slug": "mini", "sig": "<base64url Ed25519 签名>" }
```

签名覆盖（各行以 `\n` 连接，无结尾换行）：

```
claudestra-relay-auth-v2
<nonce>
<key>
<name>
<slug>
```

- `key`：形状同 `isPublicKey`；私钥就是 `STATE_DIR/instance-key.pem`。
- `name`：展示名，`^[\p{L}\p{N} ._-]{1,64}$`，不唯一、不参与路由。
- `slug`：`^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$`（1–32 字符，小写字母数字与中划线，不以中划线开头结尾）。实例从 `.env` 的 `RELAY_NAME` 取，没配就按主机名规整（`slugify`）。中继按 §5.1 决定最终 slug。

### 2.3 中继侧校验（按顺序）

| 序 | 检查 | 错误码 | 关闭码 |
|---|---|---|---|
| 1 | `v === 2`、字段形状合法 | `protocol_version` / `frame_invalid` | 4400 |
| 2 | nonce 未过期、未使用 | `nonce_expired` | 4401 |
| 3 | 签名对得上 `key` | `auth_failed` | 4401 |
| 4 | 目录里另一把公钥算出同一指纹 | `fingerprint_conflict` | 4403 |
| 5 | 同一公钥已有在线连接 | 旧连接收 `error replaced` + 关闭 4409；新连接继续 | — |

没有组织口令：谁都能登记。能不能给某台实例发帧由 §4 的联系人门控决定，登记本身只让中继知道「这把钥匙叫这个 slug」。握手每 IP 每分钟 10 次，超过关闭 4429。

### 2.4 welcome

```json
{ "t": "welcome", "v": 2, "fp": "16f9-b5d1-30fb-8923", "slug": "mini", "name": "Shawn 的 Mac mini", "base": "relay.example.com",
  "push": { "vapidPublicKey": "BJ…", "apns": true } }
```

`slug` 是中继最终分配的（§5.1），实例 MUST 以它为准；`base` 让实例拼出自己的网页地址 `https://<slug>.<base>` 与配对 / 邀请链接。`push` 是中继的推送网关能力（§3.5）：有 `vapidPublicKey` 才能替实例投 Web Push，`apns` 说明有没有 APNs 凭据；老中继不带这个字段，实例按「不能推」处理、自己直发。welcome 之后连接进入**在线**状态，才允许发业务帧。

## 3. 请求、响应与流

同一组帧同时服务两条路：**隧道**（中继 front 收到浏览器 HTTP 请求，转成帧发给实例，`from` = `"relay"`）与 **peer**（实例 A 发帧、中继转给实例 B，`from` = A 的指纹）。方向靠 `to` / `from` 区分：实例发出的帧带 `to`（目标指纹）；中继发给实例的帧带 `from`（来源指纹或 `"relay"`）。

### 3.1 req

```json
{ "t": "req", "id": "r_1790000000123_k3j9ax", "to": "65b6-0673-d6ed-884b", "timeoutMs": 40000,
  "method": "POST", "path": "/api/v1/agents/claudestra/messages",
  "headers": { "content-type": "application/json", "authorization": "Bearer …",
               "x-claudestra-key": "…", "x-claudestra-ts": "1790000000", "x-claudestra-sig": "…" },
  "body": "<base64>", "more": false }
```

| 字段 | 规定 |
|---|---|
| `id` | 发起方生成，`^[A-Za-z0-9_-]{1,64}$`，在本连接内唯一。隧道请求由中继生成 |
| `to` / `from` | 见上。peer 路径 `to` MUST 是指纹；隧道请求没有 `to`，实例看到 `from:"relay"` |
| `timeoutMs` | 发起方愿意等**响应头**的时长，缺省 40000，中继 clamp 到 `[1000, maxReqTimeoutMs]`。流的空闲超时另算（§3.4） |
| `method` / `path` | 大写方法；`path` = pathname + 查询串。peer 路径 MUST 规整后落在 `/api/v1/` 下（发起方与接收方都查）；隧道请求任意路径 |
| `headers` | 键小写；同名多值以 `, ` 合并。中继给隧道请求加 `x-forwarded-for`、`x-forwarded-proto: https`、`x-forwarded-host`、`x-claudestra-relay-base: <base>`，其余照浏览器发的 |
| `body` / `more` | 小正文直接放 `body`（base64）；`more: true` 表示后面还有 `data` 帧，以 `end` 收尾。`body` 与 `more` 可同时出现（首块随头走） |

### 3.2 data / end / cancel

```json
{ "t": "data", "id": "r_…", "to": "<指纹，实例发出时>", "b64": "<≤ maxChunkBytes 原始字节的 base64>" }
{ "t": "end",  "id": "r_…", "to": "…" }
{ "t": "cancel", "id": "r_…", "to": "…" }
```

`data` / `end` 用在两个方向：请求正文（`req.more` 之后）与响应正文（`res.more` 之后）。同一个 `id` 上请求流与响应流可以交错（先把请求发完再回响应是常态，但接收方 MAY 早回）。`cancel` 由任一方发出：发起方不再要响应，或接收方放弃处理；收到方 SHOULD 中止本机对应的 HTTP 调用。中继在 pending 超时或一方断线时替它发 `cancel` / `error peer_disconnected`。

### 3.3 res

```json
{ "t": "res", "id": "r_…", "to": "<发起方指纹>", "status": 200,
  "headers": { "content-type": "text/event-stream" }, "body": "", "more": true }
```

`status` 照抄；`headers` 去掉 hop-by-hop 与 `content-length`（流式后长度未知），其余原样。`headers` 是单值表，唯一的例外是 `set-cookie`：多条以 `\n` 连接（cookie 里不可能出现换行，而逗号会撞上 `Expires`），front 拆回多个头——登录一次常常同时下发两条 cookie，合成一条浏览器只认第一段。`more: true` 之后跟 `data*` + `end`。SSE 与长响应就靠这条：中继 front 收到 `res` 立刻把状态与头回给浏览器，之后每个 `data` 原样写出（front 要等到第一个非空 `data` 才能把头交给浏览器——运行时不发空流的响应头——所以实例回 `more: true` 后 SHOULD 尽快跟上首块）。

答**隧道请求**（收到的 `req` 带 `from: "relay"`）时，实例发出的 `res` / `data` / `end` / `cancel` / `error` **不带 `to`**——发起方是中继自己，不是某个指纹；中继按 `id` 对回它替浏览器登记的 pending。答 peer 请求时 `to` = 请求帧的 `from`。

### 3.4 pending、超时与顺序

- 中继为每个 `req` 登记 pending `(from, to, id)`。`res` 头到达前超过 `timeoutMs` → 给发起方 `error timeout`、给接收方 `cancel`。隧道请求的这个时长是中继自己的 `frontHeadTimeoutMs`（默认 120 000：浏览器那边的 API 调用可能长挂），不是 peer 的 40 000。
- `res` 头到达后 pending 转为**流态**：连续 `streamIdleMs`（默认 600 000）没有 `data` / `end` → 发起方收 `error stream_idle`、接收方收 `cancel`；总时长超过 `streamMaxMs`（默认 3 600 000）→ 同样处理，错误码 `stream_max`。隧道那头 HTTP 流中间没法报错，浏览器看到的只是提前结束的正文。
- 同一连接上 `id` 与未完成的 pending 重复 → `error duplicate_id`。每连接在途 pending ≤ 64，请求帧 ≤ 120 / 分钟（隧道请求不计入实例的配额——那是中继替浏览器发的；它们的上限在 §6.1）。
- 帧在一条连接上按序到达；中继 MUST 按收到顺序转发同一 `id` 的 `data`。不做重传：断线即失败，与直连 HTTP 断线同一种失败。

### 3.5 push / push-ack（推送网关）

一个 origin 只能有一份 Web Push 订阅，所以中继模式下浏览器用**中继的** VAPID 公钥订阅（`/app-config.json` 的 `vapidPublicKey`），把订阅交给每台已配对机器；机器要推时不自己签，而是请中继投递（设计：docs/design-hosted-frontend.md §7）。APNs 同理：官方 p8 只在中继上。持有完整订阅即视为有权推送——endpoint 只有订阅者与它交给的机器知道。

```json
{ "t": "push", "id": "r_…", "kind": "webpush", "subscription": { "endpoint": "https://…", "keys": { "p256dh": "…", "auth": "…" } }, "payload": "{\"title\":…}", "ttl": 3600 }
{ "t": "push", "id": "r_…", "kind": "apns", "token": "<hex 设备 token>", "payload": "{\"title\":…}", "badge": 3 }
{ "t": "push-ack", "id": "r_…", "ok": false, "status": 410, "gone": true }
```

| 字段 | 规定 |
|---|---|
| `id` | 同 `req`：发起方生成，本连接内唯一；`push-ack` 原样带回。不进 pending 表，与在途 `req` 的 `id` 互不相干 |
| `kind` | `webpush` 或 `apns`；其它值 → `push-ack ok:false error:frame_invalid` |
| `subscription` | 浏览器 `PushSubscription.toJSON()` 的 `endpoint` + `keys.p256dh` / `keys.auth`。endpoint MUST 是 https，且主机不能是回环 / 私网 / 链路本地的 IP 字面量或 `localhost`（SSRF），否则 `error: endpoint_forbidden` |
| `payload` | 通知正文的 JSON **字符串**，≤ 4096 字符（`PUSH_MAX_PAYLOAD_CHARS`）；中继原样加密投递（Web Push）或按 APNs 形状包装（`aps.alert` 等，`src/lib/apns.ts`），不解释其它字段。中继看得见正文（与隧道明文同级） |
| `ttl` / `badge` | 可选。`ttl` 秒（缺省 3600）；`badge` 覆盖 payload 里的角标数（给 APNs `aps.badge`） |
| `token` | APNs 设备 token，32–256 位十六进制 |
| `push-ack` | `ok` 投递成功；`status` 推送服务回的 HTTP 状态；`gone: true` = 订阅 / 设备已永久失效（Web Push 404 / 410；APNs 410 或 `BadDeviceToken` / `Unregistered` / `DeviceTokenNotForTopic`），实例 MUST 删记录；`error` 短码：`frame_invalid` `rate_limited` `endpoint_forbidden` `payload_invalid` `webpush_unavailable` `apns_unavailable`（中继没配对应凭据）`upstream_error` `send_failed`（网络层） |

每台实例每分钟 ≤ 60 个 push 帧（`pushPerFpPerMinute`），超过回 `rate_limited`，不断线。实例侧等 `push-ack` 15 秒。中继日志只记 fp、kind、状态、耗时，不记 payload。

## 4. 联系人门控与 peer 路由

```json
{ "t": "contacts", "fps": ["65b6-0673-d6ed-884b", "…"] }
```

实例在 welcome 后 MUST 发一次，之后清单变化时重发（全量替换，≤ 500 条）。中继在内存里记 `contacts[fp] = Set(fps)`，用于两件事：

1. **路由门控**：A 发 `req` 给 B，中继放行当且仅当 B **在线且** `contacts[B]` 含 A，**或**这是兑换邀请（`method === "POST" && path === "/api/v1/peers/redeem"`，每个发起方每分钟 ≤ 6 次——B 还不认识 A 时唯一允许的敲门方式；B 的 bridge 自己按一次性 join 口令决定收不收）。其余一律 `error peer_unknown`，不区分「不存在」「不在线」「没把你列为联系人」——离线实例的联系人清单不在内存里，中继判不出你是否被列入，所以**联系人离线也是 `peer_unknown`**，免得泄露目录；只有兑换邀请打到离线目标才回 `error peer_offline`。
2. **在线状态**：中继回 `peers` 帧并在之后推 `presence`，只对**双向且双方在线**的联系人（A 列了 B、B 列了 A、两边都连着）。`peers` 只含目录里查得到的指纹（没登记过的静默略去）；单向的、或对方离线的（同样因为离线方的清单不在内存）一律 `online: false, mutual: false`，`lastSeen` 取目录里的最近在线时间。

```json
{ "t": "peers", "peers": [ { "fp": "…", "slug": "alex", "name": "Alex 的 MBP", "online": true, "lastSeen": "2026-09-27T01:00:00.000Z", "mutual": true } ] }
{ "t": "presence", "peer": { "fp": "…", "slug": "alex", "name": "…", "online": false, "lastSeen": "…" } }
```

联系人怎么来：邀请方生成邀请时把自己的指纹写进邀请载荷；被邀方加入时记下这个指纹并列为联系人；兑换请求经中继送到邀请方时带着 `from` 指纹，邀请方记下并列为联系人。bridge 侧对应 `peers.json` 里 `httpPeers[].fp`（`src/lib/peers.ts`）。

### 4.1 接收方验签（peer 路径，实例 MUST 做）

中继看得见明文（本版没有端到端加密），所以「拿着 token 的中继或别的实例不能冒充发起方」靠这一步：

1. `x-claudestra-key` 形状合法，且 `keyFingerprint(key) === from`；否则 `error bad_signature`。`from` 由中继按握手结果盖章，别的实例顶不了 A 的钥匙，中继虽能盖任意 `from` 却签不出 A 的签名。
2. 按 `instance-key.ts` 的 canonical 验：`claudestra-req-v1\n<METHOD>\n<path>\n<ts>\n<sha256(body) hex>`，body 是完整请求正文的原始字节（流式正文先收齐再验——peer 路径的正文都是小 JSON）；偏差 ±300 秒。`x-claudestra-sig` MUST 是规范的无填充 base64url（86 个字符，解码再编码与原串一致），否则同一个签名能写成多种串。不过 → `bad_signature`。
3. 核发件人（`lib/peer-trust.ts` `relayPeerRefusal`）：兑换邀请之外，`from` MUST 是本机联系人（peers.json 里未禁用、记有指纹的对方），而且 MUST 带 peer token（Bearer 或 events 的 `?token=`）；token 所属 peer 的期望指纹 MUST 等于 `from`；记录里存了对方完整公钥的，`x-claudestra-key` MUST 就是那一把（不只比 64 位指纹）。否则 `error sender_forbidden`。签名只证明请求出自 `from`，这一步才证明 token 是 `from` 的。
4. 防重放：非 GET / HEAD 的签名（按解码后的字节比较）在它的有效期内（签名时间 + 300 秒）见过，→ `error replay`；时间戳早于本进程启动（缓存不落盘）→ `error bad_signature`，message 提示发起方时钟慢、先对时。**只在第 3 步通过后才写缓存**：被拒的请求一条都不进，非联系人签名再合法也占不到位置。兑换帧（非联系人也能发）记在单独的小缓存里（整体 500 条、每个发件人 60 条），满了挤掉最旧的一条而不拒新兑换：口令只能兑换一次、持钥证明绑着加入方现生成的 nonce，被挤掉的签名再来一次最多得到和原请求相同的结果。联系人的缓存按发件人分桶：一个发件人 2000 条、整体 5 万条未过期，满了拒新请求（`error replay_full`）并告警，不挤掉未过期的条目；一个发件人灌满只拒它自己。

目标地址用 `new URL(path, 入口基址)` 构造并断言与基址同源（`relay-inbound.ts` `localUrl`）：`path` MUST 以单个 `/` 开头（`//`、`/\`、`@host`、不带斜杠的一律 `error path_forbidden`），帧里的 `path` 改不了目标主机。peer 帧在第 1 步之前就做这项检查，不合格的不验签、不进防重放缓存。隧道请求（§4.2）同样如此。拒绝发件人的日志每个发件人每分钟一行（发件人数超过上限的归到同一行）。

验过后打到本机 **peer 专用回环入口**（`src/bridge/peer-ingress.ts`，端口 `.env` 的 `PEER_INGRESS_PORT`），头里去掉 hop-by-hop、`host`、`content-length`、`cookie`、设备头 `x-cstra-device`、`x-forwarded-*` 与发起方自带的 `x-claudestra-relay-*`，加 `x-claudestra-relay-from: <from>` 与只有本进程知道的标记头；peer 入口核对标记后把 `from` 放进请求上下文、两个头一律剥掉，bridge 只从上下文读来源指纹（主端口、旧 web 端口带来的同名头不起作用）。

bridge 里请求来源分四类（`bridge/request-context.ts`）：`loopback`、`lan`、`relay`、`peer-ingress`；没设过来源的请求是 `unknown`，各处按来源放行都查同一张正向白名单（`sourceAllows`），`unknown` 一个都不认——`/api/v1` 的任何凭据（含不看来源的 Bearer）在 `unknown` 下一律 403 `unknown_source`，并每分钟最多记一行日志（入口与路径，不含凭据）；来源为 `peer-ingress` 的请求（不包括下面的回环反代兼容路径）只收 peer 凭据，设备凭据与非 peer 的 Bearer（网页 token、scoped token）一律 403（权限矩阵：`tests/session-gates.test.ts`）。主端口与接管的旧 web 端口对每个请求都定来源（`relay-inbound.ts` `socketTrust`）：带隧道标记的是 `relay`，回环 socket 且无 XFF 的是 `loopback`，其余是 `lan`（`clientIp` 取 socket 地址，`https` 跟随 `x-forwarded-proto`）。

peer 入口只见其中两种：回环 socket、没有中继标记、也没有隧道标记头 = 本机反代（`tailscale serve` 把 `/api/v1` 挂在这里，网页经 HTTPS 入口也走它），按主端口经反代对待（来源 `lan`，设备 cookie 照认——这一类成立的前提是上面的同源断言，而且入口端口不是网页端口：选端口时避开网页端口，两者相同时隧道一律 `local_unreachable`）；中继 peer 帧与非回环 socket（`PEER_INGRESS_PUBLIC=1` 对外直连）来源是 `peer-ingress`，删掉 cookie 与设备头，不带凭据只放兑换（`POST /api/v1/peers/redeem`）与邀请页（`GET /api/v1/invite`），设备端点与设备凭据一律 403；回环反代即使带 XFF 仍保留设备 cookie 与设备端点，但不享受 loopback 豁免；所有来源的非 peer Bearer 均在此端口拒绝。`legacy-session` 只认 `loopback` / `lan`（包含此反代兼容路径），不认 `peer-ingress` / `relay`。

bridge 再按 peer token 与 scope 放行，并对 peer token 强制验签：签名钥匙的指纹 MUST 等于这个 peer 的期望指纹（peers.json 的 `fp` → `relay://<fp>` 基址 → 首次签名时钉住的指纹；记了完整公钥 `publicKey` 的只认这一把），不签、签错、过期、换了钥匙都 401；公钥与签名都只认规范的无填充 base64url。直连（不经中继）的 peer 请求同样如此。顺序是：验签 → 防重放（非 GET / HEAD 的签名在有效期内只认一次；GET / HEAD 同一签名第二次起照放行但不扣额度——正牌 peer 同一秒对同一路径发两次签名相同——超过 5 次按重放拒；签于本进程启动之前但仍在验签有效期内的 GET 同样纳入计次：第一次扣额度，重复沿用上述限制，不回 `before_start`；bridge 另持一份 `ReplayCache`，所有入口共用）→ 记下验签结果 → 扣成功请求的限速额度；重放 401，不扣额度、不写 `peer-keys.json`。验签失败另有一个每 peer 每分钟 120 次的桶，超了 429（`reason: sig_rate_limited`，`cause` 是这次失败的原因）；失败只记在内存，由定时器每分钟最多补写一次，钉住的钥匙不动。不限速的路由（远程终端）不收 peer token，一律 403。三样都没有的老 peer 在截止日（默认 2026-11-01，`PEER_LEGACY_DEADLINE` 可覆盖）前放行并告警（doctor 会列出来）；截止日之后一律拒（`reason: unanchored`），签名对得上也不再现钉。邀请里带的 token 在兑换之前只能读（`invite_read_only`），邀请过期或撤销即失效（`invite_expired`，不等清扫）。经中继来的请求（路径模式 §6 与 §4.2 的隧道，bridge 里来源都是 relay）不收 peer token，也不接兑换邀请，一律 403；控制面闸门看到隧道标记就不当本机，不单靠 XFF。

直连兑换时，bridge 用兑换请求自带签名的钥匙（指纹与完整公钥）记下这个 peer（经中继兑换用 `from` 与已核过的签名钥匙）。兑换带来的实例 id 命中已有记录时，只有这把钥匙等于那条记录的期望钥匙才合并；对不上（含没签名、那条记录没有期望指纹）则拒绝兑换（`code: iid_taken`），不建第二条同实例 id 的记录，原记录与它的 token 不动；同一张邀请被这样拒满 3 次就作废并吊销内嵌 token。兑换端点的限速先核 join 口令再计数：口令不对的按来源（中继发件人指纹 / socket 地址）分桶，每个来源每分钟 10 次；口令对的进全局桶（每分钟 30 次）。

### 4.2 隧道请求（`from: "relay"`）

实例把它原样重放到本机 Web（`http://127.0.0.1:<WEB_PORT>`，默认 3333），路径不限、不验签（浏览器没有实例密钥；身份由 Web 自己的会话 cookie 决定，与今天 Tailscale 直连一样）。头里 `host` 设为中继盖的 `x-forwarded-host`（= `<slug>.<base>`，front 已剥掉浏览器自带的 `x-forwarded-*`），保留 `x-forwarded-*`，且 `x-forwarded-for` MUST 非空（中继没给或给了空值就写 `unknown`：本机 Web 端口可能由 bridge 接管，bridge 只把「回环且无 XFF」认作本机进程，隧道请求绝不能落进这一档），去掉帧里除 `x-claudestra-relay-base` 之外的 `x-claudestra-*` 头，再加上只有本进程知道的隧道标记头（bridge 主端口 / 接管的旧 web 端口认出它就把来源定成 relay，与路径模式同等对待：peer token 403、不算本机、不算同机），带正文的请求不复用到本机 Web 的连接（本机 Web 提前回响应、没读完分块正文时，同一条连接上的下一个请求会得 400；bridge 一侧也会把提前拒绝时没读的正文读掉，最多 64KB / 1 秒绝对期限（收到字节不续期，取消操作不阻塞响应），超过就取消并在响应上带 `Connection: close`，`bridge/unread-body.ts`），去掉 hop-by-hop、`content-length` 与 `accept-encoding`（让 Web 回未压缩正文：实例侧 fetch 会解码，再带着 `content-encoding` 浏览器会解两次）。响应去掉 `content-encoding`；`location` 若以 `http://<slug>.<base>` 或 `http://127.0.0.1:<WEB_PORT>` 开头 MUST 改写为 `https://<slug>.<base>`（Web 在明文端口上算出的绝对地址，浏览器连不到）。

### 4.3 一键邀请的持钥证明（协议新增字段）

邀请串里的 `fp`、`iid`、`url` 是邀请方自报的，谁都能抄进自己的邀请或在转交途中改掉。加入方要把新联系人合进已有记录、或记下对方的指纹 / 实例 id，凭的是邀请方的**持钥证明**（`lib/invite-proof.ts`）：

| 位置 | 字段 | 规定 |
|---|---|---|
| 兑换请求正文 | `nonce` | 加入方每次兑换现生成的 128 位随机数（base64url，≥ 22 个字符），只在这一次兑换里认 |
| 兑换请求正文 | `inviteUrl` | 加入方手里邀请串的原始地址（`--peer-url` 改的是连哪里，这里仍写原始值）。邀请方把它和这张邀请生成时的地址按同一口径比较（`relay://` 取小写指纹；http(s) 取协议 + 主机 + 去掉尾斜杠的路径），不一致 → `code: invite_url_mismatch`，计入这张邀请的拒绝次数 |
| 兑换回复 | `proof: { key, sig }` | 邀请方的实例公钥与签名。签的是 `claudestra-invite-pop-v1\n<nonce>\n<join 口令>\n<兑换方指纹>\n<邀请方实例 id>\n<邀请地址>`；用途前缀只认登记过的（`instance-key.ts` 白名单），挪不成请求签名（`claudestra-req-v1`）或中继登录签名（`claudestra-relay-auth-v2`），也挪不到别的用途 |
| 兑换回复 | `iid` | 邀请方实例 id（签在证明里） |
| peers.json 记录 | `publicKey` | 对方完整公钥（兑换签名或持钥证明得来）；有它验签只认这一把 |

邀请方只在兑换成功、知道兑换方是谁（签名核过）且请求带了 `nonce` 与 `inviteUrl` 时签。加入方核对：证明签名对得上本次的 `nonce`、口令、自己的指纹、自己手里邀请串的地址（把兑换原样转给真邀请方换来的证明，签的是真邀请方的地址，对不上）；签名钥匙的指纹 MUST 等于邀请里写的 `fp`（和 `relay://` 地址里的指纹）。合进已有记录、那条记录有期望指纹时，证明的钥匙 MUST 就是它（记了公钥的比公钥），或者 `relay://` 地址里的指纹就是它；否则拒绝加入并回滚本机记录（老版本邀请方给不出证明也在这里：「对方升级后重新发一张邀请，或者删掉旧联系人再加入」）。指纹、公钥、实例 id 只从证明里取；证明里的实例 id 已属于另一条记录时同样拒绝。没有证明时 `relay://` 地址记地址里的指纹；http 地址在截止日前什么都不记（按老 peer 验签），截止日后直接拒绝加入并回滚（「对方版本过旧，请先升级」），不留一条对方永远进不来的记录。

## 5. 目录、slug、配对短码

### 5.1 slug 分配

握手时实例给出想要的 slug；中继：这个 slug 没人用或就是本指纹在用 → 照给；被别的指纹占着 → 追加 `-<指纹前 4 位>`，还冲突再追加 `-<前 8 位>`，仍冲突用整个指纹去横线的 16 位十六进制（这一步不可能再撞：那就是本指纹自己）。welcome 里返回最终值。同一指纹换 slug（`.env` 改了 `RELAY_NAME`）→ 目录里更新，旧 slug 释放。中继 MUST NOT 让两把钥匙同时持有一个 slug。

### 5.2 配对短码

```json
{ "t": "code", "op": "put", "code": "K7PM2XQ9", "exp": 1790000600 }
{ "t": "code", "op": "del", "code": "K7PM2XQ9" }
```

实例生成 8 位短码（字母表 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`，无 0/O/1/I；展示时 `K7PM-2XQ9`，输入不分大小写、可带中划线），登记到中继，中继只存 `code → fp`，front 靠它把只有键盘的用户送到正确的实例（§6）。`exp` 是 Unix 秒，中继把它 clamp 到最多 15 分钟后（`codeTtlMs` + 5 分钟余量）。**短码的校验在实例本机**（bridge 侧一次性、10 分钟、每分钟 5 次尝试），中继只做映射；中继上过期即删。每实例同时最多 5 个短码，超过、或这个码已被别的实例占着 → `error rate_limited`（不带 `id`，message 说明）；`del` 不存在的码静默忽略。

### 5.3 目录持久化

SQLite：`instances(fp PRIMARY KEY, public_key UNIQUE, slug UNIQUE, name, first_seen, last_seen)`、`codes(code PRIMARY KEY, fp, expires_at)`。连接表、联系人、pending 只在内存。中继不存任何请求内容、头或 token。

## 6. front：中继的 HTTPS 入口

front 按 `Host`（反代之后按 `X-Forwarded-Host`）分两种：

**`<base>` 本身**（中继自己的页面，无状态）：

| 路径 | 行为 |
|---|---|
| `GET /healthz` | `{"ok":true,"online":N,"pending":M,"version":"…","commit":"…"}`（`commit` 有才带：`RELAY_COMMIT` 或部署脚本写的 `.relay-commit`），无身份信息；不看主机名 |
| `GET /v1/ws` | WebSocket 升级（§1）；不看主机名 |
| `GET /` | 一页静态 HTML：输入配对短码 → 跳 `/c/<code>`；说明「这是一台中继，要用 Claudestra 先在你的电脑上装 bridge」。`?e=code` 显示「无效或已过期」 |
| `GET /c?code=…` | 无 JS 的表单提交 → `302 /c/<code>` |
| `GET /c/<code>` | 短码有效 → `302 https://<slug>.<base>/pair#<code>`（浏览器把 # 带过去）；无效 → `302 /?e=code`；同一地址查太多次 → `429` 页（§6.1） |
| `GET /i` | 邀请落地。带 cookie `cstra_home=<slug>`（形状合法）→ `302 https://<slug>.<base>/join`（邀请载荷在 #，浏览器原样带过去）；没有或形状不对 → 一页 HTML：读 # 里的邀请、显示「谁邀你」，让用户输入自己的 slug 或短码后跳到自己的实例 `/join#…`，或引导安装 |
| 其它 | `404`；非 GET / HEAD → `405` |

**`<slug>.<base>`**（隧道）：slug 形状不合法或主机名不属于 `<base>` → `404 unknown host`；slug 没登记过 → `404` 页「没有叫这个名字的 Claudestra」；登记过但不在线 → `503` 页「这台电脑不在线」（离线也给页面，不是裸错误）；在线 → 转成 `req` 帧（§3.1，`from:"relay"`），请求正文 > `maxChunkBytes` 就切成 `data` 帧；收到 `res` 立刻回状态与头，`data` 逐块写给浏览器，`end` 收尾；浏览器断开 → 发 `cancel`；实例回 `error` 或等不到头 → `502` JSON `{ok:false,error:<code>,message}`。WebSocket 升级请求在隧道上 → `426`（本版不隧道 WS；Web 用的是 SSE）。

front 的响应头补 `strict-transport-security`；不改写 HTML；不缓存。

### 6.1 front 的限流与上限

这些都是中继自己扛流量的闸，与实例连接上的配额（§3.4、§4）无关；数值在 `LIMITS`，`RelayOptions.limits` 可覆盖。

| 项 | 默认 | 超限 |
|---|---|---|
| 短码查询 `/c/<code>`，每 IP | 30 / 分钟 | `429` 页；`/c?code=` 的 302 不计数 |
| 隧道请求，每 IP | 600 / 分钟（一页几十个资源，别卡正常浏览） | `429` 文本，`retry-after: 60`，不进实例 |
| 每台实例同时在途的隧道请求 | 256 | `503` JSON `{ok:false,error:"too many concurrent requests"}`，`retry-after: 5`；多半是它的 Web 卡住不回 |

IP 的取法与握手限流相同：`RELAY_TRUST_PROXY=<受信反代层数>` 时取 `X-Forwarded-For` 从右数第这么多项（最右是最近一层反代追加的对端，更左边的客户端自己能写；项数不够、层数超过 5 都不认），否则取连接对端。按 IP 的配额 IPv6 按 /64 计数，内嵌 IPv4 的写法（映射、NAT64 `64:ff9b::/96`、兼容地址）按那个 IPv4，带端口的先去端口，认不出的写法共用一个桶（`src/relay/limiter.ts` `ipLimitKey`）。

### 6.2 路径模式：`<base>/m/<fp>/api/v1/…`（docs/design-hosted-frontend.md）

同一个主源下按机器指纹路由，前端由中继托管、按机器只转 API。与子域名模式并存到兼容截止；两者走同一条隧道（§3），差别只在 front：

| 项 | 路径模式 |
|---|---|
| 匹配 | `^/m/<fp>(/…)?$`，fp 大小写不敏感；fp 形状不对 → `404 {ok:false,error:"machine_unknown"}` |
| 路径规范化 | 去掉前缀后解一次百分号编码：必须落在 `/api/v1` 下；含 `.`/`..` 段、连续 `/`、`\`、控制字符、编码过的 `/` `\` `%` `.` → `400 {ok:false,error:"path_forbidden"}`；带 `Upgrade` → `426`。中继不是任意转发器，控制路由与静态文件永远到不了实例 |
| 目标 | `byFp`：没登记 → `404 machine_unknown`；不在线 → `503 {ok:false,error:"machine_offline"}` + `retry-after: 10`（都是 JSON，调用方是 API 客户端） |
| 发给实例的 req 帧 | `path` = 去前缀后的路径 + 查询串；头里客户端自带的 `x-forwarded-*` / `x-claudestra-relay-*` 一律丢弃后再加：`x-forwarded-for`、`x-forwarded-proto: https`、`x-forwarded-host: <base>`、`x-claudestra-relay-base`、**`x-claudestra-relay-mode: api`**、**`x-claudestra-relay-prefix: /m/<fp>`**；`Cookie` 只保留 `cstra_dev=…` 这一对（主源上别的 cookie 与这台机器无关） |
| 实例侧 | 看到模式头就在进程内直接调 API（不经回环 HTTP，来源标记为 relay，不享回环豁免）；没有模式头 = 旧子域名隧道，照旧打本机 Web |
| 回给浏览器的响应头 | `Set-Cookie` 只放名为 `cstra_dev` 的，属性一律改写为 `Path=/m/<fp>/; HttpOnly; Secure; SameSite=Strict`（保留 `Max-Age` / `Expires`；值为空 = 删除）；`clear-site-data`、`service-worker-allowed`、`alt-svc` 丢弃；根相对 `Location` 补上 `/m/<fp>` 前缀。一台机器影响不到主源上别的机器 |
| 限流 | 与隧道相同（每 IP、每实例在途） |

`<base>` 上为路径模式新增的端点：

| 路径 | 行为 |
|---|---|
| `POST /api/v1/codes/lookup` `{code}` | 短码 → `{ok, fp, name, slug}`；无效 / 坏 JSON → `404 {ok:false,error:"code_invalid"}`；与 `/c/` 共用每 IP 限流；非 POST → `405` |
| `GET /app-config.json` | 前端入口配置 `{mode:"relay", relayBase, version, commit?, vapidPublicKey?}`，`no-store` |
| 静态站 | 配了 `RELAY_STATIC_DIR`（前端的 Next 静态导出目录）时，`<base>` 上没被上面接住的 GET/HEAD 按导出布局服务：`/chat` → `chat.html`，目录 → `index.html`，未知页面 → `404.html`（状态 404），`/_next/static/*` 永久缓存，HTML `no-cache`；`/`、`/i` 在有静态站时也由它服务（`/i` 带 `cstra_home` cookie 时仍 302 到子域名，兼容期） |

## 7. 错误帧与错误码

```json
{ "t": "error", "id": "r_…", "code": "peer_offline", "message": "…", "origin": "relay" }
```

`origin`：`relay` = 中继产生；`peer` = 接收方实例产生、经中继转给发起方（中继补 `from`）；`client` = 客户端库本地产生（`connection_lost` / `closed`）。

| code | origin | 含义 | 发起方应对 |
|---|---|---|---|
| `protocol_version` | relay | `v` 不是 2 | 致命：升级，5 分钟一试 |
| `frame_invalid` | relay | 坏 JSON / 形状不对 / 未知 `t` | bug，记日志 |
| `frame_too_large` | relay | 超过 `maxFrameBytes` | 不重试 |
| `nonce_expired` | relay | auth 晚于 60 秒 | 立即重连 |
| `auth_failed` | relay | 签名与 `key` 对不上 | 致命，5 分钟 |
| `fingerprint_conflict` | relay | 另一把钥匙同指纹 | 致命 |
| `replaced` | relay | 同钥匙新连接顶掉了这条 | 固定 300 秒再试（克隆了 STATE_DIR 的两台机器会互顶，靠日志发现） |
| `not_authenticated` | relay | welcome 前发业务帧 | bug |
| `peer_unknown` | relay | 目标不存在 / 没把你列为联系人 | 不重试 |
| `peer_offline` | relay | 目标不在线 | 不重试，报「对方不在线」 |
| `duplicate_id` | relay | `id` 撞了在途请求 | bug |
| `rate_limited` | relay | 超过 §3.4 / §4 配额，或短码登记超过每实例上限 / 撞码（§5.2） | 按 429 报 |
| `auth_timeout` / `heartbeat_timeout` | relay | 10 秒内没 auth / 75 秒内没任何帧，紧跟关闭 4408 | 退避重连 |
| `timeout` | relay | `timeoutMs` 内没有 `res` | 不重试 POST |
| `stream_idle` / `stream_max` | relay | 流态空闲超时 / 总时长超限 | 不重试 |
| `peer_disconnected` | relay | 等待期间对方断线 | 不重试 POST |
| `unknown_request` | relay | `res` / `data` / `end` / `cancel` 对不上 pending（已超时、发起方已断、或 `to` 填错） | 记日志 |
| `bad_signature` / `replay` / `path_forbidden` / `sender_forbidden` | peer | §4.1（`path_forbidden` 也用于隧道路径不是本机绝对路径） | 不重试；发起方按原因提示（`lib/peer-auth-hints.ts`），不说成网络不可达 |
| `replay_full` | peer | §4.1 第 4 步防重放缓存已满（兑换帧另有一份小缓存） | 稍后重试 |
| `payload_too_large` | peer | peer 请求正文超过接收方上限（bridge 侧 2 MiB；正文要收齐验签，不能无限收） | 不重试 |
| `local_unreachable` / `local_timeout` | peer | 接收方连不上 / 等不到本机入口 | 不重试 |

## 8. 心跳、重连、关闭码

| 项 | 值 |
|---|---|
| 心跳 | 实例每 25 秒 `{t:"ping",ts}`，中继回 `pong`；中继收 `ping` 必答 |
| 判死 | 实例 20 秒没 pong → 断开重连；中继 75 秒没收到任何帧 → 关闭 4408 |
| 重连退避 | 1, 2, 4, 8, 16, 30, 30 … 秒 ±20%；稳定 ≥ 60 秒后归零 |
| 致命错误退避 | 300 秒（`auth_failed` `fingerprint_conflict` `protocol_version` `replaced`） |
| 断线时的在途请求 | 发起方本地以 `connection_lost` 拒绝全部；中继清掉涉及该连接的 pending 并通知另一头（发起方收 `peer_disconnected`，接收方收 `cancel`） |
| 中继侧限流 | 握手每 IP 10 / 分钟（关闭 4429）；每连接 120 请求 / 分钟、64 在途；兑换邀请每发起方 6 / 分钟；push 帧每实例 60 / 分钟（§3.5）；front 的三项见 §6.1 |

关闭码：1000 主动关；1012 中继重启（立即重连）；4400 协议违规（含二进制帧、连续 3 个坏 JSON、未认证先发业务帧）；4401 认证失败 / nonce 过期；4403 目录拒绝（`fingerprint_conflict`）；4408 超时（`auth_timeout` / `heartbeat_timeout`）；4409 被顶替；4413 帧过大；4429 握手洪水。

## 9. 安全边界（本版）

中继**能**：看见帧内明文（含 token 与正文）；知道谁在线、谁调了谁、多大、多久、从哪个 IP 来；拒绝转发；替换 front 送出的任何内容（它就是 HTTPS 终点）。

中继**不能**：冒充实例发 peer 请求（没有私钥；接收方验签，核对 token 属于签名者，bridge 对 peer token 强制验签，路径模式不收 peer token）；未经 B 列为联系人就替 A 敲 B 的门（除兑换邀请那一条限流路径）。

明说的残余风险，留给下一版端到端加密：隧道里的 Web 流量（含会话 cookie）对中继可见；中继若能直连某台实例的 Web 端口（同机部署）就能绕过一切。缓解：不在跑 bridge 的机器上跑中继；Web 与 peer 入口默认只听本机。中继日志 MUST 只记信封：时间、from、to、id、方法、路径前缀、大小、状态、耗时；不记头与正文，不记 `/c/<code>` 的短码值。

## 10. 测试向量

固定种子生成，任何实现 MUST 复现。私钥 = PKCS#8 前缀 `302e020100300506032b657004220420` + 种子。

```
seed(hex)   0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20
publicKey   ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ
fingerprint 65b6-0673-d6ed-884b
```

请求签名（`claudestra-req-v1`）：

```
POST /api/v1/agents/claudestra/messages  ts=1790000000  body={"text":"hello","wait":25}
sig  iScsvxVcjcHTN-zENfr5fVsaqqEAI23msC0jUqoeQ0ECnqWXGctckYWbKmMtj30TbJLI5g4r1ktbAvZ_mMNAAA
GET  /api/v1/agents  ts=1790000000  空正文
sig  bDtmKeo0J-44eoYMOZsgi2yUv22AKDemJD5TdlzZsh1yKD3UeenhiXjo0DBZuTo9Rm2HF-pa3q6sDhjkn0aKCQ
```

握手签名（`claudestra-relay-auth-v2`，向量由 `tests/relay-protocol.test.ts` 用同一种子生成并钉住）：

```
nonce  oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8
name   MacBook-A
slug   macbook-a
sig    JaWyysd1-D9wa1rQt94MjYMgmNzu1vEboFjmBzHR78LpfcOwEBJrYlb-MJvt4dt6LRCSRfvq6eyaTawFj5x4Ag
```
