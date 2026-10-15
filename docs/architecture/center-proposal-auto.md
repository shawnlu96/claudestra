# 中心待批提案自动批准（PROPAUTO1）

owner 10-16 原话：普通的直接批，只有涉及安全的才让我批。判定全在代码里，PM 不参与，也不持 owner 凭据。

## 链路

`pollCenterProposals` → `pull`（owner:self person 凭据拉中心列表）→ `gatedReconcile`：

1. 开关不是 off：先补记上一轮结果不明的自动批准（中心已不是 `pending_approval` → 写结果事件 `settled`）。
2. `canApprove` 照旧：成员表读失败不开不撤，不是 owner 撤卡。
3. 核过之后、建卡之前：`autoRoute` 对每条待批提案跑 `classifyProposal`（`src/lib/center-proposal-auto.ts`，纯函数）。
   - observe：判 auto 的记一条 `recordObserved` 样本（按 proposalId + rev 去重），卡照旧开，内容和旧路径逐字相同。
   - on，判 owner：照旧建卡，正文多一行「需要你批的原因：…」。
   - on，判 auto，且这一版本没有人工卡（任何状态）：`autoApprove`，不建卡。
4. `reconcile` 照旧撤旧卡、开缺的卡，跳过 `autoApprove` 已处理的那些。

off（或 deps 里没有 `auto`）：以上都不发生，逐字回到旧路径。

## 分类规则

任一命中就判 owner，reason codes 固定：

| code | 含义 |
| --- | --- |
| `nodes_empty` / `glob_empty` | 没有节点 / 有节点 fileGlobs 为空 |
| `glob_invalid` / `glob_outside_roots` | 格式不对（绝对路径、`..`）/ 不在 src/ tests/ docs/ web/ 下（含 `*`、`**`、根目录文件） |
| `glob_security_surface` | peer-pr-surface 的敏感目录、固定文件、文件名规则、文件名关键词（复用其导出的常量） |
| `glob_permission_gate` | scopeWireProtected：权限闸文件、`-gate` / `-auth` / `auth-` 名字规则 |
| `glob_data_schema` | ledger-store / ledger-schema / migrate / migration、`*.sql`、shared-ledger-contract*、recovery-key-class / defaults、scripts/guard/ |
| `glob_wide` | 通配 glob 的静态前缀是某个保护路径的祖先，且能匹配到它（`src/**`、`src/lib/**`、`src/bridge/**`…） |
| `text_sensitive_word` | 标题、说明、ownerWords、节点 oneLine 命中固定词表（只补判 owner） |

glob 判法：名字规则对 glob 原文判；通配 glob 用 `Bun.Glob` 对每个具体保护文件试匹配，对保护目录逐段比（剩余段有 `**` 一律算能到）。
修订提案对新的全量节点判，被移除的节点不判。提案人不限。

## 只 decide 一次

执行占位存在台账 kind=note 事件里（项目级，target ""），dedup 键 `center-proposal-exec:<中心项目>:<proposalId>:<rev>:<完整摘要>`，
UNIQUE 键 + 立即事务保证同一键只有一方写进去（`src/lib/center-proposal-auto-exec.ts`）。

- 自动路径：先抢占位，抢到才 `d.decide(decisionBody(params, "approve"))`，凭据 / 请求体 / rev / 摘要和人工路径相同。重发占 `#a2` / `#a3`。
- 人工答复（开关 on）：发 decide 前抢同一个占位；已被自动占了、且自动没有交还 → 不再发，回一条「该版本已在执行」。自动交还后占 `#owner`。
- 同一版本已有人工卡（open / answered / 已撤都算）：交回人工路径，自动不碰。

## 结果

结果事件 `center_proposal_auto_approve_result`（`#result` 键，只写一次），data 带完整身份键、reason codes、中心状态 / 错误码，不带凭据。

| 情况 | 处理 |
| --- | --- |
| 成功 | `approved`，不建卡、不推送 |
| 409 | `conflict`；下一轮按新快照重新分类 |
| 网络错误 / 超时 | 占位留着；下一轮中心已不是待批 → 补记 `settled`；仍待批且占位满 10 分钟才再发；同一 rev 最多 3 次，第 3 次仍不明 → `handover`，出 owner 卡「自动批准没有确认结果」 |
| 中心明确拒绝（非 409） | `handover`，出 owner 卡带错误码，不再自动发 |

自动批准不发 owner 推送、不发 PM 通知，只写台账事件。

## 开关

恢复键 `centerProposalAutoApprove`，在 recovery-key-class.ts 登记为 permission，未配置时是 observe。
上线后 PM 按 owner 授权单键设 on：`bun src/manager.ts ledger scheduler-recovery <项目> on --key centerProposalAutoApprove --reason "…"`。

测试：`tests/center-proposal-auto.test.ts`。
