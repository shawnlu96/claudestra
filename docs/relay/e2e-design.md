# 设计稿：中继端到端加密（E2E）

> 状态：**设计稿，未开工**。2026-09-28 初稿，09-29 按第 2 轮安全审查重写。只做调查、给推荐，不含产品代码。
> 范围：路径模式 `/m/<fp>/api/v1`、peer、推送、配对。子域名隧道只写退场（§7.3）。
> 前置阅读：[protocol.md](./protocol.md) §4.1、§9；[design-hosted-frontend.md](../design-hosted-frontend.md) §4、§5、§7、§11。
> **前提：T25 已修**，即 §1 列出的三处现有漏洞。T25 无条件修，不挂在本稿的任何开关后面；本稿所有结论都以它已修为前提。

## 0. 结论先说

1. **难点不在加密，而在浏览器里跑的代码由谁提供。** 前端由中继托管，中继进程既能改帧，也能换 JS；改过的 JS 可以把明文和密钥直接发走。所以攻击者一旦控制了中继进程或主机，浏览器里做什么加密都挡不住。要挡住它，只有两条路：
   - 代码不从中继来：iOS 壳打包前端、本机或 Tailscale 直连、bridge 直托管；
   - 作恶能被发现：签名清单，以后还有 WAICT（目前只是草案）。
2. **应用层加密挡得住的，是不控制中继进程的那些人**：
   - 被动窥探：日志、备份、内存转储里泄露的帧；
   - 事后被要求交出数据；
   - 只能改帧、换不了代码的一跳（§2.2 的 A2）。

   做完之后，这些人手里只剩元数据：哪台机器、什么时候、多少流量、从哪个 IP 来。
3. **分三期**：
   - **P1**：先修 T25，再做两件不依赖前端的小事：「推送不带正文」开关；经 CLI 或带外渠道交换邀请的 peer 之间整体加密。
   - **P2**：浏览器与 bridge 之间加密，包括配对 v2、「只收加密请求」开关、凭据记录来源，Web Push 改为 bridge 自己加密。
   - **P3**：可信客户端。iOS 壳打包前端，用 iOS 通知服务扩展（NSE）解密 APNs 推送，每次发版附签名的 bundle 清单。
4. **TLS 直通（只按 SNI 分流）不作主线。** 它等于退回每台机器一个子域名、每台机器各自出一份前端，正好推翻托管前端刚解决的问题；而且中继运营方控制 DNS，自己签一张证书就能做中间人。它的好处今天用「直托管加自带域名」已经能拿到。

## 1. 现状：中继今天看得见什么

| 数据 | 路径 | 中继看得见 | 依据 |
|---|---|---|---|
| 聊天、终端输出、会话历史、附件 | 浏览器 → 中继 front（TLS 在这里终止）→ `req`/`data` 帧 → bridge | **明文** | protocol.md §3、§6.2 |
| 设备凭据 `cstra_dev` | 配对响应下发 `Set-Cookie`，之后每个请求都带 | **明文**；中继还要改写它的属性 | protocol.md §6.2 |
| 配对秘密 `S`（`#<fp>.<S>`） | 由 CLI（`claudestra pair`，走回环控制路由）、本机页面或直托管签发，不经中继 | 看不到 | design-hosted-frontend §4 |
| 同上 | **网页经中继签发**：`web/lib/api/devices.ts` 的 `newShareCode` 调 `/relay/pair`（路径模式），响应里带 `fragment = <fp>.<S>` | **明文**：中继拿得到 S | `bridge/devices.ts` 的 `issuePairing` |
| 手输短码 | 登记在中继上：`code → fp` | 看得见；靠 Mac 侧确认兜底 | protocol.md §5.2 |
| Web Push 订阅与正文 | 订阅经路径模式交给 bridge；推送由中继做 RFC 8291 加密 | **明文** | protocol.md §3.5 |
| APNs 正文 | 中继持有 p8 | **明文**；Apple 也看得见 | 同上 |
| peer 请求 | A → 中继 → B | **明文**，包括 `Authorization: Bearer <peer token>` | protocol.md §4.1 |
| 元数据 | 所有路径 | 在线状态、联系人图、fp、IP、时间、大小 | protocol.md §4、§9 |
| 前端 JS / HTML / SW | 中继进程自己托管静态站（`relay/front.ts`，`RELAY_STATIC_DIR`） | 这些代码就是中继**提供**的 | protocol.md §6.2 |

**归 T25 修的三处现有漏洞**（本稿不修，以它们已修为前提）：

1. 路径模式把 `Authorization` 原样转给 bridge（`relay/front.ts` 的 `tunnelHeaders`），而 bridge 的 `authenticateApi` 不看请求来源就接受 Bearer。中继拿着看到过的 peer token，经路径模式发请求，就完全绕过了验签。
2. peer 路径只核对「签名钥匙的指纹 = `from`」，不核对这枚 token 是不是签发给这个 fp 的（`bridge/relay-inbound.ts` 的 `verifyPeerRequest`）。
3. `forwardTunnel` 不强制带 XFF。迁移过旧 web 的机器，3333 端口已由 bridge 接管，子域名隧道请求会被当成真本机，享受回环豁免。

因此，protocol.md §4.1、§9 里「中继冒充不了实例」的说法，在 T25 修好之前不成立。两处都已加注。

## 2. 威胁模型

### 2.1 资产

- **C1 内容**：消息、终端流、附件、会话历史、推送正文。
- **C2 凭据**：设备凭据（cookie 或设备私钥）、peer token、配对秘密。
- **C3 控制权**：能否以用户身份调 API，包括终端（终端等于宿主 shell）。
- **C4 元数据**：在线状态、联系人图、流量大小与时间、IP。

