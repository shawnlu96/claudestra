/**
 * 台账巡检的取数（规则在 ledger-audit.ts）：全部从文件和 tmux 取，不读 bridge 内存——CLI 手动跑和 bridge 定时跑结果一样，
 * bridge 重启（事件态、bg-activity 清空）也不影响。每个来源单独兜错：取不到的记 null，依赖它的规则这一轮不跑。
 * 来源：台账库、registry、tmux 窗口与画面、会话文件写入时间、PM 名单里各人的 subagents、押后队列文件、docsDir 旁的 ledger.json。
 */
import type { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AuditAgent, AuditHeld, AuditInboxEntry, AuditSnapshot, MainTurn } from "./ledger-audit.js";
import { blockedBy, depViews, isSatisfied, type DepView } from "./ledger-deps.js";
import { getMeta, listDeps, listEvents, listTasks } from "./ledger-store.js";
import type { LedgerEvent, LedgerTask, Stage, TaskKind } from "./ledger-stages.js";
import { runningReviewers, type ReviewerRef } from "./ledger-audit-reviewers.js";
import { HELD_MESSAGES_PATH } from "./paths.js";
import { readRegistryAgents, type RegistryAgent } from "./registry.js";
import { sessionJsonlPath } from "./session-source.js";
import { readJsonStateSync } from "./state-file.js";
import { specPathFor, specPolicyOf } from "./task-spec.js";
import { listWindows, tmuxRawStrict, windowTarget } from "./tmux-helper.js";
import { turnState } from "./turn-state.js";

export interface SnapshotSources {
  registry(): Promise<RegistryAgent[]>;
  /** master 会话里的窗口名；tmux 出错 = null */
  windows(): Promise<string[] | null>;
  turn(agent: RegistryAgent): Promise<MainTurn>;
  /** 会话文件的最近写入与创建时刻；没有文件 = 都是 null */
  fileTimes(agent: RegistryAgent): Promise<{ lastWriteAt: number | null; startedAt: number | null }>;
  reviewers(agent: RegistryAgent, now: number): ReviewerRef[] | { error: string };
  heldPath: string;
}

async function fileTimes(a: RegistryAgent): Promise<{ lastWriteAt: number | null; startedAt: number | null }> {
  const p = a.cwd && a.sessionId ? sessionJsonlPath(a.runtime, a.cwd, a.sessionId) : null;
  if (!p) return { lastWriteAt: null, startedAt: null };
  // 还没生成 / 刚被挪走：当没有记录，空闲与孤儿规则都不拿它下结论
  return stat(p).then((st) => ({ lastWriteAt: st.mtimeMs, startedAt: st.birthtimeMs }), () => ({ lastWriteAt: null, startedAt: null }));
}

const realSources: SnapshotSources = {
  registry: () => readRegistryAgents(),
  windows: async () => {
    const w = await listWindows();
    return w.length ? w : null; // 生产的 master 会话至少有窗口 0：一个都没有 = tmux 没列出来
  },
  turn: async (a) => {
    let pane: string | null;
    try {
      pane = await tmuxRawStrict(["capture-pane", "-t", windowTarget(a.name), "-p"]);
    } catch {
      pane = null; // 抓屏失败 = 画面未知，turnState 报 unknown
    }
    return turnState({ pane, runtime: a.runtime }).main;
  },
  fileTimes,
  reviewers: runningReviewers,
  heldPath: HELD_MESSAGES_PATH,
};

type HeldRaw = { env?: { from?: Record<string, unknown>; meta?: { messageId?: string } }; heldAt?: number; lease?: { at?: number } };

function senderOf(from: Record<string, unknown> | undefined): string | null {
  const kind = from?.kind;
  if (kind === "bridge" || !kind) return null; // 巡检自己的通知也押在这里，不算「PM 漏了消息」
  const name = from?.agentName ?? from?.username ?? from?.name;
  return typeof name === "string" && name ? name : String(kind);
}

