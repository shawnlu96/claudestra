# 共享台账 V2：并行 PR 设计

本稿只拆设计，不实施代码/部署/生产台账。依据[原设计](shared-ledger.md)，基线 ecbf08a8；全部V2通过才开execution，每卡最多半天，热文件集中串接。

## 1. 必须能力及范围对照

以下每项缺失均为 P1；出处均指原设计。

- 中心单写 tasks/依赖/步骤/调度意图，主场发命令和回执，不本地成功后补同步；按 feature 整组 source/planning/execution。
  禁止旧 source 图覆盖 planning、半卡双权威；全部替代 C7–C9 节点通过才开放 execution。（§1.1；X0/X7/X12/X13/X15）
  网页经本人bridge、CLI/PM同命令入口；独立SQLite WAL事务提交行/版本/事件/回执，各机只读缓存，不用网络盘库。
  task_mirrors只是投影、不触发执行或覆盖规划；追加观测之外不搞多主事件合并或客户端时间最后写赢。（§1.1；X7/X12）
- 纳入 items/tasks/task_deps/task_steps/task_workflows/dag_proposals/业务 asks/执行 events。
  tasks 保留 title/kind/stage/round/specRev/rev/featureId/仓库坐标/branch/pr/head，并增 homeInstanceId；extra 拆命名 schema。（§3.1 V2；X1/X2/X14）
- 中心持 scheduler_intents/resources、调度租约及执行操作回执；资源键按团队项目+仓库/文件范围，禁绝对路径。
  lend 订单/claim/lease/result 随 feature 迁入唯一权威，不能两库接单；合并部署仅上传状态/head/审批引用/摘要，shell 参数/原输出留执行端。（§3.1；X4/X5/X6/X8）
- 规格/报告获准副本存不可变 artifactId/kind/taskId/specRev或head/digest/redactionVersion；本机绝对路径不能变远程链接。
  未共享全文明确仅在主场，脱敏摘要不叫原文。（§3.2 附件；X3/X10/X11/X13）
- 业务决定/授权 bind、到期、答复人、审计入中心；终端权限/模型 permission/聊天 AUQ 不上中心。
  原文及副本哈希分列，授权绑定实际用于动作的内容；脱敏变义须新规格/审批，不能挪旧批准。（§3.2 asks；X2/X3/X11）
- personId + owner 登记实例绑定；bridge 核本人，不接受 body actor/role；服务身份限制项目/动作、记录代表谁/哪个订单。
  多个本机 owner 不自动获项目 owner；member 可开 spec 卡/改他人允许字段，均 CAS+审计；在途规格改动新 specRev。
  分配/阶段/交付/审查独立鉴权，generic PATCH 不得改 stage/head/主场/授权/工作流模式。（§4；X0/X1/X7/X12）
  团队共享规划权限独立于本机PM名单，不把成员变owner或放宽canReadLedger；仍核DAG无环/同项目/完成节点继承。（§4；X12/X14）
- 成员不能 create/kill/interrupt 他人执行者、读终端或改 registry；只能发暂停/调整请求，主场在机器 owner 授权内执行。
  出借空位仍按算力授权领单，订单不扩大整机管理权。（§4；X8/X9/X12）
- 合并/发版/授权仅 owner；调度只执行有效、未越界的明确授权；项目 owner 管范围/成员/主场，机器 owner 管算力。
  中心不存 Git/部署凭据，实际动作在授权主场；403/冲突不泄漏其他项目，撤成员停新数据清在线缓存，已下载副本不能保证追回。（§4；X2/X7/X12）
- homeInstanceId 推进，executorInstanceId 干活，出借不改主场；仅登记主场领 scheduler_leases。
  中心时钟、单持有者，建议60秒租期/15秒续租；重启 bootId/新 epoch，旧 holder 禁写。（§5.1；X4/X8）
