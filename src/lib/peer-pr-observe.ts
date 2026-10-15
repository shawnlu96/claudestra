/**
 * The peer tick's watch over its own in-flight cards (i28-A2 §6 §7). verifyHolds releases the auto tick's hold: after a verdict,
 * one fresh `gh pr view` must still show the card's head. cardsTick, once per poll: a closed / externally merged / re-based /
 * cross-repo PR goes back to PM; a fix card at maxRounds goes back to PM; a new head, once stable, is fetched and handed to
 * `ledger peer-pr-observe` (fix, or review after the verdict) — in merge it only tells PM and the author, the queue owns the rest.
 * A fix the merge queue bounced into (CI red / conflict, i28-M12) is told to the author once and never counts against maxRounds:
 * the bounce adds no round, so the last allowed round's pass followed by red CI must still re-review the new head.
 * PEERHEAD1 (peerPrHeadReview on): "at maxRounds" means consecutive rounds still holding a P1 (peer-pr-head-review.ts), so a pass
 * re-reviewed only for a new head costs nothing; and a manual peer card the author pushed to after a passing review is handed to
 * `ledger peer-pr-observe` too (its manual branch: the new head, or the card's own head once the re-review is in). Off: as it was.
 */
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, listEvents } from "./ledger-store.js";
import type { OpenPr } from "./peer-pr-github.js";
import { headChecked, markHeadChecked } from "./peer-pr-hold.js";
import { headStable } from "./peer-pr-intake.js";
import { hasRoundVerdict, inFlightPeerCards, manualPeerCards, peerPrOf, pushDedupKey, type PeerPrMeta } from "./peer-pr-ledger.js";
import { HEAD_REVIEW_KEY, headReviewMode, p1RoundsSpent, passingFacts, registrationOf } from "./peer-pr-head-review.js";
import { listRequests, revokeOf } from "./manual-merge-queue-facts.js";
import { currentReviewFacts } from "./scheduler-review.js";
import { renderBouncePush, renderDriftPush } from "./peer-pr-message.js";
import { fallbackOnce, logUnlessStopped, noticeOnce, record, type PeerPrCtx } from "./peer-pr-notice.js";
import { fixBounce } from "./scheduler-merge-conflict.js";

const VERIFY_RETRY_MS = 15_000;

/** Every pass: a review card whose verdict is in but not yet re-checked against GitHub gets one `gh pr view` (throttled). */
export async function verifyHolds(c: PeerPrCtx, repo: () => Promise<string>): Promise<void> {
  for (const card of inFlightPeerCards(c.db, c.cfg.project)) {
    const meta = peerPrOf(card);
    const verdict = card.stage === "review" && meta ? hasRoundVerdict(c.db, card) : null;
    if (!meta || !verdict || headChecked(c.db, card, verdict.seq)) continue;
    const last = c.state.verifyAt.get(card.id);
    if (last !== undefined && c.deps.now() - last < VERIFY_RETRY_MS) continue;
    c.state.verifyAt.set(card.id, c.deps.now());
    try {
      const v = await c.deps.github.view(await repo(), meta.number);
      if (v.state === "OPEN" && v.head === card.headSHA && v.base === "main" && !v.crossRepo) markHeadChecked(c.db, card.id, verdict.seq, v.head);
    } catch (e) {
      logUnlessStopped(`${card.id} 结论后的 PR head 现查失败（${VERIFY_RETRY_MS / 1000}s 后再查）`, e);
    }
  }
}

const sameOwner = (pr: OpenPr, repo: string): boolean => !pr.crossRepo && !!pr.headOwner && pr.headOwner.toLowerCase() === repo.split("/")[0]!.toLowerCase();

async function closedPr(c: PeerPrCtx, repo: string, card: LedgerTask, meta: PeerPrMeta): Promise<string> {
  const v = await c.deps.github.view(repo, meta.number);
  if (v.state === "OPEN") return "列表里没有但 PR 还开着，下一轮再看";
  if (v.state === "MERGED" && card.stage === "merge") return "PR 已合并，合并队列收尾";
  await fallbackOnce(c, card.id, v.state === "MERGED" ? "merged-outside" : "closed",
    v.state === "MERGED" ? `PR #${meta.number} 在合并队列外被合并了` : `PR #${meta.number} 已关闭`);
  return "退回人工";
}

