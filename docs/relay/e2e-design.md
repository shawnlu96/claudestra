# 设计稿：中继端到端加密（E2E）

> 状态：**设计稿，未开工**（2026-09-28）。只做调查、给推荐，不含产品代码。
> 范围：路径模式 `/m/<fp>/api/v1`、peer、推送、配对。子域名隧道只写退场（§7.3）。
> 前置阅读：[protocol.md](./protocol.md)（尤其 §9「安全边界」）、[design-hosted-frontend.md](../design-hosted-frontend.md) §4、§5、§7、§11。

## 0. 结论先说

1. **真正的难点不是加密，而是「浏览器里跑的代码是谁给的」。** 前端由中继托管，中继想作恶就能给你一份改过的 JS。那份 JS 可以直接把明文和密钥发走，所以只在浏览器和 bridge 之间加密，挡不住**主动作恶的中继运营方**。能挡住它的只有「代码不从中继来」：iOS 壳打包前端、本机或 Tailscale 直连、自带域名直托管，或者以后浏览器支持的代码透明（WAICT，目前只是草案）。
2. 应用层加密依然值得做。它挡得住的是更常见的几类风险：被动窥探、日志和内存泄露、中继被入侵但静态文件没被换、事后被要求交出数据。做完之后，中继手里只剩元数据：哪台机器、什么时候、多大流量、从哪个 IP 来。
3. **推荐分三期**：
   - **P1**：推送改为 bridge 自己加密，中继只负责签 VAPID 和投递；peer 请求整体加密，所有 peer 入口强制验签。两件都不牵涉前端可信问题，改动也小。
   - **P2**：浏览器与 bridge 之间的会话加密。设备密钥在配对时由秘密 `S` 绑定；bridge 可设为「经中继只收加密请求」。
   - **P3**：可信客户端。iOS 壳打包前端，更新靠签名校验；每次发版公布签名过的 bundle 清单；跟进 WAICT。
4. **TLS 直通（只按 SNI 分流）不作主线。** 它等于退回每台机器一个子域名、每台机器各自出一份前端，正好推翻了托管前端刚解决的问题。另外中继运营方控制 DNS，自己签一张证书就能中间人，只能靠证书透明日志（CT）事后发现。它的长处（前端由用户自己的机器提供）今天用「直托管加自带域名」已经能拿到，留给要求最高隔离的用户。

## 1. 现状：中继今天看得见什么

| 数据 | 路径 | 中继看得见 | 依据 |
|---|---|---|---|
| 聊天、终端输出、会话历史、附件 | 浏览器 → 中继 front（TLS 在这里终止）→ `req`/`data` 帧 → bridge | **明文** | protocol.md §3、§6.2 |
| 设备凭据 `cstra_dev` | 配对响应 `Set-Cookie`，之后每个请求都带 | **明文**。中继甚至要改写它的属性 | protocol.md §6.2 |
| 配对秘密 `S` | 二维码或链接的 `#` 片段 | 看不到，`#` 不会上网络 | design-hosted-frontend §4 |
| 配对证明 `HMAC(S, challenge)` | 经中继 | 看得见，但它只证明「持有 S」。配对结果（上一行的 cookie）同样经过中继 | 同上 |
| 手输短码 | 登记在中继：`code → fp` | 看得见。靠 Mac 侧确认兜底 | protocol.md §5.2 |
| Web Push 正文 | bridge → `push` 帧 → 中继做 RFC 8291 加密 → 推送服务 | **明文**，因为是中继替机器加密 | protocol.md §3.5 |
| APNs 正文 | 同上，中继持有 p8 | **明文**；Apple 也看得见 | 同上 |
| peer 请求 | A → 中继 → B | **明文**，包括 `Authorization: Bearer <peer token>`。**现有漏洞（T25）**：① 路径模式 `/m/<fpB>/api/v1/*` 原样转发 `Authorization`（`relay/front.ts` 的 `tunnelHeaders`），bridge 的 `authenticateApi` 不看来源就收 Bearer，所以中继拿看到的 token 从路径模式发请求，完全绕过验签；② peer 路径只核「签名钥匙的指纹 = `from`」，不核这枚 token 是不是签发给这个 fp 的（`bridge/relay-inbound.ts` 的 `verifyPeerRequest`）。所以「中继签不出 A 的签名、就冒充不了 A」**今天不成立** | protocol.md §4.1；T25 |
| 元数据 | 所有路径 | 在线状态、联系人图、fp、IP、时间、大小 | protocol.md §4、§9 |
| 前端 JS / HTML / SW | 中继静态托管 | 中继**提供**这些代码，能换成任何内容 | protocol.md §6.2「静态站」 |
| 子域名隧道请求 | 中继 → `from:"relay"` → 实例把它重放到本机 Web 端口 | **现有漏洞（T25）**：`forwardTunnel` 不强制带 XFF。迁移过旧 web 的机器，3333 端口已由 bridge 接管，这类请求会被当成真本机，享受回环豁免 | protocol.md §4.2；T25 |

## 2. 威胁模型

### 2.1 资产

- **C1 内容**：消息正文、终端流、附件、会话历史、推送正文。
- **C2 凭据**：设备凭据、peer token、配对秘密、设备私钥。
- **C3 控制权**：能不能以用户身份调 API，包括终端，而终端等于宿主 shell。
- **C4 元数据**：谁在线、谁和谁联系、流量的大小和时间、IP。

