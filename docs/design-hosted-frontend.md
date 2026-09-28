# 设计文档：托管前端 + 设备配对（一个域名，配对即到自己的机器）

> 状态：**定稿，开工中**（2026-09-27 owner 拍板「直接做最终形态」；同日经本机 agent-codex 复核，标「codex」的条目是复核后改的）。
> 前置：中继 v2（[relay/protocol.md](./relay/protocol.md)）、多前端 API（[design-multi-frontend.md](./design-multi-frontend.md)）。

## 0. TL;DR

- **用户只记一个地址** `https://relay.<域名>/`，打开就是 Claudestra 网页；第一次扫码 / 输码把「这个浏览器」配对到自己的 Mac，以后打开直接进；一个浏览器可配对多台机器，页内切换。
- **前端由中继托管**（静态 bundle），所有用户同时拿到新版本；每台 Mac 不再跑 Next.js 服务，**web 服务端（BFF）整个消失**，机器侧只剩 bridge（Bun）一个进程。
- **登录 = 设备凭据**：配对时由用户自己的 bridge 签发、bridge 自己校验；中继只做路由、转发和推送投递，不做账号、不做授权。没有邮箱账号、没有密码、没有 SSH 远程登录要求。
- **中继按路径路由**：`/m/<指纹>/api/v1/…` → 转给那台机器的 bridge。子域名 `<名字>.relay.…` 按明确的兼容截止退场；自建中继从此只要**一个主机名**。
- 三种入口同一份代码：中继（公网 HTTPS）、bridge 直接托管（`https://<mac>:3847/`，Tailscale / 自带证书；明文 LAN 只算降级入口）、本机回环（自动配对）。

## 1. 为什么要改

中继 v2 把每台 Mac 上的整个 web（含服务端）经隧道搬到公网，一夜做完，代价是：每台机器一个子域名，用户要记「自己的地址」，自建者要通配 DNS + 通配证书；前端跟着每台 Mac 的 build 走，三台机器三个版本（owner 手机上「新版本已就绪」就是 Mac 没重建 web）；机器侧两个进程，web 那边还有 SSH 远程登录、SQLite 会话、passkey、TOTP 一整套登录体系。owner 一开始的设想就是「所有人连一个域名」。

## 2. 目标形态

```
                    https://relay.<域名>/                     ← 静态前端（中继托管，同一份给所有人）
  浏览器 / iOS 壳 ──┤
                    https://relay.<域名>/m/<fp>/api/v1/…      ← 设备凭据（HttpOnly cookie，Path=/m/<fp>/）
                                 │ 隧道（现有 from:"relay" 帧，按 fp 选实例；中继只放规范化后的 /api/v1/*）
                                 ▼
                    这台 Mac 的 bridge  ── 进程内「远程设备入口」dispatch（不经回环 HTTP，不享回环豁免）
```

- 中继：静态托管 + 路由 + 转发 + 推送投递网关（§7）。它知道的只有「哪个 fp 在线」和它转发的字节（本版仍是 TLS 终点，见 §11）。
- bridge：唯一的服务端。现有 `/api/v1` 已覆盖聊天 / 事件 / 终端 / 会话 / 项目 / cron / 更新等；BFF 里剩下的本地逻辑搬进来（§9）。
- 前端：Next.js **保留**，`output: "export"` 静态导出（codex：别同时换认证、服务端和构建器）；所有请求经一个 API 客户端，基址 = 当前机器的 `/m/<fp>`（中继）或 `""`（直托管）。

## 3. 身份模型：person / device / machine / grant（codex）

bridge 里「你是谁」= principal，聊天身份 `chat_id = api:<principalId>`：历史里「哪条是我发的」、未读、推送、Discord 镜像都按它算。今天 web 只有一个 token，所以一切正常；每个设备一个 principal 会让手机和电脑变成两个「用户」。所以：

