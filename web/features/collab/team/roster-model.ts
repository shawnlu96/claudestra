/**
 * 团队名册纯模型（team-roster-ROSTER3）：名册回包解析 + 目录 + 实例归属 + 投影 → 人 → 机器 → 位子格 → worker → 卡。
 * 不 import react / next / 任何 hook，不发请求（ROSTER4 接线）。界面词只出 i18n key，由 ROSTER4 的 roster-i18n.ts 翻。
 * 归人不猜：本机归 selfPersonId，peer 只经 instances 按 instanceId 找人，找不到进「未认领的机器」。单测 tests/web-roster-model.test.ts。
 */
import type { TeamDirectoryMember } from "@/lib/shared-projects-model";
import type { WorkBoard, WorkRow } from "../work/work-types";
import {
  LOCAL_MACHINE_KEY, ROSTER_FAMILIES, type Roster, type RosterCards, type RosterFamily, type RosterMachine, type RosterOutputDay,
  type RosterQuota, type RosterSlot, type RosterWorker,
} from "./roster-types";

// 同 web/features/collab/team-body/team-body-model.ts:18：代号里夹长十六进制（实例 / 任务 id 形状）就不当名字
const LONG_HEX = /[0-9a-f]{16,}/i;

// ---------- 解析 ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
/** 数值字段不是有限数 → 抛 BAD，整台机器丢弃 */
const BAD = Symbol("bad");
const fin = (v: unknown): number => { if (typeof v === "number" && Number.isFinite(v)) return v; throw BAD; };
const finOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : fin(v));
const str = (v: unknown): string => { if (typeof v === "string") return v; throw BAD; };
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : str(v));
const bool = (v: unknown): boolean => { if (typeof v === "boolean") return v; throw BAD; };
const strs = (v: unknown): string[] => { if (Array.isArray(v) && v.every(s => typeof s === "string")) return [...v]; throw BAD; };
const oneOf = <T extends string>(v: unknown, all: readonly T[]): T => { if (all.includes(v as T)) return v as T; throw BAD; };

function slotOf(v: unknown): RosterSlot | null {
  if (v === null || v === undefined) return null;
  if (!isObj(v)) throw BAD;
  return { total: fin(v.total), busy: fin(v.busy), reportedBusy: finOrNull(v.reportedBusy), placeable: fin(v.placeable), held: bool(v.held) };
}
function quotaOf(v: unknown): RosterQuota | null {
  if (v === null || v === undefined) return null;
  if (!isObj(v)) throw BAD;
  return { usedPct: fin(v.usedPct), resetAt: fin(v.resetAt), stopPct: finOrNull(v.stopPct), observedAt: finOrNull(v.observedAt) };
}
function workerOf(v: unknown): RosterWorker {
  if (!isObj(v)) throw BAD;
  return {
    id: str(v.id), name: strOrNull(v.name), family: oneOf(v.family, ROSTER_FAMILIES), role: oneOf(v.role, ["author", "reviewer"] as const),
    state: oneOf(v.state, ["running", "silent", "no_beat", "unknown"] as const),
    taskId: strOrNull(v.taskId), step: strOrNull(v.step), round: finOrNull(v.round), since: finOrNull(v.since),
    phase: strOrNull(v.phase), excerpt: strOrNull(v.excerpt), beatAt: finOrNull(v.beatAt),
  };
}
function cardsOf(v: unknown): RosterCards {
  if (!isObj(v)) throw BAD;
  return { merge: strs(v.merge), live: strs(v.live), blocked: strs(v.blocked) };
}
function outputOf(v: unknown): RosterOutputDay[] {
  if (!Array.isArray(v)) throw BAD;
  return v.map(d => { if (!isObj(d)) throw BAD; return { day: str(d.day), delivered: fin(d.delivered), reviewed: fin(d.reviewed) }; });
}
const perFamily = <T>(v: unknown, of: (x: unknown) => T): Record<RosterFamily, T> => {
  const o = isObj(v) ? v : v === null || v === undefined ? {} : (() => { throw BAD; })();
  return { claude: of(o.claude), codex: of(o.codex) };
};
function grantOf(v: unknown): RosterMachine["grant"] {
  if (v == null) return null;
  if (!isObj(v)) throw BAD;
  return { roles: strs(v.roles), repos: fin(v.repos), until: fin(v.until), ordersLeftToday: fin(v.ordersLeftToday) };
}
function pausedOf(v: unknown): RosterMachine["paused"] {
  if (v == null) return null;
  if (!isObj(v)) throw BAD;
  return { reason: str(v.reason), until: fin(v.until) };
}
function machineOf(v: unknown): RosterMachine {
  if (!isObj(v)) throw BAD;
  const online = v.online === null || v.online === undefined ? null : typeof v.online === "boolean" ? v.online : (() => { throw BAD; })();
  if (!Array.isArray(v.workers)) throw BAD;
  return {
    machineKey: str(v.machineKey), instanceId: strOrNull(v.instanceId), online,
    checkedAt: finOrNull(v.checkedAt), latencyMs: finOrNull(v.latencyMs), helloAt: finOrNull(v.helloAt),
    proto: v.proto == null ? null : oneOf(v.proto, ["local", "push", "poll"] as const), why: strOrNull(v.why),
    grant: grantOf(v.grant), paused: pausedOf(v.paused),
    slots: perFamily(v.slots, slotOf), quota: perFamily(v.quota, quotaOf),
    workers: v.workers.map(workerOf), cards: cardsOf(v.cards), output: outputOf(v.output),
  };
}