### 2.2 攻击者

| # | 攻击者 | 能力 |
|---|---|---|
| A1 | 被动的中继：好奇的运营方、日志或备份泄露、内存转储 | 读取经过的帧，不改 |
| A2 | 被入侵的中继进程：能改帧，**没动**静态文件目录 | 读、改、丢、重放帧，自己发起请求 |
| A3 | 恶意运营方，或被强制配合 | A2 的全部能力，外加**给指定用户下发改过的 JS 或 SW** |
| A4 | 网络上的攻击者 | TLS 之外的东西 |
| A5 | 同一中继上的其它实例 | 发 `req` 帧，受联系人门控限制 |
| A6 | 某台机器的恶意输出（agent 回复里注入内容） | 在同源页面里造成 XSS，借用同一浏览器里其它机器的凭据 |
| A7 | 推送服务（Apple、Google、Mozilla） | 看到推送密文、通知展示文本、时间 |
| A8 | CA 或 DNS 运营方 | 签发中继域名下的证书 |

### 2.3 每期之后谁还能拿到什么

「能」= 能拿到明文或能冒用；「元」= 只剩元数据。

**前提**：这张表假设 **T25 已修**（路径模式不收 peer Bearer；peer token 绑定签发对象的 fp；隧道请求永远不算回环）。T25 是无条件修复，不挂在任何 E2E 开关后面。T25 修好之前，今天那一列里 A2 对 C3 的「能」要更严重：拿任何一枚看到过的 peer token，都能以那个 peer 的 scope 调 API。

| 攻击者 | 今天 | P1 后 | P2 后（浏览器用中继托管的前端） | P3 后（可信客户端） |
|---|---|---|---|---|
| A1 被动 | C1、C2 能 | 推送正文和 peer 转为「元」 | C1、C2 转为「元」 | 元 |
| A2 改帧 | C1、C2、C3 能 | 同左，推送和 peer 除外 | **只在开了 `RELAY_E2E_ONLY` 的机器上**转为「元」：中继能丢帧或拖慢，但改不了、伪造不了、重放不了、也换不了响应（§4.1.4）。**没开的机器**（存量机器默认不开，§7.2）：明文路径还在，老设备的 cookie 仍然经过中继，A2 照旧拿得到 C1、C2、C3 | 同 P2 |
| A3 换 JS | 全能 | 全能 | **仍然全能**：改过的 JS 直接读明文、用设备密钥 | 可信客户端上转为「元」；浏览器用户照旧全能，只是可以事后审计（§4.4） |
| A5 其它实例 | 受门控 | 同左 | 同左 | 同左 |
| A6 跨机器 XSS | 借用凭据 | 同左 | 借用设备密钥（不可导出，偷不走，只能借用） | 同左 |
| A7 推送服务 | 看通知文本 | Web Push 只看密文；APNs 看通用文本（壳里的 NSE 负责解密） | 同左 | 同左 |
| A8 CA | 能对中继域名做中间人，但中继本来就能看 | 同左 | 看到的只有密文 | 同左 |

### 2.4 明确不防的

- **元数据**：连接关系、在线状态、流量模式。分块填充可以作为 P2 的可选项，只防粗粒度的大小分析。
- **拒绝服务**：中继可以不转发。
- **模型厂商**：agent 的内容本来就要发给模型接入商，与中继无关。
- **本机被入侵**：bridge 所在机器等于全部权限。
- **浏览器里的 A3**：除非用可信客户端或代码透明（§4.4）。这一条必须在对外说法里写明，不能淡化（§8）。

## 3. 核心约束：代码从哪来

| 事实 | 出处 |
|---|---|
| SRI 只能校验页面引用的子资源，校验不了顶层 HTML 本身 | Cloudflare WAICT 博客原文：「there is no way for a page to enforce the hash of the pages it links to」 |
| 旧 SW 否决不了新 SW：取 SW 脚本时 service-workers mode 设为 none，旧 SW 拦不到；超过 24 小时强制绕过 HTTP 缓存 | W3C Service Worker 规范（Update 算法；「last update check time … greater than 86400」） |
| 浏览器端的代码透明（WAICT）还在标准化早期，Firefox Nightly 里有需要手动开启的原型 | Cloudflare 博客、Mozilla Hacks 2026-05 |
| Chrome 的 Isolated Web Apps / Signed Web Bundles 目前只对企业管理设备和部分合作方开放，普通网站用不了 | Chrome 开发者文档 |
| Meta Code Verify 是浏览器扩展，拿页面代码的哈希对照第三方保存的真值 | engineering.fb.com，2022-03 |

结论：**纯 Web 形态下，只要托管代码的一方想作恶，今天的浏览器里没有办法防住它**。可行的路只有两条：让代码不经中继来（壳、直连、直托管），或者让作恶可以被发现（签名清单 + 扩展，以后是 WAICT）。所以本设计把「加密」和「代码可信」拆开写：§4.1 加密解决 A1、A2；§4.4 代码可信解决 A3。两者都做了，才能对外说「中继看不到」。

## 4. 方案

### 4.1 方案 A：浏览器 ↔ bridge 的应用层加密（推荐，P2）

#### 4.1.1 密钥