/** 取不到时 value = null，reason 写进 CLI 输出的 skipped */
type Got<T> = { value: T | null; reason?: string };

function readHeld(path: string, byChannel: ReadonlyMap<string, string>): Got<AuditHeld[]> {
  const r = readJsonStateSync(path);
  if (r.status === "missing") return { value: [] };
  if (r.status !== "ok" || !r.data || typeof r.data !== "object") return { value: null, reason: `押后队列文件读不了：${path}` };
  const out: AuditHeld[] = [];
  for (const [ch, q] of Object.entries(r.data as Record<string, unknown>)) {
    const to = byChannel.get(ch);
    if (!to || !Array.isArray(q)) continue;
    for (const i of q as HeldRaw[]) {
      const from = senderOf(i?.env?.from);
      if (!from || typeof i.heldAt !== "number") continue;
      out.push({ to, from, messageId: i.env?.meta?.messageId ?? String(i.heldAt), heldAt: i.heldAt, leaseAt: typeof i.lease?.at === "number" ? i.lease.at : null });
    }
  }
  return { value: out };
}

/** 押后队列里现有的全部 messageId（巡检自己押着的通知投出去没有，看它还在不在）；文件坏了 = null（当还在） */
export function queuedMessageIds(path: string = HELD_MESSAGES_PATH): Set<string> | null {
  const r = readJsonStateSync(path);
  if (r.status === "missing") return new Set();
  if (r.status !== "ok" || !r.data || typeof r.data !== "object") return null;
  const ids = Object.values(r.data as Record<string, unknown>).flatMap((q) => (Array.isArray(q) ? (q as HeldRaw[]) : []).map((i) => i?.env?.meta?.messageId));
  return new Set(ids.filter((x): x is string => typeof x === "string"));
}

/** 本项目在跑的审查员：扫项目内所有 agent 加 PM 名单（调度助理不在名单里时它派的也看得到）；PM 缺会话信息、读失败 → null */
function projectReviewers(src: SnapshotSources, list: readonly RegistryAgent[], project: string, pms: readonly string[], now: number): Got<ReviewerRef[]> {
  const out: ReviewerRef[] = [];
  for (const a of list) {
    const isPm = pms.includes(a.name);
    if (!isPm && a.projectId !== project) continue;
    if (!isPm && (!a.cwd || !a.sessionId)) continue; // 普通成员刚建 / 不是 Claude Code：没有 subagents 可看，不影响判断
    const r = src.reviewers(a, now);
    if (!Array.isArray(r)) return { value: null, reason: r.error };
    out.push(...r);
  }
  return { value: out };
}

/** ownerInbox 在 docsDir 上一级的 ledger.json（PM 手写的老台账）：没有 docsDir / 没有这个文件 / 坏了都不跑，写明原因 */
function readOwnerInbox(docsDir: string | null): Got<AuditInboxEntry[]> {
  if (!docsDir) return { value: null, reason: "项目没有 meta.docsDir，找不到 ownerInbox" };
  const file = join(dirname(docsDir), "ledger.json");
  const r = readJsonStateSync(file);
  if (r.status === "missing") return { value: null, reason: `${file} 不存在` };
  if (r.status !== "ok") return { value: null, reason: `${file} 读不了` };
  const list = (r.data as { ownerInbox?: unknown } | null)?.ownerInbox;
  if (!Array.isArray(list)) return { value: null, reason: `${file} 里没有 ownerInbox` };
  return { value: list.map((m: Record<string, unknown>) => {
    const ts = typeof m.ts === "string" ? Date.parse(m.ts) : Number.NaN;
    return { ts: Number.isFinite(ts) ? ts : null, text: String(m.text ?? ""), status: String(m.status ?? ""), to: String(m.to ?? "") };
  }) };
}

