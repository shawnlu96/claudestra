# i28-CL5 · specRev 1 自查

订单 lend:i28-CL5:s1:r0:a5；基线 cf0eb7b25817629c934a2b30462ddce13c9a412b；仅在 lend/i28-CL5-9109 提交，推送及 PR 由出借服务执行。

1. 登录失效：调度桩以 loggedIn:true、未知额度启动 Claude，真实生产 failure 接线读取该 worker 自身 JSONL。下一轮停止 worker、退租 stopped 并通知，原因明确写 Claude authentication_error / OAuth 刷新失败；Claude 零位，Codex 容量及 pause:codex 不变。包含 create 返回前 bootstrap 已失败、首条派单尚未送达的回归。
2. 额度上限：复用 quota-wall-text / autopilot-run 解析重置时间；持久化 pause:claude，hello 与收单共享暂停判定。到重置时间恢复；更新的明确不满快照可提前恢复，满快照只延长截止，未知/旧快照不解闸。重复 hello、新 auth 探测、kill 重试不缩短或滑动冷却。退单 detail 仅传固定额度分类和重置时间，借入方可识别冷却；未改变 QP3 的借入方 hello 处理。
3. auth status：真实假子进程输出 loggedIn:true 但 exit 1，仍判不可用且说明非零退出；打印成功 JSON 后挂住，超时杀子进程并报零位。测试没有调用真实模型或登录凭据。
4. 登录恢复：必须有失败之后新开始的成功 auth 探测，先恢复每个授权 1 个试单位；新 worker 的真实 assistant 响应确认正常后清除 auth 暂停并恢复全部位。旧探测晚返回 true 不覆盖新失败。测试实际接收并启动下一单，再确认全量恢复。
5. 验证：最终相关回归 13 文件 120 pass / 0 fail；根 tsc 通过；GUARD_STRICT=1 guard 通过；bridge、channel-server、manager、launcher、cron、setup 六入口 build 通过；git diff --check 通过。
   扩展 lend 回归：743 pass / 17 fail（74 文件），失败涉及管理命令权限与收单子进程等，现场有出借 worker 身份守卫拒绝。已执行 bun run check：10835 pass / 20 skip / 116 fail（868 文件），失败含管理身份/DAG、ACP stub 等，未宣称全量绿色，未修改这些范围外模块。PR head 的 CI 三项仍由合并闸核对。

范围：新增 lend-claude-pause*.ts；drive 仅失败查询接线净增 1 行，文件 394 行；deps 净增 1 行。PM 经 ask_muqlszhgdcbefd57a1 准许 ready.ts 最小接线，实际净增 3 行（上限 6）。不改 lend-health.ts、lend-inbox.ts、lend-quota-reset*.ts；原目标 5 / 验收线 6 已撤回，保留 CLP 回归。本摘要及自查按交付要求更新。
