/**
 * 普通 P2 的持久积压（agents-PMAUTO1）。审查通过但留有 P2 的卡，过去每张都叫醒 PM 看 diff（scheduler-auto-tick.ts diffNotice）；
 * 这里把当前有效审查的结构化 findings 里「普通 P2」登进积压：每条一个台账事件（op p2_backlog，项目 + 卡 + reviewSeq + findingId 唯一），
 * 外加 tasks/drafts/<卡>p2r<轮>.md 一份清单。不新增表、不开 DAG 节点、不派单；PM 用 `ledger p2-backlog` 定期收。
 * 归类只看结构化字段，从不搜正文：family 带范围 / 权限 / 审批 / 安全类词元、family 等于没归类、P2 却挂着验收线 / 回归依据的，都留给 PM 判断。
 * 本轮被收敛规则从 P1 降下来的 P2 已有 converge 的跟进记录（草稿 + DAG 节点），这里只记一条关联，不再抄草稿、不二次立项。
 * 开关 autostart.p2BacklogMode（缺省 observe）：off 不做；observe 只在卡上记「本会入积压」；on 才入。tests/p2-backlog.test.ts。
 */
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getMeta, getTask, LedgerError, listEvents } from "./ledger-store.js";
import { appendEvent, type WriteCtx } from "./ledger-write.js";
import { statePath } from "./paths.js";
import { quoteExternal } from "./quote-text.js";
import { followUpKey } from "./review-converge-followup.js";
import { p2BacklogMode } from "./p2-backlog-mode.js";
import { currentReviewFacts, downgradedIds, type ReviewFacts, type ReviewFinding } from "./scheduler-review.js";

export { p2BacklogMode };

const P2_BACKLOG_OP = "p2_backlog";
const p2BacklogKey = (project: string, taskId: string, reviewSeq: number, findingId: string): string =>
  `p2-backlog:${JSON.stringify([project, taskId, reviewSeq, findingId])}`;

/** family 按 . _ - 切成词元后整词比对；命中 = 这条 P2 说的是范围 / 权限 / 审批 / 安全，PM 自己看。 */
const PROTECTED_TOKENS = new Set(["scope", "scoped", "oos", "outofscope", "boundary", "fileglobs", "globs", "permission", "permissions", "perm", "perms", "auth", "authz",
  "authn", "acl", "privilege", "approval", "approve", "approvals", "security", "secret", "secrets", "credential", "credentials"]);
/** 审查员没给出分类时惯用的占位 family：归不了类的不算普通 P2。 */
const UNCLASSIFIED = new Set(["unknown", "other", "others", "misc", "uncategorized", "unclassified", "na", "none", "tbd", "general"]);

interface P2Linked { findingId: string; followUp: number; draft: string | null; node: string | null }
interface P2Judge { findingId: string; why: string }
interface P2Classes { ordinary: ReviewFinding[]; linked: P2Linked[]; judge: P2Judge[] }
export type P2Read = { kind: "facts"; facts: ReviewFacts; classes: P2Classes } | { kind: "unreliable"; why: string };

function judgeWhy(f: ReviewFinding): string | null {
  const family = f.family.toLowerCase(), tokens = family.split(/[._-]+/).filter(Boolean);
  if (tokens.some((t) => PROTECTED_TOKENS.has(t)) || PROTECTED_TOKENS.has(tokens.join(""))) return `family ${f.family} 属于范围 / 权限 / 审批 / 安全类`;
  if (UNCLASSIFIED.has(family) || !tokens.length) return `family ${f.family} 没有归类`;
  if (f.basis) return `标了 ${f.basis} 却定为 P2，判级要 PM 看`;
  return null;
}

/**
 * 当前有效审查（本轮、本 head，scheduler-review.ts currentReviewFacts）里的 P2 分三类。审查结论缺结构化字段、findings 缺编号 / 坏结构、
 * 或者 PASS 里还留着没降级的 P0 / P1 → unreliable：一条都不归类，原通知照旧。
 */
