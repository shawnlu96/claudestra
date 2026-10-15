# rename.rollout：三机混版本与回滚的隔离验收矩阵（rename-floka-MIX1）

验收的是**合成的临时三实例**，不是真实三台机器。真实部署、生产切 `on` 都不在这里，由 PM 核过矩阵与样本后另行操作。

## 开关

`rename.rollout` 取 `off` / `observe` / `on`，缺省 `observe`；别的值按 `off`。CLI 只读 `--mode` 或显式给的 `--config` 文件，
不读真实状态目录里的配置。

| 值 | 行为 |
| --- | --- |
| `off` | 不出计划、不跑 |
| `observe` | 只出滚动计划：每一步拨哪些 `rename.*` 档位、失败时怎么回滚 |
| `on` | 只在系统临时目录下新建的目录里起三实例 + 本机回环上的假中心跑矩阵（`admitRun` 把关），跑完删掉 |

```bash
bun scripts/rename-floka/mixed/cli.ts plan [--order alpha,beta,gamma]                 # 六个次序的计划（observe）
bun scripts/rename-floka/mixed/cli.ts preflight --center-proof proof.json --topology topo.json
bun scripts/rename-floka/mixed/cli.ts run --mode on [--order gamma,alpha,beta] [--tmp /tmp/x] [--keep]
```

`run` 的 `--tmp` 只能是系统临时目录（`$TMPDIR` 或 `/tmp`）之下的目录，缺省 `/tmp`：macOS 的 `$TMPDIR` 路径很长，
事务日志的凭据遮蔽会把它误认成密钥，STATE 迁移因此拒绝。

## 计划次序

1. `center:dual`：中心 `centerReceive` / `centerSend` 先开 `on`（两族都认、welcome 里发能力）。
2. 逐机 `cut:<机器>:<分项>`：`state` → `runtime` → `services` → `mcp` → `receive`（接收档：中心、请求签名、relay 入站、台账、E2E 接收）。
   同一台的五个分项在一个维护窗口里做：先停写，任一分项失败就按已完成分项逆序整机回滚。
3. 三台都切完后才 `send:<机器>`：`centerSend`、`peerRequestSend`、`ledgerSend`、E2E 发送。发送仍要对端已认证的能力证明才发新族。

## 矩阵覆盖什么

`matrix.ts` 每一阶段后六向互发一轮（经真中心转发，正文带台账签名、头带请求签名），并核：

- 六个有向对全部送达：中心 / 客户端混版本都可用（含切完后中心回旧版本）；
- 没开接收的一端只收到旧族（请求签名、台账签名、转发头里都没有新族），没有一条被拒；对照组硬发新族给旧端一律被拒；
- 每台四个 daemon 任何时刻最多一个写者（假控制器记 `maxLive`），runtime 新旧两条路径看到同一个 tmux server；
- 身份、`peers.json`、旧邀请、VAPID 钥匙、状态根之外的外部配置逐字节不变；推送订阅逐行不变；任务只增不减（含迁移后新增的）。

真实的库：`migrateState` / `rollbackState`、`applyRuntimeAlias` / `rollbackRuntimeAlias`、`runServicePlan`、`selectMcpName` +
会话族记录、`createRelay` + `connect`、`chooseSendFamily` / `verifyRequestFamilies`、`ledgerSendFamily` / `receiveLedgerUse`、
`createPushSender`。只有服务控制器、tmux server 探针和推送服务是假的。

## 不覆盖什么

- 真实三机没有升级；四个 daemon 的实际拓扑与三机差异要 `preflight --topology` 给证据，没给就是 `unverified`。
- 私仓中心的支持证明本仓看不到，`preflight --center-proof` 没给就是 `unverified`。
- 不换域名、不换 VAPID：推送沿用原钥匙与原域名，矩阵不声称换域或新旧 VAPID 兼容。
- peer 层 E2E 握手与能力缓存的六次序由 `tests/floka-peer.test.ts`（PEER1）覆盖；本矩阵每次现算能力，不模拟缓存过期。
- 台账的生产能力来源还没接线（LEDGER1 注：缺省恒发旧族），矩阵里的能力由测试直接按实例签发。

单测：`tests/floka-mixed.test.ts`。
