/**
 * 跨实例委托的台账接口（docs/team/peer-delegation.md）：受托方用 peer token 读写委托给它的那几张卡，台账留在发起方本机。
 * 哪些卡算「给这个 peer 的」：extra.delegate（执行方）或 extra.reviewer（审查方）@ 后面的名字等于 token 对应的 peer。
 * 读：这些卡本身 + 它们的事件时间线（去掉 owner 原话和「待你处理」）。写的判定在这里，执行在 manager/ledger-peer.ts：
 * note（双方）、挂 PR / head（执行方，合并前）、阶段（执行方，ledger-stages.ts peerMayMove）、审查结论（审查方，不带阶段跳转）。
 * tests/peer-ledger.test.ts。
 */
import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { delegatePeerOf, isAskEvent, samePeer, STAGES, type LedgerEvent, type LedgerTask, type ReviewVerdict, type Stage } from "./ledger-stages.js";
import { getTask, listEvents, toTask } from "./ledger-store.js";
import { REPO_ROOT } from "./repo-root.js";

/** 委托约定的绝对路径：peer 请求的注入头里给接收方 agent 看，它的 cwd 一般是自己的项目，相对路径找不到 */
export const PEER_DELEGATION_DOC = resolve(REPO_ROOT, "docs/team/peer-delegation.md");

export type PeerLink = "delegate" | "reviewer";

export function peerLinks(task: Pick<LedgerTask, "extra">, peer: string): PeerLink[] {
  return (["delegate", "reviewer"] as const).filter((f) => samePeer(delegatePeerOf(task, f), peer));
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
  updatedAt: number;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function peerTaskView(t: LedgerTask, links: PeerLink[]): PeerTaskView {
  const { id, project, title, kind, stage, stageBefore, round, rev, pr, headSHA, updatedAt } = t;
  const x = t.extra ?? {};
  return { id, project, title, kind, stage, stageBefore, round, rev, pr, headSHA, updatedAt, goal: str(x.goal), delegate: str(x.delegate), reviewer: str(x.reviewer), links };
}

/** 委托给这个 peer 的全部卡（跨项目）。ponytail: 全表扫，台账是几百行的量级；上万行再加 extra 索引 */
export function peerTasks(db: Database, peer: string): PeerTaskView[] {
  const rows = db.query("SELECT * FROM tasks ORDER BY updatedAt DESC").all() as Record<string, unknown>[];
  return rows.map(toTask).flatMap((t) => {
    const links = peerLinks(t, peer);
    return links.length ? [peerTaskView(t, links)] : [];
  });
}

/** owner 原话（decision）和「待你处理」一族不给对方看 */
const hiddenFromPeer = (e: LedgerEvent): boolean => e.kind === "decision" || isAskEvent(e);

/** 不是委托给它的卡一律当不存在（null → 404），不泄露别的任务在不在 */
export function peerTaskDetail(db: Database, peer: string, id: string): { task: PeerTaskView; events: LedgerEvent[] } | null {
  const t = getTask(db, id);
  const links = t ? peerLinks(t, peer) : [];
  if (!t || !links.length) return null;
  return { task: peerTaskView(t, links), events: listEvents(db, { project: t.project, target: id }).filter((e) => !hiddenFromPeer(e)) };
}

export type PeerOp =
  | { op: "note"; text: string }
  | { op: "pr"; rev: number; pr?: string; head?: string }
  | { op: "stage"; from: Stage; to: Stage; text?: string }
  | { op: "review"; verdict: ReviewVerdict; p0: number; p1: number; p2: number; text?: string };

const TEXT_MAX = 4000;
const count = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1000;
const optText = (v: unknown): string | undefined | null => (v === undefined ? undefined : typeof v === "string" && v.length <= TEXT_MAX ? v : null);

/** 请求体 → 操作；不认识的返回错误原因（字段格式如 PR 链接、head 由写入层再核） */
export function parsePeerOp(body: unknown): PeerOp | string {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const text = optText(b.text);
  if (text === null) return `text 要是不超过 ${TEXT_MAX} 字的字符串`;
  if (b.op === "note") return text?.trim() ? { op: "note", text } : "note 要带 text";
  if (b.op === "pr") {
    if (!Number.isInteger(b.rev) || (b.rev as number) < 1) return "pr 要带当前 rev（先 GET 任务）";
    const pr = str(b.pr) ?? undefined;
    const head = str(b.head) ?? undefined;
    return pr || head ? { op: "pr", rev: b.rev as number, pr, head } : "pr 要带 pr 或 head";
  }
  if (b.op === "stage") {
    const ok = (s: unknown): s is Stage => typeof s === "string" && (STAGES as readonly string[]).includes(s);
    return ok(b.from) && ok(b.to) ? { op: "stage", from: b.from, to: b.to, text } : "stage 要带合法的 from / to";
  }
  if (b.op === "review") {
    const v = b.verdict;
    if (v !== "pass" && v !== "changes" && v !== "block") return "verdict 只能是 pass / changes / block";
    if (!count(b.p0) || !count(b.p1) || !count(b.p2)) return "p0 / p1 / p2 要是非负整数";
    return { op: "review", verdict: v, p0: b.p0, p1: b.p1, p2: b.p2, text };
  }
  return "op 只能是 note / pr / stage / review";
}

const PEER_EDIT_STAGES: readonly Stage[] = ["spec", "restate", "build", "review", "fix"];

/** 这个 peer 能不能对这张卡做这个操作；能 = null。阶段本身合不合法由写入层按 peer 角色判（ledger-stages.ts） */
export function peerOpDenied(op: PeerOp, task: Pick<LedgerTask, "stage" | "stageBefore">, links: PeerLink[]): string | null {
  const isDelegate = links.includes("delegate");
  if (op.op === "note") return null;
  if (op.op === "review") return links.includes("reviewer") ? null : "只有审查方能写审查结论";
  if (!isDelegate) return "只有执行方能挂 PR、推阶段";
  if (op.op === "pr") {
    const at = task.stage === "blocked" ? task.stageBefore : task.stage;
    if (!at || !PEER_EDIT_STAGES.includes(at)) return `任务已在 ${task.stage}，合并之后 PR / head 由发起方 PM 改`;
  }
  return null;
}
