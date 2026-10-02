# i28-LK1 · specRev 1 · 第 2 轮修复自查

订单 lend:i28-LK1:s1:r2:a1；基线 3ee0db987cc4369e64f7067f9564ccf99517fbff；仅提交 lend/i28-LK1-9109，不自行 push。

1. 验收线 1 / P1 retire-deadlock：author session 或 registry active 不再直接视为在写。无 worker 同步结清；有 worker 提交后异步读取 tmux/ACP 忙闲，明确空闲才结清。覆盖四阶段 live/verified/done/cancelled × 三意图态 pending/submitted/unknown；active author 结清→beginRetire→archive/kill→退役完成，C6 能取得原文件锁；手动 task.agent 和旧 recipient 的空闲 worker 同样释放。
2. 验收线 2：真实 pooled/claimed/unknown 写单保锁；忙、creating、未知画面、探测异常/超时均保锁。跨连接、连续 tick 不重复通知或结清事件。生产 retireStep 测试覆盖首次忙→下一轮空闲→自动结清放锁，且先结清再退役。
3. P2 lend-unknown：按 PM ask_muqqz0kd477a86f93b 批准，使用真实 schema 的 unknown 代替不存在的 running；删除伪造 running 表测试，真实 unknown 写单覆盖保锁。
4. P2 notice-once-forever：结清后清通知键，重开卡再次阻塞会重新通知；通知加唯一 ID，旧轮在途回执不能把新通知误标为已送达。
5. PM 异步约束：事务外探测；回写新事务精确复核卡、意图、锁及绑定 session 快照，并复核 registry worker 身份。阶段/意图/锁持有者/锁消失/session/registry 变化均不动；新增活写单仍阻止结清。第二连接在探测挂起时能取得写锁。原事务回滚不启动探测，CLI 关库后的保锁通知仍可送达；调度失租不结清、不放锁。失败保锁、后续 tick 可重试。PM ask_muqr7pykf88fec26e5 确认四阶段三状态都保留。
6. 范围：实现和回归在 ledger-scheduler-lease*；ledger-scheduler-lease.ts 本轮未改，保留原累计 +2 行。经 PM ask_muqrfrm10c7ae91753 批准，scheduler-retire-deps.ts 仅新增 import+调用共 2 行。另经 PM ask_muqs3i9t719f8d84b0 批准，scheduler-retire.ts 两处调用同一未结写意图守卫，净增 2 行、总长 340 行，阻止 cancelled 的候选筛选与 closeStray 绕过忙 worker/unknown 写单保护；补取消卡忙→下轮空闲→退役放锁回归。按派单要求更新 summary.txt/selfcheck.md。
7. 验收线 3：相关 6 文件 148 测试全过；根 tsc、guard 通过；六入口 bridge/channel-server/manager/launcher/cron/setup 及 scheduler build 通过。本地全量 check 最近一次为 10495 pass / 20 skip / 116 fail（838 文件）；失败涉及 DAG/出借身份权限、usage-cache-write 等，usage-cache-write 与 lend-cli-keep-unset 单独运行也复现 11 fail；未修改这些模块。最后补充的取消卡守卫已纳入上述 148 项回归。

全量以新 PR head 的 CI 三项为准，由出借服务推送后合并闸核对；本次没有冒充远端 CI 已通过。