/** 有 PM 名单的项目（没有名单的项目没人收推送，也就不巡检） */
export function auditedProjects(db: Database): string[] {
  const rows = db.query("SELECT DISTINCT project FROM meta WHERE key = 'pms' ORDER BY project").all() as { project: string }[];
  return rows.map((r) => r.project).filter((p) => getMeta(db, p).pms.length > 0);
}

async function readAgents(src: SnapshotSources, want: ReadonlySet<string>): Promise<{ list: RegistryAgent[]; agents: AuditAgent[] } | string> {
  let list: RegistryAgent[];
  try {
    list = await src.registry();
  } catch (e) {
    return `registry 读不了：${(e as Error).message}`; // 依赖它的规则这一轮不跑，原因进 skipped
  }
  const windows = await src.windows().catch(() => null); // tmux 出错：windowAlive 全为 null，只有回收规则不跑
  const agents = await Promise.all(list.map(async (a): Promise<AuditAgent> => {
    // 会话文件时间：空闲 / 押后规则要看的人，加上孤儿规则要看的临时执行者
    const times = want.has(a.name) || a.name.startsWith("agent-task-") ? await src.fileTimes(a) : { lastWriteAt: null, startedAt: null };
    return {
      name: a.name,
      projectId: a.projectId,
      windowAlive: windows ? windows.includes(a.name) : null,
      turn: want.has(a.name) ? await src.turn(a) : "unknown",
      ...times,
    };
  }));
  return { list, agents };
}

/** 这条事件让任务进了哪个阶段：stage 事件的 to，或建任务时直接给的 stage */
function enteredStage(e: LedgerEvent): Stage | undefined {
  if (e.kind === "stage") return e.data.to as Stage;
  if (e.kind === "task" && e.data.op === "new") return (e.data.patch as { stage?: Stage } | undefined)?.stage;
  return undefined;
}

/**
 * 前置这一段连续满足的起点：最后一次从不满足进入满足的时刻。在满足阶段之间走（live → verified）、
 * 进出 blocked（暂停不算倒退，同 ledger-deps.ts 的 workStage）都不重新计时，否则下游 merge 停滞会被推后再重推一次。
 */
function satisfiedSince(kind: TaskKind, events: readonly LedgerEvent[]): number | undefined {
  let since: number | undefined;
  let was = false;
  for (const e of events) {
    const stage = enteredStage(e);
    if (!stage || stage === "blocked") continue;
    const now = isSatisfied({ kind, stage });
    if (now && !was) since = e.ts;
    was = now;
  }
  return was ? since : undefined;
}

/**
 * 依赖最后一次放行的时刻（已放行的边里取最晚）：PM 手动定的状态取边的 updatedAt，
 * 推导的取前置任务这一段连续满足的起点。没有已放行的边 = null。
 */
function unblockedAt(taskId: string, deps: readonly DepView[], tasks: readonly LedgerTask[], byTarget: ReadonlyMap<string, LedgerEvent[]>): number | null {
  const kindOf = new Map(tasks.map((t) => [t.id, t.kind]));
  let at: number | null = null;
  for (const d of deps) {
    if (d.to !== taskId || d.effective !== "done") continue;
    const kind = kindOf.get(d.from);
    const satisfiedAt = kind ? satisfiedSince(kind, byTarget.get(d.from) ?? []) : undefined;
    const ts = d.state !== null ? d.updatedAt : satisfiedAt;
    if (ts !== undefined && (at === null || ts > at)) at = ts;
  }
  return at;
}

function unknownMerges(db: Database, project: string): NonNullable<AuditSnapshot["mergeUnknown"]> {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_merges'").get()) return [];
  return (db.query("SELECT intentId, taskId, reason, updatedAt FROM scheduler_merges WHERE project=? AND phase='unknown'").all(project) as
    { intentId: string; taskId: string; reason: string | null; updatedAt: number }[])
    .map((r) => ({ intentId: r.intentId, taskId: r.taskId, reason: r.reason ?? "", since: r.updatedAt }))
    .concat(unknownDeploys(db, project));
}

