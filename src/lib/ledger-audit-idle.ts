/**
 * AUDLEND1：巡检判「执行者空闲 / 孤儿」时认出借在途和后台 shell（规则本体仍在 ledger-audit.ts executorIdle / registryRules）。
 * 这里只提供只读事实和判定，落库 / 去重 / 发送、出借、租约、调度都不动：
 * - 出借在途：卡有活出借单（pooled / claimed / unknown，同卡至多一张）且 step 是 write / fix。真正干活的是对方 worker，
 *   本机会话按设计只复述（ledger-lend-relay.ts lentAwayText），进度在那张单心跳里的 lastActivityAt。
 * - 后台 shell：本机执行者用 run_in_background 跑长命令时主回合空闲、会话不写。来源复用 bg-shell-dirs.ts（主会话 jsonl 里 CC 登记的启动结果）
 *   和 bg-shell-progress.ts 的结束约定（.output 末尾的终止行）；只给本来就要被报空闲的执行者读，读不到 / 认不出 = 没有。
 * - 复述会话：本机执行者在某张卡上登记过作者（最后一条 worker_register、role=author 是它），而这张卡派给了 peer 或出借在途。
 * 开关 = 恢复策略 auditIdleFacts（缺省 observe）：off 与原来逐字一致；observe 照原样报，会被改变结果的条目在 detail 末尾加注；
 * on 按上面三条判。没有 lend_orders 表 / 读失败 / 策略读不了 = 按 off。tests/ledger-audit-idle*.test.ts。
 */
import type { Database } from "bun:sqlite";
import { basename, join } from "node:path";
import { findSessionOutput, reportedShells } from "./bg-shell-dirs.js";
import { feedShellChunk, newShellProgress, settleShellTail } from "./bg-shell-progress.js";
import { projectsSlug } from "./jsonl-cost.js";
import { LEND_LIVE } from "./ledger-lend-schema.js";
import { currentStageMark, stageTimeline } from "./ledger-metrics.js";
import { TERMINAL_STAGES, type LedgerEvent, type LedgerTask } from "./ledger-stages.js";
import type { RecoveryMode, RecoveryPolicyPort } from "./recovery-policy.js";
import { sessionJsonlPath } from "./session-source.js";

const MIN = 60_000;
/** 本机执行者有后台 shell 在跑时的空闲阈值：满了照报 */
const BG_SHELL_IDLE_MS = 60 * MIN; // 满 60 分钟照报（< 才放过）
/** 判终止行只读 .output 的尾部这么多字节（终止行是最后一行） */
const OUTPUT_TAIL_BYTES = 4096;
/** 找登记记录时整份读主会话 jsonl，一块这么多字节 */
const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
const TRANSIT_STEPS: readonly string[] = ["write", "fix"];
const BG_NOTE = "（后台 shell 在跑）";
/** 复述会话的卡走完了：出借卡合并上线后本机复述会话就没事了，verified 也算（同 agent-lifecycle.ts FINISHED_STAGES） */
const RELAY_ENDED: readonly string[] = ["verified", ...TERMINAL_STAGES];

export interface LendTransitFact {
  orderId: string;
  peer: string;
  step: string;
  status: string;
  leaseUntil: number | null;
  /** 心跳摘要里对方 worker 最近一次活动的时刻；还没有心跳 / 认不出 = null */
  lastActivityAt: number | null;
}

export interface IdleFactInputs {
  /** 卡 → 它出借在途的那张单；undefined = 没有 lend_orders 表 / 读失败 / 快照没带：三条规则都按原样 */
  lendTransit?: Readonly<Record<string, LendTransitFact>>;
  /** 有后台 shell 还在跑的本机执行者（只查了本来要被报空闲的那些） */
  bgShells?: readonly string[];
}

/** 只读取数：本项目各卡出借在途的那张单 */
export function readLendTransit(db: Database, project: string): Record<string, LendTransitFact> | undefined {
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lend_orders'").get()) return undefined;
    const rows = db.query(`SELECT orderId, taskId, peer, step, status, leaseUntil, beat FROM lend_orders
      WHERE project = ? AND status IN (${LEND_LIVE.map(() => "?").join(", ")})`).all(project, ...LEND_LIVE) as
      (Omit<LendTransitFact, "lastActivityAt"> & { taskId: string; beat: string | null })[];
    const out: Record<string, LendTransitFact> = {};
    for (const { taskId, beat, ...r } of rows) if (TRANSIT_STEPS.includes(r.step)) out[taskId] = { ...r, lastActivityAt: beatActivity(beat) };
    return out;
  } catch {
    return undefined; // 老库没有 beat 列 / 库读不了：当作没有这张表
  }
}

function beatActivity(beat: string | null): number | null {
  try {
    const at = (JSON.parse(beat ?? "null") as { lastActivityAt?: unknown } | null)?.lastActivityAt;
    return typeof at === "number" && at > 0 ? at : null;
  } catch {
    return null; // 摘要坏了：当还没有心跳
  }
}