- **person = principal**。owner 本人是 `owner:self`（role owner）；别人（家人、同事的手机）是独立的 external principal，有自己的聊天身份。
- **device = credential**，挂在 principal 下：`credentials: [{id, v: 1, type: "bearer", hash, deviceName, grant, createdAt, lastSeenAt, expiresAt}]`。同一 principal 的所有设备共享 chat_id。凭据可单独撤销；`v`/`type` 预留 pubkey 类凭据（codex：版本化凭据比只加 pubkey 字段有用）。
- **machine** = 这台 bridge（fp）。一个浏览器 × 一台机器 = 一条凭据，高熵随机，服务端只存哈希。
- **grant** = 该凭据能做什么：`agents`（`*` 或清单）、`master`、`terminal`、`manage`（cron / projects / config / update / devices / peers / stats / relay）。管理类端点这次补上角色 / grant 判定——今天只看 Bearer 不看角色；旧的无 role token 保持 external，**不自动升 owner**（codex）。
- 有效期：凭据 90 天不用自动失效（每次使用滑动）；丢设备就撤销；恢复路径 = 重新配对。第一版不做 refresh（codex：它限制的是外泄窗口，不是恶意 JS）。

## 4. 配对（codex 复核后重写）

短码登记给中继、兑换又经中继，所以**中继看得见兑换流量**（它是 TLS 终点），本版不宣称「中继看不到授权」。能做的是让它只当查找线索，把决定权留在 Mac 上：

1. Mac 上 `claudestra pair`（或网页「配对新设备」）→ bridge 生成 **128 位秘密** `S` 与 **8 位短码** `C`，向中继登记 `C → fp`（现有机制），打印二维码 `https://relay.<域名>/pair#<fp>.<S>` 与短码。**生成时明确打印这条凭据的 grant**（默认：所有 agent + master + 终端；`--agents a,b` / `--no-terminal` / `--guest <名字>` 缩小；guest = 独立 principal，无 master 无终端无 manage，**agents 必须写明**——没写 / 空一律拒，`*` 要二次确认，见 lib/devices.ts `checkGuestAgents`）。
2. **扫码 / 点链接**：`#` 片段不经中继。前端 `POST /m/<fp>/api/v1/devices/pair {proof: HMAC(S, challenge), deviceName}`（先 `GET …/devices/pair/challenge`）→ bridge 校验 → 签凭据 → `Set-Cookie`。秘密本身不出浏览器。
3. **手输短码**：前端 `POST /api/v1/codes/lookup {code}`（中继，限流）得 fp → `POST /m/<fp>/api/v1/devices/pair {code, deviceName}` → bridge 记为 **pending**，**Mac 侧确认**：正在跑的 `claudestra pair` 提示「设备 <名字> 请求配对，授予 <grant>，确认？」，网页对话框同样弹确认；确认后签发。短码只是查找与确认线索，穷举无用（codex）。
4. bridge 自己做：尝试限额（每 fp 每分钟）、10 分钟过期、原子一次性消费；不依赖中继限流（现有 relay-pairing.ts 已有大半）。
5. **本机回环**：`POST /api/v1/devices/local` 只接受**真实回环 HTTP 连接**（不是隧道 dispatch，见 §6）+ 同源 Origin + 自定义头 `x-cstra-device`（浏览器跨源打不进：自定义头触发预检，CORS 默认拒）。

TOTP / passkey 删除后，配对就是唯一验证手段，强度靠：秘密 128 位 + 短码需 Mac 确认 + grant 明示 + 可撤销（codex：「Face ID 遮罩」只是 UI，不算再认证）。

## 5. 凭据的传输：HttpOnly cookie，不是 IndexedDB 里的 Bearer（codex 复核后改）

同源下按机器分 IndexedDB 不是安全隔离：机器 A 的输出若造成 XSS，能读到 B、C 的凭据。改为 bridge 在配对响应里 `Set-Cookie: cstra_dev=<token>; HttpOnly; Secure; SameSite=Strict; Path=/m/<fp>/`（直托管 `Path=/`；回环 http 不带 Secure）：

- JS 拿不到凭据，XSS 只能在页面存活期间借用（与不可导出私钥同等效果，零加密复杂度）；`<img src>`、下载链接、Service Worker 自动带凭据，**三处「拿不到 header」的问题消失**，token 永不进 URL / 日志 / SW 缓存（codex 第 6 条）。
- CSRF：SameSite=Strict + bridge 对所有非 GET 要求自定义头 `x-cstra-device: 1`。
- **中继过滤机器响应的 Set-Cookie**：只放 `cstra_dev` 一个名字，并**强制**改写属性为上面那组（Path 钉死为该 fp）；其它 Set-Cookie、`Clear-Site-Data`、`Service-Worker-Allowed` 一律丢弃——不让一台机器影响整个主源（codex）。
- Bearer 仍给 peer / 脚本 / 老 token 用；`/api/v1` 鉴权 = cookie 或 Bearer 二选一。
- 撤销要**连带**：该凭据的在途 SSE、终端流、推送绑定一起断（bridge 维护「凭据 → 活动连接」表）；前端区分撤销 / 过期 / 机器离线 / 版本不兼容四种状态，不是统一 401 就删配置。

