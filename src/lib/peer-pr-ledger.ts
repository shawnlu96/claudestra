/**
 * Ledger writes of the peer PR path (i28-A2): intake (one transaction: card + security auto workflow + spec→restate→build as PM +
 * build→review as the peer's deliver), the head-drift observe (the same result as the peer delivering in fix itself), and the
 * push / notice records. They only compose the existing write functions inside one outer transaction; nested ones become
 * savepoints, so any refusal rolls the whole step back. Identity comes from peer-prs.json read by the caller, never from args.
 */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { setWorkflow } from "./ledger-scheduler-write.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { busyAsLedgerError, getMeta, getTask, LedgerError, listEvents, listTasks } from "./ledger-store.js";
import { appendEvent, createTask, deliver, moveStage } from "./ledger-write.js";
import { BRANCH } from "./order-deliver-pr.js";
import { peerOfLogin, type PeerPrConfig } from "./peer-pr-config.js";

export interface PeerPrMeta {
  peer: string; fp: string; agent: string; login: string; number: number; url: string; base: string;
  surface: "security" | "plain"; reasons: string[];
}

export const SHA_RE = /^[0-9a-f]{40}$/;
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)$/;
/** Past these the PR is no longer the peer path's business (merged and deploying, or finished). */
const SETTLED = new Set(["live", "verified", "done", "cancelled"]);

export const peerTaskId = (n: number): string => `PR${n}`;
const write = <T>(db: Database, fn: () => T): T => busyAsLedgerError("写入", () => db.transaction(fn).immediate());

/** The card's peer PR facts, or null for any card that is not a well-formed peer PR card (all other cards behave as before). */
export function peerPrOf(task: Pick<LedgerTask, "extra" | "assigneeKind" | "assignee">): PeerPrMeta | null {
  const m = task.extra?.peerPr as Record<string, unknown> | undefined;
  if (!m || typeof m !== "object" || task.assigneeKind !== "peer_agent") return null;
  const s = (k: string) => (typeof m[k] === "string" ? (m[k] as string) : null);
  const [peer, fp, agent, login, url, base] = ["peer", "fp", "agent", "login", "url", "base"].map(s);
  if (!peer || !fp || !agent || !login || !url || !base || !Number.isInteger(m.number) || task.assignee !== `${fp}/${agent}`) return null;
  const surface = m.surface === "plain" ? "plain" : "security";
  const reasons = Array.isArray(m.reasons) ? m.reasons.filter((r): r is string => typeof r === "string") : [];
  return { peer, fp, agent, login, number: m.number as number, url, base, surface, reasons };
}

/** Peer cards still owned by the automatic path (auto mode, before live). */
export function inFlightPeerCards(db: Database, project: string): LedgerTask[] {
  return listTasks(db, project).filter((t) => peerPrOf(t) && !SETTLED.has(t.stage) && getWorkflow(db, t.id)?.mode === "auto");
}

/** Any card of the project that already names this PR (a PM's manual card included). */
export function cardForPr(db: Database, project: string, url: string): LedgerTask | null {
  const n = Number(PR_URL.exec(url)?.[1] ?? NaN);
  return listTasks(db, project).find((t) => t.pr === url || t.pr?.replace(/\/+$/, "") === url || peerPrOf(t)?.number === n) ?? null;
}

/** The current round already has a verdict (structured or not): drift after it re-reviews the new head as a new round. */
export const hasRoundVerdict = (db: Database, task: LedgerTask): LedgerEvent | null =>
  listEvents(db, { project: task.project, target: task.id }).findLast((e) => e.kind === "review" && e.data.round === task.round) ?? null;

const openIntent = (db: Database, taskId: string): string | null =>
  (db.query("SELECT id FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown') LIMIT 1").get(taskId) as { id: string } | null)?.id ?? null;

export interface IntakeInput {
  project: string; number: number; url: string; head: string; branch: string; base: string; login: string; title: string;
  surface: "security" | "plain"; reasons: string[]; spec: string;
}

function checkIntake(db: Database, input: IntakeInput, cfg: PeerPrConfig) {
  if (input.project !== cfg.project) throw new LedgerError("forbidden", `peer-prs.json 不收项目 ${input.project} 的 PR`);
  const peer = peerOfLogin(cfg, input.login);
  if (!peer) throw new LedgerError("forbidden", "PR 作者不在 peer-prs.json 里");
  if (Number(PR_URL.exec(input.url)?.[1]) !== input.number || input.number < cfg.fromNumber) throw new LedgerError("invalid", "PR 链接 / 编号不合规或小于 fromNumber");
  if (input.base !== "main") throw new LedgerError("invalid", "只收 base 是 main 的 PR");
  if (!SHA_RE.test(input.head) || !BRANCH.test(input.branch)) throw new LedgerError("invalid", "head 要是完整 SHA，分支名要合规");
  if (!["security", "plain"].includes(input.surface) || input.reasons.length > 40) throw new LedgerError("invalid", "安全面判定不合规");
  return peer;
}