### 2.2 攻击者

| # | 攻击者 | 能力 |
|---|---|---|
| A1 | 被动：好奇的运营方、日志或备份泄露、内存转储、事后调取 | 读经过的帧，不改 |
| A2 | 只能改帧、换不了中继发出的静态文件的一跳。例如只控制了「中继 ↔ 实例」这段转发，或者只能往帧里注入内容的组件 | 读、改、丢、重放帧，也能自己发请求 |
| A3 | **中继进程或主机被入侵；恶意运营方；被强制配合的运营方** | A2 的全部能力，外加给指定用户下发改过的 JS 和 SW。静态站就由中继进程自己托管，所以现实部署里不存在「进程被入侵、静态文件没被换」这种情况：**进程被入侵就是 A3** |
| A4 | 网络上的攻击者 | 能碰到 TLS 之外的部分 |
| A5 | 同一中继上的其它实例 | 能发 `req` 帧，受联系人门控限制 |
| A6 | 某台机器的恶意输出（agent 回复里注入的内容） | 在同源页面里造成 XSS，借用同一浏览器里其它机器的凭据 |
| A7 | 推送服务（Apple、Google、Mozilla） | 看得到推送密文、通知展示文本、时间 |
| A8 | CA 或 DNS 运营方 | 能签发中继域名下的证书 |

### 2.3 每期之后谁还能拿到什么

「能」= 拿得到明文或能冒用；「元」= 只剩元数据。P2 列只对**开了 `RELAY_E2E_ONLY` 的机器上的 v2 设备**成立（§4.1.6）；没开开关的机器，P2 列等于 P1 列。

| 攻击者 | 今天（T25 已修） | P1 后 | P2 后 | P3 后 |
|---|---|---|---|---|
| A1 被动 | C1、C2 能 | 开了「不带正文」的推送、CLI 或带外邀请的 peer，这两类转为元 | v2 设备的流量和 Web Push 转为元 | 元 |
| A2 只改帧 | C1、C2、C3 能 | 同 A1 这一格；另外，带外邀请的 peer 不能被中间人 | 元：能丢帧、拖慢，但改不了、伪造不了、重放不了，也换不了响应（§4.1.4） | 元 |
| A3 控制中继 | 全能 | 全能（CLI 或带外邀请的 peer 除外） | **仍然全能**：改过的 JS 直接读明文、用设备密钥 | 可信客户端上转为元；浏览器用户仍然全能，只是能事后审计（§4.4） |
| A5 其它实例 | 受门控 | 同左 | 同左 | 同左 |
| A6 跨机器 XSS | 借用凭据 | 同左 | 借用设备密钥（不可导出，偷不走，只能借用） | 同左 |
| A7 推送服务 | 看得到通知文本 | 开了「不带正文」的，只看得到通用文本 | Web Push 只看得到密文；APNs 仍看得到文本 | APNs 只看得到通用文本（由 NSE 解密） |
| A8 CA | 能做中间人，但中继本来就看得见 | 同左 | 只拿得到密文 | 同左 |

### 2.4 明确不防的

- **元数据**：连接关系、在线状态、流量模式。分块填充列为 P2 可选项，只防粗粒度的大小分析。
- **拒绝服务**：中继可以不转发。
- **模型厂商**：agent 的内容本来就要发给模型接入商。
- **本机被入侵**：bridge 所在机器被入侵，就是全部权限。
- **浏览器里的 A3**：除非用可信客户端或代码透明（§4.4）。对外说法必须写明这一点（§8）。

## 3. 核心约束：代码从哪来

| 事实 | 出处 |
|---|---|
| SRI 只能校验子资源，校验不了顶层 HTML | Cloudflare 的 WAICT 博客：「there is no way for a page to enforce the hash of the pages it links to」 |
| 旧 SW 否决不了新 SW：取 SW 脚本时 service-workers mode 设为 none；距上次检查超过 24 小时，强制绕过 HTTP 缓存 | W3C Service Worker 规范（Update 算法） |
| WAICT 还在标准化早期，Firefox Nightly 有一个需要手动开启的原型 | Cloudflare 博客；Mozilla Hacks（2026-05） |
| Isolated Web Apps / Signed Web Bundles 只对企业管理设备和部分合作方开放 | Chrome 开发者文档 |
| Meta Code Verify 是浏览器扩展，把页面代码的哈希和第三方保存的真值比对 | engineering.fb.com（2022-03） |

结论：**在纯 Web 形态下，托管代码的一方要作恶，今天的浏览器没有办法防住。** 所以本稿把两件事分开写：加密（§4.1）挡 A1、A2；代码可信（§4.4）挡 A3。

## 4. 方案

### 4.1 方案 A：浏览器 ↔ bridge 的应用层加密（推荐，P2）

#### 4.1.1 密钥与编码

| 密钥 | 存在哪 | 算法 | 为什么 |
|---|---|---|---|
| 机器身份 | `STATE_DIR/instance-key.pem`（已有） | Ed25519 | 不动，用它给下面这把 ECDH 公钥签名 |
| 机器 E2E 密钥 `M` | `STATE_DIR/e2e-key.pem`（新增） | P-256 ECDH | ECDH 两端曲线必须一致，而浏览器侧只能用 P-256 |
| 设备密钥 `D` | 浏览器 IndexedDB，按机器分开存，不可导出 | P-256 ECDH | **实测**：Safari 26.5.2 里 X25519 的 CryptoKey 存进 IndexedDB 后读回来是 `null`；P-256 和 Ed25519 都能存能读，SW 里也能用（§9.1） |
| 会话密钥 | 两端内存，**不持久化** | HKDF-SHA256 → AES-256-GCM | 全部用 WebCrypto 原语 |

