# Claude 出借 worker：升级与验收交接

本页对应 i28-CL1。出借方 B 可接 Claude 的 write / fix / review 单，名额与 Codex 分开计算。
借入方 A 的 Claude 派单入口依赖 i28-CL2；本分支的 `ledger lend-offer` 仍拒绝 `--family claude`。
以下是 PM 待执行的验收流程，不能当作已经完成的双实例实测记录。

## 出借方升级

1. 更新 Claudestra 到包含本改动的版本（正常升级入口 `bun src/manager.ts update`），确认 `claude` CLI 在服务 PATH 中。
2. owner 在自己的终端运行 `claude setup-token`，按 CLI 提示完成认证。只使用它生成的 token；不复制 `~/.claude`，不读 Keychain。
3. 将 token 作为 `CLAUDE_CODE_OAUTH_TOKEN` 提供给**出借调度服务进程**。只在交互 shell export 不会改变已运行的服务。
   前台调度可在独立终端执行下列 zsh 示例；先停原调度进程，避免单实例锁冲突。token 不进命令历史或 argv：

   ```zsh
   read -rs 'CLAUDE_CODE_OAUTH_TOKEN?粘贴 setup-token: '
   export CLAUDE_CODE_OAUTH_TOKEN
   bun --no-env-file src/scheduler.ts
   unset CLAUDE_CODE_OAUTH_TOKEN
   ```

   此方式仅存于 shell / scheduler 内存，退出后不持久保存。长期 launchd 服务需要 owner 将变量加入现有
   `com.claudestra.scheduler` plist 的 `EnvironmentVariables`，限制 plist 为本用户可读（0600），再重载该服务。
   这是明文持久凭据，由 owner 按机器基础设施审批流程执行；不要另建第二个 scheduler，也不要把 token 提交到仓库或放进 PR。
   本实现不新增 token 文件或凭据管理器。轮换时重新运行 `claude setup-token`，替换服务的变量并重启服务；
   已启动 worker 保留旧环境，先收回授权等待停止，再重授。旧 token 的撤销 / 有效期按 CLI 和账号管理界面处理。
4. 重新授权，所有要保留的字段都显式填入；grant 会替换旧条目，Codex 缺省为 5，纯 Claude 测试需显式给 0：

   ```bash
   bun src/manager.ts lend grant A \
     --repos owner/repo --until 12h \
     --codex 0 --claude 1 --roles review,write
   bun src/manager.ts lend status
   ```

5. 等 B 调度服务发 hello，在 A 执行 `bun src/manager.ts ledger lend-peers --peer B`。
   核对 hello 新鲜、Claude 槽可放单。wire 中准确字段为 `slots.claude.total` 和 `slots.claude.busy`；
   空闲且未暂停时 total 应为 N、busy 为 0。缺 token 时 total 为 0，不能只看 grant 中的 N。

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
     用 `bun run sandbox --lab --as b env` 获取 B 隔离环境，在独立 shell 应用后用上述静默 read 注入 token，
     从本 checkout 以前台方式启动 B `src/scheduler.ts`；A 调度进程同样用 A 隔离环境启动。
     为沙箱项目配置 enabled 的 scheduler（参见 [scheduler-engine.md](../design/scheduler-engine.md)），所有路径留在 lab。
   - 当前 sandbox 出站闸拒绝 Unix socket，包括 Claude token 交接 socket。
     此为现有 lab 限制，PM 需先获得限定 lab 凭据 socket 的测试支持；不能关闭出站闸、去掉 sandbox 标记或改连生产。
3. 前置条件满足后，B 执行 `bun run sandbox --lab --as b manager lend grant a --repos owner/test-repo --until 12h --codex 0 --claude 1 --roles review,write`。
   A 为测试项目配置 `borrow set b --projects <测试项目> --roles review,write`（通过 A 的 sandbox manager）。
   先不注入 token 跑一次，确认上述提示与 hello total=0；再在 B 服务环境注入并重启、重授，确认新鲜 hello total=1、busy=0。
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
