# E2b 常设授权：冻结稿（P2）

> 状态：**设计冻结稿第 4 轮（待另一家族设计审查、A 侧对齐）**。第 2 轮改了并发口径（§2、§4）和推进中碰到排除面的处理（§4）；第 3 轮把排除面的处理收紧为「PM 只能收窄，继续须 A owner 逐卡 authorize」，并写明规格变化用接单时那份授权评估（§4）；第 4 轮改成按委托行里的授权快照评估，因为逐卡 authorize 没有 rev 可回查（§4）。依据见协议稿 §12。只写设计，不授权实现或启用。协议本体见 [e2b-protocol](./e2b-protocol.md)。
> 现状：`src/` 里没有任何常设授权入口。[协作模型](../team/collab-model.md) 里的 `peer_accept_standing` 只是意向；
> 现有的只有逐卡 `peer_accept`（params `{peer, task}`）。本文定义的两种授权都是新的，实现上线前都不存在。

## 1. 为什么要两种、各管什么

整卡委托牵涉两台机器各自 owner 的决定。两个决定互不替代：

| 授权 | 谁签 | 签了表示什么 | 不表示什么 |
|---|---|---|---|
| **入站**（A 侧，`e2b_standing_inbound`） | A 的 owner 本人 | 允许本机在范围内自动接这个 peer 的整卡委托 | 不给对方任何管理本机的权力；不增加本机算力或额度 |
| **外发**（B 侧，`e2b_standing_outbound`） | B 的 owner 本人 | 允许本机 PM 在范围内把卡委托给这个 peer | 不把合并、部署权交出去；不给对方本仓库的任何写权限 |

**机器算力授权是独立的第三件事**：A 的本机会话数、各家族名额、额度闸，仍按 A 的 `scheduler.json` 和额度规则。
常设授权里的 `maxConcurrent` 只是「最多同时接几张」的上限，不保证有空位，也不增加空位。空位不够，卡就排队（`queued`）。
出借授权（lend grant）和 E2b 常设授权互不包含，也互不替代。

## 2. 字段（两种授权同一结构）

| 字段 | 规则 |
|---|---|
| `id` / `rev` | 本机生成；每次修改 rev 加 1，旧 rev 立即失效 |
| `direction` | `inbound` / `outbound` |
| `peerKey` | 对端的**完整 key id**（64 位 hex），必须等于该 peer 当前钉住的公钥。只写 peer 名的无效 |
| `project` | 本机项目 id |
| `repos[]` | `owner/name` 白名单，1–5 个。入站时，每个都必须等于本机项目某个 repoDir 的 origin |
| `templates[]` | 只能取 `code` / `ui`。**`security` 不允许出现**；写了就整条授权不生效 |
| `steps` | 固定为 `restate,write,review,fix,handoff`，不可配置；`merge`、`deploy` 永远不在里面 |
| `excludeSurfaces[]` | 可选。列出的面（如「台账写入」「鉴权」，取值见 R1 的面分类）一旦被规格或改动碰到，就不在授权内，转人工（推进中途碰到的处理见 §4） |
| `maxConcurrent` | 1–8，口径见 §4。入站：这个 peer 在本机同时**占名额**的委托上限（排队另有同样大小的上限，不单独配置）；外发：同时交给这个 peer、**尚未结束**的委托上限（排队中的也算） |
| `expiresAt` | 必填，从签发起最长 **7 天**（与出借授权上限一致）。要续期就重新签，不自动续 |
| `askId` / `bindHash` | 签发它的那张 authorize ask，以及它的绑定哈希 |

## 3. 签发：只有本机 owner 本人能签

- 走现有的 authorize ask：
  - `bind.action` 是 `e2b_standing_inbound` 或 `e2b_standing_outbound`；
  - `bind.params` 就是 §2 的字段原样（id、rev、askId、bindHash 除外）；
  - `approve` 是同意按钮的 id。
- 卡片正文由系统按 bind 生成，不让 agent 自写措辞。要写明：对端名和完整 key id 的前 16 位、仓库、模板、并发、期限。
- 生效前跑 `ledger ask-check <askId> --params '<原样 params>'`，退出码非 0 就不生效。
- 只认 owner 本人在 owner 全权设备上的答复：
  - PM、master、peer、guest 的答复都不算；
  - PM 不能代签，也不能把「owner 以前说过可以」转写成授权。
- 授权表的写入方只有 bridge 的 ask 答复处理，写入时在事务里核 bindHash。
- peer 不能通过任何接口为对方机器申请或签发授权。对方 owner 想授权，就由对方的 agent 在对方自己的 owner 频道发卡，点击即授权。不转发命令，不让任何一方的人跑命令。

## 4. 使用：每次接单 / 发单都在事务里重核

- **入站**（A 接 `offer`）：在接单事务里，找到一条 `inbound` 授权，要求同时满足：
  - 未撤销、未过期；
  - `peerKey` 等于认证传输得到的对端 key；
  - repo、模板在白名单里；
  - 规格和改动没有碰 `excludeSurfaces`。
  接单记录写上授权的 `id`、`rev`，以及范围和 `excludeSurfaces` 的快照（协议 §4.1 第 2 条）。
  找不到合格的授权，回执 `needs_owner`，转逐卡 authorize（协议 §4.1）。