- 算法套件：P-256 + HKDF-SHA256 + AES-256-GCM。
- 实现：`src/lib/e2e/*` 和 `web/lib/e2e/*` 共用一份逻辑，在 `scripts/guard/config.ts` 里登记为 twin，再用同一组测试向量把两边钉住。
- **编码规则**：本稿中 `‖` 拼接的每一项，都编码成「u16 大端长度 + 字节」，唯一例外是 nonce（定长，见 §4.1.4）。标签字符串（如 `"pair-v2-req"`）也按这条规则编码。公钥一律用 SEC1 未压缩格式（65 字节），随机数一律 32 字节。

#### 4.1.2 配对 v2：把设备密钥绑进配对

**信任根只有两种**：

- **S 从来没有明文经过中继**：由 CLI、本机页面、直托管签发，或者经 E2E 通道签发。bridge 为每个配对码记下签发途径 `issuedVia`，取值为 `cli`、`loopback`、`direct`、`relay-e2e`、`relay-plain` 之一。
- **手输短码，加 SAS 核对。**

途径为 `relay-plain` 的码也能走 v2 配对，但得到的设备密钥同样标 `relay-plain`，按 §4.1.6 处理。

**扫码或点链接（带 S）**：

1. 链接改成 `#2.<fp>.<S>`。老前端不认识 `2.`，回退到 v1。
2. 浏览器生成 `D`，发 `POST /m/<fp>/api/v1/devices/pair`，正文 `{v:2, challenge, devicePub, mac}`，其中 `mac = HMAC(S, "pair-v2-req" ‖ fp ‖ challenge ‖ devicePub)`。
3. bridge 原子地消费这个码，验 mac，登记 `devicePub` 并记下来源，然后回复 `{machineE2ePub, idSig, mac2}`：
   - `mac2 = HMAC(S, "pair-v2-res" ‖ fp ‖ challenge ‖ devicePub ‖ machineE2ePub)`；
   - `idSig` = Ed25519 身份密钥对同一串内容的签名。
4. 浏览器验 `mac2`，通过才保存 `machineE2ePub`。只要 S 没经过中继，中继就换不掉任何一边的公钥。fp 只有 64 位，不单独拿它来认证密钥。
5. 经中继做的 v2 配对**不下发 cookie**，设备凭据就是 `devicePub`。principals.json 里登记为 `v:2, type:"p256"`，这两个字段 design-hosted-frontend §3 已经预留。

**手输短码（SAS）**：短码中继看得见，它可以在两头各换一把公钥。对策是带承诺的数字比较，做法参照 Bluetooth 的 Numeric Comparison 和 ZRTP 的哈希承诺：

```
浏览器 → bridge   {code, devicePub, C = SHA-256("pair-v2-commit" ‖ devicePub ‖ Nd)}
                  bridge 收到后立即原子地消费这个短码；一个码只接受一个承诺
                  Mac 侧马上提示「有设备正在配对，等待核对」
bridge → 浏览器   {machineE2ePub, idSig, Nm}        // Nm：bridge 收到 C 之后才生成
浏览器 → bridge   {Nd}                               // bridge 核对 C，不符即失败
SAS = u32be(SHA-256("pair-v2-sas" ‖ fp ‖ devicePub ‖ machineE2ePub ‖ Nd ‖ Nm ‖ code) 的前 4 字节) mod 10^6，显示为 6 位数字
```

- **两边都要用户确认**：
  - Mac 侧：用户看到两边的 SAS 一致，点「批准」；
  - 浏览器侧：同样显示 SAS，用户点「一致」之后，浏览器才保存 `machineE2ePub`。浏览器必须自己问用户，因为批准结果（`pair/status`）经中继明文返回，可以被伪造；浏览器只信用户的确认，不信 status。
- **超时不揭示也算失败**：60 秒内没收到 `Nd` 就算失败，这个码已经作废，Mac 侧提示改为「配对失败，可能有人在中间」。
- **成功概率上界**：承诺迫使中间人在任何一方揭示之前，就先锁定自己的值；一个码又只接受一个承诺，所以**每签一个码，中间人最多只能试 1 次**，成功概率 ≤ 10^-6（6 位十进制，约 19.9 位）。每次签码都要用户在 Mac 上主动操作，失败也会显示给用户。
- **局限**：浏览器侧的 SAS 是中继发来的 JS 显示的，挡不住 A3。中继也可以抢先提交承诺，把码耗掉，这属于拒绝服务（§2.4），用户重新签一个码即可。

**不再做「补登记」**：用 cookie 给老设备补一把密钥，走的正是中继看得见的通道，中继完全可以替自己补一把。老设备一律重新配对（§7.2）。

**本机回环配对**：不经过中继，直接登记 `devicePub`，来源记为 `loopback`。

#### 4.1.3 会话握手

参照 Noise KK（双方事先都知道对方的静态公钥）：

```
浏览器 → POST /m/<fp>/api/v1/e2e/hello   {v:1, devId, ce}          // ce：浏览器临时公钥；devId = SHA-256(devicePub)
bridge → 200                              {be, sid, ttl, confirm}   // be：bridge 临时公钥
ikm = ECDH(ce,be) ‖ ECDH(D,be) ‖ ECDH(ce,M) ‖ ECDH(D,M)
th  = SHA-256("cstra-e2e-v1" ‖ fp ‖ devId ‖ ce ‖ be ‖ sid)
key_c2b, key_b2c, key_confirm = HKDF(ikm, salt = th, info 分别为 "c2b" / "b2c" / "confirm")
confirm = HMAC(key_confirm, th)
```

