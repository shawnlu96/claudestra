# Claude 出借 worker：升级与验收交接

本页对应 i28-CL1。出借方 B 可接 Claude 的 write / fix / review 单，名额与 Codex 分开计算。
借入方 A 的 Claude 派单入口依赖 i28-CL2，使用 `ledger lend-offer --family claude`。
以下是 PM 待执行的验收流程，不能当作已经完成的双实例实测记录。

## 出借方升级

1. 更新 Claudestra 到包含本改动的版本，确认 Claude CLI 可用。
2. 在设置 → Peer 协作 → 出借面板的「Claude 登录」复制 `claude setup-token`，在自己的终端执行并完成浏览器账号登录。
3. 将生成的 token 粘贴进密码框并保存。面板仅显示配置状态与保存时间；不显示 token 的任何片段。
   凭据单独保存在状态目录的 `lend-credentials/claude-token.json`（文件 0600，目录 0700），不进入 lend.json 或台账。
4. 在面板授权表单设置 Claude 名额并提交。未更改的 Codex 名额、角色、模型和推理档沿用原授权。
5. 下一次调度 hello 的 `slots.claude.total` 反映授权数，`busy` 仍仅统计已领单。无需重启服务或修改 plist。
   清除凭据后 total 归零，已运行的 worker 保持原环境。未曾配置文件时兼容服务进程的
   `CLAUDE_CODE_OAUTH_TOKEN`；面板清除会写空标记，防止旧环境变量重新启用名额。

缺 token 的出借调度日志原文（同进程去重一次，配置恢复后重置）：

> [lend] Claude 位不可用：请运行 claude setup-token，将 CLAUDE_CODE_OAUTH_TOKEN 配给出借调度服务，再重授 --claude N；不读取本机 ~/.claude 登录。

worker 启动的最后一道闸还会报：

> Claude 出借未配置 CLAUDE_CODE_OAUTH_TOKEN：先 claude setup-token，再重授 --claude N

token 经一次性、0700 目录内的 Unix socket 交给宿主，再仅注入 Claude 子进程环境。
启动计划、命令行、隔离配置文件和 MCP 子进程环境不含 token。独立 HOME / CLAUDE_CONFIG_DIR 位于
`<state>/lend/claude-config/<agent>/run-*`；退出后归档会话再清理。干净配置防止意外继承，不能隔离同一 OS 用户的文件权限。

## PM 双实例验收步骤

先阅读 [sandbox.md](sandbox.md) 的 lab 隔离约束。PM 在允许检查生产 deny-list 的环境执行，
不要在禁止读取生产 `.env` 的执行卡上启动 sandbox（启动脚本会读取它）。

1. 清空 lab 禁止的代理变量，检查所选端口空闲，执行 `bun run sandbox up --lab --pair`。
   默认 A/B 为 `/tmp/claudestra-lab-23900/{a,b}`，端口 23900/23901；只操作 lab 的 state、runtime、peer 和测试仓库。
   `--pair` 建立双向 peer，`bun run sandbox --lab --as b manager peer-http-list` 可核对；不要借用生产 peer。
2. 本轮验收环境先过三道前置检查，否则记录 blocked，不声称 E2E 通过：
   - A 包含 CL2，能发 `family=claude`；仅 CL1 的 A 会在 CLI 拒绝。
   - `sandbox up` 不启动 scheduler，且沙箱环境白名单丢弃 OAuth 变量。
     用 `bun run sandbox --lab --as b env` 获取 B 隔离环境，在独立 shell 应用后通过 B 的面板保存 token，
     从本 checkout 以前台方式启动 B `src/scheduler.ts`；A 调度进程同样用 A 隔离环境启动。
     为沙箱项目配置 enabled 的 scheduler（参见 [scheduler-engine.md](../design/scheduler-engine.md)），所有路径留在 lab。
   - 当前 sandbox 出站闸拒绝 Unix socket，包括 Claude token 交接 socket。
     此为现有 lab 限制，PM 需先获得限定 lab 凭据 socket 的测试支持；不能关闭出站闸、去掉 sandbox 标记或改连生产。
3. 前置条件满足后，B 执行 `bun run sandbox --lab --as b manager lend grant a --repos owner/test-repo --until 12h --codex 0 --claude 1 --roles review,write`。
   A 为测试项目配置 `borrow set b --projects <测试项目> --roles review,write`（通过 A 的 sandbox manager）。
   先不配置 token 跑一次，确认上述提示与 hello total=0；再在 B 面板保存 token 并授权 Claude 名额，确认新鲜 hello total=1、busy=0。
4. 在 A 建立含规格、仓库和 base 的测试卡，使用 CL2 的 `ledger lend-offer <task> --peer b --repo owner/test-repo --family claude`。
   write 从测试 base 开始；review 指定测试 PR；fix 使用写单已有租约与审查问题。
   每步用 `ledger lend-orders <task>` 核对 family、领单、租约和交付状态。
5. B 核对独立 clone 与 `agent-lend-*` Claude worker；在启动计划（不读凭据）核对独立 HOME / CLAUDE_CONFIG_DIR、
   `--strict-mcp-config` 与 lend 档。调用 whoami / take_order / deliver、take_review / submit_verdict；
   普通管理工具应不可用。write / fix 修改测试文件、中文提交并交摘要与自查；review 交 pass 或 changes 与报告。
   A 核对回传 head / PR / 报告，B 核对 owner 通知与记账。Git 推送仅用 owner 已批准的测试仓库。
6. 挂一张长运行 Claude 单，B 执行 `bun run sandbox --lab --as b manager lend revoke --peer a`。
   核对 Claude 及其子进程停止、对应 run 目录消失、会话归档存在、A 不再放单；清理失败日志须显示未确认并保留原因。
   再测 `--claude 0` 拒单及 Claude/Codex 同时占槽互不挤占。
7. 留存 A/B 版本 head、订单号、hello 字段、交付与收回检查结果及脱敏日志。
   分别停止前台 scheduler，再 `bun run sandbox --lab down`；按 sandbox 文档清理测试资源。

自动化替身测试覆盖启动隔离、MCP 档、两族名额、write/fix/review 生命周期与收回清理；不替代上述真实 CLI / 双实例验证。
