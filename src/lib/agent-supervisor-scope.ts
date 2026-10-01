/**
 * 监护名单（i28-S1）：只管「手上有活」的 agent，两类：
 * - 调度器派出、还没结的单：自动流程卡上 active 的 scheduler session，台账里最近一张派给它的单已发出（done）、还没有交付 / 结论；
 * - 别的 agent 用 send_to_agent 发来、回程还挂着的请求：已经送到它手上（不在押后队列里）、还没过期（与 bridge 的 PAC_STALE_MS 同值）。
 * 一律不管：master、出借 worker（agent-lend-*，它有自己的看门狗 R5a）、不在 scheduler.json 里的项目、按项目关了的、registry 的
 * session 不是台账绑定的那个（换了会话 = 已不是派单那个上下文）。scheduler.json 没开或 supervise 关了，名单恒为空（零变化）。
 * bridge（失败卡要不要推 owner）和调度服务（处置）用同一个函数，两边看到的名单一致。tests/agent-supervisor-scope.test.ts。
 */
import type { Database } from "bun:sqlite";
import { requestExpired, requestStillHeld, type HeldFromLike } from "./held-pac.js";
import { HELD_MESSAGES_PATH, statePath } from "./paths.js";
import { readJsonStateSync } from "./state-file.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { isMasterAgent, type RegistryAgent } from "./registry.js";
import { LEND_WORKER_PREFIX } from "./runtimes/clean-env.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import { stepOfNode, ledgerResult } from "./scheduler-work-order.js";
import { workKeyOf, type WorkRef } from "./agent-supervisor-policy.js";

/** 与 bridge.ts 的 PAC_STALE_MS 同值：回程簿两小时没消化就会被扫掉，过了这个点就不算「还在等」 */
export const CALL_STALE_MS = 2 * 3_600_000;

export interface Supervised {
  agent: string;
  channelId: string;
  sessionId: string;
  project: string;
  runtime: string;
  /** acp = ACP 宿主（判卡住只对它）；tmux = 窗口里的 CLI（只管窗口没了） */
  transport: "acp" | "tmux";
  work: WorkRef;
}

/** 回程簿落盘的一槽里监护要看的字段（bridge/agent-calls.ts PendingAgentCall 的子集；老格式没有 requests = 整槽当一条） */
export interface CallRow {
  callerChannelId: string;
  callerName: string;
  targetName: string;
  targetChannelId?: string;
  ts: number;
  requests?: { messageId?: string; ts: number; deliveredAt?: number }[];
}

/** 这个项目开没开监护：scheduler.json 开着、项目在里面、supervise 没关（全局与项目两级） */
export function superviseOn(config: SchedulerConfig, project: string | undefined): boolean {
  if (!config.enabled || config.supervise?.enabled !== true || !project) return false;
  const p = config.projects[project];
  return !!p && p.supervise !== false;
}

/** 名字上就不归监护管的：master、出借 worker */
export const exemptAgent = (name: string): boolean => isMasterAgent(name) || name.startsWith(LEND_WORKER_PREFIX);

const hasTable = (db: Database, name: string): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

interface SessionRow { taskId: string; role: "author" | "reviewer"; agent: string; sessionId: string }
interface IntentRow { id: string; taskId: string; action: string; node: string; status: string; recipient: string | null; head: string | null }

/** 这个 session 手上那张已发出、还没结果的单；没有 = null */
function inFlightOrder(db: Database, s: SessionRow): WorkRef | null {
  const wf = getWorkflow(db, s.taskId);
  if (!wf || wf.mode !== "auto") return null; // 退回人工的卡归 PM，不再自动处置
  const last = db.query(`SELECT id, taskId, action, node, status, recipient, head FROM scheduler_intents
    WHERE taskId = ? AND action IN ('dispatch','review') ORDER BY eventSeq DESC LIMIT 1`).get(s.taskId) as IntentRow | null;
  if (!last || last.status !== "done" || last.recipient !== s.agent) return null;
  const reviewer = last.action === "review" || last.node === "adversarial_review";
  if (reviewer !== (s.role === "reviewer")) return null;
  const step = stepOfNode(last.node);
  if (!step) return null;
  const ref = { taskId: s.taskId, role: s.role, agent: s.agent, sessionId: s.sessionId, family: "claude" as const, transport: "tmux" as const };
  if (ledgerResult(db, ref, { step, head: last.head, dedupKey: last.id, round: 0 })) return null;
  return { kind: "order", taskId: s.taskId, intentId: last.id, step };
}

/** 每个 agent 最多一件：同时有单和请求时以单为准（派活方是调度器） */
function ordersByAgent(db: Database | null): Map<string, { work: WorkRef; sessionId: string }> {
  const out = new Map<string, { work: WorkRef; sessionId: string }>();
  if (!db || !hasTable(db, "scheduler_sessions") || !hasTable(db, "scheduler_intents")) return out;
  const rows = db.query("SELECT taskId, role, agent, sessionId FROM scheduler_sessions WHERE state = 'active' ORDER BY updatedAt DESC").all() as SessionRow[];
  for (const s of rows) {
    if (out.has(s.agent)) continue;
    const work = inFlightOrder(db, s);
    if (work) out.set(s.agent, { work, sessionId: s.sessionId });
  }
  return out;
}