## 6. 入口边界（codex 第 4 条，先于搬功能）

- **隧道请求不走回环 HTTP**：relay-inbound 在 bridge 进程内，from:"relay" 的请求直接调 API dispatch，带显式 `RequestContext { source: "relay", clientIp: <xff，仅展示不作身份> }`；`source: "loopback"` 只由真实回环 socket 产生。回环豁免、`/devices/local`、`/host`、`/agents/:name/open` 只认 `source: "loopback"`。
- **中继侧 `/m/<fp>/<path>` 规范化**：percent-decode 后拒 `..`、`//`、控制字符；只允许 `/api/v1/*`；拒 Upgrade；方法白名单；正文按现有帧上限。
- **peer 入口不变**：peer-ingress 端口仍只认 peer token；设备请求不走它。`isFullScope` 的每处使用逐项映射到 grant。
- **推送 endpoint 是用户提交的外部 URL**：只允许 https、拒私网 / 回环 / 链路本地地址、限响应体、超时（SSRF）。转写（≤20 MB、并发 2、30 s 超时）、上传（沿用 bridge multipart 上限）、client-log（限行长与速率、脱敏）都有鉴权与限额，不能拖死唯一的 bridge 进程。
- **终端**：现有 web 终端已是 SSE + POST（`/agents/:name/terminal` + `/terminal/:id/input|resize`），不是 WebSocket，无需 WS 隧道。

## 7. 推送（codex 复核后改：网关模式）

一个 origin 一个 Service Worker registration 只能有**一份**订阅，不能按机器各用一把 VAPID 密钥；也**不能把同一把 VAPID 私钥复制到所有 Mac**。因此：

- **中继模式 = 推送网关**：浏览器用**中继的 VAPID 公钥**（`/app-config.json` 下发）订阅一次；把订阅交给每台已配对机器（`POST /m/<fp>/api/v1/push/subscriptions`）。机器要推时发 `push` 帧 `{endpoint, keys, payload}` 给中继，中继用自己的 VAPID 私钥签名、加密、投递；持有完整订阅即视为有权推送（endpoint 只有订阅者与它交给的机器知道）。中继限每 fp 速率与 payload 大小，校验 endpoint（SSRF 规则同 §6）。APNs 同理：官方中继持官方 `p8`，机器只发 `{deviceToken, payload}`；自建中继用自己的凭据或只做 Web Push；**官方 p8 不分发**。
- **直托管模式**：机器自己的 origin 一个订阅，bridge 自签 VAPID 直发（现有逻辑搬入 bridge，`web-push` 包 + `node:http2` 已在 Bun 1.3.14 验证可加载；真实 http2 请求路径 T3 先用本地 http2 测试服务器验证）。
- 派发规则原样（只推 owner principal 的 `api:` 出站消息、Discord 里说话算已读、未读计数与角标、iOS 不发 dismiss）；派发器订阅进程内 event-bus，不再自己开 SSE 连自己；3339 端口锁不再需要。
- 子域名 → 主域名后旧 SW / 订阅**无法迁移**，浏览器重新注册（codex）。
- 中继看得见通知正文（与本版隧道明文同级；端到端加密是下一阶段）。

## 8. 前端（web/）