async function mergeDrift(c: PeerPrCtx, card: LedgerTask, meta: PeerPrMeta, head: string): Promise<string> {
  const key = `drift:${head.slice(0, 12)}`;
  const text = renderDriftPush(meta.number, card.headSHA ?? "", head, c.cfg.replyTo);
  const q = await record(c, card.id, key, "queued", "合并途中 head 变了，排队告诉对方", { message: text });
  if (q.ok !== true) console.error(`⚠️ [peer-pr] ${card.id} 漂移通知没排上队：${String(q.error)}`);
  await noticeOnce(c, card.id, key, `[peer PR] ${card.id} 在合并途中 PR head 变了（${(card.headSHA ?? "").slice(0, 12)} → ${head.slice(0, 12)}）：` +
    "合并队列会因 head 不符停下，peer 卡不碰合并意图，请 PM 核对");
  return "合并途中漂移：已通知";
}

/**
 * The card sits in a fix the merge queue bounced it into: queue one push to the author for M12's merge_conflict event (keyed by
 * its seq, so a re-run never queues it twice). "none" for every other card, which keeps the P1 fix's maxRounds rule. "retry"
 * while the queue write fails: the caller must not take a new head then, since once the card leaves fix nothing looks here again
 * and the bounce would never reach the author. Only the bounce that made this very fix is pushed; an escalated one never moved it.
 */
async function bounceFix(c: PeerPrCtx, card: LedgerTask, meta: PeerPrMeta): Promise<"none" | "queued" | "retry"> {
  if (card.stage !== "fix") return "none";
  const events = listEvents(c.db, { project: card.project, target: card.id });
  if (!fixBounce(events, "fix")) return "none";
  const e = events.findLast((x) => x.kind === "scheduler" && x.data.op === "merge_conflict" && x.data.escalated !== true);
  if (!e) return "queued";
  const key = `bounce:${e.seq}`;
  if (getEventByDedup(c.db, pushDedupKey(card.id, key, "queued")!)) return "queued";
  const rows = (Array.isArray(e.data.checks) ? e.data.checks : []) as Record<string, unknown>[];
  const checks = rows.filter((x) => x && typeof x.name === "string").map((x) => ({ name: x.name as string, link: typeof x.link === "string" ? x.link : "" }));
  const text = renderBouncePush(meta.number, { cause: String(e.data.cause), prHead: String(e.data.prHead ?? card.headSHA ?? ""), checks }, c.cfg.replyTo);
  const q = await record(c, card.id, key, "queued", "合并队列退回 fix，排队告诉对方", { message: text });
  if (q.ok === true) return "queued";
  console.error(`⚠️ [peer-pr] ${card.id} 合并退回的说明没排上队（下一轮再试，排上前不收新 head）：${String(q.error)}`);
  return "retry";
}

/**
 * Whether the card has spent maxRounds. off: the round number, as before. on: consecutive unresolved P1 rounds of this spec.
 * observe: the round number still decides; where the new rule would let the card go on, one sample says so.
 */
async function roundsSpent(c: PeerPrCtx, card: LedgerTask): Promise<boolean> {
  const mode = headReviewMode(card.project), old = card.round >= c.cfg.maxRounds;
  if (mode === "off" || (mode === "observe" && !old)) return old;
  const spent = p1RoundsSpent(listEvents(c.db, { project: card.project, target: card.id }), card);
  if (mode === "on") return spent >= c.cfg.maxRounds;
  if (spent < c.cfg.maxRounds) {
    const r = await c.deps.manager("ledger", "scheduler-recovery-observe", card.id, "--mechanism", HEAD_REVIEW_KEY, "--action-key", `rounds:${card.round}:${(card.headSHA ?? "-").slice(0, 40)}`,
      "--action", `第 ${card.round} 轮不判到顶（连续未解决 P1 只有 ${spent} 轮 < maxRounds ${c.cfg.maxRounds}）`, "--data", JSON.stringify({ round: card.round, spent, head: card.headSHA }));
    if (r.ok !== true) console.error(`⚠️ [peer-pr] ${card.id} 到顶判定样本没记上：${String(r.error)}`);
  }
  return old;
}