/** 名册回包 → Roster。外层形状不对返回 null（不抛）；单台机器不对整台丢弃并计 dropped，不猜默认值；未知键忽略 */
export function parseRosterWire(x: unknown): Roster | null {
  if (!isObj(x) || !isObj(x.self) || !Array.isArray(x.machines)) return null;
  const instanceId = x.self.instanceId;
  if (instanceId !== null && instanceId !== undefined && typeof instanceId !== "string") return null;
  if (typeof x.now !== "number" || !Number.isFinite(x.now)) return null;
  if (typeof x.project !== "string") return null;
  let unattributed: RosterCards;
  try { unattributed = cardsOf(x.unattributed); } catch (e) {
    if (e !== BAD) throw e;
    return null; // Malformed outer card lists cannot be interpreted as no unassigned cards.
  }
  const machines: RosterMachine[] = [];
  let dropped = 0;
  for (const m of x.machines) {
    try { machines.push(machineOf(m)); } catch (e) {
      if (e !== BAD) throw e;
      dropped++;
    }
  }
  return { now: x.now, project: x.project, self: { instanceId: instanceId ?? null }, machines, unattributed, dropped };
}

// ---------- 位子格 ----------

export type CellState = "running" | "silent" | "pending" | "other" | "held" | "empty" | "unknown";
export interface CellWorker { card: string | null; step: string | null; round: number | null; since: number | null; name: string | null }
export interface Cell { state: CellState; worker: CellWorker | null }
export interface SlotCells { cells: Cell[]; overflow: number; label: string }

const cellOf = (state: CellState, w: RosterWorker | null = null): Cell =>
  ({ state, worker: w && { card: w.taskId, step: w.step, round: w.round, since: w.since, name: w.name } });

/** 一台机器一个家族的位子格：running → silent → pending → other → held → empty；slot 为 null 给一个 unknown 格，label 为 key */
export function slotCells(machine: Pick<RosterMachine, "machineKey" | "proto" | "slots" | "workers">, family: RosterFamily): SlotCells {
  const slot = machine.slots[family];
  if (!slot) return { cells: [cellOf("unknown")], overflow: 0, label: "roster.slot.unknown" };
  const mine = machine.workers.filter(w => w.family === family);
  const by = (s: RosterWorker["state"][]) => mine.filter(w => s.includes(w.state)).map(w => cellOf(w.state === "running" ? "running" : w.state === "silent" ? "silent" : "pending", w));
  const busy = machine.proto === "local" ? slot.busy : Math.max(slot.reportedBusy ?? slot.busy, slot.busy);
  const other = Math.max(0, busy - mine.length);
  const occupied = [...by(["running"]), ...by(["silent"]), ...by(["no_beat", "unknown"]), ...Array.from({ length: other }, () => cellOf("other"))];
  const total = Math.max(0, Math.floor(slot.total));
  const free = Math.max(0, total - occupied.length);
  const cells = [...occupied.slice(0, total), ...Array.from({ length: free }, () => cellOf(slot.held ? "held" : "empty"))];
  return { cells, overflow: Math.max(0, occupied.length - total), label: `${occupied.length}/${total}` };
}

