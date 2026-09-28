# 跨实例 Chat（talk）协议 v1

人与人的 Chat（代码名 talk，界面叫 Chat）在两台 Claudestra 实例之间怎么传。**本文是定稿，传输还没实现**：一期只有本机 Chat（`src/lib/talk-*.ts`、`src/bridge/talk*.ts`），这里的入口、outbox、重投在二期写。规则的纯函数参考实现在 `src/lib/talk-protocol.ts`，测试向量在 `tests/talk-protocol.test.ts`。改协议先改这里。

关键字 MUST / SHOULD / MAY 按 RFC 2119 理解。术语沿用 [中继协议](../relay/protocol.md)：**fp / 指纹** = 实例公钥 sha256 前 16 位十六进制四位一组；**期望指纹** = 按 peer 记录现算出来的对方指纹（`src/lib/peer-trust.ts` 的 `expectedPeerFp`：peers.json 的 fp → `relay://` 里的 fp → 钉住的指纹）。

## 0. 已定的口径

| 项 | 规定 |
|---|---|
| 信任单位 | **实例，不是人**。接收方只能验证消息出自哪台机器；那台机器上是谁，是对方自报的，只能显示，不能拿来审计或授权 |
| 能力 | peer token 上新增布尔能力 `talk`，默认关，与 agent scope 互相独立（互加 ≠ 互相开放 agent）。**双方各自开**才能聊：中继的门控只看接收方的联系人清单，保证不了「双方都开了」 |
| 谁能往外发 | 只有 owner 级 principal（本机 owner 的设备）。由**发送方** bridge 执行；接收方只看得到对方自报 |
| 远端的人能做什么 | 只能发 chat、被 @。**不能当我方任务的 assignee，也不能作答我方的 ask** |
| 进 agent 上下文 | 别的实例发来的任何 chat 都不进。远端写的 @ 按纯文本处理；本机的人把它「丢进工作台」时整段包成外部文本 |
| 中继能看见什么 | 中继端到端加密上线前，经中继的 talk 正文对中继可见。界面在走中继的房间常驻一行「中继可见内容」 |
| 前提 | 中继信任边界的修复合并之后才开工：直连与中继两路强制验签、peer token 在路径模式被拒、隧道请求不算回环 |
| 推送 | 只推「@ 我」和「指给我的 ask」，不是每条都推。一期推送订阅只登记 owner 的设备，所以只有 owner 收得到；**二期先把推送订阅改成按 principal 区分**（订阅记下是哪个 principal 订的，推送按收件人挑设备），guest 才能收到自己的 @ 和指派 |

## 1. 入口与鉴权

- 入口 `POST /api/v1/talk/messages`，只收 peer principal。本机网页走 local-api（`/api/v1/talk/*`，一期已有），不走这个入口。
- 处理顺序 MUST 是：
  1. **正文上限在验签之前**：先看 Content-Length、按流截断，整条消息（含全部附件）≤ 2 MiB（`TALK_BODY_MAX_BYTES`），超了回 413。
  2. 验签：签名钥匙的指纹 MUST 等于期望指纹。
  3. **每次请求都现算期望指纹**，算不出来（legacy peer，三处都没有指纹）一律拒，不走 legacy 放行。
  4. token 上 `talk` 能力没开 → 403。
  5. 按 peer 限流：每个 peer 每分钟 ≤ 60 条，超了回 429。
  6. 帧校验与房间规则（§2、§3，`checkInboundFrame`）。
  7. 按 `(origin, id)` `INSERT OR IGNORE`，回签名回执（§4）。
- **origin 取期望指纹，不取正文里的任何字段**。
- 签发 `talk` 能力也要求能算出期望指纹。开关：`peer-http-scope <name> --talk on|off`。

## 2. 帧

