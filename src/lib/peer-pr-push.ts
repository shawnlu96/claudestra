/**
 * Pushes to the peer PR author (i28-A2 §5): every review on a peer card (key review:<seq>), every merged phase of its merge run
 * (merged:<intentId>) and queued notes the tick wrote (drift). Per attempt: render → mask → gate → size → claim on the ledger →
 * one bridge frame → record. Only a 2xx from the peer is "sent"; sent / refused / abandoned are terminal per key, a failure is
 * retried 30 s → 10 min until 24 h after the first claim. PM hears once at 15 min, once on giving up, once per refusal.
 */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { listEvents, listTasks } from "./ledger-store.js";
import { peerPrOf, SHA_RE, type PeerPrMeta } from "./peer-pr-ledger.js";
import { GATE_REJECTED, PUSH_MAX_BYTES, renderMergedPush, renderReviewPush } from "./peer-pr-message.js";
import { logUnlessStopped, noticeOnce, oneLine, record, type BridgeSendResult, type PeerPrCtx } from "./peer-pr-notice.js";
import { hexCandidates, peerPrSecretHit, redactPeerPr } from "./peer-pr-redact.js";

export const PUSH_BACKOFF_MS = 30_000, PUSH_BACKOFF_CAP_MS = 600_000, LATE_MS = 15 * 60_000, GIVE_UP_MS = 24 * 3600_000;

export interface PushItem { task: LedgerTask; meta: PeerPrMeta; key: string; source: LedgerEvent }
interface History { terminal: boolean; firstClaim: number | null; failures: number; lastFail: { at: number; reason: string } | null }

const isPush = (e: LedgerEvent, key: string): boolean => e.kind === "note" && e.data.op === "peer_pr_push" && e.data.key === key;

export function pushHistory(events: readonly LedgerEvent[], key: string): History {
  const rows = events.filter((e) => isPush(e, key));
  const fails = rows.filter((e) => e.data.result === "failed");
  const last = fails.at(-1);
  return {
    terminal: rows.some((e) => ["sent", "refused", "abandoned"].includes(String(e.data.result))),
    firstClaim: rows.find((e) => e.data.result === "claimed")?.ts ?? null,
    failures: fails.length, lastFail: last ? { at: last.ts, reason: String(last.data.reason ?? last.text) } : null,
  };
}

/** Everything still owed to the peers of this project's peer cards, oldest first. */
export function pendingPushes(db: Database, project: string): PushItem[] {
  const out: PushItem[] = [];
  for (const task of listTasks(db, project)) {
    const meta = peerPrOf(task);
    if (!meta) continue;
    const events = listEvents(db, { project, target: task.id });
    for (const e of events) {
      const key = e.kind === "review" ? `review:${e.seq}`
        : e.kind === "scheduler" && e.data.op === "merge_phase" && e.data.to === "merged" ? `merged:${String(e.data.intentId)}`
        : e.kind === "note" && e.data.op === "peer_pr_push" && e.data.result === "queued" ? String(e.data.key) : null;
      if (key && !pushHistory(events, key).terminal) out.push({ task, meta, key, source: e });
    }
  }
  return out.sort((a, b) => a.source.seq - b.source.seq);
}

const backoffMs = (failures: number): number => Math.min(PUSH_BACKOFF_MS * 2 ** Math.max(0, failures - 1), PUSH_BACKOFF_CAP_MS);
const count = (v: unknown): number => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);

type Rendered = { text: string; commits: Set<string> } | { refuse: string };

async function renderReview(c: PeerPrCtx, item: PushItem): Promise<Rendered> {
  const d = item.source.data;
  const rep = c.deps.readReport(String(d.path ?? ""));
  if ("error" in rep) return { refuse: `报告读不了：${rep.error}` };
  const head = typeof d.head === "string" && SHA_RE.test(d.head) ? d.head : item.task.headSHA ?? "";
  const commits = await c.deps.commits([...hexCandidates(rep.text), head]);
  if (SHA_RE.test(head)) commits.add(head);
  const red = redactPeerPr(rep.text, c.deps.identity, commits);
  const counts = { verdict: String(d.verdict ?? ""), p0: count(d.p0), p1: count(d.p1), p2: count(d.p2), round: count(d.round) };
  return { commits, text: renderReviewPush({ number: item.meta.number, taskId: item.task.id, head, counts, maxRounds: c.cfg.maxRounds,
    replyTo: c.cfg.replyTo, report: red.text, masked: red.count }) };
}