1. `next.config`：`output: "export"`、`images.unoptimized`；删 `app/api/**`、`proxy.ts`、`instrumentation.ts`、`lib/services/*`、`lib/db*`、`lib/push` 服务端部分、`headers()`、`serverExternalPackages`；`app/page.tsx` 改客户端跳转。**先验证** `/chat`、`/pair`、`/join`、`/i` 直接打开 / 刷新 / 前进后退在导出布局下的行为；动态段改查询参数；托管方按导出文件布局服务（`/chat` → `chat.html`），未知路径 404 页（codex：不是所有路径都自动回退 index.html）。
2. **入口模式用明确配置**：托管方提供 `/app-config.json`：`{ mode: "relay", relayBase, vapidPublicKey }` 或 `{ mode: "direct", fp, machineName }`（codex：别靠「origin 像中继」猜）。
3. **API 客户端** `lib/api/client.ts`：`api(machine, path, init)` 基址 `/m/<fp>` 或 `""`，`credentials: "include"`，非 GET 自动带 `x-cstra-device: 1`；响应 401 → 该机器进入「需重新配对」态。**每个请求捕获目标机器**，切机器时中止旧 SSE / 请求，异步完成时不许改用「当前机器」；缓存键与 query key 含 fp（codex）。
4. **形状适配** `lib/api/<域>.ts`：把 BFF 对 bridge 响应做过的包装（`{data}`、`__master__`↔`master`、错误码）搬到这里；`chat/history`（376 行）与 `chat/stream`（400 行）的纯变换整体搬进前端（bridge 只出原始数据；「哪条是我发的」= `chatId === "api:owner:self"`）。
5. **机器列表** `lib/machines.ts`：IndexedDB 只存 `{fp, name, addedAt, lastUsedAt}`（**不存凭据**）；顶栏切换；`/pair` 页处理扫码片段与手输短码；`/login` 重定向到 `/pair`。
6. **版本与兼容**：`GET /api/v1/capabilities` 加 `apiVersion` / `minClient`，前端对每台机器做握手，过旧的机器显示「这台机器需要升级」而不是坏掉；中继部署原子化（新目录 + 切换）并保留旧的 hashed chunks；`/version.json` 只驱动「新版本」提示（codex：只比 version.json 会把远端旧机器集体弄坏）。
7. **安全下限（codex 第 6 条）**：markdown 默认禁 raw HTML，链接 / HTML / SVG 统一清洗；HTML 类附件强制下载；CSP 严限 `script-src`（无 unsafe-inline / unsafe-eval，layout 内联脚本移出或构建时算 hash）、`connect-src 'self'`、`object-src 'none'`、`base-uri 'none'`、`frame-ancestors 'none'`；API 响应 `Cache-Control: no-store`。
8. 删：登录页表单、passkey / TOTP 设置、SSH 相关文案、`cstra_home`、`alignShellServerUrl`。

## 9. 现有 web 服务端路由盘点与去向

70 个 `web/app/api/**/route.ts`，全部经 `isAuthed()`（cookie 或 INTERNAL_API_KEY）、出站带 `CLAUDESTRA_API_TOKEN` 打 bridge。

**A · 直连 bridge（45）**——前端改调 `/api/v1/…`，BFF 的响应包装搬进 `lib/api/<域>.ts`：agents(POST) · agents/archive · claude-settings · codex-settings · pi-settings · kill · restart · remove · pi-update · resume · auto-compact · capabilities · chat/auq · chat/clear · chat/interrupt · chat/permission · chat/search · chat/send(JSON) · chat/skills · chat/tasks · claude-models · cron · memory-hygiene · peers(全部) · projects · remote-access · restart-all · runtimes · sessions · sessions/:id/history · sessions/:id/manage · sessions/archived · archived/:id/restore · settings/archive-retention · settings/claude-defaults · terminal/input · terminal/resize · terminal/stream · update · update/check · update/settings；A†（控制路由 → owner grant `manage` 专用 `/api/v1/relay/status|pair`、`/api/v1/stats`）。

**B · 逻辑搬进 bridge（17）**：agents(GET：未读计数 + 清孤儿) · agents/open · projects/open · host（三者只认 `source: "loopback"`）· agents/settings · chat/attachment/[name] · chat/messages/hide · chat/send(multipart：改用 bridge 原生 multipart) · chat/transcribe · client-log · profile · push · push/apns · push/read · settings · skills/prefs · version。**chat/history、chat/stream 是纯变换，搬进前端**（§8.4）。

**C · 随登录体系删除（8）**：auth/config · login · logout · me · pair（→ devices/pair）· passkey · passkey/login · totp；连带 auth.db、`login_lockouts` / `auth_config` / `totp_recovery_codes` / `webauthn_credentials`、ssh2 / @simplewebauthn / otpauth 依赖、`proxy.ts`、`instrumentation.ts`。

