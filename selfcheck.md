验收线自查：
1. cwd 缺失：原有跳过 restart、单行日志和告警持久去重保持；相关回归通过。
2. 连续失败三次停恢复：保留三次上限；Pi/Codex 同一 generation 连续两次 active 后清零 failures、failureAlert 和失败告警冷却。第一次观察持久化，重启 launcher 后仍能解除；dead/creating/unknown 或新恢复尝试打断连续观察。Claude Code 仍要求 active+真实 idle，单次 active 不会清零。
3. 正常 dead 会话恢复保持；launcher.ts 本轮零修改（1157 行），开机波租约不变。只改 gate、其测试及交付文件。
4. 定向测试 61 pass / 0 fail；根 tsc 已通过；严格 guard、六入口 build 已通过。全量及最终检查见下。

上一轮 P1 hook-runtime-unlock：已修。采用报告允许的连续两轮 active 方案，不使用 Pi/Codex 恒真 idle 当就绪证据；同一 generation 可解除熔断，并恢复下一轮失败及熔断告警。启动预登记但结果未写回时也能经后续观察清零。旧 version=1 文件无需迁移，新观察字段可选。
复现测试：
- %s sustained active after manual restart unlocks the same generation
- %s sustained active clears an unfinished restart reservation
以上分别覆盖 pi/codex。先只加测试：27 pass / 4 fail，计数分别仍为 3、1；修复后定向共 61 pass / 0 fail。另覆盖短暂 active→dead 循环仍只执行三次、creating/unknown 中断观察、跨 launcher 重建、解除后重新熔断告警。

边界：hook runtime 以连续两次巡检 active 判断恢复，单次 active 不解锁；这不是新增 manager 成功事件。缺目录、故障告警、失败告警冷却等前轮修复未改变。
未 push；出借服务负责推送。最终 PR head 三项 CI 由合并闸核对。

最终本机检查：bun run check 已执行，根 tsc 通过；全量 10688 pass / 20 skip / 113 fail（853 文件），未全绿，失败涉及 dag-tools、lend/身份权限、usage-cache-write、acp-host、peer-e2e-gates 等未改模块，未逐项定因。本机 Bun 1.3.10，CI 为 1.3.14。check 因测试失败未运行 guard；另行根 tsc、GUARD_STRICT=1 guard、六入口 build 均通过。最终定向测试 61 pass / 0 fail，新增复现也在全量中通过。完整 CI 以提交后的 PR head 三项结果为准。
