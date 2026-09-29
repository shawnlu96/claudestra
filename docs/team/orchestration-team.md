# 编排班子

[English](./orchestration-team.en.md) · **简体中文**

一个项目里同时跑很多 agent 时，靠一个 PM 手动接住所有消息会漏。编排班子把「谁来接下一步」交给台账：执行者只管交付，bridge 从台账看到交付，就通知该接手的人；每一步都写回台账，现在谁在接，随时查得到。

## 角色

| 角色 | 做什么 | 不做什么 |
|---|---|---|
| **PM** | 写规格卡、派活、放行复述、串行合并与部署、找 owner 拍板 | 不写大块功能代码；不替 owner 点确认 |
| **调度助理**（可选） | 接住交付：派审查员、整理审查结论、记账、判断要不要升级 | 不合并、不部署、不直接找 owner、不建执行者 |
| **审查员** / **对抗式审查员** | 只读审查某个 worktree，按 P0 / P1 / P2 给结论 | 不改代码、不碰线上 |
| **执行者** | 在自己的 worktree 里按规格卡实现、测试、交付 | 不合并、不部署、不改规格范围外的文件 |

角色说明放在仓库的 [`roles/`](../../roles) 目录里。agent 启动时按 registry 里的 `role` 字段注入对应的角色：

- **调度助理**：用 `--agents` 加 `--agent claudestra-dispatcher`，让主线程直接成为这个角色；两种审查员也一并定义好，它可以直接派。
- **PM**：用 `--append-system-prompt-file` 追加角色说明，再用 `--agents` 带上两种审查员，没配调度助理时它可以自己派审查。
- **执行者**：用 `--append-system-prompt-file` 追加角色说明。
- 实测过：用 `--agent` 当主线程时，Claude Code 的默认工具、项目的 CLAUDE.md 和 Claudestra 的频道工具都还在。
- 所有角色都**不**写进 `~/.claude/agents`：不动你的全局目录，换机器、换项目也不用安装，仓库更新后下次启动就是新版。
- 角色注入目前只对 Claude Code runtime 生效。执行者如果用 Codex 或 Pi，由 PM 在派活的第一条消息里交代约束。

## 拉起来

```bash
# 在 PM 自己的会话里跑（或者在终端里加 --pm <agent>）
bun src/manager.ts team up --project <项目 id>                 # 只配 PM 和巡检
bun src/manager.ts team up --project <项目 id> --dispatcher    # 另建一个调度助理 <项目 id>-dispatch
bun src/manager.ts team up --project <项目 id> --dispatcher-agent <已有 agent>   # 让已有的 agent 当调度助理
bun src/manager.ts team up --project <项目 id> --no-dispatcher # 撤掉现有的调度助理（不带这三个参数时保留现有的）
```

只有项目的 PM（调度助理除外）、大总管、owner 能提议 `team up` / `team down`，执行者和调度助理不行。`team up` **不会直接改任何东西**，只生成一份提案，由 bridge 按提案内容在提议者的频道里贴出卡片和「确认 / 拒绝」按钮（终端里提议的贴控制频道）。改 PM 名单需要 owner 身份，所以要由 owner 本人在界面上点确认：

- **Discord**：只有 `ALLOWED_USER_IDS` 里的用户点了才算，而且要点在 bridge 贴出的那条消息上。
- **网页**：只有 owner 本人设备的凭据点了才算。用 `token-add` 签出的 Bearer token、guest 设备、peer 都不行。
- 按钮 id 带一段校验码，是 bridge 用只在自己内存里的密钥算的，绑定提案内容和贴出的频道。agent 算不出来，也贴不出这类按钮：bridge 处理的管理按钮（班子确认、管理面板、权限弹窗等）id 都在一张保留表里（`src/lib/reserved-buttons.ts`），agent、本机脚本、peer 发的消息里只要带了保留 id，整条拒发。bridge 重启后旧卡片作废，重新提议即可。
- 按钮 30 分钟内有效，只能生效一次；提案在点击前被改过就作废。
- 命令行没有「确认」子命令。

owner 点确认后，bridge 先把提案标成「已确认」，再依次做下面几步（任何一步失败就停下，并在 `team status` 里写明停在哪一步）：