async function newHead(c: PeerPrCtx, card: LedgerTask, meta: PeerPrMeta, head: string, bounced: boolean): Promise<string> {
  if (card.stage === "merge") return mergeDrift(c, card, meta, head);
  if (card.stage === "review" && !hasRoundVerdict(c.db, card)) return "本轮结论还没出：先审完旧 head";
  if (card.stage !== "review" && card.stage !== "fix") return `卡在 ${card.stage}，不处理漂移`;
  if (!bounced && await roundsSpent(c, card)) {
    await fallbackOnce(c, card.id, "rounds-drift", `第 ${card.round} 轮结论后 PR head 又变了，复验轮次已到顶（maxRounds ${c.cfg.maxRounds}）`);
    return "退回人工";
  }
  const fetched = await c.deps.github.fetchHead(meta.number, head);
  if (fetched) return `取新 head 没对上，下一轮再试：${fetched}`;
  const r = await c.deps.manager("ledger", "peer-pr-observe", card.id, "--head", head);
  return r.ok === true ? String(r.reason ?? "已记新 head") : `新 head 没写进台账：${String(r.error)}`;
}

async function checkCard(c: PeerPrCtx, repo: string, card: LedgerTask, meta: PeerPrMeta, pr: OpenPr | undefined): Promise<string> {
  if (!pr) return closedPr(c, repo, card, meta);
  if (pr.base !== "main") return (await fallbackOnce(c, card.id, "base", `PR #${meta.number} 的 base 改成了 ${pr.base.slice(0, 80)}`), "退回人工");
  if (!sameOwner(pr, repo)) return (await fallbackOnce(c, card.id, "cross", `PR #${meta.number} 改成了跨仓 / head 仓库 owner 不对`), "退回人工");
  const bounce = await bounceFix(c, card, meta);
  const bounced = bounce !== "none";
  if (card.stage === "fix" && !bounced && await roundsSpent(c, card)) {
    await fallbackOnce(c, card.id, "rounds", `第 ${card.round} 轮审查后仍有 P1，复验轮次到顶（maxRounds ${c.cfg.maxRounds}）`);
    return "退回人工";
  }
  if (pr.head === card.headSHA) return "";
  if (bounce === "retry") return "合并退回的说明还没排上队：先不收新 head";
  if (!headStable(c.state, meta.number, pr.head, c.deps.now(), c.cfg.headSettleSec)) return "新 head 还没稳";
  return newHead(c, card, meta, pr.head, bounced);
}

/** A held manual card is asked again for the same head at most this often (each ask fetches the PR head first). */
const MANUAL_RETRY_MS = 5 * 60_000;
const manualAsked = new WeakMap<PeerPrCtx["state"], Map<string, { head: string; at: number }>>();

/** PM hears once per card + round that consecutive re-reviews still had a P1 at maxRounds (the card stays manual, in fix). */
const topNotice = (c: PeerPrCtx, card: LedgerTask) => noticeOnce(c, card.id, `head-top:${card.specRev}:${card.round}`,
  `[peer PR] ${card.id} 作者新推后的复审连续 ${c.cfg.maxRounds} 轮仍有 P1，复验轮次到顶：卡留在人工，请 PM 接手`);

/** peerPrRequeue observe: PM hears once per new head what the scheduler would have queued, as a command PM can run as is. */
const requeueNotice = (c: PeerPrCtx, card: LedgerTask, w: Record<string, unknown>) => noticeOnce(c, card.id, `requeue:${String(w.head).slice(0, 12)}`,
  `[peer PR] ${card.id} 作者新推后的增量复审已通过，peerPrRequeue 在 observe，调度器没代排。要排就跑：ledger manual-merge-request ${card.id} ` +
  `--head ${String(w.head)} --spec-rev ${String(w.specRev)} --round ${String(w.round)} --review-seq ${String(w.reviewSeq)} --reason "peer PR 作者新推后增量复审通过"`);

