# i28-C6 s2 r3 自查

1. 迁移重跑、碰撞、缺引用、敏感字段、pending、旧写门：原有迁移/prepare/gate-window 测试通过。本轮补 prepared/gating 本机 abort、换 batchId 和新摘要重新 prepare、aborted 批次不能 commit；同批撤销重跑不碰新批次。
2. 中心重启、断网、回执丢失：原有 C6 测试通过；本轮测试用断网客户端证实未进入 committing 时不请求中心。committing 阶段仍走中心回执，不本机撤销。
3. 双成员回环演练：C6 members 测试通过；导入可见、轮询、CAS 409 保留草稿重交、权限拒绝均覆盖。`focused.log` 记录临时端口与清理；测试结束停轮询和中心并移除隔离状态目录。
4. 部署说明：仅更新试迁撤销说明，无真实地址、凭据、个人信息；人工检查文档 diff。
5. `bun run typecheck` 通过；`bun run guard` 通过；C6/写门/prepare 定向 26 测试通过，日志见 `focused.log`。全量 `bun run check` 曾遇非本卡的超时和 ACP/lend 测试失败后中断；以 PR CI 为准。
6. 写门窗口：gate-window 七个入口测试通过，切模式仍与台账写事务串行。

按 PM 最新决定，empty-db 暂不做，原模式文件打开行为保留；staged-proj、manual-block 两项 P2 留后续节点。本轮未部署，未改 relay/反代/LaunchAgent，未碰其他分支。