// ---------- 额度 ----------

export type QuotaState = "unknown" | "ok" | "near" | "stop";
export const QUOTA_STALE_MS = 5 * 60_000;
export const QUOTA_NEAR_PCT = 10;

/** A 稿 §3.1：观测过期 5 分钟算未知，在网页判；stopPct 为 null（peer）只有 ok / unknown */
export function quotaState(q: RosterQuota | null, now: number): QuotaState {
  if (!q || q.observedAt === null || now - q.observedAt > QUOTA_STALE_MS) return "unknown";
  if (q.stopPct === null) return "ok";
  if (q.usedPct >= q.stopPct) return "stop";
  return q.stopPct - q.usedPct <= QUOTA_NEAR_PCT ? "near" : "ok";
}

// ---------- 归人 ----------

/** Read state of one source: loading = not answered yet, error = the read failed (neither means "none"). */
export type LoadStatus = "loading" | "ready" | "error";
export interface RosterTask { id: string; title: string; stage: string; assigneeCode: string | null; executorInstanceId: string | null }
export interface RosterInput {
  /** null = 这台设备读不到（非全权 / 没有本机项目 / 404） */
  roster: Roster | null;
  /** 本机项目没绑团队时为 null */
  directory: TeamDirectoryMember[] | null;
  /** 缺省 ready；不是 ready 时 directory 为 null 只表示还不知道，机器不归「未认领」 */
  directoryStatus?: LoadStatus;
  selfPersonId: string | null;
  /** ROSTER2a 之前一律 null */
  instances: { instanceId: string; personId: string }[] | null;
  tasks: RosterTask[];
  now: number;
}
export interface CardView { id: string; title: string | null; stage: string | null }
export interface MachineView {
  key: string; name: string; instanceId: string | null; online: boolean | null; isSelf: boolean;
  checkedAt: number | null; latencyMs: number | null; helloAt: number | null; output: RosterOutputDay[];
  slots: Record<RosterFamily, SlotCells>; quota: Record<RosterFamily, QuotaState>;
  workers: RosterWorker[]; cards: RosterCards;
}
/** slotNote：机器为空时位子为什么是「未知」（i18n key）；有机器为 null */
export type SlotNote = "roster.slot.unreadable" | "roster.slot.noMachines";
export interface PersonView {
  personId: string; code: string; teamRole: "owner" | "member"; isSelf: boolean;
  machines: MachineView[]; cards: CardView[]; slotNote: SlotNote | null;
}
export interface RosterView {
  people: PersonView[]; unclaimed: MachineView[]; selfPersonId: string | null;
  /** 目录还没读到 / 读失败时的机器：归不了人也不算未认领，只进指标 */
  ungrouped: MachineView[];
  /** 目录长度；没绑团队为 null */
  memberCount: number | null;
  /** 同一 worker id 出现在多台机器上的次数（取后一台） */
  conflicts: number;
}

/** 同一 worker id 只留最后一台机器上的那个 */
function dedupeWorkers(machines: RosterMachine[]): { workers: RosterWorker[][]; conflicts: number } {
  const last = new Map<string, number>();
  let conflicts = 0;
  machines.forEach((m, i) => m.workers.forEach(w => {
    const prev = last.get(w.id);
    if (prev !== undefined && prev !== i) conflicts++;
    last.set(w.id, i);
  }));
  const workers = machines.map((m, i) => {
    const seen = new Set<string>();
    return m.workers.filter(w => last.get(w.id) === i && !seen.has(w.id) && (seen.add(w.id), true));
  });
  return { workers, conflicts };
}

