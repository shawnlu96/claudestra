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
```

`team up` **不会直接改任何东西**，只生成一份提案，并在 PM 的频道里贴出「确认 / 拒绝」按钮。改 PM 名单需要 owner 身份，所以要由 owner 本人在界面上点确认：

- **Discord**：只有 `ALLOWED_USER_IDS` 里的用户点了才算。
- **网页**：只有 owner 本人设备的凭据点了才算。用 `token-add` 签出的 Bearer token、guest 设备、peer 都不行。
- 按钮 30 分钟内有效，只能生效一次。按钮里带着提案内容的哈希：提案在点击前被改过，就会作废。
- 命令行没有「确认」子命令。

owner 点确认后，bridge 先把提案标成「已确认」，再依次做下面几步（任何一步失败就停下，并在 `team status` 里写明停在哪一步）：

1. 建调度助理（如果要新建），角色设为 dispatcher；
2. 把 PM 的角色设为 pm。**要等 PM 下次重启才生效，不会自动重启 PM**；
3. 调 `ledger team-apply <提案 id>` 写台账。这条命令自己再核对三件事：提案已被 bridge 标为确认、参数哈希一致、确认发生在过期之前（并且确认后 10 分钟内）。三项都满足，才写 PM 名单、班子配置（`meta.team`，从这一刻起开始事件路由），再记一条 owner 的决定。bridge 自己对台账仍然只读。

**改 PM 名单也走同一条路**：`ledger meta --pms a,b` 不直接写，只生成一份提案、贴出按钮（PM、大总管、owner 可以提议，执行者不行）。owner 在终端里跑也一样，去界面上点一次确认即可。班子配置没有单独的命令行开关，一律用 `team up` / `team down`。

撤下班子：`team down --project <id>`，同样要 owner 确认。撤下后事件路由停止，调度助理移出 PM 名单、撤掉角色；这个 agent 本身不会被删，需要的话手动 `kill`。

**关于「不能冒充 owner」**：这是产品约束，不是安全边界。所有 agent 都以你的用户身份运行，默认不做权限确认，一个铁了心的 agent 可以直接改状态文件和台账库，也可以自己去配对一台设备。「已确认」这个标记记在状态目录的提案文件里，同一个用户的进程也能伪造它。按钮保证的是：走正常工具路径的 agent 给不了自己 PM 身份，任何一次 PM 名单的变更都能在台账里查到是 owner 点的哪份提案。

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
- 执行者写的交付说明、升级原因，在通知和审查员 prompt 里只以单行引用出现（「…」，注明是谁的原文），证据只收文件路径：被审的人没法借这些文字给审查员或 PM 下指令。
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

- **换 PM**：`team up --pm <新 PM>`，owner 确认后，新 PM 下次重启时带上角色。先确认旧 PM 已经停下，避免两个 PM 同时写台账。旧 PM 仍留在 PM 名单里；要移除，用 `ledger meta --pms` 提议新名单，owner 在界面上确认。
- **调度助理挂了**：`manager restart <调度助理>`，角色会随 registry 恢复。重启期间积下的交付通知在押后队列里，它连上后会收到。
- **不要调度助理了**：`team down`；或者重新 `team up` 且不带 `--dispatcher`，交付就改为通知 PM。

## 相关

- 台账的数据结构与事件形状：台账设计稿（`meta.team`、`dispatch` / `escalate` 事件）
- 代码：`src/manager/ledger-team-cmds.ts`（team-apply）、`roles/`、`src/lib/team-*.ts`、`src/lib/ledger-handler.ts`、`src/lib/review-pack.ts`、`src/bridge/team-router.ts`、`src/bridge/team-confirm.ts`、`src/manager/team-up.ts`、`src/manager/ledger-dispatch-cmds.ts`
