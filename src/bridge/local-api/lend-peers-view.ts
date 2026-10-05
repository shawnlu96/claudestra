/**
 * Owner borrow settings: GET reports project pools, hello capacity/quota and remote orders.
 * Peer PUT/DELETE and local PUT delegate to the manager CLI, preserving its locking and audit.
 * Local agents use scheduler-local --agents; legacy tier/role fields remain for older clients.
 * Errors return fixed codes so CLI command hints are never displayed in the web UI.
 * Quota is read-only and may be null without preventing slot edits.
 */
import { parseAgents, type AgentLimits } from "../../lib/scheduler-agent-pool-config.js";
import type { Database } from "bun:sqlite";
import { canReadLedger } from "../../lib/devices.js";
import { LEND_LIVE } from "../../lib/ledger-lend-schema.js";
import { getTask } from "../../lib/ledger-store.js";
import { getLendPeer, peerCapacity, unifiedPeerCapacity, type PeerCapacity, type UnifiedPeerCapacity } from "../../lib/ledger-lend-peers.js";
import { isPriority, LEND_PATH, MAX_OPEN, readLend, type BorrowEntry, type Priority } from "../../lib/lend-config.js";
import { placementOf } from "../../lib/lend-placement-view.js";
import { effectiveLend, isPersonalProject, readLendContext, type LendContact } from "../../lib/lend-policy.js";
import { canRunFleet, type Principal } from "../../lib/principals.js";
import type { ProjectDef } from "../../lib/projects.js";
import { runManagerProcess } from "../../lib/run-manager.js";
import { localWalled, peerQuota, readWeekQuota, type QuotaReport } from "../../lib/quota-week.js";
import { readSchedulerConfig, SCHEDULER_CONFIG_PATH, type SchedulerConfig } from "../../lib/scheduler-config.js";
import { apiJson, forbidden } from "../api-respond.js";
import { BUN_PATH, ENV_WITH_BUN, MANAGER_PATH } from "../config.js";
import { ledgerDb } from "../ledger-feed.js";

export interface BorrowViewDeps {
  db(): Database | null;
  lendPath: string;
  schedulerPath: string;
  context(): Promise<{ contacts: LendContact[]; projects: (ProjectDef & { personal?: boolean })[] }>;
  run(args: string[]): Promise<Record<string, unknown> | null>;
  now(): number;
  /** 本机本周额度与撞墙标；单测换成固定值或抛错 */
  localQuota(now: number): Promise<{ quota: QuotaReport; walled: boolean }>;
}

/** 频道号置空 = 以 owner 身份跑（borrow set / off 只认 owner 或大总管，project-guard.ts） */
const ENV = { ...ENV_WITH_BUN, DISCORD_CHANNEL_ID: "" };
const DEFAULT_DEPS: BorrowViewDeps = {
  db: () => ledgerDb(),
  lendPath: LEND_PATH,
  schedulerPath: SCHEDULER_CONFIG_PATH,
  context: readLendContext,
  run: (args) => runManagerProcess(args, { bunPath: BUN_PATH, managerPath: MANAGER_PATH, env: ENV, timeoutMs: 30_000 }),
  now: () => Date.now(),
  localQuota: async (now) => ({ quota: await readWeekQuota(now), walled: localWalled() }),
};
let deps: BorrowViewDeps = DEFAULT_DEPS;

/** 单测：台账、lend.json、scheduler.json、联系人、manager runner、时钟全部换掉；不传 = 还原 */
export function setBorrowViewDepsForTest(over?: Partial<BorrowViewDeps>): void {
  deps = over ? { ...DEFAULT_DEPS, ...over } : DEFAULT_DEPS;
}

/** 与 lend-config 的 PEER_NAME_RE 同口径；再要求在联系人里，所以不会被当成旗标 */
const PEER_RE = /^[\w-]{1,32}$/;
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

