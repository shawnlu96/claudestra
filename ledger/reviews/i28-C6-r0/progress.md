# i28-C6 验收记录

基线 `6783ba81d5610aa823eb975183f065c4843bab5f`；仅工作分支 `lend/i28-C6-9109`。本卡未部署。
按规格及 13:06 / 13:12 / 13:50 的批准补充实现，未修改 contract-v2、沙箱、relay、反代、LaunchAgent 或生产状态。

## 逐条自查

1. **迁移整批与旧入口**：`shared-ledger-migration-prepare` 覆盖备份、稳定预览、整组 pending、在途/unknown/残留绑卡、敏感字段和缺引用。
   `shared-ledger-server-import` 覆盖碰撞与后半批失败的原子回滚、重复批次不新增。
   `shared-ledger-integration-gate` 真实调用 CLI / MCP / autostart，迁后改图、绑卡和开节点均拒绝，原卡执行仍可推进。
2. **崩溃恢复**：`shared-ledger-c6-migration` 真实 HTTP 覆盖中心重启、断网、commit / activate / revoke 回包丢失；恢复第一步查同批回执。
   已确认回执消失或水位回退即拒绝，不偷偷重提、不打开写门。开启中心写入前核对实存 feature、所有 DAG 版本/绑定、卡/step/事件投影摘要和水位。
   撤销回执持久化后才开本机写门；撤销跨本机崩溃保持批次占有，旧 revoke 重放不会影响后续新批次。
   本机重复导入不会覆盖已开放的中心规划；staged 期间成员写入拒绝，active 后不能用试迁撤销迁回。
3. **双成员替代演练**：`shared-ledger-c6-members` 同进程回环中心 + 两个独立目录、密钥和成员凭据，实际签名 HTTP 客户端。
   peer A / peer B 同见 feature / 子图 / 卡；双方分别新建后对方下一次 5 秒轮询可见；同时改未绑节点只有一人成功。
   另一人收到 409，保留原草稿，用 C4 的重读/rebase/冲突解决函数重交成功。已绑节点与执行字段拒绝；未入组、错实例、跨项目、冒充 owner 均拒绝。
   重启后读回同图，断网保持未知结果；旧投影和缓存标记 stale。按批准替代方案不提供截图，真机双 bridge / 网页验收留 X13。
4. **试部署说明**：设计稿 §10 覆盖机器、域名/TLS 复用、独立库/权限、备份、恢复和四阶段 CLI。
   `git grep` 自检设计稿中的用户绝对路径、HTTP 地址、IPv4、Bearer 值、私钥标记，无命中。没有真实地址或凭据。
5. **检查**：共享台账相关 102 pass / 1 skip / 0 fail；批准的既有 `testChildEnv` 隔离子进程跑共享台账 + dag-tools：198 pass / 1 skip / 0 fail，1314 断言。
   跳过项是既有双网页手工截图用例，本轮不冒充已跑。tsc 0、guard 0；六个既有入口、中心入口和迁移脚本均构建成功。
   全量本机 `bun run check`：10457 pass / 20 skip / 116 fail，退出 1，详见 `checks.log`。
   失败含继承的出借身份拒绝、ACP 夹具、usage-cache 的 Python 进程被终止；前后两轮失败名称一致，这不等于基线 main 已验证。
   不宣称全量绿色；PR head 的 CI 由合并闸核对。
6. **写门窗口**：`shared-ledger-gate-window` 在事务核验后、首条实际写入前启动另一进程切模式。
   ledger-dag-write、feature-migrate、feature-write、feature-split、dag-tools-steps、autostart、feature-dep 共七入口均证明在途事务完成后才能切模式。
   `shared-ledger-c6-start` 另验证真实 runStart → manager → createTask 在外层检查后切模式，事务内复核挡住 task-new；不启动 manager create。

`ledger-write.ts` 只加 helper 导入和事务内一行调用，共 +2 行、392 行。新增 `extra.sharedFeatureId` 把 feature 传到实际写事务，
因此 manager 参数/task.extra 的历史 SHA256 变化；按 13:50 批准仅更新 `dag-tools-placement`、`dag-tools-template` 五个 golden 值，其余断言不动。

## 证据与复现

- `focused.log`：共享台账全部定向测试原始日志（工作副本路径脱敏）。
- `isolated.log`：经既有 testChildEnv 的共享台账 + dag-tools 回归日志；包含双成员临时端口和收尾证明。
- `checks.log`：tsc、guard、构建和本机全量结果摘要。

```sh
bun test tests/shared-ledger-*.test.ts
bun run typecheck
bun run guard
bun run check
```

隔离回归以 `testChildEnv()` 给测试子进程最小环境，运行同一工作副本的 `bun test`，没有修改运行时身份逻辑；
共享台账 + dag-tools 共 39 个测试文件。双成员演练端口由系统临时分配，本次日志为 54839；
测试 finally 中执行 poll stop、`server.stop(true)`、关闭 SQLite 并删除两个临时状态目录，不留监听或定时器。

## 最初沙箱尝试与收尾

批准替代方案前，已在检查端口空闲后尝试两个 `bun run sandbox` bridge（24760 / 24761）与独立中心（24762）。
两侧的正式沙箱出站闸都拒绝访问另一中心端口；未绕过闸门，后按批准方案改用上述 HTTP 测试。

```sh
bun run sandbox down --root /tmp/c6-peer-a-ecc869 --port 24760
bun run sandbox down --root /tmp/c6-peer-b-ecc869 --port 24761
bun run sandbox clean --root /tmp/c6-peer-a-ecc869 --port 24760
bun run sandbox clean --root /tmp/c6-peer-b-ecc869 --port 24761
lsof -nP -iTCP:24760 -iTCP:24761 -iTCP:24762 -sTCP:LISTEN
```

上述命令已完成，端口检查无监听；中心在原启动会话内 SIGINT 正常退出，其独立临时目录也已删除。
未启动真实模型或执行 worker，未操作任何生产数据。
