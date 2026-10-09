/**
 * dispatch-recovery-MANEX1 · 人工合并队列对“审查员与作者同家族”的唯一例外，与自动合并门同一谓词：scheduler-review-swap.ts
 * exemptVerdict（本机 MODELX 正式拒审 epoch → 按它绑定的会话本人结论 → owner 当前未撤销 / 未挂起的原批准；含 MODELXP2 池单
 * poolExemptVerdict：池单 epoch → 按它挂出、带豁免原文的单 → 该单会话的结论），池单另核自动门同一张池审查回执 poolReviewRefusal。
 * 这里不另造放行判据：不看 cyber_policy 事件、不解析拒审原文、不认名字带 -ex 或任意新会话。作者家族未知仍拒；豁免成立也只免“家族相同”这一项，不记成跨模型，其余身份 / 来源 / 结论门照旧。
 * 窗口取结论写给的 head（facts.head）：只有 currentReviewFacts 已按规范 carry 记录认下的纯 main 沿用才会与卡当前 head 不同，
 * epoch 仍按原 head / specRev / 轮次核；没有 carry 的新 head 读不出这条结论，换 round 时 epoch 窗口也不再成立。
 * tests/manual-merge-review-exemption*.test.ts。
 */
import type { Database } from "bun:sqlite";
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import type { ReviewFacts } from "./scheduler-review.js";
import { getIntent } from "./ledger-scheduler.js";
import { listEvents } from "./ledger-store.js";
import { poolReviewRefusal } from "./pool-review-proof.js";
import { exemptVerdict, refusalEpoch } from "./scheduler-review-swap.js";

/**
 * scheduler-model-wiring.ts reviewMaterialCheck，调用时才取：静态 import 会成环（wiring → scheduler-maintenance → … → scheduler-merge → 本模块），
 * 环里 wiring 的 cfgReaderPath 宏读不到（同 scheduler-auto-tick.ts 对它用动态 import；这里的门是同步的，故用 require）。
 */
const materialCheck = (): typeof import("./scheduler-model-wiring.js").reviewMaterialCheck =>
  (require("./scheduler-model-wiring.js") as typeof import("./scheduler-model-wiring.js")).reviewMaterialCheck;

/** 为什么这条结论按家族不能进人工合并；null = 跨模型，或同族但正式豁免成立 */
export function manualFamilyRefusal(db: Database, task: LedgerTask, f: ReviewFacts, author: AuthorFamily | null): string | null {
  if (author && f.reviewerFamily !== author) return null;
  const why = `审查人家族 ${f.reviewerFamily} 与作者家族 ${author ?? "未知"} 不是跨模型`;
  if (!author) return why;
  const at = { ...task, headSHA: f.head };
  if (!exemptVerdict(db, at, f)) return `${why}，且没有本轮正式拒审 epoch 下 owner 当前有效的豁免`;
  // 原批准的挂起与 approvalLapse 同一口径（池单那条已在 poolExemptLapse 里核过）；本机 epoch 要带 MODEL 记下的原材料摘要
  if (task.extra.refusalHold === true) return `${why}：owner 已按卡挂起拒审豁免（extra.refusalHold）`;
  // 摘要之外再按 MODELX 既有材料核验（reviewMaterialCheck）：原派单冻结快照在、摘要就是它，派单正文与每个材料文件此刻仍与快照一致
  const epoch = refusalEpoch(listEvents(db, { project: task.project, target: task.id }), at);
  const local = epoch?.data.refusal as { materialDigest?: unknown } | undefined;
  if (epoch && local) {
    if (typeof local.materialDigest !== "string" || !local.materialDigest) return `${why}：拒审 epoch 缺原材料摘要`;
    const sent = getIntent(db, String(epoch.data.intentId));
    const drift = sent ? materialCheck()(db)(at, sent, local.materialDigest) : "缺原审查单";
    if (drift) return `${why}：拒审材料已不是原派单快照（${drift}）`;
  }
  // 池单豁免另要自动门同一张池审查回执（票据 / 领单 / 派单链）：不是池单结论时它答 null
  const pool = poolReviewRefusal(db, at, { authorFamily: author }, f);
  return pool ? `${why}：${pool}` : null;
}