```json
{ "v": 1, "type": "chat", "id": "tm_<uuid>",
  "room": { "creatorFp": "", "id": "<id>", "kind": "dm" }, "to": "owner:self",
  "author": { "principal": "owner:self", "name": "自报名" },
  "text": "…", "createdAt": "2026-10-01T00:00:00Z",
  "refs": [ { "kind": "task", "title": "…" } ],
  "atts": [ { "sha256": "…", "mime": "image/webp", "bytes": 81234, "inline": "<base64>" } ] }
```

| 字段 | 规定（不合格整条回 400） |
|---|---|
| `v` / `type` | `1` / `"chat"`。三期的派活帧用 `offer_*`，只进 offers 表，不建 people 行、不进房间 |
| `id` | `^tm_[0-9a-f-]{36}$`。手动重发复用原 id |
| `author.principal` | `^[A-Za-z0-9:_-]{1,64}$`（它会进成员键和 `people.id`） |
| `author.name` | 去掉控制字符、双向控制符、零宽字符后截到 32 个码点（`cleanName`）；存为 `claimedName` |
| `text` | ≤ 8000 字符；和 `atts`、`refs` 不能同时为空 |
| `refs` | ≤ 5 条，**只带 `kind` 和标题**（≤ 200 字符），不带 id：对方点不开我方的东西（台账读门拒 peer）。标题发出前 MUST 过出站扫描 |
| `atts` | ≤ 9 张，只收 png / jpeg / webp（SVG 拒收）；`inline` 解码后长度 = `bytes` ≤ 1 MiB、sha256 = `sha256`。发送方先压到 1 MiB 以内，压不下来只发缩略图；大文件不走中继 |
| 大小 | 中继单帧 256 KiB、分块 64 KiB；整条消息 ≤ 2 MiB，直连与中继同一上限 |

## 3. 房间

成员键 `<fp>/<principal>`（fp 小写），和从哪个实例看无关。房间键 `(creatorFp, id)`。

- **dm**：`creatorFp` 固定为空串。接收方**自己重算** `id = hex(sha256(utf8(a + "\n" + b)))`，a、b 是 `origin/author.principal` 和 `本机fp/to` 两个成员键按字节序排序；帧里的 `room.id` 不采信。`to` MUST 是本机存在并开放了 chat 的 principal。
- **thread**：按 `(creatorFp, id)` 划命名空间，`id` 形如 `tr_<uuid>`。入站只收两种：
  - `creatorFp === origin`（对方建的）：帧里 MUST 带 `members`（2–20 个成员键，含作者）。本机只有列在其中、且开放了 chat 的 principal 看得见，别的本机的人（包括 guest）看不见。
  - `creatorFp === 本机 fp`（我方建的）：origin 那边的作者 MUST 已是这个房间的成员。
  - 其余一律 400。所以本机 owner 和 guest 之间的房间，远端永远写不进去。
- 不做跨实例群聊：三个或更多实例在同一个房间里。

## 4. 签名回执

回执 `{key, sig}`：`key` 是接收方实例公钥（base64url 原始 32 字节），`sig` 是它对下面这串 UTF-8 的 Ed25519 签名（base64url）：

```
claudestra-talk-ack-v1\n<origin>\n<id>\n<接收方 fp>
```

三期 offer 类的回执末尾再加 `\n<转移后的状态>`。发送方 MUST 先核 `fingerprint(key) === 对方期望指纹`，再验签，**两步都过才算送达、出队**（`verifyTalkAck`）。回执自带公钥，没钉住对方公钥也能核；但发送方必须能为对方算出期望指纹，算不出就不许发 talk。签名串里有接收方指纹与消息 id，中继伪造不了 200，别的消息、别的实例的回执也挪不过来。

## 5. 存储、去重、副作用

- 两边各存一份（`talk.sqlite`）。发送方先写 messages 和 outbox 再发出；outbox 表二期加一步迁移：`(toFp, id)`、`paused`、`tries`、`nextAt`、`lastError`（三期再加 offer 的 `offerKey` / `seq`）。
- 接收方按主键 `(origin, id)` `INSERT OR IGNORE`：同一 id 从两个实例发来互不影响；重复投递照样回签名回执，**但不再触发任何副作用**（推送、SSE、开 ask 都只在 `changes() === 1` 时做）。这也兜住 bridge 重启后内存防重放清空之后的重放。
- 远端的人建 people 行：`remote:<fp>/<principal>`，每个 fp 最多 20 行，超了拒收。远端的人不能被合并，也不能合并别人。
- 删除只删本机这份，不同步给对方。

