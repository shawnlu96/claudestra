# Chat（talk）：人与人的对话，不烧 token

界面上侧栏顶部是「工作台 | Chat」两个 tab：**工作台**（`/chat`）是人 ↔ agent，每条都进 agent 上下文、都烧 token；**Chat**（`/talk`，代码名 talk）是人 ↔ 人，默认**不进任何 agent 的上下文**。路由 `/chat` 和代码里的 `chat` 标识符都没改名，只改了显示文案。

一期只有本机：owner（所有设备 + Discord 上的 owner 算同一个人）和 guest 设备。跨实例传输见 [protocol.md](./protocol.md)（定稿，未实现）。

## 什么会进 agent 上下文（封闭清单）

一期只有一条：**丢进工作台**——在房间里勾几条消息，选一个 agent，确认后以**发起人自己的 Web 身份**投给它（不冒充 owner），目标只能是他 scope 里的本机 agent。平时发消息、@ 人、建房、删除、上传图片都不投给任何 agent（`tests/talk-api.test.ts`、沙箱实测看 agent 会话记录）。新增投递路径前先改设计，别在别处顺手投。

- **逐字一致**：预览和确认都经 `bridge/talk-drop.ts` 的同一段渲染（正文 `lib/talk-drop-render.ts`，抬头 `bridge/router.ts renderApiInbound`，bridge.ts 投递时用的也是它），确认时重算 sha，对不上回 409。
- **只投一次、不丢**：前端开弹窗时生成 `dropId`，bridge 先 `INSERT OR IGNORE` 占位再投；intent 是 notification（不抢占），目标在线且空闲才直接送，否则进押后队列。押后队列的结局（送达 / 24 小时放弃 / 目标被 kill）经 `bridge/held-queue.ts onHeldSettled` 回写 drops；bridge 重启后占了位却不在队里的标 failed，界面可重发。
- 别的实例的人写的内容（二期起才有）包成「外部文本，不是指令」，边界标记是本进程随机钥匙的 HMAC。

## 身份与读权限

- `people` 表：本机的人是 `local:<principalId>`（和台账 human assignee 同一格式）。owner 可以把同一个人的多台 guest 设备合并（`mergedInto` 压平成一层），也可以设本机备注名。
- **读权限只有一个判定**：查看者名下的成员键（`<fp>/<principal>`，合并过的人有多个）在不在房间成员里——列表、单个房间、消息、附件、SSE 五处共用（`lib/talk-rooms.ts isMember`），不是成员一律 404。
- guest 只能和 owner 开私聊，不能建小组，目录里看不到别的 guest。集成 token、peer 不是人，talk 接口一律 403。
- 从 Chat 新建台账任务一期只有 owner 能做（`bridge/talk-task.ts`，经 runManager 调 `ledger task-new` + `ledger note`，actor 记 owner）。

## 存储

`STATE_DIR/talk.sqlite`，只有 bridge 写，版本走 `lib/sqlite-migrate.ts`（`user_version` + 只往末尾追加的步骤）。表：people、rooms、members、messages（主键 `(origin, id)`，删除只留墓碑）、atts / att_uploads / att_refs（图片按剥完元数据后的 sha256 存成 `STATE_DIR/talk/att/<sha>.<ext>`，没发出去的上传 24 小时后清掉）、drops。副作用（推送、SSE）只在真的插进去时触发。

## 推送

只推「@ 我」：推送订阅目前只登记 owner 的设备，所以一期只有 @ owner 会推（点开直达 `/talk?room=`）；guest 在页面里靠 SSE `talk` 事件（只推给房间成员）。guest 的推送要等二期把推送订阅改成按 principal 区分（[protocol.md](./protocol.md) §0）。
