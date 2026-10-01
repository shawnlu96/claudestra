/**
 * 借入方管理面（i28-R7b，方案 ledger/docs/remote-pool-v2-plan.md §2.3、§2.6）：A 侧 owner 在网页看「借谁的机器」并用按钮改。
 *   GET    /api/v1/borrow              canReadLedger：项目的 remote.mode、borrow 声明 / 生效 / 失效、各 peer 容量、远端在跑的单与放置结果
 *   PUT    /api/v1/borrow/peers/:peer  canRunFleet：`borrow set --projects … --roles review --max-open N -- <peer>`
 *   DELETE /api/v1/borrow/peers/:peer  canRunFleet：`borrow off --peer <peer>`
 * 写只经 manager CLI（准入以 buildBorrowEntry 为准，bridge 只查形状），回包只带固定错误码：CLI 原文里有命令提示，不给网页。
 * scheduler.json 没有写入口，remote.mode 这里只读。容量原样取 peerCapacity，不另算。tests/web-borrow-view.test.ts。
 */
import type { Database } from "bun:sqlite";
import { canReadLedger } from "../../lib/devices.js";
import { LEND_LIVE } from "../../lib/ledger-lend-schema.js";
import { getTask } from "../../lib/ledger-store.js";
import { getLendPeer, peerCapacity, type PeerCapacity } from "../../lib/ledger-lend-peers.js";
import { LEND_PATH, MAX_OPEN, readLend, type BorrowEntry } from "../../lib/lend-config.js";
import { placementOf } from "../../lib/lend-placement-view.js";
import { effectiveLend, isPersonalProject, readLendContext, type LendContact } from "../../lib/lend-policy.js";
import { canRunFleet, type Principal } from "../../lib/principals.js";
import type { ProjectDef } from "../../lib/projects.js";
import { runManagerProcess } from "../../lib/run-manager.js";
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
interface BorrowProjectView { id: string; mode: RemoteModeView; maxActiveWorkers: number }
/** 声明里有、生效里没有的条目 / 项目：原因只给固定码，网页按码翻译 */
interface DroppedView { peer: string; project?: string; code: "contact_gone" | "contact_disabled" | "fp_changed" | "project_gone" | "personal" }
export interface PeerView {
  peer: string;
  maxOpen: number;
  projects: string[];
  /** peerCapacity 原样；台账或 lend 表还不存在时 null */
  capacity: PeerCapacity | null;
  reported: Record<string, { total: number; busy: number }> | null;
  paused: { reason: string; until: number } | null;
  grant: { roles: string[]; repos: string[]; until: number; ordersLeftToday: number } | null;
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
    const projects = Object.entries(cfg.projects).map(([id, p]) => ({ id, mode: modeView(p.remote?.mode), maxActiveWorkers: p.maxActiveWorkers }));
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

function peerView(db: Database | null, b: BorrowEntry, now: number): PeerView {
  const base = { peer: b.peer, maxOpen: b.maxOpen, projects: b.projects };
  if (!db || !hasTable(db, "lend_orders")) return { ...base, capacity: null, reported: null, paused: null, grant: null };
  const p = getLendPeer(db, b.peer);
  const g = p?.grant;
  return {
    ...base, capacity: peerCapacity(db, b.peer, b.maxOpen, now), reported: p?.slots ?? null, paused: p?.paused ?? null,
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

export async function borrowView(now = deps.now()): Promise<Record<string, unknown>> {
  const [read, ctx] = await Promise.all([readLend(deps.lendPath), deps.context()]);
  const eff = effectiveLend(read, ctx.contacts, ctx.projects, now);
  const db = openDb();
  const { projects, cfg } = projectsView();
  return {
    ok: true, now, schedulerOk: cfg !== null, projects,
    borrow: {
      file: read.status, invalid: read.status === "invalid", declared: read.file.borrow, effective: eff.borrow,
      dropped: droppedOf(read.file.borrow, eff.borrow, ctx.contacts, ctx.projects),
      contacts: ctx.contacts.filter((c) => !c.disabled).map((c) => c.name),
      projects: ctx.projects.filter((p) => !isPersonalProject(p)).map((p) => ({ id: p.id, name: p.name })),
      maxOpenLimit: MAX_OPEN,
    },
    ledger: !!db && hasTable(db, "lend_orders"),
    peers: eff.borrow.map((b) => peerView(db, b, now)),
    remote: remoteRows(db, (d, id) => placementView(d, id, cfg, eff.borrow, now)),
  };
}

const fail = (status: number, code: string) => apiJson(status, { ok: false, code });

function decodePeer(raw: string): string | null {
  try {
    const p = decodeURIComponent(raw);
    return PEER_RE.test(p) ? p : null;
  } catch {
    // 非法百分号编码：调用方回 400
    return null;
  }
}

/** PUT 的体：projects 非空不重复的项目 id，maxOpen 1..MAX_OPEN；不合形状 → null */
function parsePut(body: unknown): { projects: string[]; maxOpen: number } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { projects, maxOpen } = body as Record<string, unknown>;
  if (!Array.isArray(projects) || projects.length === 0 || projects.length > 100) return null;
  if (!projects.every((p) => typeof p === "string" && PROJECT_RE.test(p)) || new Set(projects).size !== projects.length) return null;
  if (!Number.isInteger(maxOpen) || (maxOpen as number) < 1 || (maxOpen as number) > MAX_OPEN) return null;
  return { projects: projects as string[], maxOpen: maxOpen as number };
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
  const args = ["borrow", "set", "--projects", put.projects.join(","), "--roles", "review", "--max-open", String(put.maxOpen), "--", peer];
  return cliResult(await deps.run(args), `borrow set ${peer}`);
}

export async function handleBorrowApi(req: Request, path: string, principal: Principal): Promise<Response | null> {
  if (path === "/borrow") {
    if (req.method !== "GET") return apiJson(405, { ok: false, error: "method not allowed" });
    if (!canReadLedger(principal)) return forbidden("borrow requires a full-scope owner credential");
    return apiJson(200, await borrowView());
  }
  const m = path.match(/^\/borrow\/peers\/([^/]+)$/);
  if (!m) return null;
  if (req.method !== "PUT" && req.method !== "DELETE") return apiJson(405, { ok: false, error: "method not allowed" });
  if (!canRunFleet(principal)) return forbidden("borrow settings require the owner's full-scope credential");
  const peer = decodePeer(m[1]);
  if (!peer) return fail(400, "bad_peer");
  return writePeer(req, peer);
}
