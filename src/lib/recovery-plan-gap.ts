/**
 * Plan-gap recovery (dispatch-recovery-PLAN): when real write capacity sits idle because too little work is truly ready,
 * tell the project's PM once, with the list of what blocks each piece of planned work and which drafts are not yet in a DAG.
 * Readiness is the autostart gate itself (featureGate / nodeCandidate: spec file, deps / files / locks lanes, claims, arm);
 * capacity is local write room plus peers that peerRefusal accepts for a write. A peer's free slots are one physical pool however
 * many projects borrow it; each project only adds permission edges to it, so assessPlanGap matches ready work to seats by max
 * flow (order-independent, a refused project never shrinks the pool). Nothing here picks scope or edits a DAG.
 * Policy comes through an injected port (CFG's recoveryPolicy); without one the tick observes. tests/recovery-plan-gap*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { featureLanes } from "./dag-tools-lanes.js";
import { cardNames } from "./ledger-card-names.js";
import type { AuthorFamily } from "./ledger-scheduler.js";
import { getFeature, PLANNED, type Feature } from "./ledger-feature.js";
import { getEventByDedup } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { localAgentPool } from "./scheduler-agent-pool-ledger.js";
import { peerFacts } from "./scheduler-agent-pool-peer.js";
import { currentViews, featureGate, isStop, nodeCandidate, type ServiceFacts, type SpecFile } from "./scheduler-autostart.js";
import { peerRefusal, type PlacementFacts } from "./scheduler-placement.js";
import { borrowPeers } from "./scheduler-pool-facts.js";
import type { SlotPool } from "./scheduler-slot-hold-autostart.js";
import { writeSlotFacts } from "./scheduler-slot-hold-facts.js";
import { scanSpecHead } from "./spec-lint-head.js";

type RecoveryMode = "on" | "observe" | "off";
/** CFG's minimal policy value; manualAfterMs null = the owner has not set a threshold yet. */
export interface RecoveryPolicy { mode: RecoveryMode; manualAfterMs: number | null }
/** CFG's recoveryPolicy(project, mechanism) narrowed to this mechanism; a function over every RecoveryKey is assignable. */
export type PlanGapPolicyPort = (project: string, mechanism: "planGap") => RecoveryPolicy;

const OBSERVE: RecoveryPolicy = { mode: "observe", manualAfterMs: null };

