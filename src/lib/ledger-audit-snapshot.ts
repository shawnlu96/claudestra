/**
 * 台账巡检的取数（规则在 ledger-audit.ts）：全部从文件和 tmux 取，不读 bridge 内存——CLI 手动跑和 bridge 定时跑结果一样，
 * bridge 重启（事件态、bg-activity 清空）也不影响。每个来源单独兜错：取不到的记 null，依赖它的规则这一轮不跑。
 * 来源：台账库、registry、tmux 窗口与画面、会话文件写入时间、PM 名单里各人的 subagents、押后队列文件、docsDir 旁的 ledger.json。
 */
import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AUDIT_THRESHOLDS, RECOVERY_RULES, type AuditAgent, type AuditHeld, type AuditInboxEntry, type AuditRule, type AuditSnapshot,
  type MainTurn, type RecoveryAuditInputs, type RecoveryCandidate, type RecoveryFacts } from "./ledger-audit.js";
import { blockedBy, depViews, isSatisfied, type DepView } from "./ledger-deps.js";
import { getMeta, listDeps, listEvents, listTasks } from "./ledger-store.js";
import type { LedgerEvent, LedgerTask, Stage, TaskKind } from "./ledger-stages.js";
import { runningReviewers, type ReviewerRef } from "./ledger-audit-reviewers.js";
import { readWaitAuditSnapshot } from "./ledger-deadlock-read.js";
import { currentReview, stepsByTask, type TaskStep } from "./ledger-steps.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { gateInputs } from "./scheduler-dispatch-block.js";
import { readRegistryAgents, type RegistryAgent } from "./registry.js";
import { sessionJsonlPath } from "./session-source.js";
import { liveMergeCi, type MergeCiFact } from "./ledger-audit-merge-ready.js";
import { collectHandoffPr, type HandoffPrFact } from "./ledger-audit-handoff.js";
import { grantUntilOf, LEND_GRANT_RECENT_MS, LEND_GRANT_RULES, type LendGrantFact } from "./ledger-audit-lend-grant.js";
import { readMergePm } from "./ledger-audit-merge-pm.js";
import { readAuditTrain, readMergeTrain } from "./ledger-audit-train.js";
import { agentBgShell, readBgShells, readLendTransit } from "./ledger-audit-idle.js";
import { readStallAudit } from "./ledger-audit-stall-read.js";
import { readMirrorPush } from "./ledger-audit-mirror.js";
import type { BorrowEntry } from "./lend-config.js";
import { HELD_MESSAGES_PATH, STATE_DIR, statePath } from "./paths.js";
import { isWaiting, manualStallTick, type ActionCard } from "./recovery-manual.js";
import { assessPlanGap, planGapText, planGapTick, readPlanGapFacts, type DraftFile, type FactsIo } from "./recovery-plan-gap.js";
import { recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import type { ServiceFacts, SpecFile } from "./scheduler-autostart.js";
import { autostartSpecPath, readSpec, serviceFacts } from "./scheduler-autostart-deps.js";
import { readSchedulerConfig, type SchedulerConfig } from "./scheduler-config.js";
import { readEffectiveBorrow } from "./scheduler-pool-borrow.js";
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
  mergeCi?(project: string, tasks: AuditSnapshot["tasks"], now: number, db: Database): Promise<Record<string, MergeCiFact> | null>; // MAINP2 CI + merge gates
  /** AUDH2-1：交接卡 PR 现读（ledger-audit-handoff.ts）；测试不给 = 不读，交接卡按「没读到」判 */
  handoffPr?(prUrl: string): Promise<HandoffPrFact | null>;
  /** AUDLEND1：这个执行者有没有后台 shell 还在跑（ledger-audit-idle.ts）；测试不给 = 不查 */
  bgShell?(agent: RegistryAgent): Promise<boolean>;
  /** N8B7：共享镜像状态文件所在的状态目录（ledger-audit-mirror.ts）；测试不给 = 不读 */
  mirrorDir?: string;
  /** AUD：恢复巡检的取数源（readRecoveryAudit）；测试不给 = 不读，规则不跑 */
  recovery?: RecoveryAuditSources;
}