- **认证**：完全来自 DH，hello 不带签名。浏览器验过 `confirm`，才确认对面确实持有 `M`。
- **前向保密**：临时密钥用完即丢，事后拿到 `D` 或 `M` 也解不开录下来的流量。
- **重放旧的 hello 没用**：bridge 每次都生成新的 `be`，没有 `D` 就派生不出密钥。
- **会话生命期**：
  - 会话只在内存里，**禁止持久化**。bridge 重启，全部会话作废，客户端重新握手；因此也不存在「重放窗口没跟着会话一起落盘」的问题。
  - TTL 24 小时，或用满 2^31 个请求，以先到者为准。
  - 设备被撤销时，bridge 立即作废该设备的所有会话，并断开在途的流（接进现有的「凭据 → 活动连接」表）。
- **每个 JS 上下文单独一个会话**：每个标签页、SW 各自握手。

#### 4.1.4 请求、响应与流

```
POST /m/<fp>/api/v1/e2e/<sid>/<rid>        rid：客户端在本会话内从 1 起分配，十进制，< 2^56
请求正文 / 响应正文 = 记录流：[len:u32 大端][AES-GCM 密文 ‖ tag] …，每条明文 ≤ 64 KiB
nonce（12 字节，定长）= dir(1 字节：0x01 请求 / 0x02 响应) ‖ rid(7 字节，大端) ‖ i(4 字节，大端，从 0 起)
AAD = "cstra-e2e-v1" ‖ sid ‖ dir ‖ rid ‖ i ‖ final(1 字节)
请求第 0 条明文 = {method, path, headers}；响应第 0 条 = {status, headers}；之后是正文分块；最后一条 final = 1
```

**bridge 处理一个请求的顺序（写死，实现和测试都按这个顺序）**：

1. 按 `sid` 找会话；找不到 → 明文 `401 {code:"e2e_session"}`。客户端怎么处理见 §4.1.5。
2. `await` 解密第 0 条记录（验 tag）。失败 → 明文 `400`，**窗口不动**。所以伪造一个很大的 rid 也推不动窗口。
3. **同步地查窗口并记下**，从这一步到第 4 步之间不许有 `await`：
   - 窗口大小 1024，用位图记录，做法同 RFC 4303 §3.4.3 和 RFC 6347 §4.1.2.6；
   - `rid ≤ 已见最大值 − 1024`，或者已经见过 → 明文 `409 {code:"e2e_replay"}`；
   - 否则置位；窗口下沿只升不降。
   - JS 是单线程的，这一段中间没有 `await`，所以同一个 rid 的两份并发副本，只有一份能通过这一步。
4. 为这个 rid 创建**唯一一个**请求解码器和**唯一一个**响应编码器，然后才 dispatch：
   - 请求正文按 `i` 严格递增解密，收到 `final = 1` 才算完整；收不到就中止处理，不把残缺的正文交给路由。
   - 响应编码器是这个 rid 在 `key_b2c` 下唯一的加密者，`i` 只由它递增。
5. 解开后是一个普通的 `Request`，走现有的 `dispatchMachineRequest`，`RequestContext` 加上 `e2e: {devId}`：
   - principal 由设备公钥确定，不看 cookie；
   - grant、撤销、owner / guest 的规则都不变；
   - 路由产生的错误（4xx、5xx）写在**加密后**响应的第 0 条里。

**nonce 唯一性论证**：

- **`key_c2b` 只有本会话的客户端在用。** 客户端的 rid 计数器只在内存里递增、从不回退；每个请求只有一个编码器，由它递增 `i`。所以 `(0x01, rid, i)` 不会重复。
- **`key_b2c` 只有 bridge 在用，而且只由第 4 步创建的编码器使用。** 第 3 步保证每个 rid 在一个会话里最多通过一次：「查并记」是同步的，窗口下沿不回退，跌出窗口的 rid 永远被拒。所以每个 rid 最多只有一个编码器，`(0x02, rid, i)` 不会重复。第 2 轮审查实测复现的「重复投递导致同一 nonce 用了两次」，缺的正是第 3 步的同步要求。
- **两个方向**：用的是两把不同的密钥，dir 字节只是多一道保险。
- **会话之间**：每个会话的密钥来自新的临时 DH，不会重复；会话不持久化，所以不存在「重启后计数器归零」。
- **用量上限**：每个会话 2^31 个请求，每个请求 2^32 条记录。nonce 是确定性的，没有随机 nonce 那种约 2^32 次就要担心碰撞的上限。

**其它性质**：

- **响应绑定请求**：客户端用自己发出的 rid 去解对应 HTTP 响应。中继互换两个请求的响应、在请求之间挪记录、把响应回灌给 bridge（dir 不同），都会在 GCM 校验时失败。
- **截断和重排**：`i` 和 `final` 都在 AAD 里。两个方向都必须看到 `final = 1` 才算完整，否则按「中断」处理。
- **中继看得到的**：fp、`sid`、`rid`、每条记录的长度、时间。

#### 4.1.5 客户端规则

- **所有 `/api/v1` 请求只走一个出口。** P2 必须先把它们全部收到加密客户端，再开开关。今天有几处绕过了 `lib/api/client.ts`：
  - `system.ts` 的 client-log（keepalive）；
  - `devices.ts` 里直接写的 fetch；
  - `sw.js` 的已读回执。

  这些在 P2 里要全部迁移。guard 加一条规则：`web/` 里除了加密客户端，不许有对 `/api/v1` 的裸 fetch。SW 自己握手（IndexedDB 里的设备密钥 SW 能用，§9.1）。