| 密钥 | 在哪 | 算法 | 为什么这样选 |
|---|---|---|---|
| 机器身份 | `STATE_DIR/instance-key.pem`（已有） | Ed25519 | 不动。用它签下一行的 ECDH 公钥，把加密密钥绑到 fp 上 |
| 机器会话密钥 | `STATE_DIR/e2e-key.pem`（新） | **P-256 ECDH** | 浏览器侧必须用 P-256（见下一行），ECDH 两端曲线要一致 |
| 设备密钥 | 浏览器 IndexedDB，按机器存；不可导出 | **P-256 ECDH** | **实测**：Safari 26.5.2 里 X25519 的 CryptoKey 存不进 IndexedDB，读回来是 `null`，`structuredClone` 报「Unable to deserialize data」。P-256 和 Ed25519 能存能读，SW 里也能用（§9.1） |
| 会话密钥 | 两端内存 | HKDF-SHA256 → AES-256-GCM | 全部用 WebCrypto 原语，不引入自写的密码学 |

加密套件就定这一套：P-256 + HKDF-SHA256 + AES-256-GCM，与 HPKE 的 DHKEM(P-256) 套件同一组原语。浏览器、bridge、peer（§5.1）共用一份实现：`src/lib/e2e/*` 与 `web/lib/e2e/*` 在 `scripts/guard/config.ts` 里登记为 twin，再用同一组测试向量钉住两边。

#### 4.1.2 配对时绑定设备密钥

现有二维码配对里，`S` 不经过中继。这是整个方案的信任根，要充分利用它：

1. 链接从 `#<fp>.<S>` 升级为 `#2.<fp>.<S>`。新前端看到 `2.` 走本流程；老前端不认识，就回退到现有流程。
2. 浏览器生成设备密钥 `D`，发出 `POST /m/<fp>/api/v1/devices/pair`，正文为 `{v:2, challenge, devicePub, mac}`，其中 `mac = HMAC(S, "pair-v2-req" ‖ challenge ‖ devicePub)`。
3. bridge 验 mac，记下 `devicePub`，然后回复 `{machineE2ePub, idSig, mac2}`：
   - `idSig`：Ed25519 身份密钥对 `machineE2ePub ‖ devicePub ‖ challenge` 的签名；
   - `mac2 = HMAC(S, "pair-v2-res" ‖ challenge ‖ devicePub ‖ machineE2ePub)`。
4. 浏览器验 `mac2`。中继不知道 `S`，所以换不掉任何一边的公钥。验 `idSig` 只是多一道校验。fp 只有 64 位，不单独拿它认证密钥；以后要做「只靠 fp 认人」的场景，链接改带完整公钥的哈希。
5. **不再下发 cookie**（经中继的情况）。设备凭据就是 `devicePub`，principals.json 里用 `v:2, type:"p256"` 登记，这两个字段是 design-hosted-frontend §3 预留的。

**手输短码**：短码中继看得见，它可以两头各换一把公钥做中间人（对浏览器冒充机器，对机器冒充浏览器）。对策是带**承诺**的 SAS 核对，形状照 Bluetooth 的数字比较（Numeric Comparison）和 ZRTP 的哈希承诺：

```
浏览器 → bridge   {code, devicePub, C = SHA-256("pair-v2-commit" ‖ devicePub ‖ Nd)}     // Nd：32 字节随机数，先不给
bridge → 浏览器   {machineE2ePub, idSig, Nm}                                              // Nm：32 字节随机数；bridge 收到 C 之后才生成
浏览器 → bridge   {Nd}                                                                   // bridge 核 C，不符 → 这次配对作废
SAS = 取 SHA-256("pair-v2-sas" ‖ devicePub ‖ machineE2ePub ‖ Nd ‖ Nm ‖ code) 的前 4 字节，换成十进制后 mod 10^6，得到 6 位数字
```

- 两边各自显示 SAS。Mac 侧是 `claudestra pair` 的提示和网页确认对话框，用户对上了才点确认；现在本来就要在 Mac 上确认，所以没有多出步骤。
- **为什么要承诺**：没有承诺时，中间人可以先看到一边的值，再挑自己的随机数去凑同一个 SAS。有了承诺，任一方揭示随机数之前，另一方的值都已经锁定：
  - 中间人先跑完「对 bridge」那一段，SAS_bridge 就定了；可是面对浏览器时，它必须先给出 Nm'，而这时浏览器的 Nd 还藏在承诺里，所以 SAS_browser 对它来说是随机的；
  - 中间人先跑「对浏览器」那一段，情况对称：它得先向 bridge 交出承诺，才能看到 Nm。
  - 所以每次尝试撞上的概率是 10^-6（6 位十进制，约 19.9 位）。
- **尝试次数有上限**：
  - 每次尝试都要用户在 Mac 上看一眼并点确认，SAS 对不上时用户会看到；
  - 短码一次性，10 分钟过期，bridge 每分钟最多 5 次；
  - 所以攻击者能用的尝试次数等于用户愿意点确认的次数，成功概率 ≤ 次数 × 10^-6。
- 局限（A3）：显示 SAS 的 JS 同样来自中继。

**本机回环配对**：不经中继，直接登记 `devicePub`。

#### 4.1.3 会话握手