type RemoteModeView = "balance" | "off";
/** Explicit per-family pools are editable; legacy fields remain for older clients. */
interface BorrowProjectView {
  id: string; agents: AgentLimits | null; mode: RemoteModeView; maxActiveWorkers: number; localPriority: Priority; roles: string[]; repo: string | null; reviewFirst: string[];
}
/** 声明里有、生效里没有的条目 / 项目：原因只给固定码，网页按码翻译 */
interface DroppedView { peer: string; project?: string; code: "contact_gone" | "contact_disabled" | "fp_changed" | "project_gone" | "personal" }
export interface PeerView {
  peer: string;
  maxOpen: number;
  projects: string[];
  /** 条目有统一池（agents）项目时 = unifiedPeerCapacity（与 placement / 工作看板同口径），全是 legacy 时 = peerCapacity(maxOpen)；台账或 lend 表还不存在时 null */
  capacity: PeerCapacity | null;
  /** capacity 适用的项目：有统一项目时只列它们，否则列 legacy 项目；scheduler.json 读不了或台账不在时 [] */
  capacityProjects: string[];
  /** 仅混合条目：legacy 项目仍受 maxOpen 的读数与适用项目；其余 null。与 capacity 是同一台机器的两种计数上界，不能相加 */
  legacyCapacity: { projects: string[]; capacity: PeerCapacity } | null;
  reported: Record<string, { total: number; busy: number }> | null;
  paused: { reason: string; until: number } | null;
  grant: { roles: string[]; repos: string[]; until: number; ordersLeftToday: number } | null;
  /** 我方借入条目的角色与档位（不写 = balance） */
  roles: string[];
  priority: Priority;
  /** 对方 hello 里报的本周额度（bridge 内存）；没报 / 太旧 = null */
  quota: QuotaReport | null;
}
/** explainPlacement 原样；算不出（卡没了 / scheduler.json 坏 / 快照抛错）只给固定码，原文进日志 */
export type PlacementView = { role: string | null; where: string; reason: string } | { error: "unavailable" };
export interface RemoteRowView {
  orderId: string; taskId: string; title: string | null; project: string; peer: string; family: string; step: string; status: string;
  leaseUntil: number | null; beatAt: number | null; phase: string | null; placement: PlacementView;
}

/** W5 前的 overflow / prefer 都按 balance 显示（平均分配，满了堆本机）；只有 off 是总开关关 */
const modeView = (mode: string | undefined): RemoteModeView => (mode === "off" ? "off" : "balance");

function projectsView(): { projects: BorrowProjectView[]; cfg: SchedulerConfig | null } {
  try {
    const cfg = readSchedulerConfig(deps.schedulerPath);
    const projects = Object.entries(cfg.projects).map(([id, p]) => ({
      id, agents: p.agents ?? null, mode: modeView(p.remote?.mode), maxActiveWorkers: p.maxActiveWorkers, localPriority: p.remote?.localPriority ?? "balance",
      roles: [...(p.remote?.roles ?? [])], repo: p.remote?.repo ?? null, reviewFirst: [...(p.remote?.reviewFirst ?? [])],
    }));
    return { projects, cfg };
  } catch (e) {
    // scheduler.json 坏了：调度服务自己也不跑，这里只是不列项目、远端行的放置给 unavailable，网页照常显示 borrow 与 peer
    console.warn(`⚠️ [borrow] 读 scheduler.json 失败：${(e as Error).message}`);
    return { projects: [], cfg: null };
  }
}

/** 卡此刻放哪、为什么：与 `ledger lend-orders` 调同一个 placementOf，不另算；borrow 是同一个 now 的 effectiveLend */
function placementView(db: Database, taskId: string, cfg: SchedulerConfig | null, borrow: BorrowEntry[], now: number): PlacementView {
  try {
    const task = getTask(db, taskId);
    if (!task || !cfg) return { error: "unavailable" };
    return placementOf(db, task, cfg.projects[task.project] ?? null, borrow, now);
  } catch (e) {
    // 只读视图：这张卡的放置这一栏不显示，远端行与其余面板照常
    console.warn(`⚠️ [borrow] ${taskId} 算不出放置：${(e as Error).message}`);
    return { error: "unavailable" };
  }
}

function droppedOf(declared: readonly BorrowEntry[], effective: readonly BorrowEntry[], contacts: readonly LendContact[],
  projects: readonly (ProjectDef & { personal?: boolean })[]): DroppedView[] {
  const out: DroppedView[] = [];
  for (const e of declared) {
    const live = effective.find((x) => x.peer === e.peer);
    const c = contacts.find((x) => x.name === e.peer);
    if (!live && (!c || c.disabled || (e.fp && c.fp?.toLowerCase() !== e.fp))) {
      out.push({ peer: e.peer, code: !c ? "contact_gone" : c.disabled ? "contact_disabled" : "fp_changed" });
      continue;
    }
    for (const id of e.projects) {
      if (live?.projects.includes(id)) continue;
      const p = projects.find((x) => x.id === id);
      out.push({ peer: e.peer, project: id, code: p ? "personal" : "project_gone" });
    }
  }
  return out;
}