/** 恢复巡检读的生产事实：CFG 策略、scheduler.json、借入名单、正式规格卡、草稿目录——每轮现读，不缓存 */
interface RecoveryAuditSources {
  policy: RecoveryPolicyPort;
  config(): SchedulerConfig;
  borrow(): Promise<readonly BorrowEntry[]>;
  readSpec(taskId: string): SpecFile | null;
  drafts(project: string, docsDir: string | null): DraftFile[];
}

function readDrafts(docsDir: string | null): DraftFile[] {
  const dir = join(docsDir ?? statePath("ledger", "docs"), "tasks", "drafts");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; // 没有草稿目录 = 没有草稿
    throw e;
  }
  return names.filter((n) => n.endsWith(".md")).sort().map((n) => {
    const file = join(dir, n);
    return { name: n.slice(0, -3), mtimeMs: statSync(file).mtimeMs, text: readFileSync(file, "utf8") };
  });
}

const realRecovery: RecoveryAuditSources = {
  policy: recoveryPolicy, config: readSchedulerConfig, borrow: readEffectiveBorrow,
  readSpec: (taskId) => readSpec(autostartSpecPath(taskId)), drafts: (_project, docsDir) => readDrafts(docsDir),
};

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
      ...(a.status ? { status: a.status } : {}),
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

/**
 * 本轮显式派了、还没记结论的审查那一步（初审 / 终审按轮次取）。只看库里的行：老卡推出来的 extra.reviewer 不当派过；
 * 轮次对不上 = 上一轮派的；done = 已记结论（peer 写的结论不回写步骤行，靠轮次和 pass 分支兜住）
 */
function pendingReview(task: LedgerTask, rows: TaskStep[]): AuditSnapshot["tasks"][number]["reviewStep"] {
  const s = currentReview(rows);
  return s && s.round === task.round && s.state !== "done" ? { executor: s.executor, executorKind: s.executorKind, at: s.updatedAt } : null;
}