每次页面加载（或 SW 唤醒）做一次握手，形状照 Noise KK：双方事先都知道对方的静态公钥。

```
浏览器 → POST /m/<fp>/api/v1/e2e/hello   {v:1, devId, ce:<临时公钥>, ts}
bridge → 200                              {be:<临时公钥>, sid, ttl, confirm}
k = HKDF( ECDH(ce,be) ‖ ECDH(D,be) ‖ ECDH(ce,M) ‖ ECDH(D,M), salt = transcript hash )
```

- 认证完全来自 DH，hello 不带签名：P-256 ECDH 密钥不能用来签名，也不需要签名。`confirm` 是用 `k` 对 transcript 算的 MAC，浏览器验过它，才知道对面确实持有 `M`。
- 重放一条旧的 hello 没用：bridge 每次都生成新的 `be`，中继手里没有 `D`，派生不出 `k`。
- `M` 是机器会话密钥，`D` 是设备密钥。四个 DH 值合在一起，同时提供双向认证和前向保密：临时密钥用完即丢，事后拿到 `D` 或 `M` 也解不开录下来的流量。
- 派生出两个方向各自的 AES 密钥，外加 `sid`。会话 TTL 24 小时；设备被撤销时 bridge 立刻作废该设备的所有会话。现在已有「凭据 → 活动连接」表，会话接进这张表。
- `devId` 就是设备公钥的哈希，中继能看到哪台设备在用，与今天看到 cookie 相比只少不多。

#### 4.1.4 请求、响应与流

```
POST /m/<fp>/api/v1/e2e/<sid>        （中继只看得到这一个路径；一个 HTTP 请求 = 一个加密请求）
正文 = 记录流：[len:u32][AES-GCM 密文+tag] …
记录 i 的 nonce（12 字节）= dir(1 字节：0x01 请求 / 0x02 响应) ‖ rid(7 字节) ‖ i(4 字节，从 0 起)
记录 i 的 AAD = "cstra-e2e-v1" ‖ sid ‖ dir ‖ rid ‖ i ‖ final(1 字节)
请求首条记录明文 = {rid, method, path, headers}，之后是正文分块；响应首条 = {rid, status, headers}，之后是正文分块
SSE 和终端流 = 响应持续追加记录，最后一条 final = 1
```

- **请求 id（`rid`）**：每个会话里，客户端用一个计数器从 1 起给每个请求分配。浏览器同时有多路 fetch、SSE、终端输入的 POST，它们可以乱序到达，所以**不要求按序**。
- **防重放**：bridge 对每个会话维护一个滑动窗口加位图，形状同 IPsec ESP 的防重放（RFC 4303 §3.4.3）、DTLS 的记录窗口（RFC 6347 §4.1.2.6）。窗口 1024：
  - `rid` 小于等于「已见最大值 − 1024」→ 拒；
  - 窗口内已经见过 → 拒；
  - 其余接受并记下。
  - 拒绝一律回 `409 {code:"e2e_replay"}`。
- **响应绑定请求**：响应记录用同一个 `rid` 算 nonce 和 AAD，而且 dir = 0x02。客户端用「自己发出的 rid」去解对应 HTTP 响应的记录。于是：
  - 中继把两个并发请求的响应互换，GCM 校验就失败；
  - 中继把某个请求的记录搬到另一个请求里，同样失败；
  - 中继把响应当请求回灌给 bridge，dir 不同，也失败。
- **截断与重排**：记录序号 `i` 在 nonce 和 AAD 里，调换顺序或删掉中间某条都解不开。最后一条记录的 AAD 里 `final = 1`，流被截断时客户端收不到 final，就报「中断」，不会被当成正常结束。
- **key 与 nonce 唯一性**：
  - 两个方向各用一把 AES 密钥（`key_c2b`、`key_b2c`）。它们从本会话的握手派生，`sid` 也在 HKDF 的 info 里，所以不同会话之间密钥不同。
  - 同一把密钥下，nonce = (dir, rid, i)：dir 在这把密钥下固定；客户端的 rid 计数器只在内存里递增、不回退；每个请求内的 i 递增。所以 (rid, i) 不会重复，nonce 也就不会复用。
  - 同一浏览器里的多个页面、多个标签页、SW 各自握手、各有会话，不共享计数器。
  - 页面刷新就是新会话、新密钥，计数器从 1 重来也不冲突。
  - bridge 侧只用 `key_b2c` 加密响应，响应的 rid 来自请求，而每个 rid 只会被接受一次（上面的窗口），所以响应的 nonce 也不会重复。
