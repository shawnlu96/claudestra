/**
 * A PM's explicit redelivery of one refused review push (PRRETRY). The request is one queued note on the card, keyed
 * redeliver:<review seq>:<refused seq>, that the normal push pass picks up: same render, mask, gate, size cap and bridge recheck.
 * It never writes to the review or the refused row; it binds them (and the report's hash, the card's head / spec / round, the
 * peer triple) and the pass re-derives every fact before sending. One claim ever, so one frame ever; a refusal stays a refusal
 * and nothing re-queues itself.
 *
 * "Still the original report" is proven only against the report file's own sha256 on the original push's refused row (originOf),
 * never against the file's timestamps and never against a claim's digest of the rendered text: that text is masked, so bytes the
 * mask covers could change under it. A refusal recorded before that field existed has no such evidence and is not redelivered.
 * A review whose head is no longer the card's head is refused at the request, at the render, inside the claim's own transaction
 * (claimRedelivery) and once more right before the frame; from the claim until its result no writer can change the card's
 * head (peer-pr-ledger.ts HEAD_PIN: the ledger aborts the update; the head observe holds before trying), so the head cannot
 * move while the frame is with the bridge or on its way to the peer.
 * tests/peer-pr-retry*.test.ts drive it through the real render and the real bridge recheck.
 */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { roleOf, type LedgerEvent, type LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getMeta, LedgerError, listEvents } from "./ledger-store.js";
import { isRealPmRole } from "./ledger-team-config.js";
import { appendEvent } from "./ledger-write.js";
import type { PeerPrConfig } from "./peer-pr-config.js";
import { P1_STEP } from "./peer-pr-message.js";
import { peerPrOf, peerPrWrite, pushDedupKey, recordPeerPrNote, REDELIVER_PREFIX, SHA_RE } from "./peer-pr-ledger.js";

export interface ReportDigest { sha256: string; bytes: number }
/** The report file's own digest as the original push recorded it on its refused row, and that row's seq. */
type Origin = ReportDigest & { seq: number };

export interface Redelivery {
  /** seq of the original review event and of the refused push row this request answers */
  review: number;
  refused: number;
  /** sha256 over the review event's own facts (head, session, family, verdict, counts, round, report path) */
  reviewDigest: string;
  /** the report file when the request was made; it equals the origin */
  report: ReportDigest;
  origin: Origin;
  task: { id: string; head: string | null; specRev: number; round: number };
  peer: { peer: string; fp: string; agent: string };
}

/** The report through the push path's own reader (only under ledger/reviews). */
export type ReportReader = (path: string) => { text: string } | { error: string };

/** Stages after the merge: the redelivery tells the author there is nothing left to do. */
const MERGED = new Set(["live", "verified", "done"]);
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const reportDigest = (text: string): ReportDigest => ({ sha256: sha256(text), bytes: Buffer.byteLength(text) });
const deny = (code: "invalid" | "conflict" | "forbidden", msg: string): never => { throw new LedgerError(code, `补发申请：${msg}`); };

const redeliverKey = (review: number, refused: number): string => `${REDELIVER_PREFIX}${review}:${refused}`;
const isRow = (e: LedgerEvent): boolean => e.kind === "note" && e.data.op === "peer_pr_push" && typeof e.data.key === "string";
/** Every push key that carried this review's report: the original one and each redelivery of it. */
const inFamily = (key: string, review: number): boolean => key === `review:${review}` || key.startsWith(`${REDELIVER_PREFIX}${review}:`);

export const isRedelivery = (e: LedgerEvent): boolean => isRow(e) && e.data.result === "queued" && String(e.data.key).startsWith(REDELIVER_PREFIX);

function isRealPm(db: Database, task: LedgerTask, actor: string): boolean {
  const meta = getMeta(db, task.project);
  return isRealPmRole(roleOf(actor, task, meta.pms), actor, meta.team);
}

interface Facts { task: LedgerTask; review: LedgerEvent; rows: LedgerEvent[]; lastSeq: number; base: Omit<Redelivery, "report"> }