function machineView(m: RosterMachine, workers: RosterWorker[], now: number): MachineView {
  const base = { ...m, workers };
  const fam = <T>(f: (x: RosterFamily) => T) => ({ claude: f("claude"), codex: f("codex") });
  return {
    key: m.proto === "local" ? LOCAL_MACHINE_KEY : `peer:${m.machineKey}`, name: m.machineKey, instanceId: m.instanceId, online: m.online, isSelf: m.proto === "local",
    checkedAt: m.checkedAt, latencyMs: m.latencyMs, helloAt: m.helloAt, output: m.output,
    slots: fam(f => slotCells(base, f)), quota: fam(f => quotaState(m.quota[f], now)), workers, cards: m.cards,
  };
}

/** 一台机器归谁：本机 → selfPersonId；peer → instances 里的 personId；只认目录里的人 */
function ownerOf(m: RosterMachine, input: RosterInput, members: Set<string>): string | null {
  const pid = m.proto === "local" ? input.selfPersonId
    : m.instanceId === null ? null : input.instances?.find(i => i.instanceId === m.instanceId)?.personId ?? null;
  return pid !== null && members.has(pid) ? pid : null;
}

/** 投影卡归谁（可多人）：代号精确等于且不是 id 形状；执行实例 = 本机实例 → self；执行实例在 instances 里 → 对应的人 */
function taskOwners(t: RosterTask, input: RosterInput, directory: TeamDirectoryMember[]): string[] {
  const out: string[] = [];
  if (t.assigneeCode && !LONG_HEX.test(t.assigneeCode)) {
    const m = directory.find(d => d.code === t.assigneeCode);
    if (m) out.push(m.personId);
  }
  const ex = t.executorInstanceId;
  if (ex !== null) {
    const selfInst = input.roster?.self.instanceId ?? null;
    if (selfInst !== null && ex === selfInst && input.selfPersonId !== null) out.push(input.selfPersonId);
    const hit = input.instances?.find(i => i.instanceId === ex);
    if (hit) out.push(hit.personId);
  }
  return out;
}

/** 名册视图：目录里每人一张卡（没机器也有），归不到人的机器进 unclaimed，卡在同一人名下只出现一次 */
export function rosterOf(input: RosterInput): RosterView {
  const machines = input.roster?.machines ?? [];
  const { workers, conflicts } = dedupeWorkers(machines);
  const views = machines.map((m, i) => machineView(m, workers[i]!, input.now));
  const directory = input.directory;
  const members = new Set((directory ?? []).map(d => d.personId));
  const owned = new Map<string, MachineView[]>();
  const unclaimed: MachineView[] = [], ungrouped: MachineView[] = [];
  const known = (input.directoryStatus ?? "ready") === "ready";
  machines.forEach((m, i) => {
    const pid = directory ? ownerOf(m, input, members) : null;
    if (pid === null) (known ? unclaimed : ungrouped).push(views[i]!);
    else owned.set(pid, [...(owned.get(pid) ?? []), views[i]!]);
  });
  const taskById = new Map(input.tasks.map(t => [t.id, t]));
  const cardOf = (id: string): CardView => ({ id, title: taskById.get(id)?.title ?? null, stage: taskById.get(id)?.stage ?? null });
  const cards = new Map<string, Map<string, CardView>>();
  const give = (pid: string, id: string) => {
    const mine = cards.get(pid) ?? new Map<string, CardView>();
    if (!mine.has(id)) mine.set(id, cardOf(id));
    cards.set(pid, mine);
  };
  for (const [pid, ms] of owned) for (const m of ms) for (const id of [...m.workers.flatMap(w => w.taskId ? [w.taskId] : []), ...m.cards.merge, ...m.cards.live, ...m.cards.blocked]) give(pid, id);
  if (directory) for (const t of input.tasks) for (const pid of taskOwners(t, input, directory)) if (members.has(pid)) give(pid, t.id);
  const people = (directory ?? []).map((d): PersonView => {
    const ms = owned.get(d.personId) ?? [];
    const slotNote: SlotNote | null = input.roster === null ? "roster.slot.unreadable" : ms.length === 0 ? "roster.slot.noMachines" : null;
    return {
      personId: d.personId, code: d.code, teamRole: d.teamRole, isSelf: d.personId === input.selfPersonId,
      machines: ms, cards: [...(cards.get(d.personId)?.values() ?? [])], slotNote,
    };
  });
  return { people, unclaimed, ungrouped, selfPersonId: input.selfPersonId, memberCount: directory ? directory.length : null, conflicts };
}