**D · 删（1）**：push/ack。

**bridge 新增的状态库**：`bun:sqlite` 开 `~/.claude-orchestrator/web-state.sqlite`，表照搬 settings.db 要保留的 8 张：`agent_settings`、`user_profile`、`skill_prefs`、`push_subscriptions`、`push_read`、`hidden_messages`、`agent_unread`、`apns_devices`。转写 key 从 web 的 config.json 迁到 `~/.claude-orchestrator/config.json`（`groqApiKey`），env `GROQ_API_KEY` 兜底。

**前端现状**：没有统一 fetch 封装——41 个文件里 91 处 `fetch("/api/…")`，chat-store 23 处，401 处理复制约 12 遍；SSE 用 fetch 流。

## 10. 安装 / 迁移 / 退场（codex：先验证新模式再停旧 Next）

- `install-cli` 不再装 `com.claudestra.web`；setup 删「Web 前端配置」「网页登录」两步；「手机访问」的配对码 / 二维码逻辑不变，地址改为 `https://relay.<域名>/pair#…`。doctor 去掉 web 服务 / SSH 登录检查，加设备凭据 / 静态目录 / 推送网关检查。
- 升级顺序（每台机器）：① 新 bridge 起来，`/api/v1/capabilities` 报新能力，**旧 Next 继续跑**；② `manager migrate-web-state`：**先备份** `~/.claude-orchestrator/web/` 整目录（tar，带时间戳），再把 8 张表与 groqApiKey 复制进新库（可重复执行、幂等）；③ 用户在新入口配对一次并确认能聊、能收推送；④ `manager retire-web` 卸 `com.claudestra.web`（旧数据只作废不删，回滚 = 重装 daemon + 还原备份）。
- 子域名隧道与 `cstra_home`：**明确截止**——中继按实例上报的 bridge 版本判断，低于 `minBridgeForPathMode` 的实例仍给子域名；截止日（发布后 30 天）之后中继对子域名回 410 并指向新入口。不是「保留一个 minor」这种模糊说法（codex）。
- 文档：SETUP 两版、web/SETUP.md、docs/relay/*（self-host 单主机名 + 推送网关配置）、CLAUDE.md 一行、features.md。

## 11. 信任边界（写给用户的实话）

- 中继运营方能看到经它的一切（TLS 终点），并且托管的 JS 跑在你的浏览器里——**信任托管中继 = 信任运营方**，与任何 SaaS 相同；本版对恶意运营方没有防线，端到端加密与「打包的可信客户端 + 受控更新」是下一阶段（远程加载 serverURL 的 iOS 壳不算可信客户端）。
- **同一主源上多台机器**：一台机器的输出若突破清洗 / CSP 造成 XSS，能在页面存活期间借用你在这个浏览器里的其它机器的凭据（HttpOnly 让它偷不走，但挡不住借用）。这是相对子域名方案**新增**的攻击面，用 §8.7 的下限对冲；对隔离有更高要求的用户，走直托管 + 自带域名（JS、SW、更新源、TLS 全在自己手里）。
- 官方 runner（以后若有）改变「永远跑在用户电脑上」的承诺，不能宣称与本方案自然兼容。

## 12. 任务与顺序（codex：先纵切，再并行）

| # | 任务 | 依赖 | 交付 |
|---|---|---|---|
| T0 | **冻结接口**：本文 §3–§7 的凭据格式、grant 表、隧道来源上下文、`/m/<fp>` 规范化规则、推送帧、capabilities 握手、`/app-config.json` | — | 本文 + `docs/relay/protocol.md` 增补 |
| T1+T2 | **最小纵切**：中继 `/m/<fp>` 路由 + Set-Cookie 过滤 + `/api/v1/codes/lookup` + 静态托管；bridge 进程内 dispatch + `RequestContext` + 设备凭据（pair / challenge / local / list / revoke）+ cookie 鉴权 + grant 判定；一条真实请求端到端；**负向测试先写**：隧道打不到 `/devices/local` / `/host`、路径穿越被拒、peer token 调不了管理端点、短码穷举被限、Set-Cookie 越权被过滤 | T0 | src/relay/*、src/bridge/devices*、tests |
| T3 | 推送：网关帧 + 中继投递（VAPID / APNs）+ bridge 直发模式 + 派发器搬入 + SSRF 规则；**先在 iOS 上验证中继 origin 订阅能收到** | T1+T2 | src/relay/push*、src/bridge/push/* |
| T4 | bridge 本地逻辑搬入：web-state.sqlite、设置 / profile / skills / hidden / unread、转写、client-log、host / open、version、A† 端点 | T0 | src/bridge/local-api/* |
| T5 | 前端：API 客户端 + 形状适配 + history / stream 变换搬入 + 机器列表 + 配对页 + 静态导出 + CSP + 删登录体系 | T1+T2 接口 | web/ |
| T6 | 安装 / doctor / 迁移与退场脚本 / 文档 | T2–T5 | setup.ts、install-cli、docs |
| T7 | **从纵切起就跑**：Playwright 经中继（配对 → 聊天 → SSE → 终端 → 推送）、直托管、回环；负向清单：配对抢兑 / 穷举、隧道打 local、路径穿越、peer 调管理端点、A 输出攻击 B 凭据、撤销已连接终端、切机发错目标 | 持续 | 验证记录 |

分支 `feat/hosted-frontend`；T1+T2 主 agent 亲自做完纵切并合进分支后，T3 / T4 / T5 各一个 worktree 由子 agent 并行，每块自带 `bun run check` 与负向测试；主 agent 合并、跑 T7、发 PR。最容易反噬的是 T2（一次改 owner / master / terminal / 回环 / 旧 principal 的默认值），所以纵切阶段不并行。

## 13. 接口契约（T0 冻结；T3 / T4 / T5 并行开发的依据，改这里要三方同步）

### 13.1 已实现（纵切，feat/hosted-frontend）
- 中继：`https://<base>/m/<fp>/api/v1/…`（lib/relay-machine-path.ts 的规范化规则；请求头加 `x-claudestra-relay-mode: api`、`x-claudestra-relay-prefix: /m/<fp>`；响应只放 `cstra_dev` 一个 Set-Cookie 并钉属性）；`POST /api/v1/codes/lookup {code}` → `{ok, fp, name, slug}`；`GET /app-config.json` → `{mode:"relay", relayBase, version, commit?}`；`RELAY_STATIC_DIR` 托管前端静态站（lib/static-site.ts 的导出布局）。
- bridge 鉴权（bridge/api-auth.ts）：Bearer 或 cookie `cstra_dev`；cookie 路径的非 GET/HEAD 必须带 `x-cstra-device: 1`（否则 403 `{code:"csrf"}`）；凭据无效 / 过期 401 `{code:"device_invalid"}`。经中继的请求在进程内 dispatch（bridge/relay-dispatch.ts），`RequestContext.source = "relay"`，回环豁免只认真实 socket。
- 设备（bridge/devices.ts）：`GET /api/v1/devices/pair/challenge` → `{challenge, expiresAt, fp, machineName}`；`POST /api/v1/devices/pair {proof:{challenge,hmac}, deviceName}`（hmac = base64url(HMAC-SHA256(base64url 解出的秘密, challenge))）→ 200 + Set-Cookie + `{fp, machineName, principalId, credentialId, grant, expiresAt}`；`POST /api/v1/devices/pair {code, deviceName}` → 202 `{pending:true, approvalId, expiresAt, machineName}`；`GET /api/v1/devices/pair/status?approval=<id>` → 202 pending / 200 + cookie / 410 `{state:"denied"|"expired"}`；`POST /api/v1/devices/local {deviceName}`（只认回环 + `x-cstra-device` + 同源）；`GET /api/v1/devices`（manage）→ `{devices:[{id, deviceName, principal, principalName, grant, createdAt, lastSeenAt, lastIp, expiresAt, current}]}`；`DELETE /api/v1/devices/:id`（manage，或自己那条 = 退出登录，回删 cookie）；`GET /api/v1/devices/approvals`、`POST /api/v1/devices/approvals/:id {approve}`（manage）。
- CLI：`claudestra pair [--agents a,b|*] [--no-terminal] [--no-manage] [--guest <名字> --agents a,b [--confirm-all]] [--json]`；回环控制路由 `POST /relay/pair/new {agents?,terminal?,manage?,guest?,confirmAllAgents?}` → `{code, display, url(旧子域名), link(https://<base>/pair#<fp>.<secret>), base, slug, fp, grant, guest?, expiresAt}`、`GET /relay/pair/approvals` → `{approvals, activeCodes}`、`POST /relay/pair/approve {id, approve}`。
- 管理门：`isFullScope(principal)` 现在等于 `canManage`（owner 或过渡期的全 scope 非 peer token；设备凭据看 grant.manage）。

### 13.2 T4：bridge 本地 API（替代 BFF 的 B 类路由；全部走同一鉴权）
| 端点 | 形状 |
|---|---|
| `GET /api/v1/version` | `{version, commit, apiVersion: 1, minClient: "<semver>"}`；`GET /api/v1/capabilities` 加 `apiVersion`、`features: string[]` |
| `GET/PUT /api/v1/settings` | `{lang: "zh"\|"en", groqApiKeyHint: string\|null}`；PUT 体 `{lang?, groqApiKey?}`（空串 = 清除） |
| `GET/PUT /api/v1/agents/:name/settings` | `{initMessage: string\|null}` |
| `GET/PUT /api/v1/profile` | `{user:{nickname, avatar}, claude:{nickname, avatar}}`（avatar data URL ≤ 256 KB） |
| `GET /api/v1/skills/prefs` · `PUT /api/v1/skills/prefs/:name {pinned}` · `POST /api/v1/skills/prefs/:name/used` | `{prefs:[{name, pinned, usedCount}]}` |
| `GET /api/v1/agents/:name/hidden` · `POST /api/v1/agents/:name/hidden {sessionId, fromSeq, toSeq, hide}` | `{ranges:[{sessionId, fromSeq, toSeq}]}` |
| `GET /api/v1/agents`（owner）加 `unread: number` · `POST /api/v1/agents/:name/read` · `GET /api/v1/reads` | `{reads: Record<agent, isoTs>}` |
| `POST /api/v1/transcribe`（multipart `audio`，≤ 20 MB，并发 2，30 s） | `{text}`；没 key 501 |
| `POST /api/v1/client-log`（文本或 `{lines:string[]}`，每行 ≤ 2 KB，每凭据 60 行/分钟） | `{ok}` |
| `GET /api/v1/host` | 本机 `{local:true, platform, openers:[{id,label}]}`；否则 `{local:false, localEntry?}`（本机的判定见 §14） |
| `POST /api/v1/agents/:name/open {with}` · `POST /api/v1/projects/:id/open {with}` | 只认本机，否则 403 |
| `GET /api/v1/attachments/:name` | BFF chat/attachment 的搬运（上传目录 → 收件箱 → 后缀匹配），owner 专用 |
| `GET /api/v1/relay/status` · `POST /api/v1/relay/pair` · `GET /api/v1/stats` | 控制路由的 manage 版 |
| 状态库 | `~/.claude-orchestrator/web-state.sqlite`（bun:sqlite）：`agent_settings`、`user_profile`、`skill_prefs`、`push_subscriptions`、`push_read`、`hidden_messages`、`agent_unread`、`apns_devices`；`manager migrate-web-state` 从 `~/.claude-orchestrator/web/db/settings.db` 搬（先 tar 备份，幂等） |

### 13.3 T3：推送
- 中继帧（协议 v2 新增，向后兼容——老 bridge 不发）：bridge → 中继 `{t:"push", id, kind:"webpush", subscription:{endpoint, keys:{p256dh, auth}}, payload:<JSON 字符串 ≤ 4 KB>, ttl?}` / `{t:"push", id, kind:"apns", token, payload, badge?}`；中继 → bridge `{t:"push-ack", id, ok, status?, gone?: true, error?}`（`gone` = 订阅 / 设备已失效，bridge 删记录）。中继限每 fp 60 次 / 分钟；endpoint 只许 https 且非私网 / 回环 / 链路本地。
- `/app-config.json` 加 `vapidPublicKey`（中继模式浏览器用它订阅）。中继 env：`RELAY_VAPID_KEYS`（文件路径，缺则首次启动生成）、`RELAY_VAPID_SUBJECT`、`RELAY_APNS_KEY_PATH`、`RELAY_APNS_KEY_ID`、`RELAY_APNS_TEAM_ID`、`RELAY_APNS_TOPIC`、`RELAY_APNS_ENV`。
- bridge：`GET /api/v1/push/config` → `{webPush:{vapidPublicKey}|null, apns: boolean, mode:"direct"|"relay"}`（直托管 = 自签 VAPID 直发；中继连着 = 网关）；`POST /api/v1/push/subscriptions {subscription, userAgent}` · `DELETE /api/v1/push/subscriptions {endpoint}` · `POST /api/v1/push/apns {token}` · `DELETE /api/v1/push/apns/:token`。派发规则照 BFF（订阅进程内 event-bus）。

### 13.4 T5：前端
- 入口配置 `GET /app-config.json`（直托管由 bridge 服务：`{mode:"direct", fp, machineName, vapidPublicKey?}`）。
- API 客户端：基址 `/m/<fp>`（relay）或 `""`（direct）；`credentials:"include"`；非 GET 自动带 `x-cstra-device: 1`；401 `device_invalid` → 该机器进入「需重新配对」；请求捕获目标机器，切机器中止在途 SSE。
- 机器列表（IndexedDB，不存凭据）`{fp, name, addedAt, lastUsedAt}[]`；`/pair`：`#<fp>.<secret>` 走挑战应答，手输短码走 codes/lookup + pending 轮询（1.5 s，≤10 分钟）。
- `chat/history` 与 `chat/stream` 的变换搬进 `web/lib/chat/history-shape.ts` / `stream-shape.ts`；「我发的」= `chatId === "api:owner:self"`（guest 是它自己的 principalId，取自配对响应）。
- 静态导出：`output:"export"`；删 `app/api/**`、`proxy.ts`、`instrumentation.ts`、服务端 lib；`/login` → `/pair`；CSP 与 markdown 清洗按 §8.7。

## 14. 本机识别与本机直连（2026-09-28 补：v2.29 把「本机」收窄成只认 127.0.0.1，本机功能在 Tailscale / 局域网 / 中继下全没了）

- **直连入口**（bridge 自己的端口，含本机 Caddy / tailscale serve 反代）：来源地址属于本机任一网卡就算本机（`lib/same-host.ts`）。对端是回环且带 XFF → 取最右一跳（本机反代追加的）；对端不是回环 → 只认对端。只给「打开目录」这类低危功能用；配对与控制面豁免仍只认真实回环。
- **中继入口**：网络位置判不了。中继在浏览器出口 IP = 实例连中继的出口 IP 时给机器请求加 `x-claudestra-relay-same-net: 1`（浏览器自带的剥掉）；`GET /host` 经中继且直托管时回 `localEntry {port, sameNetwork}`。前端（`web/features/machines/local-hop.ts`）在同网 + 桌面浏览器时直接请求 `http://127.0.0.1:<port>/local-probe`（只答真实回环、跨源只放中继 origin、预检回 PNA 头），fp 对得上就整页切到 `http://127.0.0.1:<port>/chat`：回环自动配对，本机功能齐全，不再绕中继。探到别的实例（fp 不同）= 不是这台，什么都不做；Safari 拦「https → http 回环」探不通 → 底部横幅手动切（Chrome / Firefox 探不通就当不是这台，免得同网其它电脑冒横幅）；`?relay=1` 或关掉横幅 = 留在中继。
- **偏好交接**：两个网址的 localStorage 不通。切换前中继页面把白名单里的原始偏好与草稿（不含预生成的 CSS、API 基址）`POST /api/v1/handoff` 存进 bridge（内存、2 分钟、一次性、只有同一身份取得出），本机页面配对后 `GET /api/v1/handoff/:id` 取回、只补缺、按解析器重建 CSS 后重载一次。不把数据放进链接：链接谁都能伪造。
- CSP 相应放宽：`connect-src` 加 `http://127.0.0.1:*`（探测）与 `blob:`（分享导出读附件图）；`img-src` 加 `https:`（回复里的外链图）。
- 开发：`web/scripts/dev-proxy.ts`（`npm run dev`）在 127.0.0.1:33333 前挡 next dev，`/api/v1` 去掉 Origin 转本机 bridge——bridge 眼里是本机同源页面。