- 意图事务核卡 rev/specRev/workflowRev/依赖/owner授权/epoch/资源，再写 intent/event；所有写入口核 epoch，同机锁保留。（§5.2；X5/X12）
- 每次副作用前在线核租约/意图；稳定 operationId，结果携 epoch；取消/换主场不复用 epoch。
  检查与远端副作用非原子，丢回执 unknown 先对账，不承诺通用 exactly-once。（§5.3；X5/X8/X15）
- 超时不自动换主场；owner 确认旧端停推及 worker/lend 单结清或核清再增 epoch。
  未核清 unknown 持续占资源，不因租到期盲重试合并/开工。（§5.4；X4/X5/X13/X15）
- 其他机器只经出借池接单；hello/beat/offer/claim/result 外部 v2 形状保持，主场 bridge 代理中心。
  中心统一 claim/订单租约/结果，回写核订单/leaseGen/head/specRev，worker 不能直接改整卡。（§5.5；X6/X9/X12）
- 迁移暂停派单、处理活 worker/lend/unknown、核快照后整组切 execution；不迁 scheduler_sessions/进程锁，中心租约建立前不恢复。
  旧单结清或显式导入核租约不重发；新旧 id、规格副本、审查证据完整才允许启动。（§7 执行迁移；X13）
- 中心不可用只读缓存/草稿，显示最近成功时间，不自动排队/假成功/回退本机权威；V2派单/阶段/合并/发版停。
  在途 worker 保留成果，结果只存本机 outbox；恢复查回执/租约/版本再显式重交，不重复启动。（§7 中心不可用；X7/X8/X9/X15）
- 每日一致性快照、迁前备份；试用最多一天 RPO，更小目标另议连续备份。
  旧备份恢复先冻结、升服务代际、撤旧租约、核已确认回执；序列倒退告警重建缓存，不静默丢提交。
  已有中心新提交不能直接回旧本机库，须冻结、导出核对后单独迁回。（§7 恢复；X4/X13/X15）

§9 五项已定推荐逐项对照：

1. V1 只规划/投影：本稿设计 V2，中间模块交付不开放执行。
2. 同机独立服务/库、复用 TLS：沿用托管选择，本卡不部署，机器基建另行 owner 批准。
3. owner 登记成员/实例/项目；现有卡主场不变，新 feature 默认创建者实例，断网不自动换主场。
4. 白名单元数据/脱敏摘要；全文逐份批准才上传，不全库公开。
5. 活跃 feature 先 source，空闲无 pending 且可停开节点才试迁 planning；V2执行另走整组闸，断网只读/草稿。

## 2. PR 节点

半天=4小时实现含针对测试，审查另计1小时/卡，每条验收线「缺 = P1」；X0冻结DTO/命令/错误码/capabilities、迁移manifest/代际/快照/跨域事务接口。
域模块导出 schema 安装及调用者事务内校验/写入函数，不暗中另提交；统一事务组合在 X12。
X1/X14、X2与附件/任务、X5与租约/授权均通过冻结接口和夹具开发，无需互改文件或等服务实现。
X10/X11复用既有UI模式，仅增表单/夹具，不重做视觉系统；字段命名在 C1 后冻结。
新模块≤400行，测试≤600行；不改 guard 基线。每卡专属测试前缀，不占既有测试大 glob。

### X0 · 冻结共享执行契约及跨域事务接口

key：X0；oneLine：冻结共享执行契约及跨域事务接口；deps：C1；估时：1小时。
fileGlobs：

- src/lib/shared-ledger-contract-v2*.ts
- tests/shared-ledger-v2-contract*.test.ts

验收线：DTO/命令/错误码/能力及迁移代际夹具完整；定义 task/ask/artifact/lease/intent/lend/提案；跨域事务接口禁止独立提交。

### X1 · 中心事项任务依赖与阶段CAS

key：X1；oneLine：中心事项任务依赖与阶段CAS；deps：X0, C2；估时：3小时。
fileGlobs：

