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
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import { insertEvent } from "./ledger-tx.js";
import { requeueByScheduler } from "./manual-merge-queue.js";
import { intentOf, listRequests, revokeOf, REVOKE_OP } from "./manual-merge-queue-facts.js";
import {
  flowBlock, HEAD_REVIEW_KEY, headReviewMode, headSample, type Lineage, p1RoundsSpent, passingFacts, registrationOf, registrationScope, type Registration,
  requeueMode, REQUEUE_KEY, reviewSpecRev, writeRegistration,
} from "./peer-pr-head-review.js";
import { getMergeRun } from "./scheduler-merge.js";
import { cancelMergeRun } from "./scheduler-merge-conflict.js";
import { currentReviewFacts } from "./scheduler-review.js";

export interface PeerPrMeta {
  peer: string; fp: string; agent: string; login: string; number: number; url: string; base: string;
  surface: "security" | "plain"; reasons: string[];
}

export const SHA_RE = /^[0-9a-f]{40}$/;
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)$/;
/** Past these the PR is no longer the peer path's business (merged and deploying, or finished). */
const SETTLED = new Set(["live", "verified", "done", "cancelled"]);

export const peerTaskId = (n: number): string => `PR${n}`;
export const peerPrWrite = <T>(db: Database, fn: () => T): T => busyAsLedgerError("写入", () => db.transaction(fn).immediate());
const write = peerPrWrite;

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

