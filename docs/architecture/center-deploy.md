# 调度器部署与整机锁

`deployMachineLock` 控制普通部署任务复用 `pm-deploy.lock`，缺省 on；显式 off 保留原任务步骤与失败语义。任务先拿维护租约，再零等待取整机锁，直到部署退出才释放。锁占用时结果为 `deferred`；SIGTERM 到来且其他部署持锁或有有效等待者时也记 deferred。超过任务 deadline 的 SIGTERM 仍记失败，即使此时 PM 正在等锁，也不能重新提交超时部署。锁样本通过持租约的 CLI 写进台账，公开信息只有 label。

调度器确认旧任务已退出并卸下后，以原 intent、原 journal claim、原 label 重新提交。独立的 retry marker 在删除旧任务目录前落盘，重启后仍能识别尚未提交的延后重试。没有 deferred 证明的未知任务保持原 unknown 规则。连续等待满 60 分钟只写一条 `recordPmTodo`，不推送，不计失败。

PM 的仓库外 `deploy-full.sh` 须改成通过 `bun scripts/pm-deploy-lock.ts run --label deploy-full -- <原命令>` 进入锁，并移除向调度器发 SIGTERM 的步骤。此卡不改该脚本。

## 中心部署配置

状态目录下 `center-deploy.json`：

```json
{
  "projects": {
    "example": {
      "repo": "owner/private-repo",
      "script": "scripts/deploy.sh",
      "dryRunArgs": ["--dry-run"],
      "timeoutMinutes": 20
    }
  }
}
```

每项目一段，脚本必须是普通仓内文件和相对路径；拒绝绝对路径、空路径段、点路径段和反斜线。dry-run 参数为非空数组，正式执行时不带这些参数。超时为 1–60 分钟。私仓目录只经 `card-repo.ts` 的 `repoDirFor` 解析。缺少或错误配置不部署，记拉取式 PM 待办。

`centerDeployAuto` 缺省 observe：只记本会为哪个 SHA 开授权卡；off 不读配置、不读写部署状态；on 才开卡。它属于权限类高风险键；与 OBSGATE1 按后合并方登记分类的约定衔接。没有配置时有效档为 observe 的测试必须保持通过。

## 授权与执行

候选卡来自同私仓的 scheduler merged 记录，或 PM 手动合并后已过 merge 阶段的卡（含 done）。成功部署只消费开卡时捕获的合并身份；已有成功记录的历史卡不会因非卡提交再次触发部署，同卡重新合并仍会成为候选。等待授权、observe 和终态期间，版本查询每分钟至多一次；候选或配置变化会立即查询，批准后执行前始终重新核对。查询 fetch `origin/main`，读取提交中的脚本并计算 SHA-256。授权绑定项目、仓库、main SHA、脚本哈希和卡号；version 还绑定配置。同 SHA 的卡号使用开卡快照，后续阶段变化不会改变核对哈希。每项目一个 askKey，新 SHA 取代旧的未答卡；同 SHA 配置或脚本证明变化也会开一张新的授权卡，按绑定和前一张卡去重，恢复旧配置不能复用旧批准。

授权按钮为“批准部署”和“不批准”。执行前调用 `checkAsk`，核对 caller=scheduler、hash、有效期，并要求 owner 作答；重新读取版本与脚本证明。配置或证明变化时不执行，重新开卡；拒绝、过期和授权卡自身的哈希错误只记 PM 待办，同 SHA 不自动重开。新 SHA 重新走授权。

通过授权后，复用一次性 launchd job 的 request/result 机制，`kind=center` 将任务交给独立 worker。调度器在提交前持久保存 attempt；重启后只观察，不能把缺失结果当成从未执行。worker 再核配置、授权和登记目录，在独立 detached worktree 中检出指定提交，先执行最长 5 分钟的 dry-run；通过后零等待取整机锁，再 fetch 并核对 SHA、脚本与授权，正式执行。占锁延后可在授权有效期内提交下一次 attempt；失败或超时不重试。SIGTERM 先终止当前步骤，经 finally 清理 worktree 并释放锁，再退出；不会进入后续步骤。延后尝试仍重新跑有界 dry-run，以核对当前环境。

脚本 stdout/stderr 直接流入本机日志目录的 0600 文件，完整保存；不进入结果、台账或通知。台账按阶段只选取 SHA、退出码、耗时和是否 dry-run。成功写 `center_deploy` 并更新上次成功 SHA；失败写 PM 待办，并尝试发送一次 action 通知，正文只有卡号、短 SHA 和退出码。

错误按配置、状态、版本核对、job、授权和提交阶段记录脱敏待办，同阶段每小时去重；日志只写阶段。待办写失败会记录脱敏诊断，普通部署仍继续；租约失效仍立即停止。

## 写入边界

调度器 pass 的数据库为只读。`scheduler-center-deploy <task> --op …` 是窄写口，只接受卡号与操作枚举，内部重读配置、候选卡、结果与授权；只有调度身份和有效租约可以调用。命令与模块登记在既有 v2 skip 表，候选、提交和执行前继续检查所有包含卡的 skip 状态。

本项目部署步骤集合、unknown 人工结清和合并冻结规则保持现有行为。测试覆盖临时锁、真实 SIGTERM、假 launchd/git、合成台账、授权去重、拒绝和过期、脚本输出隔离。