1. `ledger team-apply <提案 id> --check`：只核对不写，过时的提案在建任何东西之前就停下；
2. 建调度助理（如果要新建），角色设为 dispatcher；
3. `ledger team-apply <提案 id>` 写台账。这条命令自己再核对：提案已被 bridge 标为确认、内容哈希一致、确认发生在过期之前（并且确认后 10 分钟内）、**提议时的 PM 名单和班子配置到现在没变**（先点了别的提案、或者 down 过，旧提案就作废，不会按过时的名单整表覆盖）。都满足，才在一个事务里写 PM 名单、班子配置（`meta.team`，从这一刻起开始事件路由），再记一条 owner 的决定。bridge 自己对台账仍然只读；
4. 按提案里列的角色变动设 / 撤 registry 角色：调度助理设 dispatcher，名单里其余的人设 pm，被移出名单的、班子撤下后的都撤掉。**角色要等下次重启才生效，不会自动重启**。卡片上逐条写着这些变动。

**改 PM 名单也走同一条路**：`ledger meta --pms a,b` 不直接写，只生成一份提案、贴出卡片（PM、大总管、owner 可以提议，执行者和调度助理不行）。在任的调度助理不能被移出名单（换调度助理用 `team up`，撤班子用 `team down`）。owner 在终端里跑也一样，去界面上点一次确认即可。班子配置没有单独的命令行开关，一律用 `team up` / `team down`。

撤下班子：`team down --project <id>`，同样要 owner 确认。撤下后事件路由停止，调度助理移出 PM 名单，班子角色一并撤掉；这个 agent 本身不会被删，需要的话手动 `kill`。

**关于「不能冒充 owner」**：这是产品约束，不是安全边界。所有 agent 都以你的用户身份运行，默认不做权限确认，一个铁了心的 agent 可以直接改状态文件和台账库，也可以自己去配对一台设备（本机的 `/api/v1/devices/local` 能直接签出 owner 设备凭据；计划中（T34，尚未实现）收紧为只接受带 `BRIDGE_CONTROL_TOKEN` 的调用或真人确认）。「已确认」这个标记记在状态目录的提案文件里，同一个用户的进程也能伪造它。卡片和按钮的保证**只在工具面上成立**：只用 Claudestra 给的工具（reply、send_to_agent、edit_message、按钮、ledger 命令）的 agent，执行者和调度助理提不了班子提案；bridge 管理按钮的 id（班子确认、权限弹窗、自动放行、换模型等，见 `src/lib/reserved-buttons.ts`）一律发不出去；edit_message 只能改自己经 reply 发出的消息，带管理按钮的消息谁都改不了。所以在工具面上，owner 点到的是 bridge 按提案渲染、之后没被改过的那张卡片。

这不是绝对保证：agent 本身是以你的用户身份运行的 shell，能读仓库的 `.env`，会话环境里本来也带着 `DISCORD_BOT_TOKEN`，拿到 bot token 就能绕开 bridge 直连 Discord，以 bot 身份发带任意按钮 id 的消息或改已有消息。这和上面改状态文件、配对设备一样，属于「铁了心的 agent」，不在防护范围内（同 CLAUDE.md 的 Security posture：guard rail，不是安全边界）。除了 owner 一次性迁移用的 `ledger import`（只在名单为空时写），PM 名单的每次变更都能在台账里查到是 owner 点的哪份提案。

## 一件任务怎么流转

```
执行者 ledger deliver ─▶ bridge 通知调度助理（没配就通知 PM）
                          │  ledger dispatch <T>：核对 head、记派审、输出审查员 prompt
                          ▼
                       审查员（只读）─▶ 调度助理把结论存进 reviews/<T>-r<N>.md，再跑 ledger review
                          │
       ┌──────────────────┼──────────────────────────┐
  推到 fix → bridge 通知执行者    推到 merge → bridge 通知 PM「可以合并」    出 P0 / 第 3 轮还不通过 → 自动升级给 PM
```

