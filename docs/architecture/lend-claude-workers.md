# Claude 出借 worker：升级与验收交接

本页对应 i28-CL1（i28-CL4 改为用出借方本机登录）。出借方 B 可接 Claude 的 write / fix / review 单，名额与 Codex 分开计算。
借入方 A 的 Claude 派单入口依赖 i28-CL2，使用 `ledger lend-offer --family claude`。
以下是 PM 待执行的验收流程，不能当作已经完成的双实例实测记录。

## 出借方升级

1. 更新 Claudestra 到包含本改动的版本，确认 Claude CLI 可用，且出借方本机 Claude Code 已登录（平时能开 worker 就行）。
2. 在面板授权表单设置 Claude 名额并提交。未更改的 Codex 名额、角色、模型和推理档沿用原授权。
3. 下一次调度 hello 的 `slots.claude.total` 反映授权数，`busy` 仍仅统计已领单。无需重启服务、无需 setup-token。

i28-CL4 起 worker 和本机新开 worker 一样起：出借方默认 HOME / 配置目录（有 `CLAUDE_CONFIG_DIR` 就照带）和本机已有登录，
不再建独立 HOME，也不读 `CLAUDE_CODE_OAUTH_TOKEN`。旧版存过的 `lend-credentials/claude-token.json` 与服务环境里的
`CLAUDE_CODE_OAUTH_TOKEN` 不再使用，出借面板「Claude 登录」会提示位置，手动删除即可（不自动删）；`POST /lend/claude-token` 已下线（405）。

能不能接单由 `claude auth status --json` 的 `loggedIn`（只看状态，不读凭据、不花额度）和本机 Claude 额度判定，进程内缓存 60 秒。
没登录 / 额度满时 Claude 位报 0（与 QP1 的 Codex 撞额度同一路：借入方不派），调度日志同一原因只记一次：

> [lend] Claude 位暂不可用（报 0 位）：本机 Claude Code 没登录：在出借方机器上运行 claude 完成 /login

整体借不出去时 `lend status` / doctor 的 blocked 带同一句原因；面板显示「本机不可用」和原因。登录过期在状态里看不出来，
worker 第一轮会以 API 错误结束，走 bridge 现有的 API 错误处理。

### 隔离开关（Claude Code 2.1.287 实测）

用假 API 端点抓请求体、加 `--debug-file` 看加载日志核对（不花额度）：

| 防什么 | 开关 | 实测 |
| --- | --- | --- |
| 用户级 MCP、claude.ai 连接器 | `--strict-mcp-config` + 只给派单 MCP；`ENABLE_CLAUDEAI_MCP_SERVERS=false` | strict 下连接器仍会拉列表，env 关后日志为 Disabled via env var；工具表只剩内置 + 派单 MCP |
| 用户设置、技能、子代理、命令、插件 | `--setting-sources ""` | user skills 0、用户子代理不出现、用户装的插件不启用 |
| hooks | `--settings` 里 `disableAllHooks: true` | Registered 0 hooks |
| 自动记忆 | `autoMemoryEnabled: false` | 只用空 setting sources 时 MEMORY.md 说明仍在，加上后消失 |
| 用户级 / 祖先 CLAUDE.md | 空 setting sources 已挡；`claudeMdExcludes` 再显式排除 `~/.claude/CLAUDE.md`、`rules/**` 与祖先目录 | 请求体里没有用户 CLAUDE.md |
| 登录 | 不改 HOME、不带 token；env -i 白名单（PATH/HOME/USER/LANG/TERM/TMPDIR） | 带全部开关、env -i 下请求已鉴权（假模型返回 404 而非 401） |

没用的开关：`--bare`（OAuth / 钥匙串一概不读，登录不了）、`--safe-mode`（会连 clone 自己的配置和 MCP 一起关，且老版本没有）。
已知：空 setting sources 下 clone 自带的 CLAUDE.md 也不自动加载（旧版同样），worker 需要时自己读。会话落在
`<配置目录>/projects/<clone slug>`，归档后照常留在出借方本机（和普通 worker 一样）；启动代次目录 `<state>/lend/claude-config/<agent>/run-*`
只放启动计划与会话位置记录，退出后归档再清理。干净启动防止意外继承，不能隔离同一 OS 用户的文件权限。