// ---------- 就绪没派 ----------

/** 调度器「该派没派」的等待码（scheduler-plan.ts 的 wait 码 + pooled + 人工模式额度到线 quota） */
export const DISPATCH_WAIT: readonly string[] = ["capacity", "placement", "resource_busy", "reviewer_capacity", "queue_frozen", "pooled", "quota"];
export interface ReadyRow {
  row: WorkRow; ready: boolean;
  /** 本机看板的 reason 原文；todo.ready 为 null，界面用 reasonKey */
  reason: string | null;
  reasonKey: "roster.ready.waitScheduler" | null;
}

/** 就绪没派：board 为 null 返回 null（未知，不是空）；todo.ready 在前，各自按 since 从旧到新 */
export function readyQueue(board: WorkBoard | null): ReadyRow[] | null {
  if (!board) return null;
  const bySince = (a: WorkRow, b: WorkRow) => a.since - b.since;
  const ready = [...board.todo.ready].sort(bySince)
    .map((row): ReadyRow => ({ row, ready: true, reason: null, reasonKey: "roster.ready.waitScheduler" }));
  const waiting = board.waiting.filter(r => r.code !== null && DISPATCH_WAIT.includes(r.code)).sort(bySince)
    .map((row): ReadyRow => ({ row, ready: false, reason: row.reason, reasonKey: null }));
  return [...ready, ...waiting];
}

// ---------- 指标条 ----------

export interface SlotUsage { used: number; total: number; partial: boolean }
/** 读不到的项为 null，界面写「暂无」 */
export interface RosterMetrics {
  members: number | null;
  online: { n: number; m: number } | null;
  claude: SlotUsage | null;
  codex: SlotUsage | null;
  writing: number | null;
  reviewing: number | null;
  awaitingMerge: number | null;
  deliveredToday: number | null;
}

const OCCUPIED = new Set<CellState>(["running", "silent", "pending", "other"]);
const allMachines = (view: RosterView): MachineView[] => [...view.people.flatMap(p => p.machines), ...view.unclaimed, ...view.ungrouped];

function usageOf(machines: MachineView[], raw: RosterMachine[], family: RosterFamily): SlotUsage | null {
  const known = raw.filter(m => m.slots[family] !== null);
  if (known.length === 0) return null;
  const keyed = new Map(machines.map(m => [m.key, m]));
  let used = 0, total = 0;
  for (const m of known) {
    const cells = keyed.get(m.proto === "local" ? LOCAL_MACHINE_KEY : `peer:${m.machineKey}`)?.slots[family];
    used += cells ? cells.cells.filter(c => OCCUPIED.has(c.state)).length + cells.overflow : 0;
    total += m.slots[family]!.total;
  }
  return { used, total, partial: known.length < raw.length };
}

/** 指标条：成员数照目录；roster 为 null 时机器、位子、worker、合并、交付都是 null */
export function rosterMetrics(view: RosterView, roster: Roster | null): RosterMetrics {
  if (!roster || roster.dropped > 0) {
    return { members: view.memberCount, online: null, claude: null, codex: null, writing: null, reviewing: null, awaitingMerge: null, deliveredToday: null };
  }
  const machines = allMachines(view);
  const workers = machines.flatMap(m => m.workers);
  const merge = new Set([...roster.machines.flatMap(m => m.cards.merge), ...roster.unattributed.merge]);
  return {
    members: view.memberCount,
    online: roster.machines.some(m => m.online === null) ? null : { n: roster.machines.filter(m => m.online === true).length, m: roster.machines.length },
    claude: usageOf(machines, roster.machines, "claude"),
    codex: usageOf(machines, roster.machines, "codex"),
    writing: workers.filter(w => w.role === "author").length,
    reviewing: workers.filter(w => w.role === "reviewer").length,
    awaitingMerge: merge.size,
    deliveredToday: roster.machines.reduce((s, m) => s + (m.output.at(-1)?.delivered ?? 0), 0),
  };
}