/** LGR1：各出借方最近一次存下的授权 + 本项目 24 小时内在它那儿的出借单数 / claimed 单数（只读）；没有出借表 = undefined（规则不跑） */
export function readLendGrants(db: Database, project: string, now: number): LendGrantFact[] | undefined {
  if ((db.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('lend_peers','lend_orders')").get() as { n: number }).n < 2) return undefined;
  return (db.query(`SELECT p.peer, p.grant, p.helloAt, (SELECT COUNT(*) FROM lend_orders o WHERE o.peer = p.peer AND o.project = ?1 AND o.updatedAt >= ?2) AS recent,
    (SELECT COUNT(*) FROM lend_orders o WHERE o.peer = p.peer AND o.project = ?1 AND o.status = 'claimed') AS running FROM lend_peers p ORDER BY p.peer`)
    .all(project, now - LEND_GRANT_RECENT_MS) as (Omit<LendGrantFact, "until"> & { grant: string | null })[]).map(({ grant, ...r }) => ({ ...r, until: grantUntilOf(grant) }));
}
/** LGR1：本项目已建 audit_baseline 的授权规则（只读）；读不了 = null（规则这轮不跑，不让首轮静默吞掉提醒） */
export function readLendGrantBaseline(db: Database, project: string): string[] | null {
  try {
    return (db.query(`SELECT rule FROM audit_baseline WHERE project = ? AND rule IN (${LEND_GRANT_RULES.map(() => "?").join(", ")})`)
      .all(project, ...LEND_GRANT_RULES) as { rule: string }[]).map((r) => r.rule);
  } catch {
    return null;
  }
}
/** LGR1：本项目已推过（notifiedAt / queuedAs）又已关掉的授权发现 key（只读）——同一次授权不重开重推；读不了 = null（规则这轮不跑） */
export function readLendGrantTold(db: Database, project: string): string[] | null {
  try {
    return (db.query(`SELECT key FROM audit_findings WHERE project = ? AND resolvedAt IS NOT NULL AND (notifiedAt IS NOT NULL OR queuedAs IS NOT NULL)
      AND rule IN (${LEND_GRANT_RULES.map(() => "?").join(", ")})`).all(project, ...LEND_GRANT_RULES) as { key: string }[]).map((r) => r.key);
  } catch {
    return null;
  }
}
/** LGR1：本项目还开着的授权发现（只读）；读不了 = null（规则这轮不跑） */
function readLendGrantOpen(db: Database, project: string): { key: string; rule: string; told: boolean }[] | null {
  try {
    return (db.query(`SELECT key, rule, (notifiedAt IS NOT NULL OR queuedAs IS NOT NULL) AS told FROM audit_findings WHERE project = ? AND resolvedAt IS NULL
      AND rule IN (${LEND_GRANT_RULES.map(() => "?").join(", ")})`).all(project, ...LEND_GRANT_RULES) as { key: string; rule: string; told: number }[])
      .map((r) => ({ ...r, told: !!r.told }));
  } catch {
    return null;
  }
}
type RecoveryRead = NonNullable<RecoveryAuditInputs["recovery"]>;
const oneLine = (text: string, cap: number) => text.split(/\s*\n\s*/).filter(Boolean).join("；").slice(0, cap);
const never = async () => { throw new Error("巡检取数不发通知"); };

/** 两条恢复规则在巡检库里的基线、还开着的、已推过又关掉的 key（只读）；读不了 = null（规则这轮不跑） */
function recoveryStore(db: Database, project: string): RecoveryRead["store"] {
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_findings'").get()) return { baseline: [], open: [], told: [] };
    const marks = RECOVERY_RULES.map(() => "?").join(", ");
    const rows = db.query(`SELECT key, rule, firstSeen, resolvedAt, (notifiedAt IS NOT NULL OR queuedAs IS NOT NULL) AS told FROM audit_findings
      WHERE project = ? AND rule IN (${marks}) ORDER BY key`).all(project, ...RECOVERY_RULES) as { key: string; rule: string; firstSeen: number; resolvedAt: number | null; told: number }[];
    const baseline = db.query(`SELECT rule FROM audit_baseline WHERE project = ? AND rule IN (${marks})`).all(project, ...RECOVERY_RULES) as { rule: string }[];
    return { baseline: baseline.map((b) => b.rule), told: rows.filter((r) => r.resolvedAt !== null && r.told).map((r) => r.key),
      open: rows.filter((r) => r.resolvedAt === null).map((r) => ({ key: r.key, rule: r.rule, firstSeen: r.firstSeen, told: !!r.told })) };
  } catch {
    return null;
  }
}

/** 读前先看 CFG：audit 或机制自己的键是 off / 读不了就不取数；否则带回 owner 的阈值（null = 没设） */
function recoveryGate(policy: RecoveryPolicyPort, project: string, key: "manualStall" | "planGap"): { ms: number | null } | { unread: string } {
  try {
    const read = [policy(project, "audit"), policy(project, key)];
    if (read.some((p) => p.source === "error" || (p.mode !== "on" && p.mode !== "observe"))) return { unread: `恢复策略 audit / ${key} 为 off 或读不了，没取数` };
    return { ms: read[1]!.manualAfterMs };
  } catch {
    return { unread: `恢复策略 audit / ${key} 读不了，没取数` };
  }
}

const cardCandidate = (c: ActionCard, now: number): RecoveryCandidate => ({
  keyParts: [c.taskId, c.version, c.fingerprint], taskId: c.taskId, since: now - c.idleMs, due: true,
  detail: oneLine(`manual 停滞（${c.cls}，阶段 ${c.stage}，执行者 ${c.agent ?? "未指定"}）：${c.evidence.join("；")}`, 600),
  suggestion: oneLine(`${c.audience === "owner" ? "转 owner 决定（系统不代批、不重试）：" : ""}${c.step}${c.command ? `；命令：${c.command}` : ""}`, 500),
});

/** MANUAL 的原函数 manualStallTick，策略钉成 observe（只读、不认领、不发）：过了 owner 阈值的卡就是候选 */
async function manualFacts(db: Database, project: string, now: number, svc: ServiceFacts, ms: number | null): Promise<RecoveryFacts> {
  const out = await manualStallTick({ db, now, svc: { ...svc, projects: [project] }, policy: () => ({ mode: "observe", manualAfterMs: ms }), notify: never });
  const cards = out.flatMap((o) => ("taskId" in o ? [o] : []));
  const idle = cards.filter((o) => !isWaiting(o.cls)).length;
  return { found: cards.flatMap((o) => (o.action === "would_notify" && o.card ? [cardCandidate(o.card, now)] : [])),
    ...(ms === null && idle ? { note: `owner 未设 manualStallHours：${idle} 张非等待类 manual 卡只观察、不判停滞` } : {}) };
}

/**
 * PLAN 的原函数：readPlanGapFacts → assessPlanGap（各项目一起做座位匹配）→ planGapTick（策略钉成 observe，只读）。
 * 座位匹配按调度服务的全部项目算（svc.projects）：`--project pa` 只筛输出，不把同一服务里 pb 的就绪需求裁掉——否则被 pb 占着的
 * 共享座位在子集上会算成空闲。没被请求 / 自己策略关着的项目只当竞争者（阈值 null，不出结果）。
 * 「不足持续了多久」在 tick 里是进程内存；巡检每轮是新进程，所以从巡检库里同一画面那条发现的 firstSeen 接上。
 */
async function planGapFacts(db: Database, live: readonly { project: string; ms: number | null; docsDir: string | null }[], now: number,
  svc: ServiceFacts, config: SchedulerConfig, rs: RecoveryAuditSources, stores: ReadonlyMap<string, RecoveryRead["store"]>): Promise<Map<string, RecoveryFacts>> {
  if (!live.length) return new Map();
  const borrow = await rs.borrow();
  const by = new Map(live.map((l) => [l.project, l]));
  const io: FactsIo = { now, svc, readSpec: rs.readSpec, drafts: (p) => rs.drafts(p, by.has(p) ? by.get(p)!.docsDir : getMeta(db, p).docsDir),
    pool: (p) => { const remote = config.projects[p]?.remote ?? null; return { remote, borrow: !remote || remote.mode === "off" ? [] : borrow }; } };
  const facts = new Map(svc.projects.map((p) => [p, readPlanGapFacts(db, p, io)]));
  const seen = new Map<string, { fp: string; since: number }>();
  for (const g of assessPlanGap([...facts.values()])) {
    const row = stores.get(g.project)?.open.find((o) => o.key === `${g.project}|recovery_plan_gap|${g.fingerprint}`);
    if (row) seen.set(g.project, { fp: g.fingerprint, since: row.firstSeen });
  }
  const outs = await planGapTick({ db, now, projects: svc.projects, policy: (p) => ({ mode: "observe", manualAfterMs: by.get(p)?.ms ?? null }),
    facts: (p) => facts.get(p)!, notifyPm: never, seen });
  return new Map(outs.flatMap((o): [string, RecoveryFacts][] => {
    if (!by.has(o.project)) return []; // 只当竞争者的项目不出结果
    const mark = seen.get(o.project); // tick 只给「容量空着且有计划卡住」的项目留记号
    if (o.mode === "off" || !mark) return [[o.project, { found: [] }]];
    if (by.get(o.project)!.ms === null) return [[o.project, { found: [], note: `owner 未设 manualStallHours：计划不足（画面 ${mark.fp}）只观察、不提醒` }]];
    return [[o.project, { found: [{ keyParts: [mark.fp], taskId: null, since: mark.since, due: o.action === "would_notify", detail: oneLine(planGapText(o.gap), 900),
      suggestion: "按清单补规格 / 解前置 / 把草稿并进 DAG，或确认眼下不需要用满容量（只提醒，不替 PM 选范围、不改 DAG）" }] }]];
  }));
}

/** 各项目的恢复事实（AUD）：每个机制单独兜错，读不了的写明原因、规则这轮不跑；全程只读，--dry-run 的 query_only 连接也能跑 */
async function readRecoveryAudit(db: Database, projects: readonly { project: string; docsDir: string | null }[], now: number,
  rs: RecoveryAuditSources): Promise<Map<string, RecoveryRead>> {
  const stores = new Map(projects.map((p) => [p.project, recoveryStore(db, p.project)]));
  const out = new Map<string, RecoveryRead>();
  const fail = (what: string, e: unknown): RecoveryFacts => {
    console.error(`⚠️ [ledger audit] ${what}读不了：${(e as Error).message}`); // 细节只进本机日志，skipped 里不带错误原文
    return { unread: `${what}读不了` };
  };
  let config: SchedulerConfig, svc: ServiceFacts;
  try {
    config = rs.config();
    svc = serviceFacts(config);
  } catch (e) {
    const bad = fail("调度配置", e);
    for (const p of projects) out.set(p.project, { store: stores.get(p.project) ?? null, facts: { recovery_manual_stalled: bad, recovery_plan_gap: bad } });
    return out;
  }
  const outside: RecoveryFacts = { unread: "项目不在调度服务名单（scheduler.json），没取数" };
  const live: { project: string; ms: number | null; docsDir: string | null }[] = [];
  const gaps = new Map<string, RecoveryFacts>();
  for (const p of projects) {
    const inService = svc.projects.includes(p.project), m = recoveryGate(rs.policy, p.project, "manualStall"), g = recoveryGate(rs.policy, p.project, "planGap");
    const manual = !inService ? outside : "unread" in m ? m : await manualFacts(db, p.project, now, svc, m.ms).catch((e) => fail("manual 停滞事实", e));
    if (!inService) gaps.set(p.project, outside);
    else if ("unread" in g) gaps.set(p.project, g);
    else live.push({ ...p, ms: g.ms });
    out.set(p.project, { store: stores.get(p.project) ?? null, facts: { recovery_manual_stalled: manual, recovery_plan_gap: outside } });
  }
  const read = await planGapFacts(db, live, now, svc, config, rs, stores).catch((e) => new Map(live.map((l) => [l.project, fail("计划不足事实", e)])));
  for (const [project, r] of out) r.facts.recovery_plan_gap = gaps.get(project) ?? read.get(project) ?? { found: [] };
  return out;
}

/** 台账库此刻的版本：别的连接提交过（data_version）或本连接改过行（total_changes）就会变 */
const dbVersion = (db: Database): string => `${(db.query("PRAGMA data_version").get() as { data_version: number }).data_version}:${
  (db.query("SELECT total_changes() AS n").get() as { n: number }).n}`;

/**
 * 写前复核（`ledger audit` 把返回的函数当 reconcileFindings 的 stale 回调）：取数和写入之间隔着多次 await，别的巡检、PM、owner 可能已经动过。
 * 临写前用同一套原函数（readRecoveryAudit）把这个项目的恢复事实整份重读——策略与阈值、manual 卡的全部适用条件（版本、冻结、暂停、
 * 待批 ask、在途意图、前置）、全服务项目的座位竞争、巡检库里的基线 / 开着 / 已推过的行——哪条规则和快照不一样，哪条这一轮作废：
 * 发现不写、旧行不关、它名下的待推不出，下一轮用新快照重判。重读本身也有 await，所以写事务里再比一次台账库版本：
 * 重读开始后库又变过（哪个连接改的都算）就两条规则都作废。事务外的文件（策略、scheduler.json、规格卡）只保证读到重读那一刻。
 */
export async function recoveryStale(db: Database, s: Pick<AuditSnapshot, "project"> & RecoveryAuditInputs, now: number,
  src: SnapshotSources = realSources): Promise<() => AuditRule[]> {
  const then = s.recovery, rs = src.recovery ?? (src === realSources ? realRecovery : null);
  if (!then || !rs) return () => []; // 没取恢复事实：规则本来就没评估
  const version = dbVersion(db), pre = (rule: string) => `${s.project}|${rule}|`;
  const view = (r: RecoveryRead, rule: (typeof RECOVERY_RULES)[number]) => JSON.stringify([r.facts[rule], r.store && [r.store.baseline.includes(rule),
    r.store.open.filter((o) => o.rule === rule), r.store.told.filter((k) => k.startsWith(pre(rule)))]]);
  const cur = await readRecoveryAudit(db, [{ project: s.project, docsDir: getMeta(db, s.project).docsDir }], now, rs).then((m) => m.get(s.project), () => undefined);
  const moved = RECOVERY_RULES.filter((rule) => !cur || view(cur, rule) !== view(then, rule)); // 重读失败：不拿旧结论写
  return () => (dbVersion(db) === version ? moved : [...RECOVERY_RULES]);
}

/**
 * 一轮巡检的台账读（X7）：所有项目的 tasks / events / steps / deps / meta 和各张调度表在同一个 deferred 读事务里取（query_only 连接也能跑），
 * 别的连接中途提交的「stage 变了 + 新 stage 事件」要么整个看到、要么整个看不到——不会拿新阶段配旧事件。
 * 事务里只有同步的库读；registry、tmux、CI、规格卡这些台账外的事实在事务外取（collectAuditSnapshots）。
 */
function readLedgerFacts(db: Database, projects: readonly string[], now: number) {
  return db.transaction(() => {
    const steps = stepsByTask(db);
    return projects.map((project) => {
      const byTarget = new Map<string, LedgerEvent[]>();
      for (const e of listEvents(db, { project })) byTarget.set(e.target, [...(byTarget.get(e.target) ?? []), e]);
      const all = listTasks(db, project);
      const deps = depViews(listDeps(db, project), all);
      const meta = getMeta(db, project);
      const tasks = all.map((task) => ({
        task, events: byTarget.get(task.id) ?? [], blockedBy: blockedBy(task.id, deps).map((d) => d.from), unblockedAt: unblockedAt(task.id, deps, all, byTarget),
        reviewStep: task.stage === "review" ? pendingReview(task, steps.get(task.id) ?? []) : null,
        workflowMode: getWorkflow(db, task.id)?.mode ?? null,
        ...(task.stage === "build" || task.stage === "fix" ? { gate: gateInputs(db, task) } : {}), // dispatch_blocked's own facts
      }));
      const unfrozenAt = byTarget.get("")?.findLast((e) => e.kind === "unfreeze")?.ts ?? null;
      const lendTransit = readLendTransit(db, project); // AUDLEND1：出借在途的单（ledger-audit-idle.ts）
      return { project, meta, tasks, unfrozenAt, mergeUnknown: unknownMerges(db, project), wait: readWaitAuditSnapshot(db, project), lendTransit,
        lendGrants: readLendGrants(db, project, now), mergeTrain: readMergeTrain(db, project, tasks) }; // AUDTRAIN1：谁占着合并列车、列车最近一次空出（ledger-audit-train.ts）
    });
  }).deferred();
}

export async function collectAuditSnapshots(db: Database, projects: readonly string[], now: number, src: SnapshotSources = realSources): Promise<AuditSnapshot[]> {
  const perProject = readLedgerFacts(db, projects, now).map((p) => ({ ...p, tasks: p.tasks.map((t) => ({ ...t,
    ...(p.meta.team ? { specPolicy: specPathFor(t.task, p.meta.docsDir) ? specPolicyOf(t.task, p.meta.docsDir) : null } : {}) })) }));
  // 只给用得上的人抓屏 / 看会话文件：build / fix 的执行者（空闲规则）、各项目 PM 名单（押后规则）、review 派给的本机审查员
  const want = new Set<string>();
  for (const p of perProject) {
    p.meta.pms.forEach((x) => want.add(x));
    for (const { task, reviewStep } of p.tasks) {
      if (task.agent && (task.stage === "build" || task.stage === "fix")) want.add(task.agent);
      if (reviewStep?.executorKind === "agent") want.add(reviewStep.executor);
    }
  }
  const got = await readAgents(src, want);
  const reg = typeof got === "string" ? null : got;
  const byChannel = new Map((reg?.list ?? []).filter((a) => a.channelId).map((a) => [a.channelId as string, a.name]));
  const held: Got<AuditHeld[]> = reg ? readHeld(src.heldPath, byChannel) : { value: null };
  const get = src.mergeCi ?? (src === realSources ? liveMergeCi : null), ci = new Map(await Promise.all(perProject.map(async (p) => [p.project, await get?.(p.project, p.tasks, now, db)] as const)));
  const readPr = src.handoffPr ?? (src === realSources ? undefined : null);
  const prs = new Map(await Promise.all(perProject.map(async (p) => [p.project, readPr === null ? undefined : await collectHandoffPr(p.tasks, readPr)] as const)));
  // AUDLEND1：只给本来要被报空闲的执行者查后台 shell
  const bg = src.bgShell ?? (src === realSources ? agentBgShell : null), byName = new Map((reg?.list ?? []).map((a) => [a.name, a]));
  const probe = async (name: string) => { const a = byName.get(name); return !!a && !!bg && bg(a); };
  const mirrorDir = src.mirrorDir ?? (src === realSources ? STATE_DIR : null);
  const rs = src.recovery ?? (src === realSources ? realRecovery : null);
  const recovery = rs ? await readRecoveryAudit(db, perProject.map((p) => ({ project: p.project, docsDir: p.meta.docsDir })), now, rs) : null;
  const shells = new Map(await Promise.all(perProject.map(async (p) =>
    [p.project, reg && bg ? await readBgShells(p.tasks, p.lendTransit, reg.agents, now, AUDIT_THRESHOLDS.executorIdleMs, probe) : []] as const)));
  return perProject.map(({ project, meta, tasks, unfrozenAt, mergeUnknown, wait, lendTransit, lendGrants }) => {
    const reviewers: Got<ReviewerRef[]> = reg ? projectReviewers(src, reg.list, project, meta.pms, now) : { value: null };
    const inbox = readOwnerInbox(meta.docsDir);
    const unavailable: AuditSnapshot["unavailable"] = {
      ...(typeof got === "string" ? { agents: got } : {}),
      ...(reg?.agents.some((a) => a.windowAlive === null) ? { windows: "tmux 没列出窗口" } : {}),
      ...(held.reason ? { held: held.reason } : {}), ...(reviewers.reason ? { reviewers: reviewers.reason } : {}),
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
      mergeUnknown, mergeCi: ci.get(project), handoffPr: prs.get(project), mergePm: readMergePm(db, project, now), lendGrants, lendGrantBaseline: readLendGrantBaseline(db, project),
      lendGrantTold: readLendGrantTold(db, project), lendGrantOpen: readLendGrantOpen(db, project),
      ...readAuditTrain(db, project, tasks), // 外部读取可能推进合并；最终同步重读列车与槽，避免把已合并卡标成排队。
      stall: readStallAudit(db, project, src),
      lendTransit, bgShells: shells.get(project), // AUDLEND1（ledger-audit-idle.ts）
      ...(mirrorDir ? { mirrorPush: readMirrorPush(db, project, mirrorDir) } : {}), // N8B7：共享镜像推送失败（ledger-audit-mirror.ts）
      ...(recovery ? { recovery: recovery.get(project) } : {}), // AUD：manual 停滞行动卡 / 计划不足（readRecoveryAudit）
      held: held.value,
      ownerInbox: inbox.value,
      ...wait,
      unavailable,
    };
  });
}