## PM 双实例验收步骤

先阅读 [sandbox.md](sandbox.md) 的 lab 隔离约束。PM 在允许检查生产 deny-list 的环境执行，
不要在禁止读取生产 `.env` 的执行卡上启动 sandbox（启动脚本会读取它）。

1. 清空 lab 禁止的代理变量，检查所选端口空闲，执行 `bun run sandbox up --lab --pair`。
   默认 A/B 为 `/tmp/claudestra-lab-23900/{a,b}`，端口 23900/23901；只操作 lab 的 state、runtime、peer 和测试仓库。
   `--pair` 建立双向 peer，`bun run sandbox --lab --as b manager peer-http-list` 可核对；不要借用生产 peer。
2. 本轮验收环境先过三道前置检查，否则记录 blocked，不声称 E2E 通过：
   - A 包含 CL2，能发 `family=claude`；仅 CL1 的 A 会在 CLI 拒绝。
   - `sandbox up` 不启动 scheduler。用 `bun run sandbox --lab --as b env` 获取 B 隔离环境，在独立 shell 应用后
     从本 checkout 以前台方式启动 B `src/scheduler.ts`；A 调度进程同样用 A 隔离环境启动。
     为沙箱项目配置 enabled 的 scheduler（参见 [scheduler-engine.md](../design/scheduler-engine.md)），所有路径留在 lab。
   - B 的环境里 HOME 下要有已登录的 Claude Code：沙箱若改写 HOME，Claude 位会报 0（原因「本机 Claude Code 没登录」），记 blocked。
3. 前置条件满足后，B 执行 `bun run sandbox --lab --as b manager lend grant a --repos owner/test-repo --until 12h --codex 0 --claude 1 --roles review,write`。
   A 为测试项目配置 `borrow set b --projects <测试项目> --roles review,write`（通过 A 的 sandbox manager）。
   确认新鲜 hello total=1、busy=0，B 面板「Claude 登录」显示用本机登录。
4. 在 A 建立含规格、仓库和 base 的测试卡，使用 CL2 的 `ledger lend-offer <task> --peer b --repo owner/test-repo --family claude`。
   write 从测试 base 开始；review 指定测试 PR；fix 使用写单已有租约与审查问题。
   每步用 `ledger lend-orders <task>` 核对 family、领单、租约和交付状态。
5. B 核对独立 clone 与 `agent-lend-*` Claude worker；在启动计划核对 HOME 为出借方默认值、没有 `CLAUDE_CODE_OAUTH_TOKEN`、
   `--strict-mcp-config` 与 lend 档。调用 whoami / take_order / deliver、take_review / submit_verdict；
   普通管理工具应不可用。write / fix 修改测试文件、中文提交并交摘要与自查；review 交 pass 或 changes 与报告。
   A 核对回传 head / PR / 报告，B 核对 owner 通知与记账。Git 推送仅用 owner 已批准的测试仓库。
6. 挂一张长运行 Claude 单，B 执行 `bun run sandbox --lab --as b manager lend revoke --peer a`。
   核对 Claude 及其子进程停止、对应 run 目录消失、会话归档存在、A 不再放单；清理失败日志须显示未确认并保留原因。
   再测 `--claude 0` 拒单及 Claude/Codex 同时占槽互不挤占。
7. 留存 A/B 版本 head、订单号、hello 字段、交付与收回检查结果及脱敏日志。
   分别停止前台 scheduler，再 `bun run sandbox --lab down`；按 sandbox 文档清理测试资源。

自动化替身测试覆盖启动隔离、MCP 档、两族名额、write/fix/review 生命周期与收回清理；不替代上述真实 CLI / 双实例验证。