- **明文错误不可信。** e2e 路径上的明文状态码（`401 e2e_session`、`409`、`400`、中继的 `502` / `503`）中继都能伪造。所以：
  - GET、HEAD 可以重新握手后重试；
  - 非幂等请求一律不自动重试，界面显示「结果未知，可能已经执行」。这样即使中继谎报 `e2e_session` 诱导重发，同一个操作也不会被自动执行两次。
- **不回退到明文。** 一台机器只要做过 v2 配对或建立过 E2E，前端就在 IndexedDB 里记下「这台机器必须加密」，从此永不回退。`#2.` 链接本身就说明对方支持 E2E。
  - 能力位（capabilities、apiVersion）只经 E2E 通道获取；
  - 握手失败就显示「无法建立加密连接」，不会退回明文，也不会退回 cookie。
- **中继原先对内容的保护，搬到前端做。** 今天中继给机器的响应钉上 `CSP sandbox`，并把脚本类 MIME 改成 `text/plain`（`lib/relay-machine-path.ts`）。加密以后中继看不到内容，这层保护就没了，所以前端把解密出的内容做成 blob 时：
  - MIME 走白名单：图片（不含 SVG）、PDF、纯文本、音频；
  - `text/html`、`image/svg+xml`、XML、脚本类一律改成 `application/octet-stream`，只能下载；
  - 永远不导航到 blob URL。blob 继承页面的源，一旦被当成 HTML 打开，就等于在托管源上跑了机器写的脚本。

#### 4.1.6 「只收加密请求」开关与凭据来源

`RELAY_E2E_ONLY=1` 打开后，bridge 对**经中继**（`source: "relay"`）的请求这样处理：

- **放行**：
  - `e2e/hello` 和 `e2e/<sid>/<rid>`；
  - `devices/pair`，但只接受两种：码的来源不是 `relay-plain` 的 v2 扫码，以及 SAS 流程。
- **拒绝**，一律回 `403 {code:"e2e_required"}`：
  - 其它一切明文 `/api/v1/*`，包括 capabilities（改走 E2E 通道）；
  - v1 配对；
  - 经中继明文调用的 `/relay/pair`；
  - 任何 cookie；
  - 子域名隧道。

`app-config.json` 是中继自己的端点，与这个开关无关。

**打开开关时，一次性作废以下凭据（永久删除，不是暂停）**：

1. 所有**曾经经中继用过**的 cookie 凭据。凭据要记录 `lastUsedVia`，从 P2 发版前就开始记；没有记录的，一律视为经过中继。
2. 来源为 `relay-plain` 的 v2 设备密钥，也就是用经中继明文签发的 S 配对得到的密钥。

为什么必须作废：开关关着的那段时间里，中继看得到 cookie，可以拿它去签一个新码、拿到 S，再给自己配对一把 v2 密钥。不作废的话，开关打开后中继依然拥有权限（第 2 轮审查 P0-1）。

**关掉开关**只是重新允许明文路径，**不会复活**已经作废的凭据；之后再打开，照样重复上面的作废。所以关了再开，也不会让泄露过的东西重新生效。

**代价**：存量机器打开开关时，owner 所有经中继用过的设备都要重新配对（CLI 扫码或 SAS）。这是这道防线的必要代价，不提供「补登记」捷径。

#### 4.1.7 多设备与撤销

- 一个浏览器 × 一台机器 = 一把设备密钥。同一个 principal 下的多台设备共享 `chat_id`。
- **撤销**：删掉公钥，握手立刻失败，在途会话断开。
- **丢失**：浏览器数据被清掉就等于钥匙丢了，重新配对即可，没有「找回」。
- **A6**：设备密钥不可导出，页面存活期间只能被借用，这一点与 HttpOnly cookie 等价。按机器分开 IndexedDB 库没有隔离作用（同源），不做。

### 4.2 方案 B：TLS 直通（只按 SNI 分流）

- **做法**：`<slug>.<base>` 的 443 流量由中继在四层按 SNI 分流，原始 TLS 字节经隧道送到 bridge，由 bridge 终止 TLS。Nabu Casa 的 SniTun、Tailscale Funnel、ngrok 的 TLS 直通都是这个结构。前端由 bridge 直托管（已有 `BRIDGE_STATIC_DIR`）。
- **优点**：只要证书没被私签，中继就碰不到 JS 和内容。
- **代价**：
  1. **证书**：`<slug>.<base>` 的 DNS 在运营方手里，它随时可以给同一个名字签一张证书做中间人，只能靠 CT 日志事后发现。Nabu Casa 官方也是这么说的：CT 可供第三方审计。只有自带域名才能真正杜绝。
  2. **退回每台机器一个 origin**：切换机器要整页跳转；每个 origin 各有一份 SW 和推送订阅；每台机器提供自己那份前端，「三台机器三个版本」的老问题又回来了（design-hosted-frontend §1）。
  3. **协议**：要新增不透明字节流帧；中继前面要有四层 SNI 分流（部署里已有 nginx `stream`，见 self-host.md）；每台 Mac 要跑 TLS，并自动续签证书。
  4. **推送**：Web Push 由 bridge 用自签 VAPID 直接发（直托管模式已有）；APNs 仍走中继。
- **结论**：不作主线；把「直托管加自带域名」写成最高隔离档（§8）。

### 4.3 方案 C：其它