/** The original push's own evidence of the report bytes, read from the refused row of the original key only. */
function originOf(rows: readonly LedgerEvent[], review: number): Origin {
  const own = rows.filter((e) => e.data.key === `review:${review}`);
  const refused = own.find((e) => e.data.result === "refused");
  if (!refused) return deny("invalid", `审查 ${review} 的原推送没有拒收记录`);
  const r = refused.data.report as Partial<ReportDigest> | undefined;
  if (r && typeof r.sha256 === "string" && /^[0-9a-f]{64}$/.test(r.sha256) && Number.isInteger(r.bytes)) {
    return { sha256: r.sha256, bytes: r.bytes as number, seq: refused.seq };
  }
  return deny("conflict", "原拒收记录没有留下原报告的摘要（认领时记的是脱敏后正文的摘要，证明不了原报告的字节没变），不补发");
}

/** Everything the request binds, re-read from the ledger and peer-prs.json; throws on anything that is not what was named. */
function factsOf(db: Database, cfg: PeerPrConfig, taskId: string, reviewSeq: number, refusedSeq: number): Facts {
  const task = mustTask(db, taskId);
  const meta = peerPrOf(task);
  if (!meta || task.project !== cfg.project) return deny("invalid", `${task.id} 不是本项目的 peer PR 卡`);
  if (!cfg.peers.some((p) => p.peer === meta.peer && p.fp === meta.fp && p.agent === meta.agent)) {
    return deny("forbidden", "这张卡的 peer / 指纹 / agent 已不在 peer-prs.json 里");
  }
  const events = listEvents(db, { project: task.project, target: task.id });
  const review = events.find((e) => e.seq === reviewSeq && e.kind === "review");
  if (!review) return deny("invalid", `事件 ${reviewSeq} 不是 ${task.id} 的审查事件`);
  const rows = events.filter((e) => isRow(e) && inFamily(String(e.data.key), reviewSeq));
  if (!rows.some((e) => e.seq === refusedSeq && e.data.result === "refused")) {
    return deny("invalid", `事件 ${refusedSeq} 不是审查 ${reviewSeq} 那份报告的拒收记录`);
  }
  const d = review.data;
  if (typeof d.head !== "string" || !SHA_RE.test(d.head)) return deny("invalid", `审查 ${reviewSeq} 没有记录完整的 head，核不了 head 漂移`);
  if (task.headSHA !== d.head) return deny("conflict", `卡的 head 已经不是审查 ${reviewSeq} 审的那个（head 漂移），原报告不再补发`);
  const reviewDigest = sha256(JSON.stringify([review.seq, review.ts, review.actor, d.round, d.verdict, d.p0, d.p1, d.p2, d.head ?? null,
    d.reviewer ?? null, d.reviewerSessionId ?? null, d.reviewerFamily ?? null, d.path ?? null]));
  return { task, review, rows, lastSeq: events.at(-1)!.seq, base: { review: reviewSeq, refused: refusedSeq, reviewDigest, origin: originOf(rows, reviewSeq),
    task: { id: task.id, head: task.headSHA, specRev: task.specRev, round: task.round }, peer: { peer: meta.peer, fp: meta.fp, agent: meta.agent } } };
}

/** A typed bridge refusal sends zero bytes (peer-pr-push.ts classify writes this prefix); every other failure may have arrived. */
const knownUnsent = (e: LedgerEvent): boolean => String(e.data.reason ?? "").startsWith("bridge 拒发（");

/** Why this report may not be requested again, or null: it arrived, an attempt has no certain outcome, or a request is open. */
function blocked(rows: readonly LedgerEvent[]): string | null {
  if (rows.some((e) => e.data.result === "sent")) return "这份报告已经送达（sent），不需要补发";
  const open = new Set<string>(), pending = new Set<string>();
  for (const e of rows) {
    const key = String(e.data.key), result = e.data.result;
    if (result === "queued") pending.add(key);
    else if (result === "claimed") open.add(key);
    else if (result === "refused") { open.delete(key); pending.delete(key); }
    else if (result === "abandoned" || (result === "failed" && !knownUnsent(e))) return `${key} 有一次发送结果不明，先用原通道向对方核实是否收到`;
    else if (result === "failed") open.delete(key);
  }
  if (open.size) return `${[...open][0]} 认领后没有回执，结果不明，先用原通道向对方核实是否收到`;
  return pending.size ? `${[...pending][0]} 这次补发还在途` : null;
}