const hasTable = (db: Database, name: string): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

function openDb(): Database | null {
  try {
    return deps.db();
  } catch (e) {
    // 台账打不开（锁住 / 坏了）：容量与远端行按「不知道」显示，借入设置照常可看可改
    console.warn(`⚠️ [borrow] 台账打不开：${(e as Error).message}`);
    return null;
  }
}

/**
 * A peer's capacity is read the way placement counts it, per project of the entry: a project scheduler.json runs on the agents
 * pool sees the unified figure (no borrow.maxOpen); any other project still sees the legacy maxOpen cap. A mixed entry reports
 * both, each with the projects it applies to. Each figure is per peer, never summed per project: two projects share one set of seats.
 */
const splitProjects = (b: BorrowEntry, cfg: SchedulerConfig | null): { unified: string[]; legacy: string[] } => {
  // scheduler.json unreadable: which project runs which policy is unknown, so no scope is claimed (capacity keeps the legacy figure)
  if (!cfg) return { unified: [], legacy: [] };
  const known = b.projects.filter((id) => cfg.projects[id]);
  return { unified: known.filter((id) => !!cfg.projects[id]!.agents), legacy: known.filter((id) => !cfg.projects[id]!.agents) };
};

/** The wire keeps PeerCapacity's shape: totals / busy are already in `reported`. */
const peerCapacityOf = ({ totals: _t, busy: _b, ...cap }: UnifiedPeerCapacity): PeerCapacity => cap;

function peerView(db: Database | null, b: BorrowEntry, now: number, cfg: SchedulerConfig | null): PeerView {
  const { unified, legacy } = splitProjects(b, cfg);
  const mixed = unified.length > 0 && legacy.length > 0;
  const base = { peer: b.peer, maxOpen: b.maxOpen, projects: b.projects, roles: b.roles, priority: b.priority ?? "balance", quota: peerQuota(b.peer, now),
    capacityProjects: unified.length > 0 ? unified : legacy };
  // no ledger: no figure, so no scope either
  if (!db || !hasTable(db, "lend_orders")) return { ...base, capacityProjects: [], capacity: null, legacyCapacity: null, reported: null, paused: null, grant: null };
  const p = getLendPeer(db, b.peer);
  const g = p?.grant;
  const legacyCap = (): PeerCapacity => peerCapacity(db, b.peer, b.maxOpen, now);
  return {
    ...base, capacity: unified.length > 0 ? peerCapacityOf(unifiedPeerCapacity(db, b.peer, now)) : legacyCap(),
    legacyCapacity: mixed ? { projects: legacy, capacity: legacyCap() } : null, reported: p?.slots ?? null, paused: p?.paused ?? null,
    grant: g ? { roles: g.roles, repos: g.repos, until: g.until, ordersLeftToday: g.ordersLeftToday } : null,
  };
}

/** 远端行 = lend_orders 里还没结的单（LEND_LIVE）；beat 只取 phase，excerpt 是对方写的摘要，不出这里 */
function remoteRows(db: Database | null, place: (db: Database, taskId: string) => PlacementView): RemoteRowView[] {
  if (!db || !hasTable(db, "lend_orders")) return [];
  const cols = new Set((db.query("PRAGMA table_info(lend_orders)").all() as { name: string }[]).map((c) => c.name));
  const beat = cols.has("beat") ? "o.beat, o.beatAt" : "NULL AS beat, NULL AS beatAt";
  const rows = db.query(`SELECT o.orderId, o.taskId, t.title, o.project, o.peer, o.family, o.step, o.status, o.leaseUntil, ${beat}
    FROM lend_orders o LEFT JOIN tasks t ON t.id = o.taskId WHERE o.status IN (${LEND_LIVE.map(() => "?").join(",")})
    ORDER BY o.createdAt, o.orderId`).all(...LEND_LIVE) as (Omit<RemoteRowView, "phase" | "placement"> & { beat: string | null })[];
  const placed = new Map<string, PlacementView>();
  const placementFor = (id: string) => placed.get(id) ?? placed.set(id, place(db, id)).get(id)!;
  return rows.map(({ beat: raw, ...r }) => ({ ...r, title: r.title ?? null, leaseUntil: r.leaseUntil ?? null, beatAt: r.beatAt ?? null, phase: phaseOf(raw),
    placement: placementFor(r.taskId) }));
}

