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
import { getMeta, listEvents } from "./ledger-store.js";
import { poolReviewRefusal } from "./pool-review-proof.js";
import { hashFile, reviewMaterialCheck } from "./review-material-check.js";
import { exemptVerdict, refusalEpoch } from "./scheduler-review-swap.js";
import { specPathFor } from "./task-spec.js";

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
    const drift = sent ? reviewMaterialCheck(db)(at, sent, local.materialDigest) : "缺原审查单";
    if (drift) return `${why}：拒审材料已不是原派单快照（${drift}）`;
  }
  // 池单豁免另要自动门同一张池审查回执（票据 / 领单 / 派单链）：不是池单结论时它答 null
  const pool = poolReviewRefusal(db, at, { authorFamily: author }, f);
  if (pool) return `${why}：${pool}`;
  const drift = poolSpecDrift(db, at, f);
  return drift ? `${why}：${drift}` : null;
}

/**
 * 池单没有 MODELX 材料快照：两张池审查单（被拒那张 = epoch.orderId，豁免那张 = 结论入账的单）挂单事务里那条规范 offer note 记下的
 * specSha256（ledger-lend.ts offerLendCore，input.spec 的 UTF-8 原文 sha256，未经脱敏 / 切段）就是原材料摘要。两张单各只认一条、
 * 由挂单者写、早于 epoch / 本单 pool_offer 的那条；摘要须是完整 sha256，且都等于此刻规格文件原始字节的 sha256（hashFile，不解码）。
 * 旧单没有摘要、读不到、来源不合或任何不等一律拒。不是池单豁免结论（本机或跨族）= null。
 */
function poolSpecDrift(db: Database, task: LedgerTask, f: ReviewFacts): string | null {
  const events = listEvents(db, { project: task.project, target: task.id });
  const orderId = (events.find((e) => e.seq === f.eventSeq)?.data.lend as { orderId?: unknown } | undefined)?.orderId;
  const epoch = events.findLast((x) => x.actor === "scheduler" && x.kind === "note" && x.data.op === "pool_refusal_epoch" && x.data.step === "review");
  if (typeof orderId !== "string" || !epoch || epoch.data.head !== f.head || epoch.data.specRev !== task.specRev || epoch.data.round !== f.round) return null;
  const now = hashFile(specPathFor(task, getMeta(db, task.project).docsDir));
  if ("error" in now) return `池审查单规格文件此刻读不到（${now.error}），无法证明材料不变`;
  const pooled = events.find((x) => x.kind === "scheduler" && x.data.op === "pool_offer" && x.data.orderId === orderId);
  for (const [what, id, before] of [["被拒池审查单", String(epoch.data.orderId), epoch.seq], ["豁免池审查单", orderId, pooled?.seq ?? 0]] as const) {
    const o = db.query("SELECT taskId, project, peer, step, specRev, round, head, createdBy FROM lend_orders WHERE orderId = ?").get(id) as
      { taskId: string; project: string; peer: string; step: string; specRev: number; round: number; head: string; createdBy: string } | null;
    if (!o || o.taskId !== task.id || o.project !== task.project || o.step !== "review" || o.specRev !== task.specRev || o.round !== f.round ||
      o.head !== f.head) return `${what} ${id} 不是本卡本窗口的池审查单`;
    const offers = events.filter((x) => x.kind === "note" && (x.data.lend as { orderId?: unknown; op?: unknown } | undefined)?.orderId === id &&
      (x.data.lend as { op?: unknown }).op === "offer");
    const lend = offers[0]?.data.lend as { peer?: unknown; step?: unknown; specSha256?: unknown } | undefined;
    if (offers.length !== 1 || !lend || offers[0].actor !== o.createdBy || lend.peer !== o.peer || lend.step !== "review" || offers[0].seq >= before) {
      return `${what} ${id} 没有唯一的规范挂单记录`;
    }
    if (typeof lend.specSha256 !== "string" || !/^[0-9a-f]{64}$/.test(lend.specSha256)) return `${what} ${id} 挂单时没记规格原文摘要，无法证明材料不变`;
    if (lend.specSha256 !== now.sha256) return `${what} ${id} 挂单时的规格与此刻规格文件不一致（池审查单规格不一致）`;
  }
  return null;
}