/**
 * The request (one immediate transaction; everything is re-checked inside it). The report is read between two snapshots of the
 * card: any event or change on the card in between is a conflict. Replaying the same request answers duplicate and writes nothing.
 */
export function requestRedelivery(db: Database, ctx: WriteCtx, input: { taskId: string; review: number; refused: number }, cfg: PeerPrConfig,
  read: ReportReader): { event: LedgerEvent; key: string; duplicate: boolean } {
  const key = redeliverKey(input.review, input.refused);
  const snapshot = () => {
    const f = factsOf(db, cfg, input.taskId, input.review, input.refused);
    if (!isRealPm(db, f.task, ctx.actor)) deny("forbidden", `只有项目 ${f.task.project} 的 PM（调度助理除外）/ master / owner 能提（你是 ${ctx.actor}）`);
    const dup = getEventByDedup(db, pushDedupKey(f.task.id, key, "queued")!);
    const stop = dup ? null : blocked(f.rows);
    if (stop) deny("conflict", stop);
    return { f, dup };
  };
  const before = snapshot();
  if (before.dup) return { event: before.dup, key, duplicate: true };
  const rep = read(String(before.f.review.data.path ?? ""));
  if ("error" in rep) return deny("invalid", `原报告读不了：${rep.error}`);
  const report = reportDigest(rep.text), origin = before.f.base.origin;
  if (origin.sha256 !== report.sha256 || origin.bytes !== report.bytes) {
    return deny("conflict", "报告正文与原拒收时台账记下的摘要不一致，不是原报告");
  }
  const binding: Redelivery = { ...before.f.base, report };
  return peerPrWrite(db, () => {
    const now = snapshot();
    if (now.dup) return { event: now.dup, key, duplicate: true };
    if (now.f.lastSeq !== before.f.lastSeq || now.f.task.rev !== before.f.task.rev || JSON.stringify(now.f.base) !== JSON.stringify(before.f.base)) {
      return deny("conflict", "卡在核对报告期间变了，重新申请");
    }
    const r = appendEvent(db, { actor: ctx.actor, now: ctx.now, dedupKey: pushDedupKey(now.f.task.id, key, "queued")! }, {
      project: now.f.task.project, target: now.f.task.id, kind: "note",
      text: `PM 申请补发审查 ${input.review} 的报告（投递补发，不是新结论；原拒收记录 ${input.refused}）`,
      data: { op: "peer_pr_push", key, result: "queued", redeliver: binding } });
    return { event: r.event, key, duplicate: r.duplicate };
  });
}

function bindingOf(e: LedgerEvent): Redelivery | null {
  const b = e.data.redeliver as Redelivery | undefined;
  const str = (v: unknown) => typeof v === "string" && v.length > 0;
  const ok = !!b && typeof b === "object" && Number.isInteger(b.review) && Number.isInteger(b.refused) && str(b.reviewDigest)
    && str(b.report?.sha256) && str(b.origin?.sha256) && str(b.task?.id) && str(b.peer?.fp) && e.data.key === redeliverKey(b.review, b.refused);
  return ok ? b! : null;
}

/**
 * The send-time half: the queued request against the ledger as it is now (the card is re-read, never taken from the caller).
 * Anything that moved since the request (head, spec, round, the peer triple, the requester's PM role, the review row, the
 * original evidence) refuses; so does a report that already arrived. Called at render, inside the claim, and before the frame.
 */