- **用量上限**：rid 7 字节、i 4 字节。单个会话最多 2^31 个请求或 24 小时（先到先算）就重新握手。单个请求最多 2^32 条记录，每条 ≤ 64 KiB，远超任何实际流。确定性 nonce 不受随机 nonce 那种 2^32 次的上限约束。
- **中继看得到的**：fp、`sid`、每条记录的长度、时间。看不到方法、路径、头、正文、状态码。
- **bridge 侧**：解开后得到一个普通 `Request`，走现有的 `dispatchMachineRequest`（`bridge/relay-dispatch.ts`），`RequestContext` 增加 `e2e: {devId}`。principal 由设备公钥确定，不看 cookie。grant、撤销、owner / guest 的规则都不变。
- **中继侧**：`/m/<fp>/api/v1/e2e/*` 只按不透明字节转发。规范化、限流、帧上限照旧，Set-Cookie 过滤对这条路径不再相关。协议只加东西、不改东西，中继几乎不用改。
- **前端**：`lib/api/client.ts` 是唯一出口，在这里包一层 `sealedFetch`。
  - `<img src>`、下载链接这类拿不到自定义请求的场景，改成 fetch → 解密 → blob URL（`web/` 里约 6 处）。
  - 另一个方案是让 SW 在 `/m/<fp>/api/v1/*` 上做透明代理，应用代码一行不改。**实测**：Safari 26.5.2 和 Chromium 145 的 SW 都能读取 IndexedDB 里的 P-256 设备密钥并完成解密，也能对 fetch 返回经过变换的流（§9.1）。但 SW 空闲会被回收，长时间 SSE 在 SW 里能不能一直活着**没测过**。
  - 另外，iOS 壳的 WKWebView 没有 SW。
  - 推荐：API 客户端包一层作为主路，SW 只负责解推送。
- **降级**：
  - bridge 加开关 `RELAY_E2E_ONLY=1`：开启后，经中继的明文 `/m/<fp>/api/v1/*` 只放行 `devices/pair`、`e2e/hello`、`capabilities` 和 `app-config` 相关的端点，其余一律 `403 {code:"e2e_required"}`；同时拒绝子域名隧道（§7.3）。
  - 这个开关防的是 A2 伪造明文请求。浏览器端被降级属于 A3，本方案防不了。

#### 4.1.5 多设备与撤销

- 一台浏览器 × 一台机器 = 一把设备密钥。同一个 principal 下的多台设备共享 `chat_id`，这是现有模型。
- 撤销：从 principals.json 删掉公钥，握手立即失败，在途会话按现有「凭据 → 连接」表断开。
- 丢失：浏览器数据被清掉就等于丢了钥匙，重新配对即可。bridge 不存设备私钥，也没有「找回」。
- A6 跨机器 XSS：设备密钥不可导出，只能在页面存活期间被借用，与 HttpOnly cookie 等价。把各机器的密钥放进不同的 IndexedDB 库没有隔离作用（同源），不做。

### 4.2 方案 B：TLS 直通（只按 SNI 分流）

- **做法**：`<slug>.<base>` 的 443 流量由中继在四层按 SNI 分流，原始 TLS 字节经隧道送到 bridge，由 bridge 终止 TLS（Nabu Casa 的 SniTun、Tailscale Funnel、ngrok TLS 直通都是这个形状）。前端改由 bridge 直托管（已有 `BRIDGE_STATIC_DIR`）。
- **优点**：中继连 JS 都碰不到（没有 A3 问题，前提是证书不被私签）。协议帧里全是 TLS 密文。
- **代价**：
  1. **证书**：`<slug>.<base>` 的 DNS 在中继运营方手里。DNS-01 需要中继开放 DNS API，HTTP-01 要经隧道应答；而运营方随时能给同一个名字签一张自己的证书做中间人，只能靠 CT 事后发现（Nabu Casa 的官方表述也是「CT 可供第三方审计」）。bridge 可以轮询 CT 日志做告警，但那已经是事后。只有自带域名才能真正杜绝这一点。
  2. **回到每台机器一个 origin**：多台机器之间切换变成整页跳转；每个 origin 一份 SW 和推送订阅；每台机器提供自己那份前端，于是「三台机器三个版本」回来了。这恰恰是 design-hosted-frontend §1 要消灭的问题。
  3. **协议**：现有帧都是 HTTP 形状的文本帧，要新增一种不透明字节流（base64 走 `data` 帧会多出 33% 的体积）；中继前面要有四层 SNI 分流（部署时已有 nginx `stream`，self-host.md §反代）；每台 Mac 要跑 TLS 服务并自动续签证书。
  4. **推送**：Web Push 由每个 origin 用 bridge 自签的 VAPID 直接发（直托管模式已有）；APNs 仍需官方 p8，只能走中继，正文加密靠 §5.2 的 NSE。
- **结论**：不作主线。它最有价值的地方（代码和 TLS 都在自己手里）今天通过「直托管 + 自带域名 / Tailscale」已经能拿到。文档里把这条写成最高隔离档（§8）。

### 4.3 方案 C：其它

| 方案 | 说明 | 结论 |
|---|---|---|
| WebRTC DataChannel | 中继只做信令，数据点对点走 DTLS，TURN 转发时也只看得到密文（RFC 8831 / 8656）。DTLS 证书指纹可以在配对时锁定：`RTCCertificate` 可序列化，并有 `getFingerprints()` | 前端代码可信的问题一样存在；bridge 要引入 WebRTC 栈（原生插件，或纯 TS 实现），NAT 与移动端后台行为难以控制。**以后当作延迟优化再评估**，不作为加密手段 |
| Tailscale 直连 | WireGuard 端到端，中继完全不参与 | 已支持，是今天最强的一档。门槛是手机也要装 Tailscale |
| 直托管 + 自带域名 | bridge 自己出前端和 TLS | 已支持（design-hosted-frontend §11），属于最高隔离档 |
| HPKE 单发（无握手） | 每个请求都用 HPKE Auth 模式封装给机器 | 少一次往返，但 bridge 侧缺前向保密，SSE 这种长流也不顺手。握手 + 记录流更合适 |