/** PEERHEAD1: peer cards PM took over or the path handed back (manual, before live); only the author-push flow looks at them. */
export function manualPeerCards(db: Database, project: string): LedgerTask[] {
  return listTasks(db, project).filter((t) => peerPrOf(t) && !SETTLED.has(t.stage) && getWorkflow(db, t.id)?.mode === "manual");
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
export function observeWrite(db: Database, ctx: WriteCtx, input: { taskId: string; head: string; lineage?: Lineage }): { task: LedgerTask; moved: boolean; reason: string } {
  return write(db, () => {
    let task = mustTask(db, input.taskId);
    const from = task, prior = hasRoundVerdict(db, task); // PEERHEAD1: what the registration names, read before anything moves
    const meta = peerPrOf(task);
    if (!meta) throw new LedgerError("invalid", `${task.id} 不是 peer PR 卡`);
    if (!SHA_RE.test(input.head)) throw new LedgerError("invalid", "head 要是完整 40 位 SHA");
    const hold = (reason: string) => ({ task, moved: false, reason });
    if (getWorkflow(db, task.id)?.mode !== "auto") return hold("卡已不在自动流程");
    const open = openIntent(db, task.id);
    if (open) return hold(`卡上还有未结意图 ${open}`);
    if (task.headSHA === input.head) return hold("head 没变");
    const inFlight = openRedelivery(db, task);
    if (inFlight) return hold(`补发 ${inFlight} 已认领、还没有结果：它绑的是现在这个 head，出了结果再换`);
    if (task.stage === "review") {
      if (!hasRoundVerdict(db, task)) return hold("本轮结论还没出：先审完旧 head");
      task = moveStage(db, ctx, { taskId: task.id, from: "review", to: "fix", asPm: true, text: "PR head 在结论之后变了：改审新 head" }).row;
    }
    if (task.stage !== "fix") return hold(`卡在 ${task.stage}，不由漂移处理`);
    const r = deliver(db, { actor: `peer:${meta.peer}`, now: ctx.now }, {
      taskId: task.id, headSHA: input.head, moveFrom: "fix", evidence: `${meta.url}@${input.head}`, text: "调度器按 GitHub PR head 代记" });
    if (input.lineage) register(db, ctx, from, r.row, prior, input.lineage, null);
    return { task: r.row, moved: true, reason: `新 head ${input.head.slice(0, 12)} 进第 ${r.row.round} 轮审查` };
  });
}

/**
 * PEERHEAD1 item 3: name the new round's increment (on), or only sample what would have been named (observe; off: the caller
 * passed no lineage). `from` = the card before the head moved, `prior` = the verdict the old head had.
 */
function register(db: Database, ctx: WriteCtx, from: LedgerTask, to: LedgerTask, prior: LedgerEvent | null, lineage: Lineage,
  settled: { requests: number[]; intents: string[] } | null): void {
  const mode = headReviewMode(to.project), now = ctx.now ?? Date.now();
  if (mode === "off") return;
  const events = listEvents(db, { project: to.project, target: to.id });
  const reg: Registration = { cause: "author_push", oldHead: from.headSHA ?? "", newHead: to.headSHA ?? "", priorReviewSeq: prior?.seq ?? null,
    round: to.round, specRev: to.specRev, flow: getWorkflow(db, to.id)?.mode === "manual" ? "manual" : "auto",
    ...registrationScope(SHA_RE.test(from.headSHA ?? "") ? lineage : "missing", reviewSpecRev(events, prior?.seq ?? null), to.specRev) };
  const sample = { ...reg, priorVerdict: prior?.data.verdict ?? null, settled };
  if (mode === "on") writeRegistration(db, ctx, to, reg, { settled });
  headSample(db, HEAD_REVIEW_KEY, to, "register", reg.newHead,
    `${mode === "on" ? "已" : ""}登记作者新 head ${reg.newHead.slice(0, 12)} 进第 ${reg.round} 轮${reg.scope === "incremental" ? "增量" : "全量"}复审`, sample, now);
}

/** The card's manual merge requests still standing (not revoked, run not ended) with their run, if claimed. */
function standingRequests(db: Database, task: LedgerTask) {
  return listRequests(db, task.project, task.id).filter((r) => !revokeOf(db, r)).map((req) => {
    const intent = intentOf(db, req);
    return { req, intent, run: intent ? getMergeRun(db, intent.id) : null };
  }).filter((x) => !x.intent || ["pending", "submitted", "unknown"].includes(x.intent.status));
}

/** Phases a claimed manual run may be in for this flow to end it: nothing was sent, and no update of the PR branch is in flight. */
const SETTLEABLE: readonly string[] = ["ready", "await_ci"];

export interface HeadWriteResult { task: LedgerTask; moved: boolean; reason: string; top?: boolean }

/**
 * PEERHEAD1 item 2 · `ledger peer-pr-observe` on a manual card: a stable new head on a manual peer card (the auto card's path is observeWrite). Only
 * when the author pushed after a passing review (or into a round this flow registered, while consecutive P1 rounds stay under
 * maxRounds); never for a pure main merge (main-carry), never past a hold / pause / freeze / open ask / safety hold. In merge
 * the card's standing manual requests are revoked and their unsent runs (ready / await_ci) ended in this same transaction; a
 * run past that (updating, merging, unknown) or any other open intent leaves the card to the merge driver. Then PM role
 * merge|review → fix and the peer's deliver: round + 1, the registration names oldHead / newHead / priorReviewSeq.
 */
export function headWrite(db: Database, ctx: WriteCtx, input: { taskId: string; head: string; lineage: Lineage; maxRounds: number }): HeadWriteResult {
  return write(db, () => {
    let task = mustTask(db, input.taskId);
    const meta = peerPrOf(task);
    if (!meta) throw new LedgerError("invalid", `${task.id} 不是 peer PR 卡`);
    if (!SHA_RE.test(input.head)) throw new LedgerError("invalid", "head 要是完整 40 位 SHA");
    const hold = (reason: string, top = false): HeadWriteResult => ({ task, moved: false, reason, ...(top ? { top } : {}) });
    if (getWorkflow(db, task.id)?.mode !== "manual") return hold("卡不在 manual（自动卡走 peer-pr-observe）");
    const mode = headReviewMode(task.project);
    if (mode === "off") return hold("peerPrHeadReview 是 off：照旧交 PM");
    if (task.headSHA === input.head) return hold("head 没变");
    if (!["review", "fix", "merge"].includes(task.stage)) return hold(`卡在 ${task.stage}，不由新 head 处理`);
    const redelivery = openRedelivery(db, task);
    if (redelivery) return hold(`补发 ${redelivery} 已认领、还没有结果`);
    const events = listEvents(db, { project: task.project, target: task.id });
    const block = flowBlock(db, task, events);
    if (block) return hold(block);
    if (input.lineage === "main_merge") return hold("新 head 是纯合 main：走 main-carry / CARRY2，不算作者改动重审");
    const prior = hasRoundVerdict(db, task);
    if (!prior) return hold("本轮结论还没出：先审完旧 head");
    const facts = currentReviewFacts(task, events, (a) => actorMayConfigure(db, a, task.project));
    const passed = facts.kind === "facts" && passingFacts(facts.facts);
    if (!passed) {
      if (!registrationOf(events, task.round, task.headSHA, "manual")) return hold("最近的结构化审查结论不是通过，本轮也不是本流程登记的：交 PM");
      const spent = p1RoundsSpent(events, task);
      if (spent >= input.maxRounds) return hold(`连续 ${spent} 轮审查仍有 P1，复验轮次到顶（maxRounds ${input.maxRounds}）`, true);
    }
    const standing = task.stage === "merge" ? standingRequests(db, task) : [];
    const stuck = standing.find((s) => s.intent && (s.intent.status === "unknown" || !s.run || !SETTLEABLE.includes(s.run.phase)));
    if (stuck) return hold(`人工合并请求 #${stuck.req.seq} 的运行已是 ${stuck.intent!.status}/${stuck.run?.phase ?? "-"}：交给合并 driver`);
    const mine = new Set(standing.flatMap((s) => (s.intent ? [s.intent.id] : [])));
    const other = (db.query("SELECT id FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown')").all(task.id) as { id: string }[])
      .find((i) => !mine.has(i.id));
    if (other) return hold(`卡上还有未结意图 ${other.id}`);
    const settled = { requests: standing.map((s) => s.req.seq), intents: [...mine] };
    if (mode === "observe") {
      const what = `结清人工合并请求 ${settled.requests.map((s) => `#${s}`).join("、") || "（无）"}，登记作者新 head ${input.head.slice(0, 12)} 进第 ${task.round + 1} 轮复审`;
      headSample(db, HEAD_REVIEW_KEY, task, "register", input.head, what,
        { oldHead: task.headSHA, newHead: input.head, priorReviewSeq: prior.seq, settled, round: task.round + 1, lineage: input.lineage }, ctx.now ?? Date.now());
      return hold("peerPrHeadReview 是 observe：只记样本");
    }
    const from = task, why = `peer PR 作者推了新提交 ${input.head.slice(0, 12)}，本流程结清旧请求重审（peerPrHeadReview）`;
    for (const s of standing) {
      if (s.run) cancelMergeRun(db, ctx, s.run, why, "作者推了新提交，未发出的人工合并作废");
      insertEvent(db, ctx, { project: task.project, target: task.id, kind: "decision", text: why,
        data: { op: REVOKE_OP, request: s.req.seq, intent: s.intent?.id ?? null, byScheduler: HEAD_REVIEW_KEY } }, false);
    }
    if (task.stage !== "fix") task = moveStage(db, ctx, { taskId: task.id, from: task.stage, to: "fix", asPm: true, text: "PR head 在审查结论之后变了：改审新 head" }).row;
    const r = deliver(db, { actor: `peer:${meta.peer}`, now: ctx.now }, {
      taskId: task.id, headSHA: input.head, moveFrom: "fix", evidence: `${meta.url}@${input.head}`, text: "调度器按 GitHub PR head 代记" });
    register(db, ctx, from, r.row, prior, input.lineage, settled);
    return { task: r.row, moved: true, reason: `新 head ${input.head.slice(0, 12)} 进第 ${r.row.round} 轮审查${settled.requests.length ? `，结清请求 #${settled.requests.join("、#")}` : ""}` };
  });
}

export interface SettleResult {
  task: LedgerTask; moved: boolean; reason: string; top?: boolean; requeued?: number;
  /** peerPrRequeue observe: the request a PM can file as is, and whether this call wrote the sample (first time for this head). */
  wouldRequeue?: { head: string; specRev: number; round: number; reviewSeq: number; recorded: boolean };
}

/**
 * PEERHEAD1 items 3–4 · `ledger peer-pr-observe` on a manual card with its own head: a manual card in a round this flow registered, its verdict on the card's head
 * in. changes / block → fix (the author's next push comes back through headWrite; top = consecutive P1 rounds reached maxRounds).
 * Passing → merge, then peerPrRequeue: on = requeueByScheduler (re-checks everything in this transaction), observe = one sample
 * with the request PM could file, off = nothing. The caller has checked GitHub still shows this head (no intermediate verdict
 * is ever queued for a newer head).
 */
export function headSettleWrite(db: Database, ctx: WriteCtx, input: { taskId: string; maxRounds: number }): SettleResult {
  return write(db, () => {
    let task = mustTask(db, input.taskId);
    if (!peerPrOf(task)) throw new LedgerError("invalid", `${task.id} 不是 peer PR 卡`);
    const hold = (reason: string): SettleResult => ({ task, moved: false, reason });
    if (getWorkflow(db, task.id)?.mode !== "manual") return hold("卡不在 manual");
    if (headReviewMode(task.project) !== "on") return hold("peerPrHeadReview 不是 on");
    let events = listEvents(db, { project: task.project, target: task.id });
    const owned = registrationOf(events, task.round, task.headSHA, "manual");
    if (!owned) return hold("本轮不是本流程登记的");
    const block = flowBlock(db, task, events);
    if (block) return hold(block);
    const facts = currentReviewFacts(task, events, (a) => actorMayConfigure(db, a, task.project));
    if (facts.kind !== "facts") return hold(facts.kind === "none" ? "本轮结论还没出" : `本轮结论不合格：${facts.reason}`);
    const f = facts.facts, now = ctx.now ?? Date.now(), head = task.headSHA!;
    if (!passingFacts(f)) {
      if (task.stage !== "review") return hold(`卡在 ${task.stage}`);
      task = moveStage(db, ctx, { taskId: task.id, from: "review", to: "fix", asPm: true, text: `第 ${task.round} 轮复审 ${f.verdict}：回 fix 等作者` }).row;
      events = listEvents(db, { project: task.project, target: task.id });
      const spent = p1RoundsSpent(events, task);
      headSample(db, HEAD_REVIEW_KEY, task, "verdict", head, `第 ${task.round} 轮复审 ${f.verdict}，回 fix 等作者`, { verdict: f.verdict, reviewSeq: f.eventSeq, spent }, now);
      return { task, moved: true, reason: `复审 ${f.verdict}：回 fix`, ...(spent >= input.maxRounds ? { top: true } : {}) };
    }
    let moved = false;
    if (task.stage === "review") {
      task = moveStage(db, ctx, { taskId: task.id, from: "review", to: "merge", asPm: true, text: `第 ${task.round} 轮增量复审通过：回合并` }).row;
      moved = true;
      headSample(db, HEAD_REVIEW_KEY, task, "verdict", head, `第 ${task.round} 轮复审通过，回 merge`, { verdict: f.verdict, reviewSeq: f.eventSeq }, now);
    }
    if (task.stage !== "merge") return { ...hold(`卡在 ${task.stage}`), moved };
    const standing = standingRequests(db, task);
    if (standing.length) return { ...hold(`已有人工合并请求 #${standing[0]!.req.seq}`), moved };
    const priorRequestSeq = (owned as { settled?: { requests?: number[] } }).settled?.requests?.at(-1) ?? null;
    const bind = { head, specRev: task.specRev, round: task.round, reviewSeq: f.eventSeq };
    const basis = { oldHead: owned.oldHead, newHead: head, priorPassSeq: owned.priorReviewSeq, priorRequestSeq, passSeq: f.eventSeq, round: task.round };
    const rmode = requeueMode(task.project);
    if (rmode === "on") {
      const r = requeueByScheduler(db, ctx, { taskId: task.id, ...bind, reason: `调度器代排：peer PR 作者新推后第 ${task.round} 轮复审 #${f.eventSeq} 通过（peerPrRequeue）`,
        basis: { mechanism: REQUEUE_KEY, mode: "on", priorRequestSeq, passSeq: f.eventSeq } }, (t) => flowBlock(db, t, listEvents(db, { project: t.project, target: t.id })));
      headSample(db, REQUEUE_KEY, task, "requeue", head, `已代排人工合并请求 #${r.request.seq}`, { ...basis, request: r.request.seq }, now);
      return { task, moved: true, reason: `代排人工合并请求 #${r.request.seq}`, requeued: r.request.seq };
    }
    if (rmode === "observe") {
      const s = headSample(db, REQUEUE_KEY, task, "requeue", head, `代排人工合并（${task.id} @ ${head.slice(0, 12)}，第 ${task.round} 轮，审查 #${f.eventSeq}）`, { ...basis, wouldRequest: bind }, now);
      return { task, moved, reason: "peerPrRequeue 是 observe：只记样本", wouldRequeue: { ...bind, recorded: s.recorded } };
    }
    return { ...hold("peerPrRequeue 是 off：照旧由 PM 排"), moved };
  });
}

export const PUSH_RESULTS = ["queued", "claimed", "sent", "refused", "failed", "abandoned", "notice", "notice_sent"] as const;
export type PushResult = (typeof PUSH_RESULTS)[number];
/** Terminal results share one key per item: once sent / refused / abandoned is written, nothing goes out for that key again. */
const TERMINAL: readonly PushResult[] = ["sent", "refused", "abandoned"];

/** Keys of a PM's explicit redelivery (peer-pr-retry.ts): redeliver:<review seq>:<refused seq>. */
export const REDELIVER_PREFIX = "redeliver:";

/**
 * A redelivery that was claimed and has no terminal row yet: its one frame may be with the bridge, and the claim checked it
 * against the card's head in its own transaction. The head observe holds until the result is recorded (the pass ends a claim
 * that never gets an answer as abandoned); every other head writer meets HEAD_PIN below.
 */
function openRedelivery(db: Database, task: Pick<LedgerTask, "project" | "id">): string | null {
  const rows = listEvents(db, { project: task.project, target: task.id })
    .filter((e) => e.kind === "note" && e.data.op === "peer_pr_push" && String(e.data.key).startsWith(REDELIVER_PREFIX));
  const ended = new Set(rows.filter((e) => TERMINAL.includes(e.data.result as PushResult)).map((e) => e.data.key));
  return (rows.find((e) => e.data.result === "claimed" && !ended.has(e.data.key))?.data.key as string | undefined) ?? null;
}

/**
 * The same hold for every writer of a card's head (deliver, task-set, whatever comes later), in the ledger itself: while a
 * redelivery's claim row (dedupKey peerpr:claim:<task>:redeliver:…) has no terminal row (peerpr:push:<task>:redeliver:…), an
 * UPDATE that changes that card's headSHA aborts, so the head the claim checked is still the card's head when the peer gets the
 * frame. Installed by the first claim, in the claim's own transaction; a card with no open redelivery claim never matches.
 */
const HEAD_PIN = "peer_pr_redelivery_head_pin";
export const HEAD_PINNED = "补发已认领、还没有结果：这张卡的 head 现在不能换，出了结果再交付";
function pinHeadWhileClaimed(db: Database): void {
  db.run(`DROP TRIGGER IF EXISTS ${HEAD_PIN}`); // always this definition, never an older or weakened one of the same name
  db.run(`CREATE TRIGGER ${HEAD_PIN} BEFORE UPDATE OF headSHA ON tasks
    WHEN NEW.headSHA IS NOT OLD.headSHA AND EXISTS (SELECT 1 FROM events c
      WHERE c.dedupKey >= 'peerpr:claim:' || OLD.id || ':${REDELIVER_PREFIX}' AND c.dedupKey < 'peerpr:claim:' || OLD.id || ':${REDELIVER_PREFIX.slice(0, -1)};'
      AND NOT EXISTS (SELECT 1 FROM events t WHERE t.dedupKey = 'peerpr:push:' || substr(c.dedupKey, ${"peerpr:claim:".length + 1})))
    BEGIN SELECT RAISE(ABORT, '${HEAD_PINNED}'); END`);
}

export function pushDedupKey(scope: string, key: string, result: PushResult): string | undefined {
  if (TERMINAL.includes(result)) return `peerpr:push:${scope}:${key}`;
  // A redelivery is claimed once ever: a second pass (concurrent, or after a restart) gets duplicate and sends nothing.
  if (result === "claimed" && key.startsWith(REDELIVER_PREFIX)) return `peerpr:claim:${scope}:${key}`;
  if (result === "queued") return `peerpr:queue:${scope}:${key}`;
  if (result === "notice") return `peerpr:notice:${scope}:${key}`;
  return result === "notice_sent" ? `peerpr:notice:${scope}:${key}:sent` : undefined;
}

/**
 * PM notices written but never marked sent, oldest first: the retry scan for these runs on its own, so a notice whose source
 * already left the path (a terminal push, a card back in manual) is still delivered. Range on the unique dedupKey index.
 */
export function unsentNotices(db: Database, project: string): { target: string; key: string; text: string }[] {
  const rows = db.query(`SELECT n.target, n.text, n.data FROM events n WHERE n.dedupKey >= 'peerpr:notice:' AND n.dedupKey < 'peerpr:notice;'
    AND n.project = ? AND n.kind = 'note' AND NOT EXISTS (SELECT 1 FROM events s WHERE s.dedupKey = n.dedupKey || ':sent') ORDER BY n.seq`)
    .all(project) as { target: string; text: string; data: string }[];
  return rows.flatMap((r) => {
    const d = JSON.parse(r.data) as Record<string, unknown>;
    return d.op === "peer_pr_push" && d.result === "notice" && typeof d.key === "string" ? [{ target: r.target, key: d.key, text: r.text }] : [];
  });
}

/**
 * target "" = project-level (a PR that never became a card); notes are invisible to peers (peer-ledger.ts peerEventView).
 * `redeliveryVerified` is passed only by peer-pr-retry.ts claimRedelivery, from inside the transaction that re-checked the request.
 */
export function recordPeerPrNote(db: Database, ctx: WriteCtx, input: {
  project: string; target: string; key: string; result: PushResult; text: string; data?: Record<string, unknown>;
}, redeliveryVerified = false): { event: LedgerEvent; duplicate: boolean } {
  if (!/^[\w:.-]{1,120}$/.test(input.key) || !PUSH_RESULTS.includes(input.result)) throw new LedgerError("invalid", "推送记录的 key / result 不合规");
  if (input.target && !peerPrOf(mustTask(db, input.target))) throw new LedgerError("invalid", `${input.target} 不是 peer PR 卡`);
  // The request row of a redelivery carries a PM's authority: only peer-pr-retry.ts writes it, never this generic record.
  if ((input.result === "queued" && input.key.startsWith(REDELIVER_PREFIX)) || (input.data && "redeliver" in input.data)) {
    throw new LedgerError("forbidden", "补发申请只能由 PM 用 peer-pr-retry 提");
  }
  // The one claim of a redelivery is written together with the re-check of everything the request bound, never on its own.
  if (input.result === "claimed" && input.key.startsWith(REDELIVER_PREFIX) && !redeliveryVerified) {
    throw new LedgerError("forbidden", "补发的认领要和发送前核对在同一笔事务里（claimRedelivery）");
  }
  if (redeliveryVerified) pinHeadWhileClaimed(db);
  const dedupKey = pushDedupKey(input.target || `-${input.project}`, input.key, input.result);
  return appendEvent(db, { ...ctx, ...(dedupKey ? { dedupKey } : {}) }, {
    project: input.project, target: input.target, kind: "note", text: input.text.slice(0, 8000),
    data: { op: "peer_pr_push", key: input.key, result: input.result, ...input.data },
  });
}
