验收线自查：
1. cwd 缺失：不 restart；日志和控制频道告警持久去重；目录恢复后再次缺失可重新告警。覆盖多轮、重建 launcher、并发检查及通知失败。
2. 连续失败 3 次停止：启动前在文件锁内持久登记尝试，成功清零；失败后只报 active 不再清零。created/sessionId 等换代或 Claude Code 的 active+真实 idle 就绪可解除；Pi/Codex 恒真 idle 不作为就绪证据。回归循环 5 轮仅 restart 3 次；第 4 轮起不再调用。
3. 正常 dead 恢复保持；launcher.ts 本轮零修改（1157 行），开机波租约与收尾冷却逻辑未改。
4. 相关测试 53 pass / 0 fail；根 tsc --noEmit 通过；GUARD_STRICT=1 guard 通过；bridge/channel-server/manager/launcher/cron/setup 六入口 build 通过。全量 check 结果见下方，PR head 三项 CI 由合并闸核对。

上一轮问题逐条：
- P1 reset-on-active：要求真实就绪或换代，残留进程仅 active 不解除；增加 active→dead 和 hook runtime 假 idle 测试。
- P2 fail-closed-all：坏 JSON/非法结构/锁超时保持拒写并跳过恢复，另用原子目录标记持久去重控制频道故障告警；写明文件、修复文件/锁、巡检会重试。故障修复后自动恢复并重置该告警。保留坏文件证据，不盲目清空熔断计数。
- P2 restart-throw-aborts-wave：提前登记尝试；运行后事务失败在 gate 内捕获并告警，返回实际结果，不抛到外层打断恢复波。测试覆盖运行后持锁超时、下一 agent 继续、计数不丢，以及运行后状态损坏。
- P2 per-failure-alert-removed：恢复首次失败告警，30 分钟按 agent 冷却且持久化；三次熔断告警独立于冷却。
- P2 missing-alert-sticky：检测到目录恢复就重新允许下一次缺失告警，跨 launcher 重建回归通过。

边界：状态不可读/不可加锁时仍暂停自动恢复并告警，修复后重试；若启动成功但结果落盘失败，保留预登记尝试，等待后续明确就绪/换代，避免失去熔断保护。未修改范围外源码，未 push。

全量本机检查：已跑 bun run check，根 tsc 通过，测试 10678 pass / 20 skip / 114 fail，未全绿；失败涉及 dag-tools、lend/权限身份、usage-cache-write、acp-host、peer-e2e-gates 等未改模块，未逐项定因。本机 Bun 1.3.10，CI 配置 1.3.14。check 因测试失败未到 guard，另跑严格 guard 通过。最终改动另跑相关 53 项测试、根 tsc、严格 guard、六入口 build 均通过；不替代 PR head CI。