### 4.4 前端代码可信（解决 A3，P3）

| 方案 | 防到什么程度 | 成本 | 结论 |
|---|---|---|---|
| **iOS 壳打包前端** | 壳里的代码随 App 签名分发，中继换不了。设备密钥可放进 Keychain，NSE 通过 App Group 共用 | 改 `native/`：`webDir` 指向 `web/out`；热更新包由壳校验签名，公钥编进 App；只能在 owner 的 MacBook 上签名 | **做**。手机是走中继的主力场景 |
| 本机 / Tailscale / 直托管 | 代码来自自己的机器 | 已有 | 文档里写成推荐档位 |
| 签名的 bundle 清单 | 每次发版在 GitHub Release 附带 `web-manifest.json`（所有文件的 sha256）及其签名。任何人都能核对中继发给自己的文件对不对得上 | 小：CI 生成清单并签名。中继的 `/app-config.json` 带清单哈希，只作展示 | **做**，是 WAICT 和扩展的前置 |
| 校验扩展（Code Verify 模式） | 装了扩展的用户，一旦页面文件不在清单里就告警，能发现针对性的换 JS | 中：Chrome / Firefox 扩展；Safari 扩展要上 App Store | 以后按需求做 |
| WAICT | 浏览器原生的完整性、一致性加透明日志 | 等标准落地 | 跟进，清单格式尽量与它对齐 |
| SW 锁定（首次信任后拒绝更新） | 做不到：旧 SW 否决不了新 SW（§3） | — | 不做 |
| SRI | 只管子资源，顶层 HTML 本身由中继提供 | — | 作为 CSP 之外的补充可以加，但不当防线 |

### 4.5 对比汇总

| 维度 | A 应用层加密 | B TLS 直通 | C WebRTC |
|---|---|---|---|
| 密钥管理 | 设备 P-256 存 IndexedDB；机器新增一把 P-256 | 每台 Mac 要 ACME 证书和续签 | DTLS 证书加配对时锁定 |
| 首次配对 | 由 S 绑定，短码加 SAS | 不变，但前提是证书可信 | 由 S 绑定指纹 |
| 多设备 | 一台设备一把钥匙，可单独撤销 | 与今天相同（cookie） | 一台设备一张证书 |
| 推送 | 与 §5.2 正交 | bridge 直发 Web Push，APNs 仍走中继 | 与 §5.2 正交 |
| 前端可信 | **要靠 §4.4** | 天然解决（代码来自自己的机器），但要防私签证书 | **要靠 §4.4** |
| 与托管前端的关系 | 兼容：单 origin、统一版本 | 冲突：退回每机一个子域名 | 兼容 |
| 协议改动 | 只加端点，中继几乎不改 | 新增字节流帧和四层分流 | 新增信令帧和 TURN |
| 实现量 | 中 | 大（每台 Mac 跑 TLS） | 大（WebRTC 栈） |

## 5. peer 与推送

### 5.1 peer（P1）

peer 两端都是 bridge，代码都可信，没有 A3 问题。**同样的加密投入，这里的收益最大。**

- **P1a 现有漏洞，归 T25（无条件修，不挂在 E2E 开关后面）**：中继看得见 peer token；路径模式会把 `Authorization` 原样转给 bridge，bridge 不看来源就收 Bearer；peer 路径又不核 token 与 `from` 是否对应（§1）。修法由 T25 定，本稿只要求结果：路径模式的请求（进程内 dispatch，`source: "relay"`）不接受 peer Bearer，peer 只能走验签的 peer 路径；peer token 绑定签发时的 fp，验签时一并核对；已钉住公钥的 peer，所有入口都强制验签。
- **P1b 加密**：邀请载荷加上邀请方的完整 Ed25519 公钥（现在只有 fp）和 E2E 公钥。经中继的 `req` 改发 `/api/v1/e2e/<sid>`，内层是原请求：包括 Bearer 和签名头，验签照旧在内层做。
  - 握手复用 §4.1.3，双方的静态密钥都是机器的 E2E 密钥。
  - 兑换邀请（`/api/v1/peers/redeem`）用 HPKE 把 join 口令封装给邀请方的公钥，中继就看不到口令。
- 中继的联系人门控只看 `to` / `from`，不受影响。

### 5.2 推送（P1）

**Web Push 改为「bridge 加密，中继只签名」**：

- VAPID 的 JWT 只包含推送服务的 origin（aud）、过期时间和联系人（sub），不覆盖正文。RFC 8291 的加密只用到订阅的 `p256dh` 和 `auth`，与 VAPID 私钥无关。所以两件事可以拆开：bridge 加密，中继签名投递（RFC 8291 / 8292）。
- 新增帧 `{t:"push", kind:"webpush-sealed", endpoint, body:<base64 aes128gcm 密文>, ttl, urgency?}`。中继只加 `Authorization: vapid …` 头再 POST；原来的 `webpush` 帧保留给老 bridge。
- 效果：订阅的 `auth` 和 `p256dh` 经 P2 的加密通道交给 bridge，之后中继既看不到正文，也伪造不了推送（手里没有 `auth`）。在 P2 之前订阅还是明文经过中继，此时这一项只防 A1。
- **fp 绑定改由密码学完成**：今天中继往 payload 里写 fp（`relay/push.ts` 的 `bindSenderFp`），防的是一台机器冒充另一台，把 SW 带凭据的已读回执引到别处。密文中继改不了，所以改为：
  1. 配对完成时，双方从 `ECDH(D, M)` 经 HKDF 派生一把推送 MAC 密钥 `Kp`（扫码和短码两种配对都有这一步），浏览器把它存成不可导出的 HMAC 密钥放进 IndexedDB（§9.1 实测的是 AES 密钥在 Safari 里能存取；HMAC 同为对称密钥，开工时补测）；
  2. payload 里带 `{fp, mac}`；
  3. SW 验过 mac 才相信这个 fp。
