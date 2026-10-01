/**
 * The peer tick's watch over its own in-flight cards (i28-A2 §6 §7). verifyHolds releases the auto tick's hold: after a verdict,
 * one fresh `gh pr view` must still show the card's head. cardsTick, once per poll: a closed / externally merged / re-based /
 * cross-repo PR goes back to PM; a fix card at maxRounds goes back to PM; a new head, once stable, is fetched and handed to
 * `ledger peer-pr-observe` (fix, or review after the verdict) — in merge it only tells PM and the author, the queue owns the rest.
 * A fix the merge queue bounced into (CI red / conflict, i28-M12) is told to the author once and never counts against maxRounds:
 * the bounce adds no round, so the last allowed round's pass followed by red CI must still re-review the new head.
 */
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, listEvents } from "./ledger-store.js";
import type { OpenPr } from "./peer-pr-github.js";
import { headChecked, markHeadChecked } from "./peer-pr-hold.js";
import { headStable } from "./peer-pr-intake.js";
import { hasRoundVerdict, inFlightPeerCards, peerPrOf, pushDedupKey, type PeerPrMeta } from "./peer-pr-ledger.js";
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

async function newHead(c: PeerPrCtx, card: LedgerTask, meta: PeerPrMeta, head: string, bounced: boolean): Promise<string> {
  if (card.stage === "merge") return mergeDrift(c, card, meta, head);
  if (card.stage === "review" && !hasRoundVerdict(c.db, card)) return "本轮结论还没出：先审完旧 head";
  if (card.stage !== "review" && card.stage !== "fix") return `卡在 ${card.stage}，不处理漂移`;
  if (!bounced && card.round >= c.cfg.maxRounds) {
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
  if (card.stage === "fix" && !bounced && card.round >= c.cfg.maxRounds) {
    await fallbackOnce(c, card.id, "rounds", `第 ${card.round} 轮审查后仍有 P1，复验轮次到顶（maxRounds ${c.cfg.maxRounds}）`);
    return "退回人工";
  }
  if (pr.head === card.headSHA) return "";
  if (bounce === "retry") return "合并退回的说明还没排上队：先不收新 head";
  if (!headStable(c.state, meta.number, pr.head, c.deps.now(), c.cfg.headSettleSec)) return "新 head 还没稳";
  return newHead(c, card, meta, pr.head, bounced);
}

/** Once per poll over this project's in-flight peer cards; one card's failure never stops the others. */
export async function cardsTick(c: PeerPrCtx, repo: string, open: OpenPr[]): Promise<string[]> {
  const out: string[] = [];
  for (const card of inFlightPeerCards(c.db, c.cfg.project)) {
    const meta = peerPrOf(card)!;
    try {
      const what = await checkCard(c, repo, card, meta, open.find((p) => p.number === meta.number));
      if (what) out.push(`${card.id} ${what}`);
    } catch (e) {
      logUnlessStopped(`看 ${card.id} 的 PR 出错（下一轮再看）`, e);
    }
  }
  return out;
}