## 6. 离线、重投、停止

| 情况 | 做法 |
|---|---|
| 正常 | 签名回执验过才出队 |
| 对方离线（中继回 `peer_unknown`，或直连网络报错） | 退避重投，1 分钟涨到 1 小时，7 天后放弃，界面标「未送达」。有意偏离中继协议的「peer_unknown 不重试」：离线联系人同样回 `peer_unknown`，而 talk 本身幂等 |
| 400 / 401 / 403 / 404 / 413，或中继错误帧 `bad_signature` `replay` `sender_forbidden` `path_forbidden` `payload_too_large` | 立即停止，标「发送失败」，界面可手动重发（同一 id）。撤销 token、验签被拒都是 401；404 = 对方版本没有 talk 入口 |
| 429 | 退避后重投 |
| 对方上线 | 由在线状态触发冲刷 outbox |
| 撤销 talk 能力 | outbox 标「对方已关闭 chat」；每次发出前都重新检查当前能力 |

## 7. 显示与审计

- 远端的人一律显示成「<实例备注名> · <自报名>（自报）」；@ 补全里的远端的人带实例前缀。
- 按 UTS#39 skeleton 比对，撞名或形近时补 fp 前 8 位，以本机备注名为准（备注名只有本机 owner 能设，对方改不了）。
- 审计里远端的 actor 一律记 `remote:<fp>`，自报的名字另存 `claimedBy`。

## 8. 残余风险

- 未签名的 4xx 可被中继伪造，让发送方停发（拒绝服务）；不影响真实性。
- 冒充同一实例上的另一个人：防不住，也不打算防——实例是信任单位。
- 元数据：中继照样看得到谁、什么时候、发了多大。
- 签名不绑定目标实例：Bearer 按目标实例分别签发，转发给别的实例过不了鉴权。

## 9. 三期（派活）已定口径

派活协议另起文档，这里只记已定的边界：粒度是单个任务节点；对方只能整体接受或整体拒绝；派活包发出前 MUST 经我方 owner 预览、批准；对方执行时提的问题进我方 owner 的 Chat，不直接进 PM；中继端到端加密上线之前不开派活。

## 10. 测试向量

`tests/talk-protocol.test.ts`，钥匙由固定种子生成（种子全 `0x01` 为发送方 A，全 `0x02` 为接收方 B），Ed25519 签名是确定的：

| 项 | 值 |
|---|---|
| A 公钥 / 指纹 | `iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w` / `3475-0f98-bd59-fcfc` |
| B 公钥 / 指纹 | `gTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5Q` / `6a38-03d5-f059-902a` |
| dm id（A 的 `owner:self` ↔ B 的 `guest:0a1b2c3d`） | `0005c46be6b0757a733cca7dfd39b7b1f0fc03655e26e6315aeba8cff8cf946b` |
| 回执签名串（id `tm_00000000-0000-4000-8000-000000000001`） | `claudestra-talk-ack-v1\n3475-0f98-bd59-fcfc\ntm_…0001\n6a38-03d5-f059-902a` |
| B 的回执签名 | `s5O7erP2bZniXBgze0GTCqp9MjwKFR3MrucgDUIrcgVlcI_fKk_SvK0ZAZVLR4L-XfmIunV1okTggwqoEsVbCw` |

还覆盖：中继用别的钥匙签的回执判 `wrong_key`；挪用别的 id / 状态的回执判 `bad_sig`；dm 的 id 由接收方重算；对方建的 thread 本机只有列名且开放了 chat 的人看得见；超 2 MiB 回 413；附件哈希、大小、SVG；principal 字符集。
