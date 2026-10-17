# Codex agent 的只读档（readOnly）

`manager create <名> <目录> --runtime codex --mode readOnly` 建出的 Codex agent 由 **Codex 自己的沙箱**强制只读：不能改文件、不能跑写入命令，shell 也没有网络。档位存进 registry 的 `permissionMode`，每次重新起进程都从 registry 读。代码在 `src/lib/codex-readonly.ts`，测试是 `tests/codex-readonly*.test.ts`、`tests/codex-launch-readonly.test.ts` 和 `tests/codex-adapter-readonly.test.ts`。

## 怎么落实

| 路径 | 落实方式 |
|---|---|
| tmux（TUI） | `codex resume/fork … --sandbox read-only --ask-for-approval never` |
| tmux 的 exec 引导轮 | `codex exec … --sandbox read-only -c approval_policy="never"`（`exec` 没有 `-a`） |
| ACP | 宿主命令带 `CLAUDESTRA_PERMISSION_MODE=readOnly`。宿主**只起自研适配器**，`INITIAL_AGENT_MODE=read-only-never`（readOnly 沙箱、`networkAccess:false`、`approvalPolicy:never`），每次 `turn/start` 都带这个策略；线程级 config 另外再写一份 `sandbox_mode="read-only"`、`approval_policy="never"` |
| ACP 引导轮（create / fork） | 同上，引导用的短命适配器也是自研、只读预设 |

任何档位组合下，readOnly 都不会和 `--dangerously-bypass-approvals-and-sandbox` 同时出现。会话里切模型、切推理档都只改 model / effort，改不了策略。自研适配器也不实现 `session/set_mode`。

### 落实不了就拒绝启动，不降级

- 只读只支持 Codex。Claude Code 或 Pi 用 `--mode readOnly` 时，create 和 resume 在建频道、写 registry 之前就报错。
- 上游 codex-acp 遇到认不出的 `INITIAL_AGENT_MODE` 会静默退回可写的 `agent` 档，所以只读 agent 绝不用上游：
  - 选择开关是 `upstream` 也强制用自研；
  - 不给可退的上游命令，所以 `AdapterPick` 无处可退；
  - 自研判不过时宿主拒起。restart 原有的「ACP 起不来就退回 tmux」照常生效，tmux 同样只读。
- `CLAUDESTRA_ACP_AGENT` 手工覆盖证明不了起的是谁，只读 agent 一律拒。出借 worker 不支持只读。
- 自研适配器认不出预设名时拒起（`parseAdapterEnv`）。
- 线程打开后读回实际生效的策略：thread/start、resume、fork 回包里的 `sandbox` 和 `approvalPolicy` 必须是「readOnly、不联网、never」。不符就停掉适配器，并回带 `data.fatal` 的错误（`session-config.ts` 的 `readOnlyPolicyMismatch`），不指望每轮 `turn/start` 带的策略兜底。真 codex 0.159.3 实测：线程默认被改成 `danger-full-access` 时拒起。
- 不加恢复键，也没有 observe 档。

### 重启不丢

所有重新起进程的路径都从 registry 读档位：

- restart、bridge 启动时的 ACP 自动迁移，以及 adopt：它们都走 `manager restart`；
- fork 自愈：restart 里沿用同一个 spec；
- resume：同名旧条目是只读时，没给 `--mode` 就沿用只读，写回 registry 也是只读；显式给了别的档位就拒。生命周期重建（`scheduler-wake-stopped`）和网页收编（含 `--fork`）都不带 `--mode`。额度恢复只管 Claude Code，而且是往在跑的会话里投消息、不重起进程，所以碰不到这一档。

此外 Codex 适配器在拼启动命令时，会按 agent 名把 spec 和 registry 的档位取并集，任一边是 readOnly 就只读，兜住漏传档位的路径。这一步只会收紧，不会放宽。

**只读 agent 不能换档**：resume 显式给别的 `--mode`、`manager mode <agent> <别的档位>` 都会被拒，报「只读 agent 不能换档，要换就删了重建」。

## MCP 工具（reply 等）

只读档下，Codex 把没标 `readOnlyHint` 的 MCP 工具都当成要审批；`approval never` 等于直接拒，于是 reply 发不出去（0.159.3 实测）。所以只读 agent 的启动参数，只给 claudestra 这一个 server（启动时注册 channel-server 用的 `MCP_NAME`）的白名单工具放行审批。白名单是 `codex-readonly.ts` 里的常量 `READ_ONLY_MCP_TOOLS`，只有这 5 个：

`reply` `send_to_agent` `check_inbox` `fetch_messages` `whoami`

- 配置写法是 `mcp_servers.<MCP_NAME>.tools.<工具>.approval_mode="approve"`，只给 readOnly agent 注入。
- 不用 server 级的 `default_tools_approval_mode`，也不给工具标 `readOnlyHint`。
- 其余工具在 never 下一律被拒，包括 `ask_codex`、`start_node`、`plan_feature`、`rewrite_dag`、`record_memory`、`mark_memory`、`save_handoff`、`take_order`、`take_review`、`submit_verdict`、`deliver`、`forward_to_agent`（真 codex 实测：`MCP tool call requires approval, but approval policy is never`）。

要知道的边界：

- **MCP 进程不在沙箱里。** 只读沙箱管的是模型跑的 shell 命令；channel-server 由 Codex 起，能联网、能写文件（实测探针 MCP 能在 cwd 外写文件、对本机回环发请求）。Stop / Interrupt hook 也不在沙箱里，回合结束照常报给 bridge。
- **白名单里的工具有对外副作用**：它们会发消息给用户和别的 agent。
- **reply 的附件能带出 agent 读得到的任何文件。** 这和下面「只读不拦读取」是同一条边界：只读拦的是改动，拦不住把读到的东西发出去。

## 能看出来

- `manager list`：该行带 `readOnly: true, mode: "只读"`。
- `GET /api/v1/agents`：该行带 `readOnly: true`。网页侧栏在运行时图标右下角挂一把锁，悬停文字为「只读：不能改文件，不能跑写入命令」，英文为 "Read-only: can't modify files or run write commands"。
- `whoami` 工具：输出带 `permissionMode` 和 `readOnly`。这里只是告知，真正拦写入的是沙箱。

## 读权限的边界（照实写）

**只读沙箱只拦写入和网络，不拦读取。** 本机任何当前用户能读的文件都读得到，包括 `~/.ssh`、`~/.codex/auth.json`、`.env`、各种 token 文件。所以禁读文件清单仍然要写进这个 agent 的指令（purpose）里。

Codex 0.159.3 能按路径禁读，用的是 permission profile：`default_permissions` 加 `permissions.<名>.filesystem`。用 `codex sandbox` 实测，被 deny 的路径读取返回 `Operation not permitted`，写入照样被拒：

```toml
default_permissions = "audit"

[permissions.audit.filesystem]
":root" = "read"                 # 其余路径只读
"/Users/<you>/.ssh" = "deny"     # 禁读
"/Users/<you>/.codex" = "deny"
```

但要注意三点：

- 和 `--sandbox read-only` 同时给时，profile **不生效**（实测照样读到了 deny 的文件）。本卡的 readOnly 档用的就是 `--sandbox read-only` / `sandboxPolicy: readOnly`，所以目前**不能叠加禁读**。
- 要用禁读，需要另开卡把 readOnly 的落实方式换成 permission profile，并重新验证写入、网络和 MCP 放行。
- `deny` 的路径要写真实路径（macOS 上 `/var` 实际是 `/private/var`）。

本卡不默认启用。
