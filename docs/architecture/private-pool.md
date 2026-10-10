# 私仓卡进统一池（i28-SECPOOL2）

项目 claude-orchestrator 有两个仓库：公共仓 `shawnlu96/claudestra`（scheduler.json 的 repoDir / remote.repo）和私仓 `floka-ai/cloud`
（clone 目录登记在 projects.json 本项目的 dirs 里）。私仓节点的 fileGlobs 写成 `repo:<owner>/<name>/<仓库内路径>`。
本卡让私仓节点能像公共仓节点一样自动开卡、出单，开卡和出单都用卡自己的仓库。拉代码（SECPOOL3）、合并与部署分流（SECPOOL4）不在本卡。

## 开关

`ledger private-pool [on|observe|off] [--project <id>]`，缺省 off。不带取值只读打印当前值；切换权限同 security-pool：项目 PM、master、owner。
命令收到非法取值直接报错。

存储在 `statePath("private-pool.json")` = `{ rev, projects: { <id>: "on" | "observe" | "off" } }`，不进 scheduler.json。
读写用 security-pool 的版本号 CAS：**选的是「抽出通用读写函数给两者共用」**——`src/lib/security-pool.ts` 导出 `readProjectMode` /
`setProjectMode`（label 区分文件和警告前缀），security-pool 与 private-pool 都调它，没有第三份拷贝。
文件缺失、损坏、取值非法都按 off；非法取值按（项目, 值）、损坏按（项目, 坏文件, 错误）各只打一次带项目名的警告。

| 取值 | 自动开卡 | 其它 |
|---|---|---|
| off | 私仓节点 `stop("private", "私仓节点由 PM 用私仓开卡流程手动开")`，和改动前逐字一样 | start_node 不解析私仓目录 |
| observe | 同 off，原因后面多一句「；按私仓进池会用 <仓库>（<目录>）开卡」（或「；按私仓进池会停：<原因>」） | 同 off |
| on | 解析仓库 → 在项目 dirs 里找 clone → preflightStart 用这个目录；找不到 / 混了仓库就 stop 并写原因 | 卡上写 extra.repo |

## 仓库解析（src/lib/card-repo.ts）

- `repoOfGlobs(globs)`：全部带同一个 `repo:<owner>/<name>/` 前缀 → owner/name；全部不带 → null（公共仓）。混了两个仓库、
  带前缀与不带前缀混用、前缀写法不对 → 抛错，错误文字就是 stop 原因。
- `repoDirFor(project, ownerName)`：按 projects.json 的 dirs 顺序，取第一个是 git 目录、`git remote get-url origin` 指向
  ownerName（不分大小写）的目录。只读本地 git 配置，不联网；找不到 null，原因写「项目 dirs 里没有 <仓库> 的 clone」。
- `cardRepo(task, remote)`：PR 链接的仓库 ?? 私仓卡的 extra.repo（没写就按前缀）?? remote.repo。
  **公共仓卡（fileGlobs 没有前缀）不看 extra.repo**：peer 放置写的 extra.repo 取自目录 origin，大小写可能和 remote.repo 不同，
  只对私仓卡生效才能保证公共仓卡的订单 repo 与改动前逐字一致。
- `stripRepoPrefix(globs, ownerName)` / `cardGlobs(task)`：去掉本卡仓库的前缀，得到仓库内路径；公共仓卡原样。

## 各处接线

- 开卡门：`scheduler-autostart.ts` nodeCandidate 的 private 门按开关分流（上表）。缺规格提醒（scheduler-spec-wait.ts）on 时的附注改成自动开卡。
- start_node / 自动开卡的预检：`dag-tools-start.ts` 在 args.repo 没给时按节点 fileGlobs 解析出私仓目录，再交给 pickRepo；
  args.repo 给了以它为准。放置（本机 / peer）拿到的都是私仓目录，peer 放置的仓库因此也是私仓。
- extra.repo：start_node（dag-tools-steps.ts）放本机时写 plan.privateRepo，放 peer 时照旧写 peer.repo；自动开卡的 step task-new
  （ledger-autostart-step.ts）放本机时按节点前缀写。
- spec 阶段放置（scheduler-spec-resume-deps.ts）：开关 on 的私仓卡按卡的仓库找目录，找不到给 refused 原因，不落到公共仓。
- 订单 repo：scheduler-pool-facts.ts、ledger-scheduler-pool.ts、ledger-scheduler-cmds.ts、scheduler-agent-pool-reserve.ts 按 cardRepo；
  scheduler-agent-pool-start.ts、scheduler-slot-hold-autostart.ts 是建卡前的容量估算，没有卡，可传节点仓库；不传 = remote.repo，
  选定 peer 后的 claim 重核仍用放置给的 peer.repo。
- 开卡容量门（scheduler-autostart.ts featureGate）按仓库估：公共仓照旧估一次；开关 on 时再给本 feature 每个待开私仓节点的仓库各估一次，
  任一仓库有空位就过 feature 门，nodeCandidate / ledgerGate 再按节点自己的仓库核。peer 只授权私仓时，公共仓没空位不再否决私仓节点；
  公共仓节点仍按公共仓的空位停。off / observe 只估公共仓，和改动前一样。
- 出单：order-wire-file-scope.ts 发 `cardGlobs(task)`，出借方在私仓 clone 里看到的是仓库内路径。
- 交付范围：order-deliver-scope.ts 用去前缀后的路径比对；「共改」只在同一个仓库的卡之间算。
- 本机放置：scheduler-local-author-plan.ts 对私仓卡按 cardRepo 找 clone，不再落到 policy.repoDir 的公共仓；公共仓卡不变。

## 不变的规则

授权链（lend-policy / claimProblem / grant 规则 / 放置拒绝）按订单 repo 核对，本卡不改；外发闸不放宽（出单的 fileGlobs 去前缀后照样过
peerTextRefusal）；security-pool 开关、跨模型、额度闸不变。

## 上线后

1. `ledger private-pool observe`，挑一个私仓计划节点看 stop 原因是否指向私仓目录。
2. SECPOOL3、SECPOOL4 上线、peer 重新授权加上 floka-ai/cloud 之后再 `ledger private-pool on`。
3. 第一张走池的私仓卡交付后，核对 PR 开在 floka-ai/cloud、交付范围没有误报。

tests/card-repo.test.ts、tests/private-pool.test.ts。