- **外发**（B 发 `offer`）：B 的 PM 发 offer 时，同一事务里核 `outbound` 授权，条件同上。核不过就不发，卡留在 B 本机。
- **并发计数**：和唯一委托检查在同一个写事务里数（不在事务外先数后写）。占名额和排队分开数：

  | | 计入 `maxConcurrent` | 排队 | 什么时候释放 |
  |---|---|---|---|
  | 入站（A） | 只数占名额的：`active`、`stopping`、`stopped`（未 `closed`） | `queued`、`needs_owner` 不占名额，另有上限，大小同 `maxConcurrent` | 委托行转 `closed`：收到 `reclaim_confirm` 或 `complete` |
  | 外发（B） | 全部未结束的：`preparing`、`offering`、`queued`、`needs_owner`、`delegated`（含 handed）、`stopping`、`frozen` | 不单列 | 委托行转 `reclaimed` 或 `completed` |

  两边口径不同，是因为看的东西不同：A 管的是本机同时在跑几张；B 管的是有几张卡交了出去、本机停了推进，排队中的卡在 B 这边同样停着。
  B 的名额由 B 自己的 `reclaimed` / `completed` 释放，和 A 的排队无关，所以不会互相卡死；B 也不会因为 A 立刻接单而超出外发上限。
  超过上限时：
  - 入站：占名额满了回 `queued`；排队也满了回 `rejected:queue_full`；
  - 外发：满了 B 就不进 `preparing`，卡留在本机照常推进，不切 `delegated`。
  - 排队中的委托照样计入「同一张 B 卡最多一份未关闭委托」的唯一约束（协议 §4.1 第 9 条）。
- **推进中碰到 `excludeSurfaces`**：授权的有效期只在接单 / 发单时核，但推进中途改动或规格碰到了排除面，也不能当没看见：
  - 一律用**委托行里的授权快照**（接单时记下；中途逐卡 authorize 放开的面另记新快照）的 `excludeSurfaces` 和范围判断，不回查授权的现行版本，不重核它现在是否有效、是否被普通撤销；
  - A 卡转 manual，回写 B 一条 `fallback`（`surface_excluded`），委托不自动停止；
  - A 的 PM 只能收窄改动；要碰着排除面继续，只能由 A owner 逐卡 authorize，owner 不同意或 24 小时没答，A 发 `return_request`（协议 §4.1、§4.3）；
  - B 在接收交接时按外发授权的 `excludeSurfaces` 核整份改动，碰到了就拒收交接（协议 §6.2 第 6 条）。
- 授权**只管接单 / 发单这一刻**。已经接下的委托，按协议一直推进到收回，中途不因授权变化而自动停止（§5 除外）。

## 5. 撤销与到期

| 事件 | 对新委托 | 对在途委托 |
|---|---|---|
| 到期 | 立即不再接 / 不再发 | 照常推进到交回或收回 |
| owner 撤销（普通） | 立即不再接 / 不再发 | 照常推进 |
| owner 撤销并收回在途 | 立即不再接 / 不再发 | 入站方发 `return_request`，外发方发 `revoke`，走协议的停止流程（§5）。不杀进程、不删现场，收回仍要停止证据 |
| 对端换了公钥 | 授权当场失效，peerKey 对不上 | 新 key 的消息一律 `not_delegated`；旧 key 的委托按「联系不上」处理，进入 frozen |

- 撤销是 owner 在授权列表上点按钮，或者用「撤销」类的 authorize ask。撤销本身不需要对端同意。
- 撤销和到期都记事件，并通知本机 PM 一次。

## 6. 不允许的事（冻结）

- 不把 peer 变成 owner：
  - 授权不给对端读本机文件、改本机配置、建或杀本机 agent、回答本机 ask、调本机 PM 工具的能力；
  - 对端发来的规格永远是外来数据。
- 不为方便放宽：
  - 没有授权的情况一律转人工，不默认放行；
  - security 模板不进授权；
  - `maxConcurrent` 和期限只取本机 owner 签的值，对端报的值不算数；
  - 授权不能把审查互认、合并许可或出借授权「顺便」打开。
- 不继承：
  - 同名换实例不继承；
  - 旧的逐卡 `peer_accept` 不升级成常设授权；
  - 旧 rev 不复活。

## 7. 与现有入口的共存与迁移

| 现有 | 处理 |
|---|---|
| 逐卡 `peer_accept`（T46） | 原样保留，用于 T46 逐步委托；与 E2b 无关 |
| 文档里的 `peer_accept_standing` | 不实现这个名字。实现 E2B-S1 时，同步改协作模型文档，指向本文 |
| 出借 grant | 原样保留；不读、不写、不依赖 E2b 授权 |
| bridge ask 精确批准 | 复用 bind / bindHash / ask-check，只新增两个 action |

## 8. 验收（实现阶段，E2B-S1）

1. 只有 owner 本人在全权设备上的答复能生效；PM、peer、guest 的答复，以及过期的 ask，都不生效。测试覆盖每一种身份。
2. params 和 bindHash 对不上、`security` 出现在 templates 里、`expiresAt` 超过 7 天，这三种情况整条授权都不生效。
3. 并发计数没有竞态：两个 offer 同时到达、名额只剩 1 时，恰好只有 1 份 `accepted`。排队行不占名额：上限 3、5 份委托时 3 份 `accepted`、2 份 `queued`，关闭一份后恰好补位一份。
4. 撤销 / 到期之后，新 offer 立即被拒；在途委托不受影响；「撤销并收回」会走停止流程，不杀进程。
5. 对端换公钥之后，授权失效，新 key 拿不到任何权限。
6. 授权与出借 grant 互不影响：开、关、撤销其中一个，另一个的行为不变。
