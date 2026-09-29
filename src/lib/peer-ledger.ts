/**
 * 跨实例委托的台账接口（docs/team/peer-delegation.md）：受托方用 peer token 读写委托给它的那几张卡，台账留在发起方本机。
 * 哪些卡算「给这个 peer 的」：有一步的执行者是 <agent>@<这个 peer>（lib/ledger-steps.ts；老卡按 extra.delegate / extra.reviewer 推）。
 * 读：这些卡本身 + 它们的事件时间线（白名单，peerEventView）。写的判定在这里（按步骤：只有这一步是它的才能写），执行在 manager/ledger-peer.ts：
 * note / accept（有它的步骤就行）、挂 PR / head（它是当前写 / 修那一步，合并前）、阶段（同上，ledger-stages.ts peerMayMove）、
 * 审查结论（它是这一轮审查那一步，不带阶段跳转）。
 * tests/peer-ledger.test.ts。
 */
import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { STAGES, type LedgerEvent, type LedgerTask, type ReviewVerdict, type Stage, type StepName } from "./ledger-stages.js";
import { getTask, listEvents, toTask } from "./ledger-store.js";
import { currentStep, derivedSteps, listSteps, stepAtStage, stepPeer, stepsByTask, type TaskStep } from "./ledger-steps.js";
import { REPO_ROOT } from "./repo-root.js";

/** 委托约定的绝对路径：peer 请求的注入头里给接收方 agent 看，它的 cwd 一般是自己的项目，相对路径找不到 */
export const PEER_DELEGATION_DOC = resolve(REPO_ROOT, "docs/team/peer-delegation.md");

export type PeerLink = "delegate" | "reviewer";

const REVIEW_STEPS: readonly StepName[] = ["review", "final_review"];

/** 这张卡上的全部步骤：库里的行，加上没派过人的步骤按老字段推出来的（同 ledger-steps.ts stepsOf，不用再查库） */
function withDerived(task: LedgerTask, rows: TaskStep[]): TaskStep[] {
  const have = new Set(rows.map((s) => s.step));
  return [...rows, ...derivedSteps(task).filter((s) => !have.has(s.step))];
}

/** 它在这张卡上接了哪些步骤：审查类算 reviewer，其余算 delegate */
export function peerLinks(task: LedgerTask, peer: string, rows: TaskStep[] = []): PeerLink[] {
  const mine = withDerived(task, rows).filter((s) => stepPeer(s) === peer);
  return (["delegate", "reviewer"] as const).filter((l) => mine.some((s) => REVIEW_STEPS.includes(s.step) === (l === "reviewer")));
}