- 执行者交付只跑 `ledger deliver`。输出里 `routed: true` 表示 bridge 会通知接手的人，执行者不用再发消息。
- `ledger dispatch <T>` 会先核对执行者 worktree 的 HEAD 是不是交付时记下的那个 head，对上了才派审。规格卡「审查」那一行写了「对抗式最后一轮」的话，前面一轮没有 P0 / P1 时，它会自动换成对抗式审查员。对抗式的结论另存 `reviews/<T>-r<N>-adv.md`，不和同一轮的常规结论撞名。常规轮通过时 bridge 不会告诉 PM「可以合并」，而是提醒调度助理再派对抗式。
- 进 merge 有一道闸门：`review --to merge`、PM 手动 `stage review → merge`、解除 blocked 回 merge 都要过。规格卡要对抗式的话，当前轮次、当前 head 上得有对抗式通过，或者 PM 的 `--waive adversarial`。策略取规格卡和派审记录里更严的一条，所以派审之后把卡改松不算数。但规格卡在第一次派审之前就被改松的话，没有记录可以比对，闸门按改松后的卡放行，所以改「审查」一行要经 PM。任务进了 merge 及以后（包括从这些阶段进的 blocked），谁要换成不同的 head，都得先由 PM 退回 review。只补 PR、分支，或者写入相同的 head，照常放行。之前在 merge 的 blocked 回 merge 被闸门拦下时，PM 可以把它直接退回 review，效果和 merge → review 一样（round+1）。
- 执行者写的交付说明、升级原因，在通知和审查员 prompt 里只以单行引用出现（「…」，注明是谁的原文），证据和结论只收文件路径（写入时就拒绝全角标点、【】「」、空白和不可见字符），显示时同样放进引用框：被审的人没法借这些文字给审查员或 PM 下指令。
- 调度助理没跑 `ledger dispatch` 就记了通过（比如 PM 手写 prompt 派的审）：bridge 读规格卡的「审查」一行，判断下一轮还要不要对抗式，和 `review-pack` 读的是同一份；规格卡也找不到时交调度助理核对，不会说「审查走完」。
- `ledger review-pack <T>` 是只读版：只打印审查员 prompt，不记账。
- `ledger escalate <T> --reason …` 用来升级给 PM。加 `--to owner` 表示需要 owner 拍板，仍由 PM 去问 owner。
- 两条硬规则写死在代码里：审出 P0，或者同一任务到第 3 轮还不通过。bridge 看到这样的审查结论，就用 `ledger escalate --auto` 记一条升级（记在 `bridge-rule` 名下，同一条结论只记一次），PM 随后收到【升级】通知。这种自动升级只是抄送，不改变「现在谁在接」。其余情况要不要升级，由调度助理或 PM 自己判断。

**只通知一次**：bridge 把处理到的位置（台账事件 seq）存进状态目录的 `team-router.json`，先存位置、再发通知。所以 bridge 重启后不会重复通知。如果恰好在两步之间崩溃，这一批还没发的通知会丢（不会重发）；单条投递出错只影响那一条，它会进押后队列。发现漏了：`team status` 看谁在接、手动补一句即可；要整段重放，停 bridge 后把 `team-router.json` 的 seq 改回去再启动。通知的对象正在忙或者不在线时，通知进押后队列，等它这一轮结束再送，不会打断它。班子开起来之前的历史事件不会补发。

## 从人工流程迁过来

项目开了班子（`team up` 被 owner 确认）之后，原来靠人手转的几步改由台账和 bridge 做，继续手动做会双发：

- **执行者**只跑 `ledger deliver`，不再 send_to_agent 给 PM 报交付（输出里 `routed: true` 就是这个意思）。
- **调度助理**记完 `ledger review` 就结束，不再手动把结论转给执行者或 PM。
- **升级**：P0 和第 3 轮还不通过这两条由 bridge 自动升级；其余只有需要人判断的情况才用 `ledger escalate`。
- 没开班子的项目照旧：执行者 deliver 之后仍发一条 oneShot 给 PM。

## 查看和接手

```bash
bun src/manager.ts team status --project <id>
```

会列出：PM 名单、调度助理、进行中的每个任务**现在谁在接、从什么时候开始**、待确认或最近结案的提案。执行者超过 5 个、又没开调度助理时，还会建议开一个。

「现在谁在接」是从台账算出来的（`src/lib/ledger-handler.ts` 的 `currentHandler`），不另存状态。协作视图和巡检都用它。

**换人接手**：

- **换 PM**：`team up --pm <新 PM>`（在任的调度助理默认保留），owner 确认后，新 PM 下次重启时带上角色。先确认旧 PM 已经停下，避免两个 PM 同时写台账。旧 PM 仍留在 PM 名单里；要移除，用 `ledger meta --pms` 提议新名单，owner 在界面上确认。
- **调度助理挂了**：`manager restart <调度助理>`，角色会随 registry 恢复。重启期间积下的交付通知在押后队列里，它连上后会收到。
- **不要调度助理了**：`team down`；或者 `team up --no-dispatcher`，交付就改为通知 PM。

## 相关

- 台账的数据结构与事件形状：台账设计稿（`meta.team`、`dispatch` / `escalate` 事件）
- 代码：`src/manager/ledger-team-cmds.ts`（team-apply）、`roles/`、`src/lib/team-*.ts`、`src/lib/ledger-handler.ts`、`src/lib/review-pack.ts`、`src/bridge/team-router.ts`、`src/bridge/team-confirm.ts`、`src/manager/team-up.ts`、`src/manager/ledger-dispatch-cmds.ts`