function phaseOf(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const v = (JSON.parse(raw) as { phase?: unknown }).phase;
    return typeof v === "string" ? v : null;
  } catch {
    // beat 是 lend-beat 写的 JSON；坏了只是这一行不显示阶段
    return null;
  }
}

/** 额度只是参考：读失败给 null，整份视图照常 */
async function localQuotaView(now: number): Promise<{ quota: QuotaReport; walled: boolean } | null> {
  try {
    return await deps.localQuota(now);
  } catch (e) {
    console.warn(`⚠️ [borrow] 读本机额度失败：${(e as Error).message}`);
    return null;
  }
}

export async function borrowView(now = deps.now()): Promise<Record<string, unknown>> {
  const [read, ctx, localQuota] = await Promise.all([readLend(deps.lendPath), deps.context(), localQuotaView(now)]);
  const eff = effectiveLend(read, ctx.contacts, ctx.projects, now);
  const db = openDb();
  const { projects, cfg } = projectsView();
  return {
    ok: true, now, schedulerOk: cfg !== null, projects, localQuota,
    borrow: {
      file: read.status, invalid: read.status === "invalid", declared: read.file.borrow, effective: eff.borrow,
      dropped: droppedOf(read.file.borrow, eff.borrow, ctx.contacts, ctx.projects),
      contacts: ctx.contacts.filter((c) => !c.disabled).map((c) => c.name),
      projects: ctx.projects.filter((p) => !isPersonalProject(p)).map((p) => ({ id: p.id, name: p.name })),
      maxOpenLimit: MAX_OPEN,
    },
    ledger: !!db && hasTable(db, "lend_orders"),
    peers: eff.borrow.map((b) => peerView(db, b, now, cfg)),
    remote: remoteRows(db, (d, id) => placementView(d, id, cfg, eff.borrow, now)),
  };
}

const fail = (status: number, code: string) => apiJson(status, { ok: false, code });

function decodeSegment(raw: string, re: RegExp): string | null {
  try {
    const p = decodeURIComponent(raw);
    return re.test(p) ? p : null;
  } catch {
    // 非法百分号编码：调用方回 400
    return null;
  }
}

type PeerPut = { projects?: string[]; maxOpen?: number; roles?: string[]; priority?: Priority };
const ROLES = ["review", "write"];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** 字符串数组：非空、不重复、每项过 ok；不合 = null */
const listOf = (v: unknown, max: number, ok: (x: string) => boolean): string[] | null =>
  Array.isArray(v) && v.length > 0 && v.length <= max && v.every((x) => typeof x === "string" && ok(x)) && new Set(v).size === v.length ? v as string[] : null;

/** PUT 的体：projects / maxOpen / roles / priority 都可选（没带的 CLI 沿用），至少带一个、不认识的键拒；不合形状 → null */
function parsePut(body: unknown): PeerPut | null {
  if (!isObj(body) || Object.keys(body).some((k) => !["projects", "maxOpen", "roles", "priority"].includes(k))) return null;
  const { projects, maxOpen, roles, priority } = body;
  const out: PeerPut = {};
  if (projects !== undefined) {
    const v = listOf(projects, 100, (p) => PROJECT_RE.test(p));
    if (!v) return null;
    out.projects = v;
  }
  if (maxOpen !== undefined) {
    if (!Number.isInteger(maxOpen) || (maxOpen as number) < 1 || (maxOpen as number) > MAX_OPEN) return null;
    out.maxOpen = maxOpen as number;
  }
  if (roles !== undefined) {
    const v = listOf(roles, 2, (r) => ROLES.includes(r));
    if (!v) return null;
    out.roles = v;
  }
  if (priority !== undefined) {
    if (!isPriority(priority)) return null;
    out.priority = priority;
  }
  return Object.keys(out).length ? out : null;
}