/** A deploy unknown (T68g) has the same exit and also freezes the queue (which mutes ship_stalled), so it goes to the PM the same way. */
function unknownDeploys(db: Database, project: string): NonNullable<AuditSnapshot["mergeUnknown"]> {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_deploys'").get()) return [];
  return (db.query("SELECT intentId, taskId, reason, updatedAt FROM scheduler_deploys WHERE project=? AND phase='unknown'").all(project) as
    { intentId: string; taskId: string; reason: string | null; updatedAt: number }[])
    .map((r) => ({ intentId: r.intentId, taskId: r.taskId, reason: `部署：${r.reason ?? ""}`, since: r.updatedAt }));
}

export async function collectAuditSnapshots(db: Database, projects: readonly string[], now: number, src: SnapshotSources = realSources): Promise<AuditSnapshot[]> {
  const perProject = projects.map((project) => {
    const byTarget = new Map<string, LedgerEvent[]>();
    for (const e of listEvents(db, { project })) byTarget.set(e.target, [...(byTarget.get(e.target) ?? []), e]);
    const all = listTasks(db, project);
    const deps = depViews(listDeps(db, project), all);
    const meta = getMeta(db, project);
    const tasks = all.map((task) => ({
      task, events: byTarget.get(task.id) ?? [], blockedBy: blockedBy(task.id, deps).map((d) => d.from), unblockedAt: unblockedAt(task.id, deps, all, byTarget),
      ...(meta.team ? { specPolicy: specPathFor(task, meta.docsDir) ? specPolicyOf(task, meta.docsDir) : null } : {}),
    }));
    const unfrozenAt = byTarget.get("")?.findLast((e) => e.kind === "unfreeze")?.ts ?? null;
    return { project, meta, tasks, unfrozenAt, mergeUnknown: unknownMerges(db, project) };
  });
  // 只给用得上的人抓屏 / 看会话文件：build / fix 的执行者（空闲规则）和各项目 PM 名单（押后规则）
  const want = new Set<string>();
  for (const p of perProject) {
    p.meta.pms.forEach((x) => want.add(x));
    for (const { task } of p.tasks) if (task.agent && (task.stage === "build" || task.stage === "fix")) want.add(task.agent);
  }
  const got = await readAgents(src, want);
  const reg = typeof got === "string" ? null : got;
  const byChannel = new Map((reg?.list ?? []).filter((a) => a.channelId).map((a) => [a.channelId as string, a.name]));
  const held: Got<AuditHeld[]> = reg ? readHeld(src.heldPath, byChannel) : { value: null };
  return perProject.map(({ project, meta, tasks, unfrozenAt, mergeUnknown }) => {
    const reviewers: Got<ReviewerRef[]> = reg ? projectReviewers(src, reg.list, project, meta.pms, now) : { value: null };
    const inbox = readOwnerInbox(meta.docsDir);
    const unavailable: AuditSnapshot["unavailable"] = {
      ...(typeof got === "string" ? { agents: got } : {}),
      ...(reg?.agents.some((a) => a.windowAlive === null) ? { windows: "tmux 没列出窗口" } : {}),
      ...(held.reason ? { held: held.reason } : {}),
      ...(reviewers.reason ? { reviewers: reviewers.reason } : {}),
      ...(inbox.reason ? { ownerInbox: inbox.reason } : {}),
    };
    return {
      project,
      pms: meta.pms,
      team: meta.team ? { dispatcher: meta.team.dispatcher } : null,
      tasks,
      agents: reg?.agents ?? null,
      reviewers: reviewers.value,
      queueFrozen: meta.queueFrozen.frozen,
      unfrozenAt,
      mergeUnknown,
      held: held.value,
      ownerInbox: inbox.value,
      unavailable,
    };
  });
}