export function verifyRedelivery(db: Database, cfg: PeerPrConfig, taskId: string, source: LedgerEvent):
  { review: LedgerEvent; task: LedgerTask; binding: Redelivery } | { refuse: string } {
  const binding = bindingOf(source);
  if (!binding || binding.task.id !== taskId || source.target !== taskId) return { refuse: "补发申请的绑定不完整" };
  let f: Facts;
  try { f = factsOf(db, cfg, taskId, binding.review, binding.refused); } catch (e) {
    if (!(e instanceof LedgerError)) throw e;
    return { refuse: e.message };
  }
  if (!isRealPm(db, f.task, source.actor)) return { refuse: "补发申请人已不是本项目的 PM / master / owner" };
  const { report: _r, ...bound } = binding;
  if (JSON.stringify(bound) !== JSON.stringify(f.base)) return { refuse: "申请之后 head / 规格 / 轮次 / 收件方、原审查记录或原推送的摘要变了" };
  if (f.rows.some((e) => e.data.result === "sent")) return { refuse: "这份报告已经送达，不再补发" };
  return { review: f.review, task: f.task, binding };
}

/**
 * The one claim of a redelivery (the push pass's `claimed` record for a redeliver: key): the request is re-checked against the
 * ledger and the claim row is written in one immediate transaction, so nothing can move between the check and the claim.
 * A request that no longer holds is a conflict (the pass records the refusal); a second claim answers duplicate and sends nothing.
 */
export function claimRedelivery(db: Database, ctx: WriteCtx, cfg: PeerPrConfig, input: {
  project: string; target: string; key: string; text: string; data?: Record<string, unknown>;
}): { event: LedgerEvent; duplicate: boolean } {
  return peerPrWrite(db, () => {
    const request = input.target ? getEventByDedup(db, pushDedupKey(input.target, input.key, "queued")!) : null;
    if (!request || !isRedelivery(request) || request.data.key !== input.key) throw new LedgerError("invalid", `没有 ${input.key} 这条补发申请`);
    const claimed = getEventByDedup(db, pushDedupKey(input.target, input.key, "claimed")!);
    if (claimed) return { event: claimed, duplicate: true };
    if (getEventByDedup(db, pushDedupKey(input.target, input.key, "refused")!)) throw new LedgerError("conflict", "这次补发已经有了结果，不再认领");
    const v = verifyRedelivery(db, cfg, input.target, request);
    if ("refuse" in v) throw new LedgerError("conflict", v.refuse);
    return recordPeerPrNote(db, ctx, { ...input, result: "claimed" }, true);
  });
}

export const sameReport = (binding: Redelivery, text: string): boolean =>
  binding.report.sha256 === sha256(text) && binding.report.bytes === Buffer.byteLength(text);

/**
 * The redelivered text: the normal review push (same title, head, report number, reply line, report) with its "next step" line
 * replaced by what this message is. null = the normal push no longer has that line where this expects it; nothing is sent then.
 */
/** Prefix of the line a P1 redelivery keeps in place of the dropped next step: whether the owner's rounds were used up then. */
export const CAP_MARK = "复验轮次（原审查当时）：";
function capLine(next: string): string[] {
  const step = next.slice("下一步：".length);
  return step === P1_STEP.cap ? [`${CAP_MARK}已到上限`] : step === P1_STEP.fix ? [`${CAP_MARK}未到上限`] : [];
}

/**
 * The next step is replaced by 现状 (the author must not act on the old one); a P1 keeps the cap line so the receiver's strict
 * parse (remote-review-parse.ts) books it as the original. `legacy` renders the format before the cap line, which that parser
 * still accepts from a peer not upgraded yet; nothing sends it.
 */
export function renderRedeliveryPush(reviewPush: string, round: number, task: Pick<LedgerTask, "stage">, legacy = false): string | null {
  const [title, head, id, next, ...rest] = reviewPush.split("\n");
  if (!title || !id?.startsWith("报告编号：") || !next?.startsWith("下一步：")) return null;
  const state = MERGED.has(task.stage) ? "该 PR 已合并，这条不需要你做任何动作。" : "这条不要求你动作；下一步以调度器之后的消息为准。";
  return [title, `投递补发：这是第 ${round} 轮原审查报告的补发（原投递当时没有送达），不是新的审查结论；结论、head 与报告都是原审查当时的。`,
    head, id, `现状：${state}`, ...(legacy ? [] : capLine(next)), ...rest].join("\n");
}