| 方案 | 说明 | 结论 |
|---|---|---|
| WebRTC DataChannel | 中继只做信令，数据走 DTLS，TURN 转发时也只看得到密文（RFC 8831 / 8656）。`RTCCertificate` 可序列化，配对时可以锁定证书指纹 | 前端可信的问题一样存在，还要在 bridge 里加 WebRTC 栈，NAT 穿透和移动端后台都难控制。以后当作降低延迟的手段再评估 |
| Tailscale 直连 | WireGuard 端到端 | 已支持，是最强的一档；门槛是手机也要装 Tailscale |
| 直托管 + 自带域名 | bridge 自己提供前端和 TLS | 已支持，属于最高隔离档 |
| HPKE 单发 | 每个请求都用 HPKE Auth 模式封装 | bridge 侧没有前向保密，长流也不好处理。只用在兑换邀请上（§5.1） |

### 4.4 前端代码可信（解决 A3，P3）

| 方案 | 防到什么程度 | 成本 | 结论 |
|---|---|---|---|
| **iOS 壳打包前端** | 代码随 App 签名分发；设备密钥放 Keychain，NSE 通过 App Group 共用 | `native/` 的 `webDir` 指向 `web/out`；热更新包由壳校验签名（公钥编进 App）；只能在 owner 的 MacBook 上签名 | **做** |
| 本机 / Tailscale / 直托管 | 代码来自自己的机器 | 已有 | 写成推荐档位 |
| 签名的 bundle 清单 | 每次发版附 `web-manifest.json`（每个文件的 sha256）及其签名，谁都能核对中继发给自己的文件对不对得上 | CI 生成并签名 | **做**，是下面两项的前置 |
| 校验扩展（Code Verify 模式） | 装了扩展的用户，能发现针对自己的换 JS | 做 Chrome / Firefox 扩展；Safari 扩展要上 App Store | 看需求再做 |
| WAICT | 浏览器原生的完整性校验和透明日志 | 等标准落地 | 跟进；清单格式尽量与它对齐 |
| SW 锁定 / SRI | SW 否决不了自己的更新；SRI 管不了顶层 HTML（§3） | — | 不做 |

### 4.5 对比汇总

| 维度 | A 应用层加密 | B TLS 直通 | C WebRTC |
|---|---|---|---|
| 密钥管理 | 设备用 P-256，存 IndexedDB；机器新增一把 P-256 | 每台 Mac 要 ACME 证书并续签 | DTLS 证书加指纹锁定 |
| 首次配对 | 靠 S（不经中继）或 SAS | 不变，但以证书可信为前提 | 靠 S 绑定指纹 |
| 多设备 | 一台设备一把钥匙，可单独撤销 | 同今天（cookie） | 一台设备一张证书 |
| 前端可信 | 要靠 §4.4 | 天然解决，但要防私签证书 | 要靠 §4.4 |
| 与托管前端的关系 | 兼容 | 冲突 | 兼容 |
| 实现量 | 中 | 大 | 大 |

## 5. peer 与推送

### 5.1 peer

两端都是 bridge，代码都可信，没有 A3 那种「换 JS」的问题。但能防到哪一步，取决于公钥怎么分发。

- **范围**：只覆盖「邀请由 CLI 生成，再经带外渠道（聊天软件、当面）交给对方」的 peer。以下两类不覆盖，P1 的对外说法要把它们排除：
  - 经托管网页生成或加入的邀请：`web/lib/api/system.ts` 的 invite-new / join-auto 走路径模式，P2 之前邀请载荷是明文经过中继的，A2 及以上能替换其中的公钥；
  - `url` 填的是 `<slug>.<base>` 的 http peer：整条走子域名隧道，全程明文。
- **公钥**：
  - 邀请载荷里加上邀请方完整的 Ed25519 身份公钥；
  - 双方各自的 E2E 公钥（P-256）由身份密钥签名，在第一次加密握手时交换，验签用邀请里钉住的身份公钥。
  - 存量 peer 钉住的公钥来自首次签名请求时的「首次信任」，钉的那一刻可能经过了中继，所以默认标为「未经带外核实」，对外只能说防被动窥探。
- **会话**：每个发起方单独握手、单独一个会话。A→B 和 B→A 是两个会话，不共用计数器。握手和记录流同 §4.1.3、§4.1.4，双方的静态密钥都用机器 E2E 密钥。内层就是原请求，包括 Bearer 和签名头，验签照旧在内层做。
- **兑换邀请**：
  - 请求：用 HPKE（RFC 9180，DHKEM(P-256)，base 模式）封装给邀请方的 E2E 公钥，内容是 join 口令，以及兑换方自己的身份公钥和 E2E 公钥。
  - 响应（签给兑换方的 token 等）：用 HPKE 上下文导出的密钥加密，即 `context.export("redeem-response", 32)`。只有持有邀请方私钥的一方和兑换方算得出这把密钥。
- **联系人门控**：只看 `to` / `from`，不受影响。

### 5.2 推送

**P1：「推送不带正文」开关。** 通知只写「<agent> 有新消息」。这是 P1 在推送上唯一能兑现的东西：
- P2 之前，订阅经路径模式明文交给 bridge，被动的中继早已看到了 `auth` 和 `p256dh`，这时由 bridge 自己加密也瞒不住它。所以 **P1 不对外说「中继看不到网页推送」**。
- 角标数字仍是明文，属于元数据，接受。

