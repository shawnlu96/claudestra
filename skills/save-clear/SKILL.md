---
name: save-clear
description: 做完一件事、下一件无关时的收尾：先把会话里值得留下的东西存进 HANDOFF.md / mem0 / 本地 memory，然后自动 /clear 清空上下文（新会话开场会自动注入 HANDOFF 和 mem0 召回）。当用户说"save-clear"/"存档清空"/"收尾清上下文"，或一件任务已经完成、上下文又很大时触发。
user-invocable: true
---

# 存档 + Clear 上下文

`/clear` 不留任何摘要：清完之后，新会话能知道的只有**你现在写进文件的东西**（开场钩子会注入 14 天内的 HANDOFF.md、mem0 召回和 CLAUDE.md）。所以这个技能的全部价值在第 1 步。整个流程你自己完成，不要再问用户确认。

**什么时候用它，什么时候用 save-compact**：一件事做完、接下来要做的与之无关 → 本技能（干净、零成本、不会越压越失真）。任务做到一半、对话里还压着大量没落盘的东西（口头定的规矩、没点的按钮、合到一半的分支、还在跑的子任务）→ 用 `/save-compact`，让摘要按原话带过去。已经 compact 过一两次还要继续 → 存档后用本技能。

## 第 1 步：存档（规则与 save-compact 相同，本技能对 HANDOFF 要求更高）

先完整读一遍 `~/.claude/skills/save-compact/SKILL.md` 的「第 1 步」，按它的三桶分法和各后端的规矩执行（mem0 先 ToolSearch 拉工具、写前先搜、只收长期事实；本地 memory 条数克制；进度只进 HANDOFF.md）。

在那之上，因为这次**没有摘要兜底**，HANDOFF.md 必须能让一个完全没见过本次对话的会话直接接着干：

- **用户本次会话口头定下、还没写进 CLAUDE.md / memory 的约束**：按原话抄进来（长期成立的同时写 mem0，本地也要有的写本地）。
- **所有悬而未决的东西**：发出去还没回应的按钮（写 id 和它问的是什么）、承诺过要做的事、等谁回复。
- **现场状态**：未提交 / 未推送的改动、在用的 worktree 与分支、后台任务或 LaunchAgent、部署到哪一步；没有就写「工作区干净、无后台任务」。
- **接手时先读哪几个文件 / 跑哪几条命令**能最快恢复现场。
- 刚做完的事如果已经全部落地（commit、发版、上线），写一句结论和关键 commit 就够，别把过程搬进来。

写完自查一遍：「如果我现在失忆，只看 HANDOFF + CLAUDE.md，能不能接上？」不能就补。

## 第 2 步：告知结果（必须在第 3 步之前）

清空之后你就不记得这次对话了，所以**先回复用户**（Claudestra / Discord 环境用 reply 工具）：

- 三处各存了什么（HANDOFF.md 写了什么、mem0 存/改了什么、本地 memory 动了什么）；
- 上下文约 10 秒后清空；下一条消息会在新会话里处理，开场自动带上 HANDOFF 和记忆。

## 第 3 步：安排自动 /clear

```bash
if [ -n "$TMUX" ] && [ -n "$TMUX_PANE" ]; then
  nohup bash -c '
    sleep 10
    # copy-mode 守卫:pane 在 copy-mode 时 send-keys 会被 tmux 吞掉且不报错,先无条件 cancel
    tmux send-keys -t "$TMUX_PANE" -X cancel 2>/dev/null
    sleep 0.2
    tmux send-keys -t "$TMUX_PANE" -l "/clear"
    sleep 0.4
    tmux send-keys -t "$TMUX_PANE" Enter
  ' >/dev/null 2>&1 &
  disown
  echo "clear scheduled"
else
  echo "not in tmux"
fi
```

- 输出 `clear scheduled` → 本轮结束约 10 秒后自动 `/clear`。在 Claudestra 管理的 agent 里，`/clear` 会换一个新 session，bridge 会自动跟上（registry 与 watcher 自愈），不用管。
- 输出 `not in tmux` → 跳过，在第 2 步的回复里请用户手动执行 `/clear`。
- 清完不要自己接着干活：这是任务边界，等用户的下一条消息。