- **Apple 的要求**（Apple 的 Web Push 文档）：
  - `sub` 必须是 URL 或 `mailto:`；
  - JWT 有效期不超过一天；
  - payload 不超过 4 KB；
  - VAPID 公钥必须与订阅时一致；
  - 必须带 TTL。

  中继现有的签名逻辑已满足前四条；拆分后 TTL 头由中继照 `ttl` 字段补上。
- iOS 上 Safari PWA 的推送走的也是这条路。SW 的解密能力已实测（§9.1）。

**APNs（iOS 壳）**：

- 中继必须持有官方 p8，所以投递绕不开它。
- bridge 发 `{aps:{alert:{title:"Claudestra", body:"有新消息"}, "mutable-content":1}, e2e:"<密文>"}`，壳里新增 Notification Service Extension：用 Keychain 里的密钥解密，再替换标题和正文。解密失败或超时（约 30 秒）就显示通用文本。
- 这样 Apple 和中继都只看得到通用文本。
- 在壳发版之前，bridge 对 APNs 默认用「只推标题」。

**「推送不带正文」开关（P1，任何客户端都可用）**：

- 通知只写「<agent> 有新消息」。给还没升级的客户端，以及不想让任何第三方看到内容的用户。
- 角标数字仍是明文，属于元数据，接受。

## 6. 推荐与分期

| 期 | 内容 | 解锁的说法 | 依赖 |
|---|---|---|---|
| **P0**（本稿） | 更新 protocol.md §9 和 design-hosted-frontend §11 的措辞，指向本稿 | — | — |
| **P1** | ⓪ 前置：T25（路径模式不收 peer Bearer、token 绑 fp、隧道不算回环）；① peer 所有入口强制验签；② peer 经中继整体加密（§5.1）；③ `webpush-sealed` 与 fp 的 MAC 校验；④「推送不带正文」开关 | 「机器之间的协作经中继是加密的」「推送正文中继看不到（Web Push）」 | 不依赖前端改造。③ 在 P2 之前只防 A1（订阅明文经过中继） |
| **P2** | 配对 v2（S 绑定设备密钥，短码加 SAS）；`e2e/hello` 与记录流；API 客户端包一层；`RELAY_E2E_ONLY`；经中继不再发 cookie | 「经中继的对话内容加密传输，中继只看得到元数据；前提是网页代码是官方构建，而且这台机器开了「只收加密请求」」 | P1 的密码学库（twin） |
| **P3** | iOS 壳打包前端和签名热更新；NSE 解密 APNs；签名的 bundle 清单；以后视需要做扩展、跟进 WAICT | 「iOS App 内置代码，中继只看得到元数据，也换不了代码」 | P2；壳只能在 owner 的 MacBook 上签名 |

每一期都能单独发版，也能单独回退：新能力都走能力位协商，关掉开关就回到上一期的行为。

## 7. 迁移与兼容

### 7.1 能力协商（只加字段）

| 位置 | 新增 |
|---|---|
| `welcome.push` | `sealed: true`：这个中继支持 `webpush-sealed`。老中继没有这个字段，bridge 就回退到 `webpush` 帧 |
| `GET /api/v1/capabilities` | `features` 加 `e2e-v1`、`pair-v2` |
| `GET /app-config.json` | 加 `e2e: 1`、`manifest: {version, sha256, sigUrl}` |
| 配对链接 | `#2.<fp>.<S>`。老前端不认识 `2.`，只要 bridge 仍接受 v1，就按旧流程走 |

### 7.2 新老组合

| 组合 | 行为 |
|---|---|
| 新前端 + 老 bridge | 没有 `e2e-v1`，走明文，页面上标「未加密（这台机器需要升级）」 |
| 老前端 + 新 bridge | 明文路径照常可用，直到用户打开 `RELAY_E2E_ONLY` |
| 已有 cookie 凭据的设备 | 可以在现有会话里「补登记」设备密钥，但补登记本身走的是中继看得见的通道，所以只算 **A1 级**。设备列表里标出「补登记」，要完整保障就重新配对。不能悄悄把它当成 v2 |
| 新 bridge + 老中继 | 推送回退到 `webpush`；E2E 请求只是普通的 `/m/<fp>/api/v1/*` 路径，老中继照样转发 |
| 自建中继 | 与官方中继同一份代码，没有额外配置 |
| `RELAY_E2E_ONLY` 默认值 | 新装机默认开；已装机默认关，doctor 提示一行。等 P2 稳定两周后再改成全部默认开（需 owner 拍板） |

### 7.3 子域名隧道