**P2：Web Push 改为「bridge 加密，中继只签名」。** 订阅改经 E2E 通道交给 bridge 之后，这件事才有意义。
- **为什么能拆开**：VAPID 的 JWT 只含推送服务的 origin、过期时间和 sub，不覆盖正文；RFC 8291 的加密只用订阅里的 `p256dh` 和 `auth`，与 VAPID 私钥无关。所以可以由 bridge 加密、中继签名投递（RFC 8291 / 8292）。
- **新帧**：`{t:"push", kind:"webpush-sealed", endpoint, body:<base64 aes128gcm 密文>, ttl, urgency?}`。中继只加 `Authorization: vapid …` 和 `TTL` 头，再 POST 出去。原有的 `webpush` 帧保留给老 bridge。
- **发送方认证**：中继看不到正文，就没法再往正文里写 fp（`relay/push.ts` 的 `bindSenderFp`）。所以 sealed 推送的正文里带上 `{fp, ts, n, mac}`：
  - `mac = HMAC(Kp, fp ‖ ts ‖ n ‖ 正文)`，其中 `Kp = HKDF(ECDH(D, M), info = "push")`，在 v2 配对完成时派生，浏览器把它存成不可导出的 HMAC 密钥；
  - SW 先验 mac，再检查 `ts` 在 TTL 之内、`n` 最近没出现过（IndexedDB 里存最近 256 个）；都通过后才信 fp，才会带着凭据发已读回执。
  - 已读回执经 SW 自己的 E2E 会话发出（§4.1.5）。
- **Apple 的要求**：`sub` 须是 URL 或 mailto，JWT 不超过一天，payload ≤ 4 KB，VAPID 公钥与订阅时一致，必须带 TTL 头。中继现有的签名逻辑已满足前四条；TTL 头由中继按 `ttl` 字段补上。
- **效果**：v2 设备的推送正文，中继既看不到，也伪造不了；它仍能丢推送，也看得到推送时间。

**P3：APNs。**
- bridge 发 `{aps:{alert:{title:"Claudestra", body:"有新消息"}, "mutable-content":1}, e2e:"<密文>"}`，壳里的 NSE 用 Keychain 里的密钥解密，再替换标题和正文。NSE 大约有 30 秒时限，超时就显示通用文本。
- 在此之前，APNs 一律走「不带正文」。

## 6. 推荐与分期

| 期 | 内容 | 解锁的说法（完整措辞见 §8） | 依赖 |
|---|---|---|---|
| **P0**（本稿） | protocol.md §4.1、§9 和 design-hosted-frontend §11 加注并指向本稿；relay README 加链接 | — | — |
| **P1** | ⓪ T25；① 「推送不带正文」开关；② CLI 或带外邀请的 peer 整体加密（§5.1） | 「用 CLI 生成、私下交换邀请建立的 peer，经中继的协作是加密的，中继也冒充不了」「推送可以设成不带任何内容」 | 不依赖前端改造 |
| **P2** | 配对 v2（S / SAS）；E2E 会话与记录流；客户端请求收口（§4.1.5）；`RELAY_E2E_ONLY` 与凭据来源、作废（§4.1.6）；Web Push sealed（§5.2）；托管网页上的 peer 邀请改走 E2E | 「开了只收加密请求的机器，经中继的内容加密传输，中继只看得到元数据；前提是网页代码是官方构建」 | P1 的密码学库（twin） |
| **P3** | iOS 壳打包前端和签名热更新；NSE 解密 APNs；签名的 bundle 清单；以后视需要做校验扩展、跟进 WAICT | 「iOS App 内置代码，中继既看不到内容，也换不了代码」 | P2；壳只能在 owner 的 MacBook 上签名 |

**回退**：
- P1、P3 的能力可以单独关掉。
- P2 的开关也可以关，但按 §4.1.6，关掉不会复活已作废的凭据；对标记为「必须加密」的机器，前端也不会回退到明文（§4.1.5）。

## 7. 迁移与兼容

### 7.1 能力协商（只加字段；能力位不可信的地方单独写明）

| 位置 | 新增 | 可信度 |
|---|---|---|
| `welcome.push` | `sealed: true`：中继支持 `webpush-sealed` | 中继自报；谎报最多让推送失败 |
| `GET /api/v1/capabilities` | `features` 加 `e2e-v1`、`pair-v2` | 经中继明文获取时不可信，**只用来决定第一次配对是否用 v2**；做过 v2 以后只经 E2E 获取（§4.1.5） |
| `GET /app-config.json` | `e2e: 1`、`manifest: {version, sha256, sigUrl}` | 中继自己的端点，只作展示 |
| 配对链接 | `#2.<fp>.<S>` | 老前端回退到 v1 |

### 7.2 新老组合

| 组合 | 行为 |
|---|---|
| 新前端 + 老 bridge | 没有 `e2e-v1`，走明文，页面标出「未加密，这台机器需要升级」。前提是这台机器从没做过 v2；做过的就只报错，不回退 |
| 老前端 + 新 bridge（开关关） | 明文路径照常可用 |
| 老前端 + 新 bridge（开关开） | 返回 403 `e2e_required`，页面提示升级前端 |
| 已有 cookie 的设备 | **不做补登记**。开关打开时作废（§4.1.6），需要重新配对 |
| 新 bridge + 老中继 | 推送回退到 `webpush`；E2E 请求在老中继看来只是普通的 `/m/<fp>/api/v1/*` 路径，照样转发 |
| 自建中继 | 与官方中继同一份代码 |
| `RELAY_E2E_ONLY` 默认值 | 新装机默认开：装机时还没有任何经中继的凭据，不需要作废什么。存量机器默认关，doctor 提示一行，并说明打开后需要重新配对。统一改成默认开需要 owner 拍板 |

### 7.3 子域名隧道

