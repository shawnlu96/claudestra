# E2b：现有入口与开关盘点

> 状态：**现状盘点；不冻结协议、不授权实现或生产切换**。
> B=仓库方，A=执行方。本文为监工后续协议冻结提供事实；六块实现建议均未冻结。
> 源码基线：`08881b1fabf812fd7fcacbe497012e1b33de7d5c`。本卡只提交本文，不修改源码或测试。

## 1. 证据口径与范围

只读本仓库代码、测试及公共设计文档，不读取生产配置、私有台账、凭据、额度或机器信息。
表中的默认值来自解析器/代码常量，不代表本机或对端的实际配置；**生产实际值全部未知**。
「已实现」表示实现及调用链存在，不表示当前已启用；「未接线」表示模块存在但没有生产入口调用；
「设计」表示文档意向尚不能作为可用入口。分类针对每条能力，不能用同模块的已实现部分替其他部分背书。
源码调用关系比历史注释优先；未运行相关加载函数，也未生成真实实例签名或审批。

复用依据：[scheduler-engine](./scheduler-engine.md)、[协作模型](../team/collab-model.md)、
[逐步委托](../team/peer-delegation.md)、[出借](./remote-capacity.md)、[共享台账](./shared-ledger.md)、
[V2](./shared-ledger-v2.md)、[MHO1](../architecture/merge-handoff.md)。
[PR773](https://github.com/shawnlu96/claudestra/pull/773) 仅为 A 侧讨论输入，不代表两端已对齐。
历史文档 A/B 字母方向不一致，本文始终按上述角色解释，不按字母继承权限。

## 2. 入口、调用方与当前闸

### 2.1 本机 v3、出借与逐步委托

| 能力/状态 | 真实入口与调用关系 | 当前授权/角色/失败门 |
|---|---|---|
| 本机服务：已实现 | `src/scheduler.ts` 的 `runScheduler` → `scheduler-pass.ts` 的 `schedulerPass` | 单实例锁、维护租约、停止信号；配置错误本轮停手 |
| E2a/v3：已实现 | `schedulerPass` → `schedulerAutoTick` (`scheduler-auto-tick.ts`) → ledger调度写入口 | 卡阶段/意图CAS、会话/head/spec绑定；unknown先对账 |
| 本机派单：已实现 | `autoTickDeps` → `worker-session.ts` 的 `selectWorkerRoute` → ACP/channel/tmux适配器 | peer transport退manual；未知审查家族不猜 |
| 本机领单：已实现 | `src/bridge/order-tools.ts` → `order-take.ts` 的 `currentOrders` | 仅build/fix、本人agent/session；出借写单本机order为空 |
| 本机交付：已实现 | bridge工具 → `order-deliver.ts` 的 `deliverOrder` → ledger writer | origin完整head、唯一open PR/base main、CAS、orderId+head去重 |
| 借步骤：已实现 | auto tick `drivePool` → `scheduler-pool-tick.ts` → ledger-lend/pool → lend-dispatch | 主场仍推进卡；只借write/fix/review订单，受borrow范围/槽限制 |
| 出借循环：已实现 | `runScheduler` → `lendWanted`/`lendStep` → `lendTickWithRetention` → `lendTick` | lend总闸独立；先停失效授权订单，再做hello/beat/推进/poll |
| 出借收单：已实现 | v2 offer/旧poll → `lend-inbox.ts` 的 `admitOrders` → `lend-drive.ts` 的 `claimOrder` | 收单共用闸；liveGrant、family位、repo、额度、租约代数 |
| 出借写交付：已实现 | lend-deps派完整单 → manager `lend submit` → lend-submit/lend-push → result | 出借方自己的git/gh；借写单take_order/deliver明确拒绝 |
| 出借停止：已实现 | `lend-loop.ts` 的 `revoke`、lend-watchdog/lend-reclaim*/lend-proc-reap | 按订单/worker收尾和保全；不是整卡stop-confirm协议 |
| peer台账：已实现 | local-api/index → `handlePeerLedgerApi` → manager `ledger peer-write` → `peer-ledger.ts` | 认证peer对应步骤；不可见卡404，出借管理步骤隐藏/拒错入口 |
| 逐卡接受：已实现 | manager `peer-ledger accept` → `checkAcceptAsk` → POST accept → `markPeerTaskAccepted` | action=peer_accept，params={peer,task}；问本机owner，按调用者核bind |
| 常设授权：设计 | collab-model 的 `peer_accept_standing`、params={peer,project}意向 | src没有对应grant入口；旧接受标记不提供完整范围/并发/撤销 |
| 整卡入口：设计 | scheduler-engine 五卡意向、PR773讨论稿 | src没有E2b接单/激活/整卡唯一委托/独立stop_confirm入口 |

以上模块未带目录前缀的均在 `src/lib/`；manager入口在 `src/manager/`，bridge入口已注明。
`peer-ledger.ts` 依步骤执行者 `<agent>@peer` 判权，旧卡可由 extra.delegate/reviewer 推导步骤。
`peer-accepted.ts` 仅按 peer/task 保存接受时间；不能证明一张 B 卡已独占转交给 A 调度器。
peer写入的模型是claims；不是 B 对 A 内部作者/审查员的直接认证。

### 2.2 审查领单、票据与拒审处理

| 能力/状态 | 真实模块/符号及调用关系 | 当前边界/失败关闭 |
|---|---|---|
| 本机领审：已实现 | bridge/order-tools → reviewHandlers → `review-order.ts` 的 `takeReview` | 本步骤审查员、绑定session与当前head；不是任意卡查询 |
| 本机交结论：已实现 | reviewHandlers → `review-verdict.ts` 的 `submitVerdict` | 只记本轮结构化结论，不推阶段；报告/head/计数匹配 |
| 自动审查身份闸：已实现 | review writer → `scheduler-auto-review.ts` 的 `autoReviewWriter` | reviewer/session/runtime、派审head、干净checkout；不隔离同OS用户 |
| 出借领审：已实现 | bridge/lend-tools → `lend-tools.ts` 的 `takeReview` | 已验证worker/order/leaseGen/session，领单事实入journal |
| 出借票据：已实现 | lend-tools交结论 → `pool-review-proof-ticket.ts`；入账经`pool-review-proof-admit.ts` | 签名绑定订单、head/specRev/round、worker/session、logical payload摘要 |
| 池审查合并来源：已实现 | `scheduler-merge.ts` 的 `mergeReviewProof` → `poolReviewRefusal` | 意图→订单→claim→签名回执→票据→原收到请求；缺任何一环不算自动来源 |
| MODELW记录/计划：已实现 | auto-tick失败分支 → `scheduler-model-wiring.ts` 的 `modelOutcomeStep` → `recordModelOutcome` | 动态CFG策略；observe仅记，加载错误off，普通redispatch仍只计划 |
| MODELX拒审接续：已实现 | modelOutcomeStep → `beginRefusalEpoch` → reviewer_swap/ensure_session → 新领审 | 有有效批准且mode on；材料冻结/重核；新审查epoch，不改材料规避策略 |
| 通用换机器重派：未接线 | MODELW输出redispatch计划明确「无现成正式路径」 | 不能把计划文字当订单已重派或远程整卡执行 |

票据要求受托实例的固定公钥通过入账验签，主场再查归档原件与已签入账回执。
CLI lend submit、旧端无票据、no_order、裸 peer verdict 仍走人工，不补造自动证明。
池审查仍要求与实际head作者跨家族，**没有MODELX同家族豁免记录**；不可混用本机拒审例外。
`scheduler-model-wiring.ts` 在正式review派出前冻结规范订单和规格/旧报告/fix材料摘要；缺失/变更拒接续。
当前MODELX对provider policy拒审直接转另一家族，不做同模型再试；可能正好是作者家族，
因此显式记「跨模型审查豁免」、approvalId、crossModel=false，不能宣传为完成了跨族独立审查。
新审仍拒、批准撤销、材料/head/specRev变化、runtime不可用等保持人工/停手，不自改范围或策略。

### 2.3 合并、main carry、人工队列与 mergeHandoff

| 能力/状态 | 真实模块/符号及调用关系 | 当前边界/失败关闭 |
|---|---|---|
| 合并驱动：已实现 | schedulerPass → `scheduler-service.ts` 的 `mergeTick` → merge-driver/external | 本机审查/head/CI/UI/slot/journal；unknown冻结并留资源 |
| 合并列车：已实现 | schedulerPass → `trainProjects`/`mergeTrainPass` | train形成/结束与合并槽；不属于整卡授权 |
| 人工请求：已实现 | manager `ledger manual-merge-request/revoke` → `manual-merge-queue.ts` 的 `recordRequest/revokeRequest` | PM(非调度助理)/master/owner显式请求；绑定head/specRev/round/reviewSeq/UI摘要 |
| 人工占槽：已实现 | schedulerPass → `manualMergeGate` → `claimManualMerge` | manualMergeQueue=on才事务claim；只scheduler身份；不打断活列车 |
| 人工队列执行：已实现 | claim写submitted intent+merge槽+beginMergeRun → 既有mergeTick | 审查/CI继续核；不把人工来源变成自动审查证明 |
| main单跳沿用：已实现 | `scheduler-merge-external.ts` 的 `mergeExternal` → `singleMainCarryProof` | 完整净diff等价及main来源证明，记review_carry；不是任意新head免审 |
| 通用多跳proof：未接线 | `review-main-carry-proof.ts` 的 `reviewMainCarryProof` 实现/测试存在 | 最多16跳、不可变proof；当前src无生产调用，授权/事务接线不能假定已落地 |
| MHO1交回：已实现 | auto-tick Card.step → `driveHandoff` → `recordMergeHandoff`/`recordHandoffCarry` | 交接证据和跟随PR；mergeHandoff项目不本机merge/deploy/train/reclaim |
| MHO1纯main沿用：已实现 | `scheduler-merge-handoff-tick.ts` → `scheduler-main-merge-carry.ts` 的 `mainMergeCarry` | 双父、main来源、auto-merge或net-diff；非纯main改动退人工 |
| peer PR收审：已实现 | schedulerPass(autoDispatch) → `peerPrStep` → peerPrTick/intakeTick/cardsTick/pushPending | 按配置peer和PR创建收审流程，未提供E2b已有B卡的整卡映射 |
| 本地部署：已实现 | schedulerPass → `deployTick` → deploymentJobs → scheduler --deploy-job → `runDeployJob` | 显式deploy target、独立job/验证；handoff=true+deploy配置非法 |

manualMergeQueue是恢复策略**执行人工明确请求的排队器**，缺省observe不是自动接管所有manual卡。
pass中的claim不依赖autoDispatch=true：先等旧列车/让路槽结清，再占槽；on时阻新列车以避免饿死，
下一张人工claim前也让等候自动卡轮一趟。关策略后未发送效果要再核，已发merge未知不能假撤回。
MQ1不是MODELX，main carry也不是拒审豁免：各自事实、批准、head与写入闸不能相互替代。

当前不存在名为`mainCarry`的RECOVERY_KEYS条目；单跳main净diff证明已经接在本地mergeExternal，
`reviewMainCarryProof` 多跳函数本身不制造PASS或授权，源码注释把其授权事务/开关留给MAINP2。
MHO1另有专用carry算法：owner合并后main已包含PR，不能拿普通本地算法直接冒交回证明。
两端证据/算法是否互认仍待冻结，A单端PASS不能替B当前审查或CI闸。

### 2.4 中心 V2 与本机身份/证据原语

| 能力/状态 | 真实模块/符号及调用关系 | 当前边界 |
|---|---|---|
| V1共享规划/投影：已实现 | bridge/local-api/shared-ledger → shared-ledger-client/gate/mirror模块 | feature source/planning与投影，不触发执行 |
| V2契约：已实现（模块） | `shared-ledger-contract-v2*.ts` DTO/事务接口 | 模块存在不表示execution入口已启用 |
| X7执行闸/client：未接线 | `SharedLedgerExecGate`、`SharedLedgerExecClient` | 注入认证identity/context，在线许可；src无生产client实例化 |
| X8scheduler适配：未接线 | `executeSchedulerCentral` 被 `runSchedulerCentralDeployJob` 内部调用 | src部署入口仍runDeployJob，X8job入口只有测试调用 |
| X9lend适配：未接线 | `LedgerLendCentralClient` 的 receipt/view/command、LendCentralOutbox | src只有类定义，无生产实例化；不是整卡accept |
| V2整卡home迁移：设计 | shared-ledger/V2的owner、home/executor、epoch/租约设计 | 不能把执行地worker权限推成home权或跨机管理权 |
| 请求签名/pin：已实现 | API认证 → bridge/peer-signature → peer-keys/peer-trust/instance-signature | 认证实例而非body角色；老peer兼容路径仍存在 |
| ask精确批准：已实现 | bridge asks认证答复 → ask-bind的bindHash/checkAsk | action/version/agent/params及本人答复，不等于standing持久授权 |
| review-export：已实现 | manager ledger `review-export` → buildBundle/collectSource/writeBundle/verifyBundle | 本地v1证据导出+自检，不发送、不导入，不提供E2b签名清单 |

`shared-ledger-exec-gate.ts` 注明身份由认证本机传输和owner登记提供，禁止body自报role/actor。
源码 `keyFingerprint()` 是公钥SHA-256**前16位hex四位分组**；公钥本身为规范Ed25519编码并钉住比较。
不可把现有展示fp声称为完整64位SHA身份。完整指纹线契约/兼容方案由监工另冻。
当前请求签名覆盖method/path/time/body哈希；purpose白名单无E2b用途，peer ReplayCache为进程内缓存。
不能据此宣称已有E2b跨重启持久nonce、整卡回执或同名换实例的常设授权状态机。
review-export v1与MHO1证据有本地报告路径；跨端证据副本与签名导入不能靠本地路径当远程链接。

## 3. 代码默认与实际值

每行实际值都是未知；本文没有执行配置读取、identity/key或quota查询。

| 项目/参数 | 代码默认/范围（on/observe/off口径） | 接点与相关闸 | 实际值 |
|---|---|---|---|
| scheduler配置缺失 | enabled=false、autoDispatch=false、projects={}、pollMs=5000 | readSchedulerConfig，缺失空转 | 未知 |
| scheduler.enabled | 对象内必填boolean，无省略默认 | runScheduler/pass；true须至少一项目 | 未知 |
| autoDispatch | 缺省false(off) | 仅true做peerPR/autostart/autoTick；不控制merge/收尾 | 未知 |
| 卡workflow mode | manual/observe/auto按卡授权配置，不由模块存在决定 | E2a写闸；observe卡只观察，不交出推进权 | 未知 |
| maxActiveWorkers | 无agents时必填0…32，有agents时按agentLimitSum | 本机槽/放置；不表示peer整卡名额 | 未知 |
| requiredChecks | 必填1…20个CI检查名，无默认 | merge/head/CI闸；不合法拒整配置 | 未知 |
| remote缺省 | balance、roles=[review]、poolTimeoutMin=15 | parseRemote；agents/localRuntime等可能收窄或调整 | 未知 |
| mergeHandoff | 缺省或false=原本机合并；true才交回 | 解析拒true+deploy；merge/train/reclaim排除 | 未知 |
| deploy | 省略无deploy target(off) | deployTick；与autoDispatch独立 | 未知 |
| supervise | 缺省enabled=true、stuckMin=20 | pass还须监督依赖；不能当新增远端算力授权 | 未知 |
| recoveryPolicy | 缺省observe，manualAfterMs=null | recovery-policy逐机制fresh read；损坏off | 未知 |
| manualMergeQueue | recovery keys优先→project mode→observe | manualMergeGate/claim/driver各核；observe不占槽 | 未知 |
| MODELW/MODELX | modelOutcome缺省observe；错误off | 记录与执行分离；拒审接续须有效本机批准+on | 未知 |
| mainCarry | 无同名恢复key；单跳proof已接，多跳授权入口未接 | mergeExternal单跳；MHO1用独立算法 | 未知 |
| lend文件缺失 | version=2、enabled=false、lend=[]、borrow=[] | 总开关只管lend；borrow条目独立 | 未知 |
| lend收尾 | live/unsettled或欠grant:null hello时lendWanted仍true | 关开关后不丢订单停止/回执 | 未知 |
| 出借write总闸 | WRITE_ROLE_OPEN=true代码常量 | 仍须liveGrant/repo/family/额度；不是机器授权已开 | 未知 |
| 出借roles | lend归一[review,write]，旧grant roles输入忽略 | family位统一；borrow roles仍独立，缺省review | 未知 |
| lend grant CLI名额 | 未给family时默认codex=5；每家0…16；默认每天200单 | buildGrant；repos/期限仍必须核授权 | 未知 |
| borrow maxOpen | CLI缺省3，合法1…20，roles缺省review | buildBorrowEntry；项目必须明确且非个人项目 | 未知 |
| 出借期限/模板 | GRANT_MAX_DAYS=7；有效步骤由roleOfStep核 | 缺fp/时间、paused、过期或scope不符停；security有原闸 | 未知 |
| lend v1/v2 | 未配v2 port则v1；协商v2后有hello/beat | poll 30秒，v2真实推送后5分钟兜底 | 未知 |
| peer-prs | 缺失/enabled=false=off | 还须scheduler enabled+autoDispatch、项目/peer配置 | 未知 |
| peer-prs限额 | pollSec=60、headSettleSec=90、maxOpen=2、maxRounds=2 | parsePeerPrConfig；fixTimeoutH=24 | 未知 |
| 老peer截止 | LEGACY_PEER_DEADLINE常量，允许环境覆盖 | 无期望pin才走兼容；不把默认日期当实际放行 | 未知 |
| shared mode缺失 | source、sharedPlanning=false | readSharedLedgerMode；损坏security state抛错 | 未知 |
| V2 execution | 不是单个模块开关；mode/feature/fence/identity均匹配 | client未生产接线，不称已可执行 | 未知 |
| E2b on/observe/off | 当前无E2b配置解析或生产入口 | 只有设计意向，不能混用workflow/recovery observe | 未知 |

`scheduler-pool-plan.ts` 的 `poolTarget` 明确拒security模板远端池审查；角色不含review、
缺repo、已有绑定reviewer或无跨家族名额也不选peer。该闸不是常设授权或整卡security放行策略。
template/security门来自当前调度模板及主场合并审查要求，不因peer接受/出借权限而放宽。
现有并发有本机agent/worker、项目资源、borrow maxOpen、family slots等不同粒度，不能统称整卡并发。
源码默认on的write常量不说明对端已授予repo/family/期限或机器算力；源码支持某字段也不说明生产填过它。

## 4. 权威、旧分支与兼容约束

主场推进卡、执行地干活是现有出借/V2的边界。借出一张步骤订单不改变主场，中心也不把executor变home。
E2b意向交出去的是整卡从复述到交回的推进权；本快照没有这条双端独占转换。
现有 **A开卡→本机v3→MHO1交B** 是反向交接，不能证明B原卡已暂停，也不能自动映射B原卡/规格/epoch。
现有 B peer-PR收审仍走既有完整审查流程，MHO1记录或review-export自检不是互认放行。

| 在途材料/状态 | 当前兼容边界 | 冻结前仍须回答的问题 |
|---|---|---|
| 旧分支/source与head | 原卡/订单/规格/审查证据不能换身份复用；head漂移走既有审查或carry证明 | B原卡如何关联A新卡，source摘要和许可如何绑定 |
| WIP/未推commit/报告 | 出借有保留与收尾模块；不能把“取消”当丢弃成果许可 | 整卡停止清单、副本/敏感本地保全及关闭证据 |
| unknown外部效果 | 现有journal/意图保留与对账，不因超时换key盲重试 | 双端收回前worker/订单/效果未知如何核清 |
| 旧回执/无票据结论 | 池审查要求真实完整链；旧/CLI来源人工，不回填自动证明 | E2b独立seq/幂等/旧epoch回执与控制确认兼容 |
| 老peer/同名换实例 | 公钥pin和短fp兼容并存；不得把peer昵称当授权主体 | 完整实例线身份与旧授权迁移需重新批准的范围 |
| V2 feature投影/源图 | source/planning/execution区分，mirror不触发执行 | 点对点整卡与中心唯一权威的共存/拒接/迁移 |
| manual/observe/auto在途卡 | 既有意图/会话/审查/人工批准有各自闸 | 整卡委托能否纳入、何时暂停及如何避免两端重派 |

现有所有同OS用户worker本质可运行shell，服务闸不构成硬安全隔离。
停止证明不能仅凭GitHub无新提交或agent UI空闲；但整卡停止判据如何实现仍待冻结，本文不发明新批准路径。
旧分支/源材料/WIP完整保全，不删/reset；旧草稿不作为本清单已验收的协议决定或互认规则。

## 5. 给监工的缺口与冲突表

| 事实缺口/冲突 | 现有接点 | 冻结/验收建议（未冻结） |
|---|---|---|
| B唯一推进与A接受之间没有整卡协议 | auto tick、peer-ledger、lend、manualMergeQueue、DAG写口 | 双端唯一委托、卡/规格/实例身份、全写入口闸；并发同卡双委托失败路径 |
| 租约过期≠旧端停止 | scheduler维护租约、lend订单租约/journal | 旧端/worker/订单/unknown/WIP核清；离线不假确认，不能只画成功路径 |
| 业务停止容易误堵停止确认 | peer请求鉴权、旧订单result/receipt | 运行/效果与stop确认控制消息独立闸，旧epoch控制不复活业务 |
| 常设意向≠真实授权 | peer_accept/checkAsk、bridge asks、lend-ask-auth | 本人批准、完整实例、scope/template/步骤、并发/期限/撤销、机器算力分开 |
| 声明审查≠B直接校验A | pool票据/原件、review-export、MHO1证据 | 如实标实例声明；互认范围与保留完整审查由监工/两端另定 |
| main carry两算法不同 | singleMainCarryProof、MHO1 mainMergeCarry | 钉head/base/参数/事实来源，对不上退现有审查，不能扩成任意head沿用 |
| 本机拒审例外不能移作peer池证明 | MODELX审批epoch、poolReviewRefusal跨族要求 | 具体批准/材料/来源保留，不把crossModel=false写成跨族PASS |
| 中心模块与生产入口分离 | X7/X8/X9模块，现有V1代理与本机scheduler | 明确谁裁权威；不把模块存在、mirror或worker权限当execution/整卡入口 |

## 6. 六块实现建议：候选范围，全部未冻结

以下不是fileGlobs批准单，也不授权开实现卡；热点的修改者、依赖、契约、验收须监工P2再定。
新模块前缀仅示意，既有热点宜薄调用，遵守lib依赖方向、事务/原子写原语及防腐闸。

| 六块 | 现有热点/接点 | 候选fileGlobs（未冻结） | 验收建议（未冻结） |
|---|---|---|---|
| 协议 | instance-signature、peer-signature/trust、order-wire、ledger事务 | `src/lib/e2b-contract*.ts`、`src/lib/e2b-auth*.ts`、`tests/e2b-contract*.test.ts` | 双端严格schema/完整实例、ID/epoch、乱序/重放/过期/控制闸 |
| A接单推进 | scheduler-config/auto-tick、worker-session、order-take/deliver、sessions | `src/lib/e2b-intake*.ts`、`src/lib/e2b-runtime*.ts`、`tests/e2b-intake*.test.ts` | 五卡三槽、独立作者/reviewer、缺授权排队、停止/重启/WIP |
| B派单观察 | ledger writer、scheduler-plan/pass、peer/lend/DAG、manualMergeQueue | `src/lib/ledger-e2b*.ts`、`src/lib/e2b-dispatch*.ts`、`tests/e2b-authority*.test.ts` | 同B卡唯一未闭委托、所有入口停推、离线不返权、禁止双写 |
| 回写 | bridge/local-api、peer-ledger、lend-receipts、journal、state-file | `src/bridge/e2b-*.ts`、`src/lib/e2b-outbox*.ts`、`tests/e2b-writeback*.test.ts` | seq/幂等/丢ack、unknown对账、控制确认可达、旧回执仅历史 |
| 证据互认 | review-evidence/export、pool-review-proof、MHO1、peer-pr-intake、carry | `src/lib/e2b-evidence*.ts`、`src/lib/e2b-handoff*.ts`、`tests/e2b-evidence*.test.ts` | B卡关联、head/spec/CI/来源、WIP；互认另批 |
| 常设授权 | bridge asks、ask-bind、peerAccept/lend授权、principals | `src/lib/e2b-authorization*.ts`、`tests/e2b-authorization*.test.ts` | 真批准live绑定、项目/仓库/模板/步骤、并发race、撤销/到期、算力独立 |

具体协议接口、期限/并发计数、收回规则、互认面、V2迁移方案均未冻结，不从本表推导API可用。
实施开工仍需仓库owner对冻结包单独批准；设计批准不意味着启用生产开关或新增机器服务/模型额度。
监工牵头冻结协议与最终验收、两端PM核对；本清单作者不替监工作协议决定。

## 7. 本文可复核的验证

- 源码符号与调用链静态检索；默认值核对解析器，不执行生产配置读函数。
- `src`中E2b/standing/delegationId/stop_confirm检索无正式入口；公共稿中的候选不计源码实现。
- X8仅内部适配调用、X7/X9仅类定义；tests有测试调用，src运行入口未实例化/驱动它们。
- main多跳proof只有模块/测试调用；单跳proof与MHO1专用carry已有各自生产调用，未混成mainCarry开关。
- 文档路径/符号/长度/隐私核对，仓库规定check/guard与入口构建；检查结果在交付证据记录。
- 只提交本文，旧协议WIP不入PR；新完整head自身CI与另一家族审查结论才算本清单验收证据。

静态盘点不证明任何机器已开启某能力，也不声称双实例沙箱、真实停止确认或审查互认已验收。
