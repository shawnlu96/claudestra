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
| 帧上限 | 默认 256 KiB（`RELAY_MAX_FRAME_BYTES`）。正文分块走 `data` 帧，单块原始字节 ≤ `maxChunkBytes`（默认 160 KiB，base64 后仍在帧上限内） |
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
  "limits": { "maxFrameBytes": 262144, "maxChunkBytes": 163840, "maxReqTimeoutMs": 180000, "heartbeatMs": 25000 } }
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
{ "t": "welcome", "v": 2, "fp": "16f9-b5d1-30fb-8923", "slug": "mini", "name": "Shawn 的 Mac mini", "base": "relay.example.com" }
```

`slug` 是中继最终分配的（§5.1），实例 MUST 以它为准；`base` 让实例拼出自己的网页地址 `https://<slug>.<base>` 与配对 / 邀请链接。welcome 之后连接进入**在线**状态，才允许发业务帧。

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
2. 按 `instance-key.ts` 的 canonical 验：`claudestra-req-v1\n<METHOD>\n<path>\n<ts>\n<sha256(body) hex>`，body 是完整请求正文的原始字节（流式正文先收齐再验——peer 路径的正文都是小 JSON）；偏差 ±300 秒。不过 → `bad_signature`。
3. 防重放：非 GET / HEAD 的 `x-claudestra-sig` 10 分钟内见过 → `error replay`。

验过后打到本机 **peer 专用回环入口**（`src/bridge/peer-ingress.ts`，端口 `.env` 的 `PEER_INGRESS_PORT`），头里去掉 hop-by-hop、`host`、`content-length`、`x-forwarded-*` 与发起方自带的 `x-claudestra-relay-*`，加 `x-claudestra-relay-from: <from>`。bridge 照旧按 peer token 与 scope 放行。

### 4.2 隧道请求（`from: "relay"`）

实例把它原样重放到本机 Web（`http://127.0.0.1:<WEB_PORT>`，默认 3333），路径不限、不验签（浏览器没有实例密钥；身份由 Web 自己的会话 cookie 决定，与今天 Tailscale 直连一样）。头里 `host` 设为中继盖的 `x-forwarded-host`（= `<slug>.<base>`，front 已剥掉浏览器自带的 `x-forwarded-*`），保留 `x-forwarded-*`，去掉 hop-by-hop、`content-length` 与 `accept-encoding`（让 Web 回未压缩正文：实例侧 fetch 会解码，再带着 `content-encoding` 浏览器会解两次）。响应去掉 `content-encoding`；`location` 若以 `http://<slug>.<base>` 或 `http://127.0.0.1:<WEB_PORT>` 开头 MUST 改写为 `https://<slug>.<base>`（Web 在明文端口上算出的绝对地址，浏览器连不到）。

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

IP 的取法与握手限流相同：`RELAY_TRUST_PROXY=1` 时取 `X-Forwarded-For` 第一项，否则取连接对端。

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
| `bad_signature` / `replay` / `path_forbidden` | peer | §4.1 | 不重试 |
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
| 中继侧限流 | 握手每 IP 10 / 分钟（关闭 4429）；每连接 120 请求 / 分钟、64 在途；兑换邀请每发起方 6 / 分钟；front 的三项见 §6.1 |

关闭码：1000 主动关；1012 中继重启（立即重连）；4400 协议违规（含二进制帧、连续 3 个坏 JSON、未认证先发业务帧）；4401 认证失败 / nonce 过期；4403 目录拒绝（`fingerprint_conflict`）；4408 超时（`auth_timeout` / `heartbeat_timeout`）；4409 被顶替；4413 帧过大；4429 握手洪水。

## 9. 安全边界（本版）

中继**能**：看见帧内明文（含 token 与正文）；知道谁在线、谁调了谁、多大、多久、从哪个 IP 来；拒绝转发；替换 front 送出的任何内容（它就是 HTTPS 终点）。

中继**不能**：冒充实例发 peer 请求（没有私钥，接收方验签）；未经 B 列为联系人就替 A 敲 B 的门（除兑换邀请那一条限流路径）。

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