子域名模式把本机 Web 整条透传出去，cookie 也在里面，**不做加密**。按 design-hosted-frontend §10 的截止日退场，届时中继回 410。开了 `RELAY_E2E_ONLY` 的机器会提前拒绝这类请求。它被当成回环的问题归 T25 修。

### 7.4 不受影响

回环、直托管、Tailscale 直连（TLS 或 WireGuard 本来就在本机终止），以及 Discord（另一条信任链）。

## 8. 残余风险与对外说法（建议稿）

- **始终存在**：元数据；模型厂商看得到内容；中继可以拒绝服务。
- **P2 之后仍然存在**：浏览器用中继托管的前端时，控制中继的人可以给指定用户下发改过的代码。所有网页版加密产品都有这个前提。缓解办法是签名清单（任何人都能核对），彻底解决要靠可信客户端。
- **开关关着的机器没有 P2 保护**；存量机器打开开关，要重新配对。
- **fp 只有 64 位**：拿来路由和给人核对够用，但凡是认证密钥的地方，都靠 S、SAS 或完整公钥。

| 阶段 | 能说 | 不能说 |
|---|---|---|
| 今天 | 「会话记录、代码、台账都在你自己的电脑上。想让任何第三方服务器都不经手，就只用 Tailscale 直连或直托管」 | 「中继看不到」「端到端加密」 |
| P1 后 | 加一句：「用命令行邀请、私下交换邀请建立的机器间协作，经中继是加密的，中继也冒充不了；推送可以设成不带任何内容」 | 「中继看不到网页推送」「所有协作都加密」 |
| P2 后 | 「电脑开启『只收加密请求』后，经中继的对话内容加密传输，中继只能看到哪台电脑、什么时候、多少流量。网页版的代码由中继提供，和所有网页版加密产品一样，前提是这份代码没被改过；每个版本的文件指纹都公开可查」 | 「中继什么都看不到」「零信任」「控制了中继也看不到」 |
| P3 后 | 「iOS App 内置代码，中继既看不到内容，也换不了代码。要最高隔离：用 Tailscale，或者用自带域名直连自己的电脑」 | 「数据不出机器」（模型厂商看得到） |

## 9. 实测与来源

### 9.1 实测（2026-09-28，在 scratchpad 做的一次性实验，不进仓库；本机 macOS 26.5.2）

| 项 | Safari 26.5.2 | Chromium 145（Playwright headless） |
|---|---|---|
| X25519 生成（不可导出）与 ECDH 派生 | 通过 | 通过 |
| Ed25519 签名与验签；导入 Node 生成的原始公钥（protocol.md §10 的测试向量） | 通过 | 通过 |
| P-256 ECDH；HKDF 加 AES-GCM | 通过 | 通过 |
| **X25519 CryptoKey 存进 IndexedDB 后读回** | **失败：读回 `null`**；`structuredClone` 报「Unable to deserialize data」 | 通过 |
| Ed25519、P-256（ECDH 与 ECDSA）、AES 的 CryptoKey 存进 IndexedDB 后读回 | 通过 | 通过 |
| SW 从 IndexedDB 取出页面存的不可导出 P-256 密钥，做 ECDH、HKDF 和 AES-GCM 解密 | 通过 | 通过 |
| SW 拦截 fetch，逐块变换上游的流再返回 | 通过 | 通过 |

- Safari 那一列是在本机 Safari 里打开 localhost 页面测的。今后同类验证改用 headless，或者交给 owner 自己打开看。
- 第 2 轮审查的实测（台账 reviews 目录下的 `T21-r2-work/race.ts`）：按 RFC「先查窗口、再验 tag、最后记下」的顺序实现，中间有 `await`；同一请求并发发两份，两份都返回 200，同一个 nonce 被用了两次。改成 §4.1.4 第 3 步的写法后，一份 200、一份 409，只处理了一次。
- **没测**：iPhone 真机；HMAC 类 CryptoKey 在 Safari 里的存取（同为对称密钥，预期与 AES 一致，开工时补测）；SW 里长时间运行的流；真实推送；NSE。

### 9.2 来源（查证日期 2026-09-28）

- WebCrypto：MDN browser-compat-data 8.1.3（Safari 17 起支持 X25519 和 Ed25519；Safari 的 Ed25519 签名是随机化的）；https://chromestatus.com/feature/4913922408710144 ；https://w3c.github.io/webcrypto/ （CryptoKey 可序列化）。
- 防重放窗口：RFC 4303 §3.4.3；RFC 6347 §4.1.2.6。HPKE：RFC 9180。
- Web Push：RFC 8291 https://www.rfc-editor.org/rfc/rfc8291 ；RFC 8292 https://www.rfc-editor.org/rfc/rfc8292 ；Apple《Sending web push notifications in web apps and browsers》。
- NSE：Apple《Modifying content in newly delivered notifications》（要求 `mutable-content: 1`，时限约 30 秒）。
- Service Worker 更新：https://w3c.github.io/ServiceWorker/ 。
- WAICT：Cloudflare 博客；Mozilla Hacks（2026-05）。Code Verify：engineering.fb.com（2022-03）。Isolated Web Apps：Chrome 开发者文档。
- SAS 与承诺：Bluetooth Core Specification 的 Numeric Comparison；ZRTP（RFC 6189）的哈希承诺。
- TLS 直通先例：Tailscale Funnel https://tailscale.com/kb/1223/funnel ；ngrok TLS 文档；Nabu Casa《Security aspects》（TLS 在本机终止、DNS-01、SniTun、CT 审计）。
- WebRTC：W3C webrtc-pc；RFC 8831、RFC 8656。