/** This flow's round on the card's head has a verdict to act on (review), or passed and waits for its requeue (merge). */
function settleDue(c: PeerPrCtx, card: LedgerTask): boolean {
  const events = listEvents(c.db, { project: card.project, target: card.id });
  const reg = registrationOf(events, card.round, card.headSHA, "manual");
  if (!reg) return false;
  if (card.stage === "review") return currentReviewFacts(card, events).kind === "facts";
  return card.stage === "merge" && !listRequests(c.db, card.project, card.id).some((r) => r.seq > reg.seq && !revokeOf(c.db, r));
}

/**
 * A manual peer card: only the author-push flow looks at it, and only through the ledger's own checks (headWrite / headSettleWrite).
 * A head GitHub shows that differs from the card's is never settled on: the old head's verdict waits for the newer head.
 */
async function checkManual(c: PeerPrCtx, card: LedgerTask, meta: PeerPrMeta, pr: OpenPr | undefined): Promise<string> {
  if (!pr || pr.base !== "main" || pr.crossRepo) return "";
  if (pr.head === card.headSHA) {
    if (headReviewMode(card.project) !== "on" || !settleDue(c, card)) return "";
    const r = await c.deps.manager("ledger", "peer-pr-observe", card.id, "--head", card.headSHA!);
    if (r.ok !== true) return `复审结论没结上：${String(r.error)}`;
    if (r.top === true) await topNotice(c, card);
    if (r.wouldRequeue && typeof r.wouldRequeue === "object") await requeueNotice(c, card, r.wouldRequeue as Record<string, unknown>);
    return r.moved === true || r.requeued ? String(r.reason) : "";
  }
  if (!["review", "fix", "merge"].includes(card.stage) || !hasRoundVerdict(c.db, card)) return "";
  const events = listEvents(c.db, { project: card.project, target: card.id });
  const f = currentReviewFacts(card, events);
  if (!(f.kind === "facts" && passingFacts(f.facts)) && !registrationOf(events, card.round, card.headSHA, "manual")) return "";
  if (!headStable(c.state, meta.number, pr.head, c.deps.now(), c.cfg.headSettleSec)) return "新 head 还没稳";
  const asked = manualAsked.get(c.state) ?? new Map<string, { head: string; at: number }>();
  manualAsked.set(c.state, asked);
  const last = asked.get(card.id);
  if (last?.head === pr.head && c.deps.now() - last.at < MANUAL_RETRY_MS) return "";
  asked.set(card.id, { head: pr.head, at: c.deps.now() });
  const fetched = await c.deps.github.fetchHead(meta.number, pr.head);
  if (fetched) return `取新 head 没对上，下一轮再试：${fetched}`;
  const r = await c.deps.manager("ledger", "peer-pr-observe", card.id, "--head", pr.head);
  if (r.ok !== true) return `新 head 没写进台账：${String(r.error)}`;
  if (r.top === true) await topNotice(c, card);
  if (r.moved === true) asked.delete(card.id);
  return r.moved === true ? String(r.reason) : "";
}

/** Once per poll over this project's in-flight peer cards (and, PEERHEAD1, its manual ones); one card's failure never stops the others. */
export async function cardsTick(c: PeerPrCtx, repo: string, open: OpenPr[]): Promise<string[]> {
  const out: string[] = [];
  const manual = headReviewMode(c.cfg.project) === "off" ? [] : manualPeerCards(c.db, c.cfg.project);
  for (const card of [...inFlightPeerCards(c.db, c.cfg.project), ...manual]) {
    const meta = peerPrOf(card)!;
    try {
      const pr = open.find((p) => p.number === meta.number);
      const what = manual.includes(card) ? await checkManual(c, card, meta, pr) : await checkCard(c, repo, card, meta, pr);
      if (what) out.push(`${card.id} ${what}`);
    } catch (e) {
      logUnlessStopped(`看 ${card.id} 的 PR 出错（下一轮再看）`, e);
    }
  }
  return out;
}