/** 值一律 `--flag=value`、peer 放 `--` 之后（与 lend-grant.ts 同一写法） */
function borrowSetArgs(peer: string, put: PeerPut): string[] {
  return ["borrow", "set", "--keep-unset", ...(put.projects ? [`--projects=${put.projects.join(",")}`] : []), ...(put.roles ? [`--roles=${put.roles.join(",")}`] : []),
    ...(put.maxOpen !== undefined ? [`--max-open=${put.maxOpen}`] : []), ...(put.priority ? [`--priority=${put.priority}`] : []), "--", peer];
}

/** CLI 结果 → 固定码；原文只进 bridge 日志 */
function cliResult(r: Record<string, unknown> | null, what: string): Response {
  if (r?.ok === true) return apiJson(200, { ok: true });
  console.warn(`⚠️ [borrow] ${what} 没成：${String(r?.error ?? "manager 无输出")}`);
  if (r?.code === "forbidden") return fail(403, "forbidden");
  return r && typeof r.error === "string" ? fail(409, "refused") : fail(502, "unavailable");
}

async function writePeer(req: Request, peer: string): Promise<Response> {
  const { contacts } = await deps.context();
  const known = contacts.some((c) => c.name === peer && !c.disabled);
  if (req.method === "DELETE") {
    const declared = (await readLend(deps.lendPath)).file.borrow.some((b) => b.peer === peer);
    if (!known && !declared) return fail(404, "unknown_peer");
    return cliResult(await deps.run(["borrow", "off", "--peer", peer]), `borrow off ${peer}`);
  }
  if (!known) return fail(404, "unknown_peer");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    // 体不是 JSON：和形状不对一样回 400
    return fail(400, "bad_body");
  }
  const put = parsePut(body);
  if (!put) return fail(400, "bad_body");
  return cliResult(await deps.run(borrowSetArgs(peer, put)), `borrow set ${peer}`);
}

async function readBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    // 体不是 JSON：和形状不对一样回 400
    return null;
  }
}

/** Pool writes reuse scheduler-local and its locked, audited setLocalSlots writer. */
async function writeLocal(req: Request, project: string): Promise<Response> {
  const body = await readBody(req);
  if (!isObj(body) || Object.keys(body).some((k) => !["priority", "maxActiveWorkers", "agents"].includes(k))) return fail(400, "bad_body");
  const { priority, maxActiveWorkers: n } = body;
  let agents: AgentLimits | undefined;
  try { agents = parseAgents(body.agents).agents; } catch {
    // Invalid pool shape must be rejected before starting the CLI.
    return fail(400, "bad_body");
  }
  if (priority === undefined && n === undefined && !agents) return fail(400, "bad_body");
  if (priority !== undefined && !isPriority(priority)) return fail(400, "bad_body");
  if (n !== undefined && (!Number.isInteger(n) || (n as number) < 0 || (n as number) > 32)) return fail(400, "bad_body");
  const args = ["ledger", "scheduler-local", project, ...(priority !== undefined ? [`--priority=${priority}`] : []),
    ...(n !== undefined ? [`--max-workers=${n}`] : []),
    ...(agents ? [`--agents=claude=${agents.claude},codex=${agents.codex}`] : []), "--reason=网页分配表"];
  return cliResult(await deps.run(args), `scheduler-local ${project}`);
}

export async function handleBorrowApi(req: Request, path: string, principal: Principal): Promise<Response | null> {
  if (path === "/borrow") {
    if (req.method !== "GET") return apiJson(405, { ok: false, error: "method not allowed" });
    if (!canReadLedger(principal)) return forbidden("borrow requires a full-scope owner credential");
    return apiJson(200, await borrowView());
  }
  const local = path.match(/^\/borrow\/local\/([^/]+)$/);
  if (local) {
    if (req.method !== "PUT") return apiJson(405, { ok: false, error: "method not allowed" });
    if (!canRunFleet(principal)) return forbidden("borrow settings require the owner's full-scope credential");
    const project = decodeSegment(local[1], PROJECT_RE);
    return project ? writeLocal(req, project) : fail(400, "bad_project");
  }
  const m = path.match(/^\/borrow\/peers\/([^/]+)$/);
  if (!m) return null;
  if (req.method !== "PUT" && req.method !== "DELETE") return apiJson(405, { ok: false, error: "method not allowed" });
  if (!canRunFleet(principal)) return forbidden("borrow settings require the owner's full-scope credential");
  const peer = decodeSegment(m[1], PEER_RE);
  if (!peer) return fail(400, "bad_peer");
  return writePeer(req, peer);
}
