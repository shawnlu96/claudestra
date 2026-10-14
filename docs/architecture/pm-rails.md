# PM 干预留痕（pm-rails，PMR P0）

设计稿：[docs/design/pm-intervention-rails.md](../design/pm-intervention-rails.md)。这里只写现在的实现、豁免怎么判，以及**哪些洞不修、为什么**。

## 做什么

- 自动卡（含当过 auto、后来切 manual 接管的卡）上，PM / master 经 `ledger` CLI 的写入，事件统一补 `manual:true` + `intervention{cmd,by,role,mode}`。
  标记点是 `src/lib/ledger-tx.ts` insertEvent；作用域由 `src/manager/pm-rails-cmds.ts` withPmRails 开（读命令、调度服务、owner 不开）。
- 开关：本机 recovery-policy 的 `projects.<id>.keys.pmRails`，off / observe（缺省，只标不推）/ on。
- 推送：bridge 每 5 分钟跑 `ledger pm-rails-tick`，经本机 owner 通知推送（同卡 10 分钟合并一条、意图停在 unknown 满 30 分钟推一次、每天汇总一次）。
  状态文件是 `pm-rails.json`（低水位 `after` + 各卡已推到哪条）。文件坏了报错时给出按当前最大事件号重建的内容；直接删会把历史干预重推一遍。

## start_node 的豁免

start_node 以 PM 身份跑 CLI。开 auto 之后它还要做几步（peer 卡的放置说明、跳过复述、绑节点），这些不算干预。
`startNodeStep` 用和执行同一份 CLI 解析结果判定，每一步都必须和 `src/lib/dag-tools-steps.ts` 实际发出的命令逐项一致：

- 出处：bridge 起 ledger 子进程时带环境变量 `CLAUDESTRA_START_NODE_ATTEMPT=<本次 attempt>`（`src/bridge/dag-tools.ts`，只给 ledger 子命令带），
  必须等于 dedup 里的 attempt。PM 在自己的 shell 里手敲或照抄同一条命令（例如 start_node 半途中断后补完剩下的步骤）没有它，照标。
- 都要求：dedup 键是 `dag-start:<卡>:<attempt>:<步>`，同一个 attempt 的建卡事件在库里。
- 放置说明 / 跳过复述：建卡事件里的 `extra.placement` 就是 peer，并且之后没改过；建卡后这张卡没有过 stage 事件。
  正文要符合 `startNodePeerWhy` 模板；复述那一步要引用这条放置说明，参数等于 `peerRestateSkip(正文).stage`。
- 绑节点：feature 是建卡时记的 `sharedFeatureId`，节点还没绑卡，节点的缺省卡号就是这张卡，`--rev` 等于当前版本，不能带多余旗标；卡不是 cancelled。

读写判定（`src/manager/write-commands.ts`）：`isLedgerWrite` 用解析后的 `--dry-run` 开关判断（ledger.ts realDeps、pm-rails 作用域都用它）。
manager 入口的认主守卫手里没有旗标表：只有在 `--dry-run` 前一个词不是光秃的 `--旗标` 时才按读算，拿不准一律当写，不会比解析结果更松。

## 不修的上限

PM 和 start_node 是同一个系统用户：一条写入算不算 start_node 的步骤，只能靠它子进程带的环境变量来认，而同一个用户能刻意设置这个变量。
所以豁免是**防手误的护栏，不是安全边界**，这和 [CLAUDE.md](../../CLAUDE.md)「Security posture」里对 guard rails 的定位一致。下面两类不修：

1. **伪造 start_node 的出处**：只有刻意设置出处环境变量（`CLAUDESTRA_START_NODE_ATTEMPT`），再配上那次 attempt 的 dedup 和逐项一致的参数，
   才能让一条写入被当成 start_node 的步骤。照抄命令文本、用同一个 dedup 重试都带不过去这个环境变量，所以都会照标。
2. **用旗标的值夹带开关**：例如把 `--dry-run` 塞进 `--out` 的值里。pm-rails 和 realDeps 已经改用解析结果；其他读原始 argv 的地方，后面再发现刻意构造的写法，也只记录不修。

## 定级口径（PM 与 Shawn 约定，2026-10-15）

- **P1**：正常操作就能写出不带标记的 PM 写入。正常操作包括：照文档用 CLI、照抄或重放旧命令、用同一个 dedup 重试、
  start_node 半途失败后 PM 手工补完剩下的步骤、`--a=b` 和 `--a b` 两种写法。
- **P2 或写进上限**：只有刻意构造才会触发的。