/** 送到了 target 手上、还没过期的那几条里最早的一条：它的送达时刻当这件活的键（同一批请求不因后到的一条换键） */
function callFor(row: CallRow, held: HeldFromLike[] | undefined, now: number): WorkRef | null {
  const reqs: { messageId?: string; ts: number; deliveredAt?: number }[] = row.requests?.length ? row.requests : [{ ts: row.ts }];
  const live = reqs.filter((r) => !requestStillHeld({ messageId: r.messageId, callerChannelId: row.callerChannelId }, held) &&
    !requestExpired(r, row, held, now, CALL_STALE_MS));
  if (!live.length) return null;
  const since = Math.min(...live.map((r) => r.deliveredAt ?? r.ts));
  return { kind: "call", caller: row.callerName, callerChannelId: row.callerChannelId, since };
}

export interface ScopeInput {
  config: SchedulerConfig;
  registry: RegistryAgent[];
  db: Database | null;
  calls: CallRow[];
  /** 押后队列：target 频道 → 还押着、它没看到的消息 */
  held: (targetChannelId: string) => HeldFromLike[] | undefined;
  now: number;
}

export function supervisedAgents(input: ScopeInput): Supervised[] {
  const { config, registry, now } = input;
  if (!config.enabled || config.supervise?.enabled !== true) return [];
  const orders = ordersByAgent(input.db);
  const out: Supervised[] = [];
  for (const row of registry) {
    if (exemptAgent(row.name) || row.status === "stopped" || !row.sessionId || !row.channelId || !superviseOn(config, row.projectId)) continue;
    const order = orders.get(row.name);
    let work: WorkRef | null = null;
    if (order) work = order.sessionId === row.sessionId ? order.work : null;
    else {
      const calls = input.calls.filter((c) => c.targetName === row.name || (c.targetChannelId && c.targetChannelId === row.channelId));
      const held = input.held(row.channelId);
      const sinceOf = (w: WorkRef) => (w.kind === "call" ? w.since : 0);
      work = calls.map((c) => callFor(c, held, now)).filter((w): w is WorkRef => !!w).sort((a, b) => sinceOf(a) - sinceOf(b))[0] ?? null;
    }
    if (!work) continue;
    out.push({ agent: row.name, channelId: row.channelId, sessionId: row.sessionId, project: row.projectId as string,
      runtime: row.runtime ?? "claude-code", transport: row.transport === "acp" ? "acp" : "tmux", work });
  }
  return out;
}

/**
 * 这个 agent 此刻还在名单里、会话和在途的活都没换吗（换了 / 不在 = null）：调度服务认领后的复核（agent-supervisor.ts eligible）
 * 和 `manager restart --expect` 拿锁后的复核（manager/restart-expect.ts）用同一个判定，PM 换会话、活交了、退回人工、开关关了都算换。
 */
export function stillSupervised(input: ScopeInput, want: { agent: string; sessionId: string; workKey: string }): Supervised | null {
  const s = supervisedAgents(input).find((x) => x.agent === want.agent);
  return s && s.sessionId === want.sessionId && workKeyOf(s.work) === want.workKey ? s : null;
}

/** bridge/agent-calls.ts 落盘的回程簿（bridge 是唯一写者，这里只读） */
const PENDING_CALLS_PATH = statePath("pending-agent-calls.json");

const isObj = (d: unknown): d is Record<string, unknown> => !!d && typeof d === "object" && !Array.isArray(d);

/** 读不到 / 坏了 = 没有在等的请求：最坏少监护几个 agent，不会多处置谁 */
export function readCallRows(path = PENDING_CALLS_PATH): CallRow[] {
  const r = readJsonStateSync(path, isObj);
  if (r.status !== "ok") return [];
  return Object.values(r.data as Record<string, unknown>).filter((c): c is CallRow => isObj(c) && typeof c.callerChannelId === "string" &&
    typeof c.callerName === "string" && typeof c.targetName === "string" && typeof c.ts === "number");
}

/**
 * 押后队列里每个 target 频道还押着、它没看到的消息（bridge/held-queue.ts unseenFrom 的同一判据：check_inbox 领走的算看到了）。
 * 读不到按「什么都没押」：那样回程簿里的请求都算送到了，最坏多监护一个本来就有活的 agent。
 */
export function readHeld(path = HELD_MESSAGES_PATH): (channelId: string) => HeldFromLike[] | undefined {
  const r = readJsonStateSync(path, isObj);
  const data = r.status === "ok" ? (r.data as Record<string, unknown>) : {};
  return (channelId) => {
    const q = data[channelId];
    if (!Array.isArray(q)) return undefined;
    return q.filter((i) => isObj(i) && !i.lease && isObj(i.env)).map((i) => {
      const env = (i as { env: { from?: { kind?: string; channelId?: string }; meta?: { messageId?: string } } }).env;
      return { fromKind: String(env.from?.kind ?? ""), fromChannelId: env.from?.kind === "local" ? env.from.channelId : undefined, messageId: env.meta?.messageId };
    });
  };
}