/** One transaction; a PR that already has this very card answers duplicate, any other card naming it is a conflict. */
export function intakeWrite(db: Database, ctx: WriteCtx, input: IntakeInput, cfg: PeerPrConfig): { task: LedgerTask; duplicate: boolean } {
  return write(db, () => {
    const peer = checkIntake(db, input, cfg);
    const id = peerTaskId(input.number);
    const existing = cardForPr(db, input.project, input.url) ?? getTask(db, id);
    if (existing) {
      if (existing.id === id && peerPrOf(existing)?.url === input.url) return { task: existing, duplicate: true };
      throw new LedgerError("conflict", `台账里已有卡 ${existing.id} 引用这个 PR（或占了 ${id}），不自动收`);
    }
    if (inFlightPeerCards(db, input.project).length >= cfg.maxOpen) throw new LedgerError("conflict", `在途 peer 卡已满 ${cfg.maxOpen} 张`);
    const meta: PeerPrMeta = { peer: peer.peer, fp: peer.fp, agent: peer.agent, login: input.login.toLowerCase(), number: input.number, url: input.url,
      base: input.base, surface: input.surface, reasons: input.reasons };
    const pm = getMeta(db, input.project).pms[0] ?? null;
    createTask(db, { ...ctx, dedupKey: `peerpr:intake:${input.project}:${input.number}` }, {
      project: input.project, id, title: `PR #${input.number} ${input.title}`.slice(0, 200), kind: "code", assigneeKind: "peer_agent",
      assignee: `${peer.fp}/${peer.agent}`, pm, branch: input.branch, pr: input.url, headSHA: input.head, spec: input.spec,
      extra: { peerPr: meta, delegate: `${peer.agent}@${peer.peer}` },
    });
    setWorkflow(db, ctx, { taskId: id, taskRev: mustTask(db, id).rev, template: "security", templateVersion: 2, mode: "auto",
      authorFamily: peer.authorFamily, fallback: "peer PR 自动流程停下，退 PM 人工处理" }, true);
    moveStage(db, ctx, { taskId: id, from: "spec", to: "restate", asPm: true, text: "peer PR 收卡：PR 说明即复述" });
    moveStage(db, ctx, { taskId: id, from: "restate", to: "build", asPm: true, text: "peer PR 收卡：代码已在 PR 上" });
    const r = deliver(db, { actor: `peer:${peer.peer}`, now: ctx.now }, {
      taskId: id, headSHA: input.head, moveFrom: "build", evidence: `${input.url}@${input.head}`, text: "调度器按 GitHub PR head 代记" });
    return { task: r.row, duplicate: false };
  });
}

/**
 * A stable new PR head (i28-A2 §6). fix: deliver it as the peer would. review with this round's verdict: PM role review→fix first,
 * then the same deliver, so the old round keeps its verdict. Anything else (verdict pending, merge, an open intent) writes nothing.
 */
export function observeWrite(db: Database, ctx: WriteCtx, input: { taskId: string; head: string }): { task: LedgerTask; moved: boolean; reason: string } {
  return write(db, () => {
    let task = mustTask(db, input.taskId);
    const meta = peerPrOf(task);
    if (!meta) throw new LedgerError("invalid", `${task.id} 不是 peer PR 卡`);
    if (!SHA_RE.test(input.head)) throw new LedgerError("invalid", "head 要是完整 40 位 SHA");
    const hold = (reason: string) => ({ task, moved: false, reason });
    if (getWorkflow(db, task.id)?.mode !== "auto") return hold("卡已不在自动流程");
    const open = openIntent(db, task.id);
    if (open) return hold(`卡上还有未结意图 ${open}`);
    if (task.headSHA === input.head) return hold("head 没变");
    if (task.stage === "review") {
      if (!hasRoundVerdict(db, task)) return hold("本轮结论还没出：先审完旧 head");
      task = moveStage(db, ctx, { taskId: task.id, from: "review", to: "fix", asPm: true, text: "PR head 在结论之后变了：改审新 head" }).row;
    }
    if (task.stage !== "fix") return hold(`卡在 ${task.stage}，不由漂移处理`);
    const r = deliver(db, { actor: `peer:${meta.peer}`, now: ctx.now }, {
      taskId: task.id, headSHA: input.head, moveFrom: "fix", evidence: `${meta.url}@${input.head}`, text: "调度器按 GitHub PR head 代记" });
    return { task: r.row, moved: true, reason: `新 head ${input.head.slice(0, 12)} 进第 ${r.row.round} 轮审查` };
  });
}

export const PUSH_RESULTS = ["queued", "claimed", "sent", "refused", "failed", "abandoned", "notice", "notice_sent"] as const;
export type PushResult = (typeof PUSH_RESULTS)[number];
/** Terminal results share one key per item: once sent / refused / abandoned is written, nothing goes out for that key again. */
const TERMINAL: readonly PushResult[] = ["sent", "refused", "abandoned"];

export function pushDedupKey(scope: string, key: string, result: PushResult): string | undefined {
  if (TERMINAL.includes(result)) return `peerpr:push:${scope}:${key}`;
  if (result === "queued") return `peerpr:queue:${scope}:${key}`;
  if (result === "notice") return `peerpr:notice:${scope}:${key}`;
  return result === "notice_sent" ? `peerpr:notice:${scope}:${key}:sent` : undefined;
}

/** target "" = project-level (a PR that never became a card); notes are invisible to peers (peer-ledger.ts peerEventView). */
export function recordPeerPrNote(db: Database, ctx: WriteCtx, input: {
  project: string; target: string; key: string; result: PushResult; text: string; data?: Record<string, unknown>;
}): { event: LedgerEvent; duplicate: boolean } {
  if (!/^[\w:.-]{1,120}$/.test(input.key) || !PUSH_RESULTS.includes(input.result)) throw new LedgerError("invalid", "推送记录的 key / result 不合规");
  if (input.target && !peerPrOf(mustTask(db, input.target))) throw new LedgerError("invalid", `${input.target} 不是 peer PR 卡`);
  const dedupKey = pushDedupKey(input.target || `-${input.project}`, input.key, input.result);
  return appendEvent(db, { ...ctx, ...(dedupKey ? { dedupKey } : {}) }, {
    project: input.project, target: input.target, kind: "note", text: input.text.slice(0, 8000),
    data: { op: "peer_pr_push", key: input.key, result: input.result, ...input.data },
  });
}