async function render(c: PeerPrCtx, item: PushItem): Promise<Rendered> {
  const d = item.source.data;
  const r: Rendered = item.source.kind === "review" ? await renderReview(c, item)
    : item.source.kind === "scheduler" ? { text: renderMergedPush(item.meta.number, String(d.mergeSha ?? ""), c.cfg.replyTo), commits: new Set() }
    : { text: typeof d.message === "string" ? d.message : "", commits: new Set() };
  if ("refuse" in r) return r;
  if (!r.text.trim()) return { refuse: "待推内容是空的" };
  const hit = peerPrSecretHit(r.text, r.commits);
  if (hit) return { refuse: `门拦下（${hit}）` };
  const bytes = Buffer.byteLength(r.text);
  return bytes > PUSH_MAX_BYTES ? { refuse: `超过发送上限（${bytes} 字节 > ${PUSH_MAX_BYTES}）` } : r;
}

/** sent only on a 2xx from the peer; the bridge's typed gate refusal is terminal; everything else (unknown included) retries. */
export function classify(r: BridgeSendResult): { result: "sent" | "refused" | "failed"; reason: string; status?: number } {
  if (r.ok) {
    const status = Number(r.result?.status);
    return status >= 200 && status < 300 ? { result: "sent", reason: `HTTP ${status}`, status } : { result: "failed", reason: `对方回 HTTP ${status || "?"}`, status };
  }
  if (r.rejected === GATE_REJECTED) return { result: "refused", reason: `bridge 复核拦下：${r.error}` };
  return { result: "failed", reason: `${r.rejected ? `bridge 拒发（${r.rejected}）` : "结果不明"}：${r.error}` };
}

async function refuse(c: PeerPrCtx, item: PushItem, why: string): Promise<string> {
  const w = await record(c, item.task.id, item.key, "refused", `没发给对方：${oneLine(why)}`, { rule: oneLine(why, 120) });
  if (w.ok !== true) return `拒发没记上：${String(w.error)}`;
  const path = item.source.kind === "review" ? `；本机报告 ${String(item.source.data.path ?? "（无）")}` : "";
  await noticeOnce(c, item.task.id, `refused:${item.key}`, `[peer PR] ${item.task.id} 的推送 ${item.key} 没发给对方：${oneLine(why, 160)}${path}`);
  return "refused";
}

export async function pushOne(c: PeerPrCtx, item: PushItem): Promise<string> {
  const h = pushHistory(listEvents(c.db, { project: item.task.project, target: item.task.id }), item.key);
  const now = c.deps.now();
  if (h.firstClaim !== null && now - h.firstClaim >= GIVE_UP_MS) {
    await record(c, item.task.id, item.key, "abandoned", "24 小时没送达，放弃");
    await noticeOnce(c, item.task.id, `abandoned:${item.key}`, `[peer PR] ${item.task.id} 的 ${item.key} 24 小时没送到对方，已放弃：${h.lastFail?.reason ?? "原因不明"}`);
    return "abandoned";
  }
  if (h.firstClaim !== null && now - h.firstClaim >= LATE_MS) {
    await noticeOnce(c, item.task.id, `late:${item.key}`, `[peer PR] ${item.task.id} 的 ${item.key} 15 分钟还没送到对方（还在重试）：${h.lastFail?.reason ?? "原因不明"}`);
  }
  if (h.lastFail && now < h.lastFail.at + backoffMs(h.failures)) return "backoff";
  const r = await render(c, item);
  if ("refuse" in r) return refuse(c, item, r.refuse);
  const digest = createHash("sha256").update(r.text).digest("hex").slice(0, 16);
  const claim = await record(c, item.task.id, item.key, "claimed", "认领推送", { digest, bytes: Buffer.byteLength(r.text) });
  if (claim.ok !== true) return `认领没记上：${String(claim.error)}`;
  const sent = await c.deps.bridge({ type: "peer_pr_push", peer: item.meta.peer, fp: item.meta.fp, agent: item.meta.agent,
    key: `${item.task.id}:${item.key}`, text: r.text, shas: [...r.commits].filter((s) => r.text.includes(s)) });
  const out = classify(sent);
  if (out.result === "refused") return refuse(c, item, out.reason);
  const w = await record(c, item.task.id, item.key, out.result, oneLine(out.reason), { reason: oneLine(out.reason), ...(out.status ? { status: out.status } : {}) });
  if (w.ok !== true) console.error(`⚠️ [peer-pr] ${item.task.id} ${item.key} 推送结果（${out.result}）没记上：${String(w.error)}`);
  return out.result;
}

/** One pass over everything owed; one item's failure never blocks the others. */
export async function pushPending(c: PeerPrCtx): Promise<{ key: string; outcome: string }[]> {
  const out: { key: string; outcome: string }[] = [];
  for (const item of pendingPushes(c.db, c.cfg.project)) {
    try { out.push({ key: `${item.task.id}:${item.key}`, outcome: await pushOne(c, item) }); } catch (e) {
      logUnlessStopped(`推送 ${item.task.id} ${item.key} 出错（下一轮再试）`, e);
      out.push({ key: `${item.task.id}:${item.key}`, outcome: "error" });
    }
  }
  return out;
}