/** 给受托方看的字段：不含规格卡路径、分支、PM、模型这些发起方内部的东西 */
export interface PeerTaskView {
  id: string;
  project: string;
  title: string;
  kind: string;
  stage: Stage;
  stageBefore: Stage | null;
  round: number;
  rev: number;
  pr: string | null;
  headSHA: string | null;
  goal: string | null;
  delegate: string | null;
  reviewer: string | null;
  links: PeerLink[];
  /** 它自己接的步骤给全（执行者、状态、head 区间、结论、本机校验、自报）；别人的只给步骤名和状态 */
  steps: { step: StepName; round: number; state: string; mine: boolean; executor?: string; headFrom?: string | null; headTo?: string | null; verdict?: string | null;
    verified?: Record<string, unknown>; claims?: Record<string, unknown> }[];
  updatedAt: number;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function peerTaskView(t: LedgerTask, links: PeerLink[], rows: TaskStep[] = [], peer = ""): PeerTaskView {
  const { id, project, title, kind, stage, stageBefore, round, rev, pr, headSHA, updatedAt } = t;
  const x = t.extra ?? {};
  const steps = withDerived(t, rows).map((s) => {
    const base = { step: s.step, round: s.round, state: s.state, mine: !!peer && stepPeer(s) === peer };
    return base.mine ? { ...base, executor: s.executor, headFrom: s.headFrom, headTo: s.headTo, verdict: s.verdict, verified: s.verified, claims: s.claims } : base;
  });
  return { id, project, title, kind, stage, stageBefore, round, rev, pr, headSHA, updatedAt, goal: str(x.goal), delegate: str(x.delegate), reviewer: str(x.reviewer), links, steps };
}

/** 委托给这个 peer 的全部卡（跨项目）。ponytail: 全表扫，台账是几百行的量级；上万行再加 extra 索引 */
export function peerTasks(db: Database, peer: string): PeerTaskView[] {
  const rows = db.query("SELECT * FROM tasks ORDER BY updatedAt DESC").all() as Record<string, unknown>[];
  const steps = stepsByTask(db);
  return rows.map(toTask).flatMap((t) => {
    const links = peerLinks(t, peer, steps.get(t.id));
    return links.length ? [peerTaskView(t, links, steps.get(t.id), peer)] : [];
  });
}

export interface PeerEventView {
  seq: number;
  ts: number;
  kind: string;
  /** 受托方自己写的（actor 是 peer:<它>）：原样给；其余只给白名单字段，不给 actor */
  mine: boolean;
  text?: string;
  data: Record<string, unknown>;
}

/**
 * 事件时间线白名单：发起方的内部信息（建卡的 extra、分支、规格卡路径、PM 的 note、owner 原话、派审、升级、部署地址……）不出本机。
 * 受托方自己写的原样；阶段变化只给 from / to；建卡 / 改卡只给 pr / headSHA（都没有就整条不给）；交付只给 head；
 * 审查只给结论（verdict、P 计数、轮次、正文，不给结论文件路径）。其余整条不给。tests/peer-ledger.test.ts。
 */
function peerEventView(e: LedgerEvent, peer: string): PeerEventView | null {
  const base = { seq: e.seq, ts: e.ts, kind: e.kind };
  if (e.actor === `peer:${peer}`) return { ...base, mine: true, text: e.text, data: e.data };
  const d = e.data;
  if (e.kind === "stage") return { ...base, mine: false, data: { from: d.from, to: d.to } };
  if (e.kind === "deliver") return { ...base, mine: false, data: { headSHA: d.headSHA ?? null } };
  if (e.kind === "review") return { ...base, mine: false, text: e.text, data: { verdict: d.verdict, p0: d.p0, p1: d.p1, p2: d.p2, round: d.round } };
  if (e.kind === "step") return { ...base, mine: false, data: { op: d.op, step: d.step, round: d.round } };
  if (e.kind !== "task") return null;
  const patch = (d.patch ?? {}) as Record<string, unknown>;
  const refs = Object.fromEntries(["pr", "headSHA"].filter((k) => patch[k] != null).map((k) => [k, patch[k]]));
  return Object.keys(refs).length ? { ...base, mine: false, data: refs } : null;
}

/** 不是委托给它的卡一律当不存在（null → 404），不泄露别的任务在不在 */
export function peerTaskDetail(db: Database, peer: string, id: string): { task: PeerTaskView; events: PeerEventView[] } | null {
  const t = getTask(db, id);
  const rows = t ? listSteps(db, t.id) : [];
  const links = t ? peerLinks(t, peer, rows) : [];
  if (!t || !links.length) return null;
  const events = listEvents(db, { project: t.project, target: id }).flatMap((e) => peerEventView(e, peer) ?? []);
  return { task: peerTaskView(t, links, rows, peer), events };
}

/** model：对方自报用的什么模型（跨实例只能凭声明），记进那一步的 claims */
export type PeerOp =
  | { op: "note"; text: string }
  | { op: "accept"; text?: string }
  | { op: "pr"; rev: number; pr?: string; head?: string }
  | { op: "stage"; from: Stage; to: Stage; text?: string; model?: string }
  | { op: "review"; verdict: ReviewVerdict; p0: number; p1: number; p2: number; text?: string; model?: string };

const TEXT_MAX = 4000;
const count = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1000;
const optText = (v: unknown): string | undefined | null => (v === undefined ? undefined : typeof v === "string" && v.length <= TEXT_MAX ? v : null);

/** 请求体 → 操作；不认识的返回错误原因（字段格式如 PR 链接、head 由写入层再核） */
export function parsePeerOp(body: unknown): PeerOp | string {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const text = optText(b.text);
  if (text === null) return `text 要是不超过 ${TEXT_MAX} 字的字符串`;
  const model = b.model === undefined ? undefined : typeof b.model === "string" && /^[\w .:/-]{1,64}$/.test(b.model) ? b.model : null;
  if (model === null) return "model 要是不超过 64 字的模型名";
  if (b.op === "note") return text?.trim() ? { op: "note", text } : "note 要带 text";
  if (b.op === "accept") return { op: "accept", text };
  if (b.op === "pr") {
    if (!Number.isInteger(b.rev) || (b.rev as number) < 1) return "pr 要带当前 rev（先 GET 任务）";
    const pr = str(b.pr) ?? undefined;
    const head = str(b.head) ?? undefined;
    return pr || head ? { op: "pr", rev: b.rev as number, pr, head } : "pr 要带 pr 或 head";
  }
  if (b.op === "stage") {
    const ok = (s: unknown): s is Stage => typeof s === "string" && (STAGES as readonly string[]).includes(s);
    return ok(b.from) && ok(b.to) ? { op: "stage", from: b.from, to: b.to, text, model } : "stage 要带合法的 from / to";
  }
  if (b.op === "review") {
    const v = b.verdict;
    if (v !== "pass" && v !== "changes" && v !== "block") return "verdict 只能是 pass / changes / block";
    if (!count(b.p0) || !count(b.p1) || !count(b.p2)) return "p0 / p1 / p2 要是非负整数";
    return { op: "review", verdict: v, p0: b.p0, p1: b.p1, p2: b.p2, text, model };
  }
  return "op 只能是 note / accept / pr / stage / review";
}

/** 挂 PR / head 只在开发、返工时：进了 review 再换，发起方审过的就不是现在这份了 */
const PEER_PR_STAGES: readonly Stage[] = ["build", "fix"];

/**
 * 这个 peer 能不能对这张卡做这个操作；能 = null。按步骤判：审查结论要它是这一轮审查那一步，挂 PR / 推阶段要它是当前在干活的那一步
 * （review 阶段看交付的那一方，同 ledger-steps-write.ts activeStepFor）。阶段本身合不合法由写入层按 peer 角色再判（ledger-stages.ts）
 */
export function peerOpDenied(op: PeerOp, task: LedgerTask, steps: TaskStep[], peer: string): string | null {
  if (op.op === "note" || op.op === "accept") return null;
  if (op.op === "review") {
    return REVIEW_STEPS.some((n) => { const s = currentStep(steps, n); return !!s && stepPeer(s) === peer; }) ? null : "这一轮的审查那一步不是你";
  }
  const stage = task.stage === "blocked" ? task.stageBefore : task.stage;
  const active = stepAtStage(steps, stage === "review" ? { stage: "fix", stageBefore: null } : task);
  if (!active || stepPeer(active) !== peer) return `${task.stage} 阶段在干活的那一步不是你（${active?.step ?? "没人"}）`;
  if (op.op === "pr" && !PEER_PR_STAGES.includes(task.stage)) return `任务在 ${task.stage}，只有 build / fix 阶段能挂 PR / head（进了 review 再换就不是审过的那份）`;
  return null;
}