/** A missing port observes; a port that throws or answers garbage is off, with the reason kept for doctor / logs. */
export function planGapPolicy(port: PlanGapPolicyPort | undefined, project: string): RecoveryPolicy & { diag: string | null } {
  if (!port) return { ...OBSERVE, diag: "没有注入策略读取（CFG 未接线），按 observe" };
  try {
    const p = port(project, "planGap");
    const okMode = p && (p.mode === "on" || p.mode === "observe" || p.mode === "off");
    const okMs = p && (p.manualAfterMs === null || (typeof p.manualAfterMs === "number" && Number.isFinite(p.manualAfterMs) && p.manualAfterMs >= 0));
    if (!okMode || !okMs) return { mode: "off", manualAfterMs: null, diag: `策略值不合法：${JSON.stringify(p)}` };
    return { mode: p.mode, manualAfterMs: p.manualAfterMs, diag: null };
  } catch (e) {
    return { mode: "off", manualAfterMs: null, diag: `策略读取失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

// ── facts ──

/** superseded / owner_paused / manual_acceptance never count as dispatchable; local_only is ready but never external. */
type HoldKind = "superseded" | "owner_paused" | "manual_acceptance";
export interface WorkItem {
  featureId: string; key: string; taskId: string; version: number;
  state: "ready" | "hold" | "blocked";
  /** ready work a peer may take (project lends writes with a repo, and the spec is not local-only) */
  external: boolean;
  hold?: HoldKind;
  /** autostart gate code for blocked work (lanes / spec / armed / proposal / …) */
  gate?: string;
  why: string;
}

type DraftFlag = "missing_spec" | "missing_deps" | "duplicate" | "stale";
export interface DraftCandidate { name: string; title: string | null; flags: DraftFlag[]; why: string[] }
export interface DraftFile { name: string; mtimeMs: number; text: string }
/** seats = free slots this project may use; free = the peer's physical free slots per write family; allowed = families it may use */
export interface PeerSeats { peer: string; seats: number; why: string | null; free: Partial<Record<AuthorFamily, number>>; allowed: AuthorFamily[] }

export interface ProjectFacts {
  project: string;
  work: WorkItem[];
  drafts: DraftCandidate[];
  localRoom: number;
  localWhy: string | null;
  peers: PeerSeats[];
}

/** Spec-head lines PM writes on a card (same block as 「自动开卡：关」): they take a node out of the dispatchable count. */
const SUPERSEDED_LINE = /^被替代\s*[:：]\s*(\S.*)$/;
const MANUAL_LINE = /^人工验收\s*[:：]\s*是\s*$/;
const LOCAL_ONLY_LINE = /^本机限定\s*[:：]\s*是\s*$/;
const OWNER_OFF = "自动开卡：关";

export function specHolds(text: string): { superseded: string | null; manual: boolean; localOnly: boolean } {
  const { head } = scanSpecHead(text);
  const sup = head.map((l) => l.match(SUPERSEDED_LINE)?.[1]?.trim()).find((v) => !!v) ?? null;
  return { superseded: sup, manual: head.some((l) => MANUAL_LINE.test(l)), localOnly: head.some((l) => LOCAL_ONLY_LINE.test(l)) };
}

export interface FactsIo {
  now: number;
  svc: ServiceFacts;
  /** the project's remote policy and borrow list, read fresh by the caller (no cached capacity) */
  pool(project: string): SlotPool;
  readSpec(taskId: string): SpecFile | null;
  drafts(project: string): DraftFile[];
  /** local quota over the line / runtime unavailable → no local room; null = fine */
  localBlocked?(project: string): string | null;
  /** drafts untouched this long are stale (default 14 days) */
  staleAfterMs?: number;
}

const DEFAULT_STALE_MS = 14 * 24 * 3600_000;

function planGapFeatures(db: Database, project: string): Feature[] {
  return (db.query("SELECT id FROM features WHERE project = ? AND status IN ('active','paused') AND currentVersion > 0 ORDER BY id").all(project) as { id: string }[])
    .map(({ id }) => getFeature(db, id) as Feature);
}

/** One feature's planned nodes, classified by the same gates autostart uses (the capacity gate is measured separately). */
function featureWork(db: Database, f: Feature, io: FactsIo, external: boolean): WorkItem[] {
  const svc: ServiceFacts = { ...io.svc, pool: io.pool, now: () => io.now };
  const shared = featureGate(db, f, svc);
  const views = currentViews(db, f);
  const lanes = featureLanes(db, f);
  return views.filter((n) => n.status === PLANNED && !n.taskId).map((n): WorkItem => {
    const base = { featureId: f.id, key: n.key, taskId: cardNames(db, f, n.key, n).taskId, version: f.currentVersion, external: false };
    if (f.status === "paused" || shared?.gate === "switch") return { ...base, state: "hold", hold: "owner_paused", why: shared?.why ?? "feature 已暂停" };
    if (shared && shared.gate !== "capacity") return { ...base, state: "blocked", gate: shared.gate, why: shared.why };
    const c = nodeCandidate(db, f, n.key, lanes, views, io.readSpec, io.now);
    if (isStop(c)) {
      if (c.gate === "spec" && c.why.includes(OWNER_OFF)) return { ...base, state: "hold", hold: "owner_paused", why: c.why };
      return { ...base, state: "blocked", gate: c.gate, why: c.why };
    }
    const h = specHolds((io.readSpec(base.taskId) as SpecFile).text);
    if (h.superseded) return { ...base, state: "hold", hold: "superseded", why: `规格写明已被 ${h.superseded} 替代` };
    if (h.manual) return { ...base, state: "hold", hold: "manual_acceptance", why: "规格写明人工验收，不当可外派写单" };
    return { ...base, state: "ready", external: external && !h.localOnly, why: h.localOnly ? "就绪，规格限定本机" : "就绪" };
  });
}

const draftTitle = (text: string): string | null => text.split(/\r?\n/).find((l) => /^#\s/.test(l.trim()))?.trim().replace(/^#\s+/, "") ?? null;
const DEPS_LINE = /^(?:前置节点|前置|依赖)\s*[:：]\s*(.*)$/;
const NO_DEPS = /^(?:无|none|-)?[。.]?$/i;

/** Drafts that no current DAG node is bound to; flags only, never a choice of which to start. */
export function draftCandidates(drafts: readonly DraftFile[], known: { taskIds: Set<string>; keys: Set<string>; titles: Set<string> },
  hasSpec: (taskId: string) => boolean, now: number, staleAfterMs = DEFAULT_STALE_MS): DraftCandidate[] {
  const titles = new Map<string, number>();
  for (const d of drafts) { const t = draftTitle(d.text); if (t) titles.set(t, (titles.get(t) ?? 0) + 1); }
  return drafts.filter((d) => !known.taskIds.has(d.name)).map((d) => {
    const flags: DraftFlag[] = [], why: string[] = [];
    const title = draftTitle(d.text);
    const body = d.text.replace(/\s+/g, "");
    if (!title || body.length < 80 || !/范围|fileGlobs/.test(d.text)) { flags.push("missing_spec"); why.push(title ? "缺范围或正文过短" : "缺标题"); }
    const depsLine = d.text.split(/\r?\n/).map((l) => l.trim().match(DEPS_LINE)?.[1]?.trim()).find((v) => v !== undefined);
    const deps = depsLine === undefined || NO_DEPS.test(depsLine) ? [] : depsLine.split(/[,，、\s]+/).map((s) => s.replace(/[。;；]$/, "")).filter(Boolean);
    const unknown = deps.filter((k) => !known.keys.has(k) && !known.taskIds.has(k));
    if (depsLine === undefined) { flags.push("missing_deps"); why.push("没写前置节点"); }
    else if (unknown.length) { flags.push("missing_deps"); why.push(`前置不在当前 DAG：${unknown.join(", ")}`); }
    if (hasSpec(d.name)) { flags.push("duplicate"); why.push("正式规格已存在同名卡"); }
    else if (title && (known.titles.has(title) || (titles.get(title) ?? 0) > 1)) { flags.push("duplicate"); why.push("标题与现有节点或其它草稿相同"); }
    if (now - d.mtimeMs > staleAfterMs) { flags.push("stale"); why.push(`草稿 ${Math.floor((now - d.mtimeMs) / 86_400_000)} 天未改`); }
    return { name: d.name, title, flags, why };
  });
}

/** Local room for a new write card: localPriority off, a fix waiting for a slot, or a blocked runtime leaves none. */
function localRoom(db: Database, project: string, io: FactsIo, pool: SlotPool): { room: number; why: string | null } {
  if (pool.remote?.localPriority === "off") return { room: 0, why: "localPriority=off：本机不写代码" };
  const blocked = io.localBlocked?.(project) ?? null;
  if (blocked) return { room: 0, why: blocked };
  const slots = writeSlotFacts(db, project);
  if (slots.waitingFix) return { room: 0, why: "本机空槽留给退回的 fix" };
  if (pool.remote?.agents) {
    const load = localAgentPool(db, project, pool.remote.agents);
    const room = (["claude", "codex"] as const).reduce((n, f) => n + Math.max(0, (load.totals[f] ?? 0) - (load.running[f] ?? 0)), 0);
    return { room, why: room ? null : "本机 agent 池已满" };
  }
  const room = Math.max(0, io.svc.maxWorkers(project) - slots.workerCount);
  return { room, why: room ? null : `本机写槽已满（maxActiveWorkers ${io.svc.maxWorkers(project)}）` };
}

/** Free write seats per borrowed peer, accepted by the same refusal check placement uses (roles, off, grant, repo, freshness). */
function peerSeats(db: Database, project: string, pool: SlotPool, now: number): PeerSeats[] {
  const repo = pool.remote?.repo ?? null;
  const peers = borrowPeers(db, project, pool.borrow, now, !!pool.remote?.agents).map(peerFacts);
  const facts: PlacementFacts = { remote: pool.remote, repo, peers, local: { running: 0, room: false }, pin: null, tried: [], lastPeer: null,
    writeLeasePeer: null, locksFree: true };
  const families: readonly AuthorFamily[] = pool.remote?.agents ? ["claude", "codex"] : (pool.remote?.writeFamilies ?? ["codex"]);
  return peers.map((p) => {
    const refused = families.map((fam) => peerRefusal(facts, p, "write", fam));
    const ok = refused.some((r) => r === null);
    const free: Partial<Record<AuthorFamily, number>> = {};
    for (const fam of families) free[fam] = Math.max(0, p.v2?.slots[fam] ?? 0);
    const allowed = families.filter((fam, i) => refused[i] === null && (free[fam] ?? 0) > 0);
    const seats = allowed.reduce((n, fam) => n + (free[fam] ?? 0), 0);
    // peerRefusal accepts any family's free seat for a write; placement then keeps only writeFamilies, so seats can still be 0.
    return { peer: p.peer, seats, why: !ok ? refused[0] : seats ? null : `写单家族 ${families.join(" / ")} 没有空位`, free, allowed };
  });
}

/** Everything one project contributes to the assessment, read now from the ledger and the caller's fresh config. */
export function readPlanGapFacts(db: Database, project: string, io: FactsIo): ProjectFacts {
  const pool = io.pool(project);
  const external = !!pool.remote && pool.remote.mode !== "off" && pool.remote.roles.includes("write") && !!pool.remote.repo;
  const features = planGapFeatures(db, project);
  const work = features.flatMap((f) => featureWork(db, f, io, external));
  const known = { taskIds: new Set<string>(), keys: new Set<string>(), titles: new Set<string>() };
  for (const f of features) {
    for (const n of currentViews(db, f)) {
      known.keys.add(n.key); known.taskIds.add(n.taskId ?? cardNames(db, f, n.key, n).taskId); known.titles.add(n.oneLine);
      if (n.title) known.titles.add(n.title);
    }
  }
  const drafts = draftCandidates(io.drafts(project), known, (id) => io.readSpec(id) !== null, io.now, io.staleAfterMs);
  const local = localRoom(db, project, io, pool);
  return { project, work, drafts, localRoom: local.room, localWhy: local.why, peers: peerSeats(db, project, pool, io.now) };
}

// ── assessment (pure) ──

export interface ProjectGap {
  project: string;
  ready: number; readyExternal: number; readyLocalOnly: number;
  localRoom: number; peerSeats: number;
  /** seats this project could still fill with more ready work while every other project's ready work stays placed (max flow) */
  idle: number;
  sharedPeers: string[];
  blocked: WorkItem[];
  holds: WorkItem[];
  drafts: DraftCandidate[];
  fingerprint: string;
}

/**
 * The seat graph: source → each project's local-only / external ready work → its local room or the (peer, family) seats it is
 * allowed → sink. A (peer, family) node holds the peer's physical free slots once (two reports of one hello keep the smaller);
 * projects only add edges, so a project refused by a peer leaves the pool intact for the projects that are allowed.
 */
const BIG = 1 << 30;
interface Graph { cap: number[][]; n: number }
const seatKey = (peer: string, fam: AuthorFamily) => `${peer}\u0000${fam}`;
function physicalSeats(facts: readonly ProjectFacts[]): Map<string, number> {
  const seats = new Map<string, number>();
  for (const f of facts) for (const p of f.peers) for (const fam of Object.keys(p.free) as AuthorFamily[]) {
    seats.set(seatKey(p.peer, fam), Math.min(seats.get(seatKey(p.peer, fam)) ?? BIG, p.free[fam] ?? 0));
  }
  return seats;
}
function seatGraph(facts: readonly ProjectFacts[], unbounded: number | null): Graph {
  const seats = physicalSeats(facts);
  const seatIx = new Map([...seats.keys()].map((k, i) => [k, i]));
  // 0 source, 1 sink, then per project [local-only, external, local room], then seat nodes
  const n = 2 + facts.length * 3 + seats.size;
  const cap = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const seatNode = (k: string) => 2 + facts.length * 3 + (seatIx.get(k) as number);
  for (const [k, free] of seats) cap[seatNode(k)][1] = free;
  facts.forEach((f, i) => {
    const lo = 2 + i * 3, ext = lo + 1, local = lo + 2;
    const ready = f.work.filter((w) => w.state === "ready");
    const e = ready.filter((w) => w.external).length;
    cap[0][lo] = unbounded === i ? BIG : ready.length - e;
    cap[0][ext] = unbounded === i ? BIG : e;
    cap[lo][local] = BIG; cap[ext][local] = BIG; cap[local][1] = Math.max(0, f.localRoom);
    for (const p of f.peers) for (const fam of p.allowed) if (seats.has(seatKey(p.peer, fam))) cap[ext][seatNode(seatKey(p.peer, fam))] = BIG;
  });
  return { cap, n };
}

/** Edmonds-Karp; the graphs are a few dozen nodes and the flow is bounded by the free seats. */
function maxFlow({ cap, n }: Graph): number {
  let flow = 0;
  for (;;) {
    const prev = new Array<number>(n).fill(-1);
    prev[0] = 0;
    const queue = [0];
    while (queue.length && prev[1] < 0) {
      const u = queue.shift() as number;
      for (let v = 0; v < n; v++) if (prev[v] < 0 && cap[u][v] > 0) { prev[v] = u; queue.push(v); }
    }
    if (prev[1] < 0) return flow;
    let push = BIG;
    for (let v = 1; v !== 0; v = prev[v]) push = Math.min(push, cap[prev[v]][v]);
    for (let v = 1; v !== 0; v = prev[v]) { cap[prev[v]][v] -= push; cap[v][prev[v]] += push; }
    flow += push;
  }
}

/** Seats some project may use: local room is per project; a peer's (family) seats count once if any project is allowed them. */
function usableSeats(facts: readonly ProjectFacts[]): number {
  const seats = physicalSeats(facts);
  const allowed = new Set(facts.flatMap((f) => f.peers.flatMap((p) => p.allowed.map((fam) => seatKey(p.peer, fam)))));
  return facts.reduce((n, f) => n + Math.max(0, f.localRoom), 0) + [...allowed].reduce((n, k) => n + (seats.get(k) ?? 0), 0);
}

/**
 * Idle is order-independent: placed = the max flow of every project's ready work; a project's idle is how many more seats it
 * could fill with more ready work while every other project's ready work stays placed.
 */
function place(facts: readonly ProjectFacts[]) {
  const placed = maxFlow(seatGraph(facts, null));
  const idle = facts.map((_, i) => maxFlow(seatGraph(facts, i)) - placed);
  return { placed, idle };
}

export function assessPlanGap(facts: readonly ProjectFacts[]): ProjectGap[] {
  const { idle } = place(facts);
  const users = new Map<string, number>();
  for (const f of facts) for (const p of f.peers) if (p.seats > 0) users.set(p.peer, (users.get(p.peer) ?? 0) + 1);
  return facts.map((f, i) => {
    const ready = f.work.filter((w) => w.state === "ready");
    const ext = ready.filter((w) => w.external).length;
    return {
      project: f.project, ready: ready.length, readyExternal: ext, readyLocalOnly: ready.length - ext, localRoom: f.localRoom,
      peerSeats: f.peers.reduce((n, p) => n + p.seats, 0),
      idle: idle[i],
      sharedPeers: f.peers.filter((p) => p.seats > 0 && (users.get(p.peer) ?? 0) > 1).map((p) => p.peer),
      blocked: f.work.filter((w) => w.state === "blocked"), holds: f.work.filter((w) => w.state === "hold"), drafts: f.drafts,
      fingerprint: gapFingerprint(f),
    };
  });
}

/** Idle write seats across projects with each peer seat counted once: seats anyone may use minus the max placement. */
export function fleetIdle(facts: readonly ProjectFacts[]): number {
  return usableSeats(facts) - place(facts).placed;
}

/** Identity of the blocking picture: work items with their DAG version and gate, plus drafts and their flags; seat counts are excluded. */
export function gapFingerprint(f: Pick<ProjectFacts, "project" | "work" | "drafts">): string {
  const items = f.work.filter((w) => w.state !== "ready").map((w) => `${w.featureId}@${w.version}:${w.key}:${w.state}:${w.hold ?? w.gate ?? ""}`).sort();
  const drafts = f.drafts.map((d) => `${d.name}:${[...d.flags].sort().join("+")}`).sort();
  return createHash("sha256").update(JSON.stringify([f.project, items, drafts])).digest("hex").slice(0, 16);
}

const HOLD_WORD: Record<HoldKind, string> = { superseded: "已被替代", owner_paused: "owner 暂停", manual_acceptance: "人工验收" };
const FLAG_WORD: Record<DraftFlag, string> = { missing_spec: "缺规格", missing_deps: "缺依赖", duplicate: "重复", stale: "过时" };

/** The PM notice: capacity, then the blocking list; it asks PM to plan, it never names which draft to start. */
export function planGapText(g: ProjectGap, cap = 20): string {
  const shared = g.sharedPeers.length ? `，与其它项目共用 ${g.sharedPeers.join("/")}` : "";
  const lines = [
    `【计划不足】项目 ${g.project}：可用写容量空着 ${g.idle} 个（本机 ${g.localRoom}，peer ${g.peerSeats}${shared}），`
      + `真正就绪的写单只有 ${g.ready} 张（可外派 ${g.readyExternal}，限本机 ${g.readyLocalOnly}）。`,
  ];
  const list = <T>(title: string, xs: readonly T[], row: (x: T) => string) => {
    if (!xs.length) return;
    lines.push(`${title}（${xs.length}）：`, ...xs.slice(0, cap).map((x) => `- ${row(x)}`));
    if (xs.length > cap) lines.push(`- …另有 ${xs.length - cap} 条`);
  };
  list("卡住的计划节点", g.blocked, (w) => `${w.taskId}（${w.featureId} v${w.version}）[${w.gate}] ${w.why}`);
  list("不算可派的节点", g.holds, (w) => `${w.taskId} [${HOLD_WORD[w.hold as HoldKind]}] ${w.why}`);
  list("drafts 里未接 DAG 的候选", g.drafts, (d) => [`${d.name}${d.title ? `「${d.title}」` : ""}`,
    d.flags.length ? `[${d.flags.map((f) => FLAG_WORD[f]).join("/")}]` : "", d.why.join("；")].filter(Boolean).join(" "));
  lines.push("请 PM 补规格 / 接依赖 / 决定是否纳入 DAG；系统不会自动选范围或扩 Feature。");
  return lines.join("\n");
}

// ── tick ──

export const planGapKey = (project: string, fp: string): string => `recovery:planGap:${project}:${fp}`;
/** Delivery state of one picture lives in the ledger: attempt 1 claims planGapKey, attempt n ≥ 2 claims `…#n`, success adds `…:sent`. */
const attemptKey = (key: string, n: number): string => n === 1 ? key : `${key}#${n}`;
const sentKey = (key: string): string => `${key}:sent`;
/** An unsent picture (send threw, or the process died after the claim) is retried after 5 min, doubling, capped at 6 h. */
export const PLAN_GAP_RETRY_BASE_MS = 5 * 60_000;
export const PLAN_GAP_RETRY_MAX_MS = 6 * 3600_000;
export const planGapRetryAfter = (attempts: number): number => Math.min(PLAN_GAP_RETRY_MAX_MS, PLAN_GAP_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));

export interface PlanGapDeps {
  db: Database;
  now: number;
  projects: readonly string[];
  policy?: PlanGapPolicyPort;
  facts(project: string): ProjectFacts;
  notifyPm(project: string, text: string): Promise<void>;
  /** first time each project's current fingerprint was seen (process memory; a restart only delays a notice) */
  seen: Map<string, { fp: string; since: number }>;
}

export type PlanGapOutcome =
  | { project: string; mode: "off"; diag: string | null }
  | { project: string; mode: "observe" | "on"; diag: string | null; gap: ProjectGap;
    action: "none" | "would_notify" | "notified" | "deduped" | "cooldown" | "retry_wait" | "failed"; why: string };

/** When PM last actually received a plan-gap notice for this project (sent markers only; an unsent claim is not a notice). */
const lastNotice = (db: Database, project: string): number | null =>
  (db.query("SELECT MAX(ts) AS ts FROM events WHERE project = ? AND target = '' AND kind = 'note' AND json_extract(data, '$.recovery.op') = 'planGapSent'")
    .get(project) as { ts: number | null }).ts;

/** Attempts claimed so far for this picture and when the last one was claimed. */
function attempts(db: Database, key: string): { n: number; lastTs: number } | null {
  let last = getEventByDedup(db, key);
  if (!last) return null;
  let n = 1;
  for (let next = getEventByDedup(db, attemptKey(key, n + 1)); next; next = getEventByDedup(db, attemptKey(key, n + 1))) { last = next; n++; }
  return { n, lastTs: last.ts };
}

/** Not enough planned work: some seat is idle while something planned is still not ready (blocked, held, or only drafted). */
const insufficient = (g: ProjectGap): boolean => g.idle > 0 && (g.blocked.length + g.holds.length + g.drafts.length) > 0;

/**
 * One pass over the projects. off reads nothing; observe assesses and reports what it would send; on claims each send attempt in
 * the ledger (dedupKey per project + fingerprint + attempt, UNIQUE inside appendEvent's transaction) before sending, so
 * concurrent ticks send once, and marks the picture sent only after notifyPm returns. A sent picture never re-sends; an unsent
 * one (send threw, or the process died after claiming) retries with bounded backoff, also across restarts; a changed picture
 * waits manualAfterMs after the last delivered notice.
 */
export async function planGapTick(d: PlanGapDeps): Promise<PlanGapOutcome[]> {
  const live: { project: string; policy: ReturnType<typeof planGapPolicy> }[] = [];
  const out: PlanGapOutcome[] = [];
  for (const project of d.projects) {
    const policy = planGapPolicy(d.policy, project);
    if (policy.mode === "off") out.push({ project, mode: "off", diag: policy.diag });
    else live.push({ project, policy });
  }
  const gaps = assessPlanGap(live.map((l) => d.facts(l.project)));
  for (const [i, { project, policy }] of live.entries()) {
    const gap = gaps[i], mode = policy.mode as "observe" | "on";
    const done = (action: Extract<PlanGapOutcome, { gap: ProjectGap }>["action"], why: string) => out.push({ project, mode, diag: policy.diag, gap, action, why });
    if (!insufficient(gap)) { d.seen.delete(project); done("none", gap.idle ? "容量有空但没有卡住的计划" : "没有空闲容量"); continue; }
    const prev = d.seen.get(project);
    const since = prev?.fp === gap.fingerprint ? prev.since : d.now;
    d.seen.set(project, { fp: gap.fingerprint, since });
    if (policy.manualAfterMs === null) { done("none", "owner 未设 manualAfterMs 阈值，只观察"); continue; }
    if (d.now - since < policy.manualAfterMs) { done("none", `不足持续 ${d.now - since}ms，未到阈值 ${policy.manualAfterMs}ms`); continue; }
    if (mode === "observe") { done("would_notify", planGapText(gap)); continue; }
    const key = planGapKey(project, gap.fingerprint);
    const sent = getEventByDedup(d.db, sentKey(key));
    if (sent) { done("deduped", `同一阻塞清单已提醒过（seq ${sent.seq}）`); continue; }
    const tried = attempts(d.db, key);
    if (!tried) {
      const last = lastNotice(d.db, project);
      if (last !== null && d.now - last < policy.manualAfterMs) { done("cooldown", `上次提醒在 ${d.now - last}ms 前`); continue; }
    } else if (d.now - tried.lastTs < planGapRetryAfter(tried.n)) {
      done("retry_wait", `第 ${tried.n} 次发送未确认送达，${planGapRetryAfter(tried.n) - (d.now - tried.lastTs)}ms 后重试`); continue;
    }
    const n = (tried?.n ?? 0) + 1;
    const text = planGapText(gap);
    const recovery = { op: "planGap", fingerprint: gap.fingerprint, idle: gap.idle, ready: gap.ready, attempt: n };
    const claim = appendEvent(d.db, { actor: "scheduler", dedupKey: attemptKey(key, n), now: d.now },
      { project, target: "", kind: "note", text: n === 1 ? "计划不足提醒" : `计划不足提醒（第 ${n} 次发送）`, data: { recovery } });
    if (claim.duplicate) { done("deduped", `另一路已认领这次发送（seq ${claim.event.seq}）`); continue; }
    try {
      await d.notifyPm(project, text);
    } catch (e) {
      // No sent marker: the claim only spaces the next attempt (planGapRetryAfter), it never stands for a delivered notice.
      done("failed", e instanceof Error ? e.message : String(e)); continue;
    }
    appendEvent(d.db, { actor: "scheduler", dedupKey: sentKey(key), now: d.now },
      { project, target: "", kind: "note", text: "计划不足提醒已送达", data: { recovery: { ...recovery, op: "planGapSent" } } });
    done("notified", text);
  }
  return out;
}