- src/shared-ledger/exec-tasks/**
- tests/shared-ledger-v2-tasks*.test.ts

验收线：items/tasks/task_deps 白名单/id映射；阶段核 rev/from/specRev，交付审查核订单/round/head；事件及不可变命令回执同事务、冲突全回滚。

### X2 · 中心业务asks和范围审批

key：X2；oneLine：中心业务asks和范围审批；deps：X0, C2；估时：3小时。
fileGlobs：

- src/shared-ledger/asks/**
- tests/shared-ledger-v2-asks*.test.ts

验收线：业务ask bind/期限/答复人/审计，排除聊天模型弹窗；同feature单pending，批准绑摘要/基础版/期限；生效重验卡，漂移过期驳回不换图。

### X3 · 不可变共享附件及双哈希绑定

key：X3；oneLine：不可变共享附件及双哈希绑定；deps：X0, C2；估时：3小时。
fileGlobs：

- src/shared-ledger/artifacts/**
- tests/shared-ledger-v2-artifacts*.test.ts

验收线：不可变对象全绑定字段；只传批准副本、原文/共享哈希分列；脱敏变义新规格/审批，拒绝绝对路径链接。

### X4 · 中心主场租约与服务代际

key：X4；oneLine：中心主场租约与服务代际；deps：X0, C2；估时：3小时。
fileGlobs：

- src/shared-ledger/leases/**
- tests/shared-ledger-v2-leases*.test.ts

验收线：登记主场独占/中心时钟/60秒租期15秒续租；bootId/epoch拒旧持有者、取消迁主场不复用；恢复旧备份升服务代际撤旧租约。

### X5 · 中心意图资源与操作回执

key：X5；oneLine：中心意图资源与操作回执；deps：X0, C2；估时：3小时。
fileGlobs：

- src/shared-ledger/intents/**
- tests/shared-ledger-v2-intents*.test.ts

验收线：事务核rev/specRev/workflowRev/依赖/授权/epoch/资源；稳定operationId和回执、unknown持续占资源；资源键按项目仓库文件范围、不用绝对路径。

### X6 · 中心出借订单claim租约与结果

key：X6；oneLine：中心出借订单claim租约与结果；deps：X0, C2；估时：3小时。
fileGlobs：

- src/shared-ledger/lend/**
- tests/shared-ledger-v2-lend-server*.test.ts

验收线：订单claim/lease/result单权威；结果核订单/leaseGen/head/specRev不改整卡；保留外部v2形状、活单导入不重发。

### X7 · 执行客户端与持久写门

key：X7；oneLine：执行客户端与持久写门；deps：X0, C3；估时：3小时。
fileGlobs：

- src/lib/shared-ledger-exec-*.ts
- tests/shared-ledger-v2-exec-client*.test.ts

验收线：本人/服务身份范围校验、业务ask创建查询答复撤销过期授权检查均中心客户端；source/planning拒执行，execution走中心；丢响应查回执，离线缓存/outbox不产生批准或本地回退。

### X8 · 调度中心租约意图适配

key：X8；oneLine：调度中心租约意图适配；deps：X0, C3；估时：3小时。
fileGlobs：

- src/lib/scheduler-central*.ts
- tests/shared-ledger-v2-scheduler-client*.test.ts

验收线：每个副作用前在线核租约意图授权、结果携epoch；新增scheduler-central部署适配传递稳定operationId及job上下文，子进程每步在线核验；保留同机锁，失租停执行、请求不变远控。

### X9 · 出借代理及中心结果回写

key：X9；oneLine：出借代理及中心结果回写；deps：X0, C3；估时：3小时。
fileGlobs：

- src/lib/ledger-lend-central*.ts
- tests/shared-ledger-v2-lend-client*.test.ts

验收线：主场bridge代理、worker仅限定订单；沿用机器owner算力授权，中心不启进程/扩大授权；恢复先查回执租约版本再显式重交。

### X10 · 共享开spec卡和允许字段编辑

key：X10；oneLine：共享开spec卡和允许字段编辑；deps：X0, C4；估时：1小时。
fileGlobs：

- web/features/collab/shared/task/**
- tests/shared-ledger-v2-task-ui*.test.ts

验收线：成员开卡/改他人允许字段、CAS草稿；在途规格新specRev，禁generic PATCH执行字段；显示主场执行地过期，未开放能力禁用。

### X11 · 范围审批及业务授权界面

key：X11；oneLine：范围审批及业务授权界面；deps：X0, C4；估时：1小时。
fileGlobs：

- web/features/collab/shared/approve/**
- tests/shared-ledger-v2-approve-ui*.test.ts

验收线：owner审批绑提案摘要基础版期限；展示批准副本不冒充原文；漂移过期撤销无假成功、member不能代签。

### X12 · 集中串接入口及全链路写门

key：X12；oneLine：集中串接入口及全链路写门；deps：X1, X2, X3, X4, X5, X6, X7, X8, X9, X10, X11, X14, C5；估时：4小时。
fileGlobs：

- src/shared-ledger.ts
- src/shared-ledger/service.ts
- src/shared-ledger/commands.ts
- src/shared-ledger/migrations.ts
- src/shared-ledger/reads.ts
- src/shared-ledger/identity.ts
- src/manager/ledger.ts
- src/lib/ledger-write.ts
- src/lib/shared-ledger-mode.ts
- src/lib/ledger-dag-write.ts
- src/scheduler.ts
- src/lib/scheduler-deploy-job.ts
- src/lib/scheduler-deploy-worker.ts
- src/lib/scheduler-deploy-steps.ts
- src/lib/scheduler-pass.ts
- src/lib/scheduler-apply.ts
- src/lib/scheduler-auto-deps.ts
- src/bridge/local-api/index.ts
- src/bridge/local-api/shared-ledger.ts
- src/bridge/dag-tools.ts
- src/bridge/order-tools.ts
- src/bridge/lend-tools.ts
- src/bridge/lend-dispatch.ts
- src/bridge/local-api/lend.ts
- src/bridge/local-api/lend-inbox.ts
- src/bridge/local-api/asks.ts
- src/bridge.ts
- src/bridge/asks.ts
- src/bridge/ask-reply.ts
- src/bridge/ask-entry.ts
- src/bridge/ask-dismiss.ts
- src/bridge/ask-expire.ts
- src/bridge/ask-locate.ts
- src/manager/ledger-read-cmds.ts
- web/features/collab/shared/shared-view.tsx
- web/features/collab/shared/shared-ledger.tsx
- web/lib/api/shared-ledger.ts
- web/lib/i18n-dict-shared-ledger.ts
- src/lib/shared-ledger-v2-wiring.ts
- src/shared-ledger/v2-wiring.ts
- src/bridge/shared-ledger-v2-wiring.ts
- tests/shared-ledger-v2-wiring*.test.ts

验收线：全部命令入口核模式epoch，副作用核授权；真实reply建中心业务ask，Web/Discord/聊天共用记录，离线本机不能有效批准；独立job提交后、下一步前断中心或失epoch，后续副作用挡住、未确认结果unknown对账。
验收线：新wiring承载逻辑、旧文件薄调用，execution仍禁用；业务ask跨入口查询/撤销/过期/ask-check一致，本机缓存/outbox非授权权威。

### X13 · 整组执行权迁移及回执核对

key：X13；oneLine：整组执行权迁移及回执核对；deps：X12, C6；估时：2小时。
fileGlobs：

- scripts/shared-ledger-execution-migrate.ts
- src/lib/shared-ledger-v2-migration*.ts
- tests/shared-ledger-v2-migration*.test.ts

验收线：暂停新派单、备份并处理活单/unknown；映射规格审查证据核全，旧单结清或显式导入核租约；持久门+全组切换+中心租约，失败查batch回执不恢复旧权威。

### X14 · 中心步骤工作流与原子绑卡

key：X14；oneLine：中心步骤工作流与原子绑卡；deps：X0, C2；估时：3小时。
fileGlobs：

- src/shared-ledger/exec-workflows/**
- tests/shared-ledger-v2-workflows*.test.ts

验收线：task_steps/task_workflows及workflowRev schema；绑卡同事务核feature.rev/task.rev更新两者及绑定；完成图原样继承，执行events统一serverSeq、不信任源事件命令。

### X15 · 故障恢复与三实例闭环验收

key：X15；oneLine：故障恢复与三实例闭环验收；deps：X13；估时：2小时。
fileGlobs：

- tests/shared-ledger-v2-e2e*.test.ts
- docs/testing/shared-ledger-v2-drills.md

验收线：本机/peer A/peer B网页开卡借单审查到owner合并闭环；失租崩溃丢回执断网活单迁移unknown逐项留证；旧备份冻结升代际回执对账、全部节点通过才开放execution。

## 3. 并行性与热文件归属

X1–X11和X14共12张，无祖先关系，各有独立目录/文件前缀与专属测试。X0先行，X12汇合，X13迁移，X15验收。
C2/C3/C4宽glob与对应后继相交，故分别列真实前置；X12等C5，X13等C6。本稿不承诺与未知外部卡无冲突，PM开工前按最新DAG重跑。
X12独占清单中所有既有热文件：中心真实路由在service而非只entry；commands事务分派，migrations schema安装，reads/identity快照权限。
其余模式/代理/CLI/DAG和订单MCP/自动阶段/lend/asks/网页壳及DTO也只归X12。
其他卡规格例外写「只加一行接入，由X12执行」，不得自行碰热文件；如发现新旧入口先补X12清单再核冲突。
采用保留独立部署链的接入方式：scheduler.ts --deploy-job → job/worker/steps 四处接线仅归X12，不能只查schedulerPass。
X8新scheduler-central模块实现job请求/结果的team/project/task/intent/bootId/epoch/operationId/授权引用；不跨进程继承内存回调。
worker显式建立中心客户端，每个实际步骤前在线核租约/意图/owner授权并使用稳定步骤operationId；离线/失epoch停后续，已开始未确认动作unknown占资源再对账。
共享卡业务ask按中心id/feature模式分流：WS reply经ask-reply中心创建，查询/locate、Web/Discord/聊天答复、撤销/过期均同中心记录。
asks/ask-entry/ask-dismiss/ask-expire及CLI ask-check只薄接线，业务逻辑入新bridge wiring和X7客户端；中心核本人/bind/期限/版本后才提交批准。
本机缓存/通知映射/outbox只作展示投递，不能当授权；禁止把askDb整体远程化，runtime permission/AUQ及非共享ask保留本机路径。
逻辑放新wiring，旧文件薄调用；src/lib不反向导入bridge/服务端，web与src不互相导入。

### 附录：检查命令与输出

从仓库根运行；git ls-files -z枚举现有tracked文件，Bun.Glob.match展开每卡fileGlobs，然后逐对集合取交集。
比较全部无祖先关系的卡，不只同一组。不存在的新路径另比较glob的固定前缀/后缀，检查未来路径所有权。
本清单只允许单个文件名前缀星号或目录尾/**；该受限语法下前缀和后缀均兼容即相交，不能靠空集合声称并行。

```sh
bun run - <<'JS'
import { readFileSync } from 'node:fs';
const doc = readFileSync('docs/design/shared-ledger-v2.md', 'utf8');
const sections = doc.split(/\n### (X\d+) · /);
const nodes = new Map();
for (let i = 1; i < sections.length; i += 2) {
  const key = sections[i], body = sections[i + 1].split('## 3.')[0];
  if (nodes.has(key)) throw Error('duplicate key');
  const deps = body.match(/deps：([^；]+)；/)[1].split(', ');
  const paths = [...body.split('验收线：')[0]
    .matchAll(/^- ([a-z][^\n ]+)$/gm)].map(m => m[1]);
  if (!paths.length || !body.includes('估时：')) throw Error(key);
  nodes.set(key, { deps, paths });
}
const files = new TextDecoder().decode(
  Bun.spawnSync(['git', 'ls-files', '-z']).stdout
).split('\0').filter(Boolean);
function symbolic(a, b) {
  if (!a.includes('*')) return new Bun.Glob(b).match(a);
  if (!b.includes('*')) return new Bun.Glob(a).match(b);
  const split = p => p.endsWith('/**') ? [p.slice(0, -2), ''] : p.split('*');
  const [ap, as] = split(a), [bp, bs] = split(b);
  if (split(a).length !== 2 || split(b).length !== 2) throw Error('glob syntax');
  return (ap.startsWith(bp) || bp.startsWith(ap)) && (as.endsWith(bs) || bs.endsWith(as));
}
const expanded = new Map([...nodes].map(([k, n]) => [k,
  files.filter(f => n.paths.some(p => new Bun.Glob(p).match(f)))]));
function ancestor(a, b) {
  return nodes.get(b)?.deps.some(d => d === a || ancestor(a, d)) ?? false;
}
let pairs = 0;
const rows = [];
for (const [a, na] of nodes) for (const [b, nb] of nodes) {
  if (Number(a.slice(1)) >= Number(b.slice(1))) continue;
  if (ancestor(a, b) || ancestor(b, a)) continue;
  const hit = expanded.get(a).filter(f => expanded.get(b).includes(f));
  const planned = na.paths.some(a => nb.paths.some(b => symbolic(a, b)));
  if (hit.length || planned) throw Error(a + '/' + b + ': overlap');
  rows.push(a + '/' + b + '=0/0'); pairs++;
}
for (let i = 0; i < rows.length; i += 6) console.log(rows.slice(i, i + 6).join(' | '));
console.log('nodes=' + nodes.size + ' incomparablePairs=' + pairs);
console.log('X12 tracked hot files=' + expanded.get('X12').length);
JS
```

实测输出（每对=existing/planned交集数）：

```text
X1/X2=0/0 | X1/X3=0/0 | X1/X4=0/0 | X1/X5=0/0 | X1/X6=0/0 | X1/X7=0/0
X1/X8=0/0 | X1/X9=0/0 | X1/X10=0/0 | X1/X11=0/0 | X1/X14=0/0 | X2/X3=0/0
X2/X4=0/0 | X2/X5=0/0 | X2/X6=0/0 | X2/X7=0/0 | X2/X8=0/0 | X2/X9=0/0
X2/X10=0/0 | X2/X11=0/0 | X2/X14=0/0 | X3/X4=0/0 | X3/X5=0/0 | X3/X6=0/0
X3/X7=0/0 | X3/X8=0/0 | X3/X9=0/0 | X3/X10=0/0 | X3/X11=0/0 | X3/X14=0/0
X4/X5=0/0 | X4/X6=0/0 | X4/X7=0/0 | X4/X8=0/0 | X4/X9=0/0 | X4/X10=0/0
X4/X11=0/0 | X4/X14=0/0 | X5/X6=0/0 | X5/X7=0/0 | X5/X8=0/0 | X5/X9=0/0
X5/X10=0/0 | X5/X11=0/0 | X5/X14=0/0 | X6/X7=0/0 | X6/X8=0/0 | X6/X9=0/0
X6/X10=0/0 | X6/X11=0/0 | X6/X14=0/0 | X7/X8=0/0 | X7/X9=0/0 | X7/X10=0/0
X7/X11=0/0 | X7/X14=0/0 | X8/X9=0/0 | X8/X10=0/0 | X8/X11=0/0 | X8/X14=0/0
X9/X10=0/0 | X9/X11=0/0 | X9/X14=0/0 | X10/X11=0/0 | X10/X14=0/0 | X11/X14=0/0
nodes=16 incomparablePairs=66
X12 tracked hot files=38
```

## 4. 关键路径与工期

工作日按8小时，每卡审查1小时计同一执行槽。假设C1已通过、C2–C6最迟后继开始前就绪；其剩余外部等待W另加，不冒称已经通过。
依赖链 X0 → 最长并行卡（如X5）→ X12 → X13 → X15。
纯依赖关键路径 = (1+1)+(3+1)+(4+1)+(2+1)+(2+1) = 17小时。
并行组10张长卡各4槽小时，X10/X11各2槽小时，共44；全图57槽小时。

- A档：仅本机Codex，最多6执行者，本机Claude不写代码。首波6张长卡4小时，次波4张长卡加同槽X10→X11共4小时。
  资源关键路径：X0(1+1) → 两波(4+4) → X12(4+1) → X13(2+1) → X15(2+1) = 21小时 = 2.625工作日，再加W。
  少于6槽或审查员不足更长，A档不保证两天。
- B档：本机最多6槽，peer A/peer B恢复后合计加5–10执行者，至少11槽。
  10张长卡占10槽，X10/X11在第11槽依次各2小时，同在4小时内结束。
  X0(1+1) → 并行组(3+1) → X12(4+1) → X13(2+1) → X15(2+1) = 17小时 = 2.125工作日，再加W。
  B档比≤2工作日目标多1小时+W：独立部署跨进程和业务ask生命周期接线补齐使X12从2增至4小时；不能删安全闸凑两天。
  部署/人工全文批准/owner动作另计等待，写完不等于上线；若要压至两天需实测节约至少1小时+W，否则报告超目标。

每卡实现最长4小时，无超半天卡。这是复用契约和既有模式的预算，非既成能力；超预算继续拆卡并重算，不削验收。
X12已含独立部署和ask全链路，超4小时须再拆串接子卡并重核热文件归属；unknown核清或真实三实例不可用要报告阻塞，不能拿夹具代替真实闭环。

## 5. C7–C9 去留

- C7由X0/X1/X2/X3/X7/X14及X12对应入口替代。
- C8由X4/X5/X6/X8/X9及X12对应入口、X13迁移、X15故障演练替代。
- C9由X10/X11及X12网页接入、X15三实例闭环替代。

PM用rewrite_dag撤换未开始C7–C9，加入X0–X15及§2依赖；完成节点原样继承。进行中原卡记录取消原因及处理在途订单，不能假定无副作用。
本卡不改DAG/台账。execution总开关绑定全部16节点验收证据，不只看X12合并。
X13切换演练只在隔离fixture；正式试迁必须等X15也通过、核owner授权，活跃feature仍可source。

## 6. 禁区及公开内容自检

不改src/lib/relay-protocol.ts、relay帧/版本、relay HTTP idleTimeout: 0、PROXY protocol和现有代理链。
不碰生产状态目录；规格只读；不读peer/身份配置、环境文件、实例私钥、模型登录文件，不连接生产bridge。
公开实例只叫本机/peer A/peer B；不写真实IP、域名、凭据、人名。
下列搜索仅本文件；无匹配返回1为预期，匹配须人工复核。检测正则本身不能当披露证据，需排除代码块再执行同一检查。

```sh
git grep --no-index -nEI \
  '([0-9]{1,3}\.){3}[0-9]{1,3}|https?://|([[:alnum:]-]+\.)+(com|net|org|io|cn)|Bearer[[:space:]]+[[:alnum:]_-]+|BEGIN.*PRIVATE KEY' \
  -- docs/design/shared-ledger-v2.md
```

人名检查采用本机只读核对后得到的禁止词列表，通过环境变量传入pattern，不将列表或生产资料写入公开文档。
git grep --no-index -nEI "$V2_PRIVATE_NAME_PATTERN" -- docs/design/shared-ledger-v2.md；随后人工通读核未覆盖的地址/姓名/凭据。

## 7. 验收及交付

验收1见§1逐条出处；验收2见§2全字段及每卡3–5条P1线；验收3见§3命令/实测；验收4见§4两档算式；验收5见§5/§6；验收6见本节。
只改本文；提交前bun run check、guard退出0、git grep及人工复核；普通push、PR base main，全量以PR CI为准，失败处理或如实报告。
PR正文只解释共享执行拆分和验证，不写生产台账节点标题；设计PR通过不代表execution已开放。