/** .output 末尾是不是终止行（bg-shell-progress.ts 的口径：最后一行、整行精确匹配）；读不了 = 当已结束（不放宽阈值） */
async function outputEnded(file: string): Promise<boolean> {
  try {
    const f = Bun.file(file);
    const st = newShellProgress();
    const fed = feedShellChunk(st, new Uint8Array(await f.slice(Math.max(0, f.size - OUTPUT_TAIL_BYTES), f.size).arrayBuffer()));
    return !!(fed.end ?? settleShellTail(st)?.end);
  } catch {
    return true;
  }
}

/**
 * 主会话 jsonl 从头到尾 CC 登记过的后台 shell（任务 id）。不用 ReportedShellDirs：它首次只读尾部 512 KB，shell 起了以后会话又写过这么多，
 * 启动记录就在窗口外了，而巡检每轮是新进程、没有累计。这里整份分块读，行的认法仍是 bg-shell-dirs.ts 的 reportedShells；末尾没写完的半行不认。
 */
async function registeredShells(jsonlPath: string, slug: string): Promise<Set<string>> {
  const f = Bun.file(jsonlPath), size = f.size, ids = new Set<string>();
  let carry = new Uint8Array(0);
  for (let off = 0; off < size; off += SCAN_CHUNK_BYTES) {
    const part = new Uint8Array(await f.slice(off, Math.min(size, off + SCAN_CHUNK_BYTES)).arrayBuffer());
    const buf = new Uint8Array(carry.length + part.length);
    buf.set(carry);
    buf.set(part, carry.length);
    const used = buf.lastIndexOf(10) + 1; // 只吃到最后一个换行：跨块的行留到下一块拼完整
    for (const r of reportedShells(new TextDecoder().decode(buf.subarray(0, used)), slug)) ids.add(r.id);
    carry = buf.subarray(used);
  }
  return ids;
}

/** 主会话 jsonl 里 CC 登记过的后台 shell 里，有没有 .output 还没有终止行的；shellRoot = `<…>/<slug>`（各会话的 tasks/ 在它下面） */
export async function bgShellRunning(jsonlPath: string, shellRoot: string): Promise<boolean> {
  try {
    for (const id of await registeredShells(jsonlPath, basename(shellRoot))) {
      const file = await findSessionOutput(shellRoot, id);
      if (file && !(await outputEnded(file))) return true; // 输出文件找不到 = 认不出，不算在跑
    }
  } catch { /* 读不到一律按没有后台 shell */ }
  return false;
}

/** 生产的探针：按 registry 里的 cwd / sessionId 定位主会话 jsonl 和 CC 的 shell 根（同 bg-activity-watcher.ts shellTasksDirFor） */
export async function agentBgShell(a: { runtime?: string; cwd?: string; sessionId?: string }): Promise<boolean> {
  const jsonl = a.cwd && a.sessionId ? sessionJsonlPath(a.runtime, a.cwd, a.sessionId) : null;
  if (!jsonl || !a.cwd) return false;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return bgShellRunning(jsonl, join("/tmp", `claude-${uid}`, projectsSlug(a.cwd)));
}

interface Card { task: LedgerTask; events: readonly LedgerEvent[] }
interface IdleAgent { name: string; turn: string; lastWriteAt: number | null }

/** 进入当前阶段的时刻，口径同 ledger-audit.ts facts（导入推断的近似时间 = null） */
function stageSinceOf(events: readonly LedgerEvent[], now: number): number | null {
  if (currentStageMark(events)?.data.approxTime === true) return null;
  return stageTimeline(events, now).at(-1)?.from ?? null;
}

/**
 * 快照用：只给本来就要被报空闲的本机执行者查后台 shell（条件同 executorIdle：build / fix、主回合不忙、本阶段没 deliver、满 idleMs 没写），
 * 出借在途的卡不查（那里不看本机会话）。probe 出错 = 没有。
 */
export async function readBgShells(tasks: readonly Card[], lent: IdleFactInputs["lendTransit"], agents: readonly IdleAgent[], now: number, idleMs: number,
  probe: (agent: string) => Promise<boolean>): Promise<string[]> {
  if (!lent) return [];
  const byName = new Map(agents.map((a) => [a.name, a]));
  const due = new Set<string>();
  for (const { task, events } of tasks) {
    const a = task.agent ? byName.get(task.agent) : undefined;
    const stageSince = stageSinceOf(events, now);
    if ((task.stage !== "build" && task.stage !== "fix") || stageSince === null || !a || lent[task.id]) continue;
    if (a.turn === "busy" || a.turn === "compacting" || events.some((e) => e.kind === "deliver" && e.ts >= stageSince)) continue;
    if (now - Math.max(stageSince, a.lastWriteAt ?? stageSince) > idleMs) due.add(a.name);
  }
  const running = (name: string) => probe(name).catch(() => false); // 探针出错：按没有后台 shell
  const hits = await Promise.all([...due].map(running));
  return [...due].filter((_, i) => hits[i]);
}