子域名模式整条透传本机 Web，cookie 也在里面，**不做加密**。按 design-hosted-frontend §10 的截止日退场（届时中继回 410）；开了 `RELAY_E2E_ONLY` 的机器会提前拒绝 `from:"relay"` 且不带路径模式头的隧道请求。

隧道请求被当成回环（§1 最后一行）是 T25 的范围，不论开不开 `RELAY_E2E_ONLY` 都要修；本稿对存量机器的所有结论都以 T25 已修为前提（§2.3）。

### 7.4 不受影响

回环、直托管、Tailscale 直连：TLS 或 WireGuard 本来就在本机终止，不变。Discord 是另一条信任链（用 Discord 就等于交给 Discord），不在本稿范围内。

## 8. 残余风险与对外说法（建议稿）

- **一直都在的**：元数据（在线状态、联系人图、IP、流量大小和时间）；模型厂商能看到内容；中继可以拒绝服务。
- **P2 之后仍然存在**：浏览器用中继托管的前端时，中继运营方（或强迫它的人）可以给指定用户下发改过的代码。这与 WhatsApp 网页版、各类 Web 版加密产品是同一类前提。缓解手段是签名清单（任何人都能核对）；彻底解决要用可信客户端。
- **fp 只有 64 位**：用来路由和给人核对够用，但不作为加密密钥的唯一认证。凡是认证密钥的地方，都靠 S 或完整公钥。

| 阶段 | 能说 | 不能说 |
|---|---|---|
| 今天 | 「会话记录、代码、台账都在你自己的电脑上。想让任何第三方服务器都不经手，就只用 Tailscale 直连」 | 「中继看不到」「端到端加密」 |
| P1 后 | 加一句：「机器之间的协作、网页推送的内容，中继看不到」 | 同上 |
| P2 后 | 「经中继的对话内容加密传输，中继只能看到哪台电脑、什么时候、多少流量。网页版的代码由中继提供，和所有网页版加密产品一样，前提是这份代码没被改过；每个版本的文件指纹都公开可查」 | 「中继什么都看不到」「零信任」 |
| P3 后 | 「iOS App 内置代码，中继既看不到内容，也换不了代码。最高隔离：Tailscale，或者自带域名直连自己的电脑」 | 「数据不出机器」（模型厂商能看到） |

## 9. 实测与来源

### 9.1 实测（2026-09-28，scratchpad 一次性实验，不进仓库；本机 macOS 26.5.2）

| 项 | Safari 26.5.2（真机浏览器，localhost） | Chromium 145（Playwright headless） |
|---|---|---|
| X25519 生成（不可导出）与 ECDH 派生 | 通过 | 通过 |
| Ed25519 签名与验签；导入 Node 生成的原始公钥（protocol.md §10 的测试向量） | 通过 | 通过 |
| P-256 ECDH；HKDF 加 AES-GCM | 通过 | 通过 |
| **X25519 CryptoKey 存 IndexedDB 后读回** | **失败：读回 `null`**；`structuredClone` 报「Unable to deserialize data」；`postMessage` 传出去收不到 | 通过 |
| Ed25519、P-256（ECDH 与 ECDSA）、AES CryptoKey 存 IndexedDB 后读回 | 通过 | 通过 |
| SW 从 IndexedDB 取出页面存的不可导出 P-256 密钥，做 ECDH、HKDF 和 AES-GCM 解密 | 通过 | 通过 |
| SW 拦截 fetch，对上游流逐块变换后返回（透明代理的形状） | 通过 | 通过 |

没测的：iOS 真机 Safari（按 WebKit 同源推断应与 macOS 一致，P2 开工前在 iPhone 上复测一次 IndexedDB 里的 P-256）、SW 里长时间 SSE 的存活、真实推送经推送服务后 SW 解内层密文、NSE。

### 9.2 来源（查证日期 2026-09-28）

- WebCrypto 算法支持：MDN browser-compat-data 8.1.3。Safari 17 起支持 X25519 和 Ed25519，并注明 Safari 的 Ed25519 签名是随机化的；Chrome 137 支持 Ed25519，见 https://chromestatus.com/feature/4913922408710144 。CryptoKey 可序列化：https://w3c.github.io/webcrypto/ 。
- Web Push：RFC 8291 https://www.rfc-editor.org/rfc/rfc8291 ，RFC 8292 https://www.rfc-editor.org/rfc/rfc8292 ；Apple《Sending web push notifications in web apps and browsers》。
- NSE：Apple《Modifying content in newly delivered notifications》：要求 `mutable-content: 1`，约 30 秒。
- Service Worker 更新：https://w3c.github.io/ServiceWorker/ 。
- WAICT：Cloudflare 博客；Mozilla Hacks（2026-05，Firefox Nightly 原型）。Code Verify：engineering.fb.com（2022-03）。Isolated Web Apps：Chrome 开发者文档（仅限企业管理设备）。
- TLS 直通先例：Tailscale Funnel https://tailscale.com/kb/1223/funnel （TLS 在节点上终止）；ngrok TLS 直通文档；Nabu Casa《Security aspects》：TLS 在本机终止，DNS-01 申请证书，SniTun 做 SNI 代理，靠 CT 审计。
- WebRTC：W3C webrtc-pc（RTCCertificate 可序列化，`getFingerprints()`）；RFC 8831、RFC 8656。