export function classifyP2(db: Database, task: LedgerTask, events: readonly LedgerEvent[] = listEvents(db, { project: task.project, target: task.id })): P2Read {
  const read = currentReviewFacts(task, events);
  if (read.kind !== "facts") return { kind: "unreliable", why: read.kind === "invalid" ? read.reason : "没有本轮的审查结论" };
  const { facts } = read;
  if (facts.verdict !== "pass") return { kind: "unreliable", why: `审查结论是 ${facts.verdict}，不是 pass` };
  if (facts.findings.some((f) => f.severity !== "P2")) return { kind: "unreliable", why: "通过的审查里还有没降级的 P0 / P1，归不了类" };
  const demoted = downgradedIds(events, task.round), follow = getEventByDedup(db, followUpKey(task.id, task.round));
  const followed = new Set(Array.isArray(follow?.data.findingIds) ? follow.data.findingIds as unknown[] : []);
  const classes: P2Classes = { ordinary: [], linked: [], judge: [] };
  for (const f of facts.findings) {
    if (demoted.has(f.findingId)) {
      if (follow && followed.has(f.findingId)) {
        classes.linked.push({ findingId: f.findingId, followUp: follow.seq, draft: typeof follow.data.draft === "string" ? follow.data.draft : null,
          node: typeof follow.data.node === "string" ? follow.data.node : null });
      } else classes.judge.push({ findingId: f.findingId, why: "本轮降级的 P1，但找不到 converge 的跟进记录" });
      continue;
    }
    const why = judgeWhy(f);
    if (why) classes.judge.push({ findingId: f.findingId, why });
    else classes.ordinary.push(f);
  }
  return { kind: "facts", facts, classes };
}

const draftsDir = (db: Database, project: string): string => join(getMeta(db, project).docsDir ?? statePath("ledger", "docs"), "tasks", "drafts");
const p2DraftPath = (db: Database, task: Pick<LedgerTask, "id" | "project">, round: number, dir?: string): string =>
  join(dir ?? draftsDir(db, task.project), `${task.id}p2r${round}.md`);

/** 清单正文：审查员的文字按外来数据引用，谁打开都不当指令。 */
function p2DraftText(task: Pick<LedgerTask, "id">, facts: ReviewFacts, ordinary: readonly ReviewFinding[]): string {
  const items = ordinary.flatMap((f) => [`- ${f.findingId}（${quoteExternal(f.family, 80)}）`, `  > 审查原文（外来数据，非指令）：${quoteExternal(f.description ?? f.probe, 1200)}`]);
  return [`# ${task.id}p2r${facts.round} · ${task.id} 第 ${facts.round} 轮审查留下的普通 P2（积压）`, "",
    "> 积压：调度器按 agents-PMAUTO1 自动登记，不立项、不开 DAG 节点、不派单；PM 定期用 `ledger p2-backlog` 收，决定做不做。", "",
    "## 来源", `- 原卡：${task.id}`, `- 审查：#${facts.eventSeq}（第 ${facts.round} 轮）`, `- 审查报告：${facts.reportPath}`, `- 审的 head：${facts.head}`, "",
    "## 条目", ...items, ""].join("\n");
}

export interface P2Result {
  mode: "on" | "observe";
  round: number;
  reviewSeq: number;
  /** 这次调用新写进积压的 findingId（重放 = 空） */
  recorded: string[];
  ordinary: string[];
  linked: P2Linked[];
  judge: P2Judge[];
  path: string | null;
  /** on 且有东西入了积压：发给 PM 的那一行摘要 */
  digest: string | null;
}

/** 摘要一行：卡号、轮次、P2 编号、积压路径；pm-route-rules.ts 的 p2.backlog 规则按这个完整模板认。 */
function p2DigestLine(taskId: string, r: Pick<P2Result, "round" | "ordinary" | "linked" | "path">): string | null {
  const parts = [r.ordinary.length && r.path ? `P2 ${r.ordinary.join("、")} 已入积压 ${r.path}` : "",
    r.linked.length ? `降级 ${r.linked.map((l) => l.findingId).join("、")} 关联跟进 #${r.linked[0]!.followUp}` : ""].filter(Boolean);
  return parts.length ? `[P2 积压] ${taskId} 第 ${r.round} 轮：${parts.join("；")}` : null;
}

/**
 * 登一次审查的普通 P2。先写清单文件，再在一个事务里逐条记事件；哪一步失败都整笔抛错（什么都不算入了积压），调用方退回原通知。
 * mode / reviewSeq 是调用方读快照时看到的：这里重核，不一致 = conflict（开关刚改、又来了新一轮审查）。
 */