type IdleEmit = (f: { rule: "executor_idle"; taskId: string; since: number; detail: string; suggestion: string; keyParts: (string | number)[] }) => void;

export interface IdleRules<T extends Card> {
  /** on 且卡出借在途：executor_idle 由出借单判，返回 true = 这张卡判完了（本机会话不看） */
  lent(card: { task: LedgerTask; stageSince: number; delivered: boolean }, now: number, emit: IdleEmit): boolean;
  /** 本机执行者按原规则要报空闲时：hold = 这一轮不报；note = 加在 detail 末尾 */
  local(task: LedgerTask, since: number, now: number): { hold: boolean; note: string };
  /** 本机执行者当复述会话的卡：own = 算它的任务、going = 其中还有没走完的（on）；两个 note = observe 下加在孤儿 / 回收 detail 末尾的说明 */
  relay(agent: string): { own: readonly T[]; going: boolean; orphanNote: string; reclaimNote: string };
}

const PLAIN = { hold: false, note: "" } as const;
const NO_RELAY = { own: [], going: false, orphanNote: "", reclaimNote: "" } as const;
const OFF: IdleRules<never> = { lent: () => false, local: () => PLAIN, relay: () => NO_RELAY };
const mins = (ms: number) => `${Math.floor(ms / MIN)} 分钟`;
const live = (t: Card) => !RELAY_ENDED.includes(t.task.stage);

function idleMode(policy: RecoveryPolicyPort, project: string): RecoveryMode {
  try {
    return policy(project, "auditIdleFacts").mode;
  } catch {
    return "off"; // 策略读不了：保守按原规则
  }
}

function lendNote(o: LendTransitFact, now: number): string {
  const state = o.status !== "claimed" ? (o.status === "pooled" ? "等领单" : "单子未知")
    : o.lastActivityAt === null ? "还没有心跳" : `对方最近活动 ${mins(now - o.lastActivityAt)}前`;
  return `（出借在途：${o.peer} 单 ${o.orderId}，${state}）`;
}

/** 各本机会话当复述会话的卡：卡上最后一条作者登记是它，且卡派给了 peer 或出借在途 */
function relayCards<T extends Card>(ts: readonly T[], lent: NonNullable<IdleFactInputs["lendTransit"]>): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const t of ts) {
    if (t.task.assigneeKind !== "peer_agent" && !lent[t.task.id]) continue;
    const author = t.events.findLast((e) => e.data.op === "worker_register" && e.data.role === "author")?.data.agent;
    if (typeof author === "string" && author) out.set(author, [...(out.get(author) ?? []), t]);
  }
  return out;
}

/** 给 executorIdle / registryRules 用；idleMs = 原空闲阈值（AUDIT_THRESHOLDS.executorIdleMs）。没带出借事实或 off = 原规则 */
export function idleRules<T extends Card>(s: { project: string } & IdleFactInputs, ts: readonly T[], policy: RecoveryPolicyPort, idleMs: number): IdleRules<T> {
  const lent = s.lendTransit;
  const mode = lent ? idleMode(policy, s.project) : "off";
  if (!lent || mode === "off") return OFF;
  const shells = new Set(s.bgShells ?? []);
  const relays = relayCards(ts, lent);
  return {
    lent({ task, stageSince, delivered }, now, emit) {
      const o = mode === "on" ? lent[task.id] : undefined;
      if (!o) return false;
      // pooled / unknown 各有自己的机制（等领单、单子未知）；本阶段已交付的同原规则不报
      const since = Math.max(stageSince, o.lastActivityAt ?? stageSince);
      if (o.status !== "claimed" || delivered || now - since <= idleMs) return true;
      emit({ rule: "executor_idle", taskId: task.id, since, keyParts: [task.id, task.stage, stageSince, o.orderId, since],
        detail: `${task.id} 在 ${task.stage}，出借给 ${o.peer}（单 ${o.orderId}），对方 worker 已 ${mins(now - since)}没有活动，还没交付`,
        suggestion: `ledger lend-orders ${task.id} 看单子，再问对方 worker 卡在哪` });
      return true;
    },
    local(task, since, now) {
      const o = lent[task.id];
      if (o) return { hold: false, note: lendNote(o, now) }; // 只有 observe 走到这里：on 下出借在途的卡已由 lent 判完
      if (!task.agent || !shells.has(task.agent)) return PLAIN;
      return { hold: mode === "on" && now - since < BG_SHELL_IDLE_MS, note: BG_NOTE };
    },
    relay(agent) {
      const cards = relays.get(agent) ?? [];
      if (!cards.length) return NO_RELAY;
      const going = cards.find(live);
      if (mode === "on") return { own: cards, going: !!going, orphanNote: "", reclaimNote: "" };
      const last = cards[cards.length - 1];
      const transit = going ? `（复述会话：${going.task.id} 出借在途）` : "";
      return { own: [], going: false, orphanNote: transit || `（复述会话：${last.task.id} 已 ${last.task.stage}）`, reclaimNote: transit };
    },
  };
}
