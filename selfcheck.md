# i28-X6 · specRev 1 自查

订单 lend:i28-X6:s1:r0:a0；基线 391666f9f2caf1289967391fb185f13d2a9fefe9；仅提交 lend/i28-X6-9109，不自行 push。

1. 通过：中心 v2_lend_* 表持有订单、claim、lease、result；订单号全局唯一，同项目任务只能有一张活单，unknown/过期 claimed 仍占位。第二次 claim 拒绝，包含同持有人重领、另一 worker 及独立 SQLite 连接；重开连接仍读到原持有人。source/planning 模式、错误主场/身份范围/代际拒绝。
2. 通过：结果核 orderId、leaseGen、expectedHead、specRev、round、worker、存活租约及当前任务/步骤绑定。review 的 head 必须等于订单 head；write/fix 的 head 是输出提交。只改订单和对应步骤，不改整卡 stage/head/主场/授权/工作流及其他步骤；额外字段拒绝。相同结果幂等，异文或复用 operationId 拒绝；failed/unknown 不标成功。步骤、事件、回执失败时同事务全回滚。
3. 通过：复用既有 lend-wire / lend-wire-v2 解析器和 offer/lease 外形。hello、beat、offer、claim、result 样例往返及旧 v1 golden 测试通过；未改协议字段、版本或 V1 服务。
4. 通过：在调用者事务内按冻结 migration manifest 导入，保留原订单号、leaseGen（覆盖代际 7）、原截止时间及结清状态；不重发、不 claim、不续租。缺失/错绑 claim、lease、step，过期活单、重映射单号、内容冲突均拒绝；同内容重复导入无新单。审批/源写门/整组导入由必填事务适配器及 X13 核验。
5. 验证：专属域测试 31 项通过；域+冻结契约+现有出借协议回归共 153 pass、0 fail。根 tsc 通过，guard 通过（未改基线），bridge/channel-server/manager/launcher/cron/setup 六入口及新域入口 build 通过，git diff --check 通过。
   已跑 bun run check：10691 pass、20 skip、113 fail（858 文件），退出 1；不宣称全量绿。失败集中在未修改的 DAG 工具、出借身份/CLI、ACP、usage-cache-write、peer-e2e 等路径；usage-cache-write 与 lend-config-priority 单独复跑仍 7 fail。当前环境 python3 连简单 print 都无输出，CLI 失败含 actor=? 的权限拒绝。全量结果以出借服务推送后的 PR head CI 三项为准，CI 由合并闸核对。

接入：只加一行接入，由 X12 执行。migrations 注册 lendSchema 并调 domain.installSchema；commands/V2 wiring 注册 lendStatements 并在统一事务调用 createLendDomain(ports).applyInTransaction；reads 用 readLendRow。X13 同事务调用 importInTransaction。必填 ports 连接中心 task/workflow/feature、步骤 CAS、事件序列及授权/机器算力 grant 校验；不得替换为本机库或整卡交付 helper。完整约束见 src/shared-ledger/lend/README.md。真实 HTTP/CLI 接线及 execution 开关未开启。

范围：实现和测试仅在指定目录/前缀；按派单要求更新 summary.txt/selfcheck.md 交付报告。未修改冻结契约、热文件、V1 服务或 guard 基线；未读取生产配置、连接生产 bridge 或改机器设施。