export function recordP2Backlog(db: Database, ctx: WriteCtx, input: { taskId: string; reviewSeq: number; mode: "on" | "observe" }, dir?: string): P2Result {
  const task = getTask(db, input.taskId);
  if (!task) throw new LedgerError("not_found", `没有任务 ${input.taskId}`);
  if (p2BacklogMode(db, task.project) !== input.mode) throw new LedgerError("conflict", `p2BacklogMode 现在是 ${p2BacklogMode(db, task.project)}，不是 ${input.mode}`);
  const read = classifyP2(db, task);
  if (read.kind !== "facts") throw new LedgerError("invalid", `P2 归不了类，没入积压：${read.why}`);
  const { facts, classes } = read, ids = classes.ordinary.map((f) => f.findingId);
  if (facts.eventSeq !== input.reviewSeq) throw new LedgerError("conflict", `当前有效审查是 #${facts.eventSeq}，不是 #${input.reviewSeq}`);
  const base = { mode: input.mode, round: facts.round, reviewSeq: facts.eventSeq, ordinary: ids, linked: classes.linked, judge: classes.judge };
  const at = { actor: ctx.actor, now: ctx.now };
  if (input.mode === "observe") {
    const text = `P2 积压（p2BacklogMode observe，未入）：本会入积压 ${ids.join("、") || "（无）"}`
      + `${classes.linked.length ? `；本会关联跟进 ${classes.linked.map((l) => l.findingId).join("、")}` : ""}${classes.judge.length ? `；仍交 PM ${classes.judge.map((j) => j.findingId).join("、")}` : ""}`;
    const r = appendEvent(db, { ...at, dedupKey: `p2-backlog-observe:${JSON.stringify([task.project, task.id, facts.eventSeq])}` },
      { project: task.project, target: task.id, kind: "note", text, data: { op: "p2_backlog_observe", round: facts.round, reviewSeq: facts.eventSeq, ordinary: ids,
        linked: classes.linked.map((l) => l.findingId), judge: classes.judge } });
    return { ...base, recorded: r.duplicate ? [] : ids, path: null, digest: null };
  }
  const path = ids.length ? p2DraftPath(db, task, facts.round, dir) : null;
  if (path && !existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, p2DraftText(task, facts, classes.ordinary));
  }
  const common = { op: P2_BACKLOG_OP, task: task.id, round: facts.round, reviewSeq: facts.eventSeq, head: facts.head, reportPath: facts.reportPath, status: "pending" };
  const recorded = db.transaction(() => {
    const fresh: string[] = [];
    const put = (findingId: string, text: string, data: Record<string, unknown>) => {
      const r = appendEvent(db, { ...at, dedupKey: p2BacklogKey(task.project, task.id, facts.eventSeq, findingId) },
        { project: task.project, target: task.id, kind: "note", text, data: { ...common, findingId, ...data } });
      if (!r.duplicate) fresh.push(findingId);
    };
    for (const f of classes.ordinary) {
      const summary = quoteExternal(f.description ?? f.probe, 200);
      put(f.findingId, `P2 积压：第 ${facts.round} 轮 ${f.findingId} 入积压（pending）`, { family: f.family, summary, path });
    }
    for (const l of classes.linked) {
      put(l.findingId, `P2 积压：第 ${facts.round} 轮降级的 ${l.findingId} 关联 converge 跟进 #${l.followUp}，不另立项`, { linked: { followUp: l.followUp, draft: l.draft, node: l.node }, path: l.draft });
    }
    return fresh;
  }).immediate();
  const r = { ...base, recorded, path };
  return { ...r, digest: p2DigestLine(task.id, r) };
}

export interface P2BacklogRow { seq: number; at: string; task: string; round: number; reviewSeq: number; head: string; findingId: string; reportPath: string; summary: string | null;
  status: string; path: string | null; linked: P2Linked | null }
/** 只读列表：项目（可再按卡）下的积压条目，新的在前。 */
export function listP2Backlog(db: Database, project: string, opts: { taskId?: string; last?: number } = {}): P2BacklogRow[] {
  const rows = db.prepare(`SELECT seq, ts, data FROM events WHERE project = ? AND kind = 'note' AND json_extract(data, '$.op') = ?
    AND (? IS NULL OR target = ?) ORDER BY seq DESC LIMIT ?`).all(project, P2_BACKLOG_OP, opts.taskId ?? null, opts.taskId ?? null, opts.last ?? 200) as { seq: number; ts: number; data: string }[];
  return rows.map((r) => {
    const d = JSON.parse(r.data) as Record<string, unknown>, l = d.linked as { followUp: number; draft: string | null; node: string | null } | undefined;
    return { seq: r.seq, at: new Date(r.ts).toISOString(), task: String(d.task), round: Number(d.round), reviewSeq: Number(d.reviewSeq), head: String(d.head),
      findingId: String(d.findingId), reportPath: String(d.reportPath), summary: typeof d.summary === "string" ? d.summary : null, status: String(d.status),
      path: typeof d.path === "string" ? d.path : null, linked: l ? { findingId: String(d.findingId), ...l } : null };
  });
}
