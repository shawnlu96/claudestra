/** SBXC2 records ownership and settlement facts. Only LIFESBX1 may supply the retire executor; this module sends no signals. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getMeta, getOrder, setMeta, isTerminal, LEND_JOURNAL_PATH, type LendRow } from "./lend-journal.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import type { LifecyclePolicy } from "./agent-lifecycle-config.js";
import type { CardWorker } from "./agent-lifecycle-store.js";
import type { LendDeps } from "./lend-drive.js";
import { canonicalPath, SANDBOX_MARKER } from "./sandbox.js";
import { acquireLock } from "./file-lock.js";
import { writeJsonAtomic } from "./state-file.js";
import {
  addSandboxOwned, archiveOwnerEvidence, dirIdentity, identityVerdict, listSandboxOwners, ownerArea, probeProcess, readSandboxOwner, registerSandboxOwner, socketProblem,
  type SandboxOwnerKey, type SandboxOwnerRecord,
} from "./sandbox-order-owner.js";

const BINDING = "claudestra-sandbox-owner.json";
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const sandboxOwnersDir = (journal = LEND_JOURNAL_PATH): string => join(dirname(journal), "sandbox-owners");
type Mode = LifecyclePolicy["mode"];
interface Binding { v: 1; orderId: string; worker: string; generation: number; journal: string }

interface LaunchCatalog extends Binding { mode: Mode; sandboxes: { key: SandboxOwnerKey; root: string; mode: Mode }[] }
const orderId = (b: Pick<Binding, "orderId" | "worker" | "generation">) => hash(JSON.stringify([b.orderId, b.worker, b.generation]));
const rowBinding = (row: LendRow) => ({ orderId: row.orderId, worker: row.agent ?? "", generation: row.leaseGen ?? -1 });
const catalogFile = (owners: string, b: Pick<Binding, "orderId" | "worker" | "generation">) => join(owners, "bindings", `${orderId(b)}.json`);
const launchMode = (b: Binding): Mode => readSchedulerConfig(join(dirname(b.journal), "..", "scheduler.json")).lifecycle?.mode ?? "observe";

function readCatalog(owners: string, b: Pick<Binding, "orderId" | "worker" | "generation">): LaunchCatalog | null {
  const file = catalogFile(owners, b), st = lstatSync(file, { throwIfNoEntry: false });
  if (!st) return null;
  ownerArea(owners, "bindings", false);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error("启动登记不是普通文件");
  const c = JSON.parse(readFileSync(file, "utf8")) as LaunchCatalog;
  if (c.v !== 1 || orderId(c) !== orderId(b) || !["on", "observe", "off"].includes(c.mode) || !Array.isArray(c.sandboxes) ||
    c.sandboxes.some((s) => !s.key || orderId(s.key) !== orderId(b) || typeof s.key.scope !== "string" ||
      !s.root?.startsWith("/") || !["on", "observe", "off"].includes(s.mode))) throw new Error("启动登记损坏");
  return c;
}

/** The lender's catalog lives outside the clone. Planned keys survive failed startup and make reads order-local. */
async function updateCatalog(b: Binding, change: (c: LaunchCatalog) => void, create = false): Promise<void> {
  const owners = sandboxOwnersDir(b.journal), file = catalogFile(owners, b);
  ownerArea(owners, "bindings", true);
  const lock = await acquireLock(`${file}.lock`, 10_000);
  if (!lock) throw new Error("启动登记被占用");
  try {
    const old = readCatalog(owners, b);
    if (!old && !create) throw new Error("启动登记丢失，不追认");
    const c = old ?? { ...b, mode: launchMode(b), sandboxes: [] };
    change(c);
    if (!lock.held()) throw new Error("启动登记失锁");
    await writeJsonAtomic(file, c, { mode: 0o600, noFollow: true });
  } finally { lock.release(); }
}

/** Written by the lender before creating the worker, outside tracked files; never guess an order from its directory name. */
export async function bindLendSandbox(row: LendRow, journal = LEND_JOURNAL_PATH): Promise<void> {
  if (!row.dir || !row.agent || !Number.isSafeInteger(row.leaseGen) || row.leaseGen! < 0) throw new Error("沙箱属主缺少订单 / worker / 代次");
  const git = lstatSync(join(row.dir, ".git"));
  if (!git.isDirectory() || git.isSymbolicLink()) throw new Error("沙箱属主只登记本单的独立 clone");
  // An empty readable catalog distinguishes a new order with no sandboxes from lost ownership evidence.
  mkdirSync(sandboxOwnersDir(journal), { recursive: true, mode: 0o700 });
  ownerArea(sandboxOwnersDir(journal), "records", true);
  const binding: Binding = { v: 1, orderId: row.orderId, worker: row.agent, generation: row.leaseGen!, journal: canonicalPath(journal) };
  if (lstatSync(join(row.dir, ".git", BINDING), { throwIfNoEntry: false }) && !readCatalog(sandboxOwnersDir(journal), binding)) {
    throw new Error("已有启动绑定缺少外部登记，不追认无沙箱");
  }
  await updateCatalog(binding, () => {}, true);
  await writeJsonAtomic(join(row.dir, ".git", BINDING), binding, { mode: 0o600, noFollow: true });
}

function bindingIn(cwd: string): Binding | null {
  for (let dir = canonicalPath(cwd); ; dir = dirname(dir)) {
    const git = join(dir, ".git");
    const gitStat = lstatSync(git, { throwIfNoEntry: false });
    if (gitStat?.isDirectory() && !gitStat.isSymbolicLink()) {
      const file = join(git, BINDING), st = lstatSync(file, { throwIfNoEntry: false });
      if (!st) return null;
      if (!st.isFile() || st.isSymbolicLink()) throw new Error("沙箱属主绑定不是普通文件");
      const b = JSON.parse(readFileSync(file, "utf8")) as Binding;
      if (b.v !== 1 || !b.orderId || !b.worker || !Number.isSafeInteger(b.generation) || b.generation < 0 || !b.journal?.startsWith("/")) {
        throw new Error("沙箱属主绑定损坏");
      }
      return b;
    }
    if (dirname(dir) === dir) return null;
  }
}

function boundOrder(b: Binding, cwd: string): LendRow {
  const db = new Database(b.journal, { readonly: true });
  try {
    const row = getOrder(db, b.orderId);
    const dir = row?.dir && canonicalPath(row.dir), here = canonicalPath(cwd);
    if (!row || row.agent !== b.worker || row.leaseGen !== b.generation || !dir || (here !== dir && !here.startsWith(`${dir}/`))) {
      throw new Error("沙箱属主与 journal 的订单 / worker / 代次 / clone 不一致");
    }
    if (!["cloned", "started"].includes(row.state) || row.payload || row.work || !row.leaseUntil || row.leaseUntil <= Date.now()) {
      throw new Error("订单非活代次或已有待交结果，不启动沙箱");
    }
    return row;
  } finally { db.close(); }
}

export interface SandboxLaunch {
  key: SandboxOwnerKey;
  add(item: { pid: number; kind: "tmux" | "bridge" | "child"; socket?: string }): Promise<void>;
  ready(): Promise<void>;
}

/** Pre-start directory identity survives partial startup; every subsequent resource uses the same SBXC1 key. */
export async function beginLendSandbox(root: string, cwd = process.cwd()): Promise<SandboxLaunch | null> {
  const binding = bindingIn(cwd);
  if (!binding) return null; // Ordinary and legacy sandboxes have no lender-issued binding; never backfill their PIDs.
  const row = boundOrder(binding, cwd);
  const mode = launchMode(binding);
  if (mode !== "off" && lstatSync(join(root, SANDBOX_MARKER), { throwIfNoEntry: false })) {
    throw new Error("已有沙箱不追认属主；down 保留根标记，请使用新的沙箱根（clean 不会抹掉历史属主记录）");
  }
  const dir = sandboxOwnersDir(binding.journal);
  const key = { orderId: row.orderId, worker: row.agent!, generation: row.leaseGen!, scope: `sandbox-${hash(canonicalPath(root)).slice(0, 24)}` };
  await updateCatalog(binding, (c) => {
    boundOrder(binding, cwd); // Waiting for the catalog lock must not let a just-ended order start new resources.
    const previous = c.sandboxes.filter((s) => s.key.scope === key.scope);
    if (previous.length && mode !== "off") throw new Error("这一根已有启动登记，请使用新的沙箱根");
    if (previous.some((s) => s.mode === "off")) return;
    c.sandboxes.push({ key, root: canonicalPath(root), mode });
  });
  if (mode === "off") return null; // Keep a durable unregistered-root fact for a later mode flip; no PID adoption.
  await registerSandboxOwner(dir, { key, root, resources: [], dirs: [root] });
  return {
    key,
    add: async (item) => { boundOrder(binding, cwd); await addSandboxOwned(dir, key, item); },
    ready: async () => {
      boundOrder(binding, cwd);
      const r = readSandboxOwner(dir, key);
      if (r.status !== "ok") throw new Error(r.reason);
      const observations = await Promise.all(r.record.resources.map(async (p) => ({ pid: p.pid, verdict: identityVerdict(p, await probeProcess(p.pid)) })));
      if (observations.some((p) => p.verdict !== "same")) throw new Error("沙箱启动后资源身份不明，不报成功");
      await archiveOwnerEvidence(dir, r.record, { phase: "ready", head: row.wire?.order.head ?? null, observations }, Date.now());
    },
  };
}

export interface SandboxRetireRequest {
  owner: SandboxOwnerRecord;
  order: { orderId: string; worker: string; generation: number; sessionId: string | null; state: LendRow["state"]; head: string | null };
  observations: { pid: number; verdict: ReturnType<typeof identityVerdict> }[];
  evidence: { path: string; sha256: string };
}

/** Startup resources are not a complete descendant census. LIFE1 must revalidate dynamic children and identities
 * under its lifecycle lease before any effect; done means verified completion, never merely a signal sent. */
export type SandboxRetirePort = (request: SandboxRetireRequest) => Promise<{ status: "done" | "retained"; reason?: string }>;
export interface SandboxSettlementPorts {
  owners: string;
  mode(): Mode;
  /** Must use LIFE1 cardWorkerIndex; any local card link protects the worker, and a read error must throw. */
  card(worker: string): CardWorker | undefined;
  active(): void;
  retire?: SandboxRetirePort;
}

function terminalProblem(row: LendRow, owner: SandboxOwnerRecord): string | null {
  if (!isTerminal(row.state)) return "订单非终态";
  if ((row.payload || row.work) && !row.receipt) return "仍有待交 / 待回执结果";
  const key = owner.key;
  return row.orderId !== key.orderId || row.agent !== key.worker || row.leaseGen !== key.generation ? "订单 / worker / 代次不一致" : null;
}

async function snapshotSandbox(row: LendRow, owner: SandboxOwnerRecord, d: LendDeps): Promise<SandboxRetireRequest> {
  const p = d.sandbox!;
  p.active();
  const current = getOrder(d.db, row.orderId);
  if (!current || terminalProblem(current, owner)) throw new Error(current ? terminalProblem(current, owner)! : "订单失读");
  if (p.card(owner.key.worker)) throw new Error("worker 关联本机卡，保留");
  if (await d.worker.alive(owner.key.worker) !== "no_window") throw new Error("worker 活性未确认退出，保留");
  for (const dir of owner.dirs) {
    const current = dirIdentity(dir.path);
    if (current && JSON.stringify(current) !== JSON.stringify(dir)) throw new Error("自有目录身份已变，保留");
  }
  const observations = await Promise.all(owner.resources.map(async (r) => ({ pid: r.pid, verdict: identityVerdict(r, await probeProcess(r.pid)) })));
  for (const r of owner.resources) {
    if (r.kind === "tmux" && observations.find((o) => o.pid === r.pid)?.verdict === "same" && socketProblem(r.socket!, owner.root)) {
      throw new Error("tmux socket 不是本单私有对象，保留");
    }
  }
  const reread = readSandboxOwner(p.owners, owner.key);
  if (reread.status !== "ok" || JSON.stringify(reread.record) !== JSON.stringify(owner)) throw new Error("属主记录失读或已变，保留");
  p.active();
  const order = { orderId: current.orderId, worker: current.agent!, generation: current.leaseGen!, sessionId: current.sessionId, state: current.state,
    head: current.work?.head ?? (typeof current.wire?.order.head === "string" ? current.wire.order.head : null) };
  const path = await archiveOwnerEvidence(p.owners, owner, { order, observations }, Date.now());
  return { owner, order, observations, evidence: { path, sha256: hash(readFileSync(path)) } };
}

type Settlement = "remove" | "deferred" | "retry";

/** Persist facts separately from normal settlement so observation cannot block update-gap or reborrow. */
async function deferSandbox(row: LendRow, d: LendDeps, reason: string, facts: unknown): Promise<Settlement> {
  const body = { v: 1, owner: rowBinding(row), state: row.state, dir: row.dir, reason, facts };
  mkdirSync(d.sandbox!.owners, { recursive: true, mode: 0o700 });
  const file = join(ownerArea(d.sandbox!.owners, "deferred", true), `${orderId(rowBinding(row))}.json`);
  await writeJsonAtomic(file, body, { mode: 0o600, noFollow: true });
  if (readFileSync(file, "utf8") !== JSON.stringify(body, null, 2)) throw new Error("待回收事实读回不一致");
  d.sandbox!.active();
  reportOnce(row, d, `${reason}，无信号 / 不删目录；待回收清单 ${file}`);
  return "deferred";
}

function reportOnce(row: LendRow, d: LendDeps, message: string): void {
  const key = `sandbox-report:${orderId(rowBinding(row))}`;
  if (getMeta(d.db, key)) return;
  setMeta(d.db, key, "1");
  d.log(`${row.orderId} ${message}`);
}

function orderOwners(row: LendRow, owners: string, catalog: LaunchCatalog | null): SandboxOwnerRecord[] {
  if (catalog) return catalog.sandboxes.filter((s) => s.mode !== "off").map((s) => {
    const r = readSandboxOwner(owners, s.key);
    if (r.status !== "ok") throw new Error(r.reason);
    return r.record;
  });
  const all = listSandboxOwners(owners);
  if (all.status !== "ok") {
    if (!lstatSync(owners, { throwIfNoEntry: false })) return [];
    throw new Error("属主目录失读，不能当没有沙箱");
  }
  // Without a trusted catalog a corrupt hash-named record cannot be assigned to any order safely.
  if (all.entries.some((e) => e.read.status !== "ok")) throw new Error("属主记录有无法归属的未知对象，只读复核");
  return all.entries.flatMap((e) => e.read.status === "ok" && e.read.record.key.orderId === row.orderId ? [e.read.record] : []);
}

/** remove permits the old deletion; deferred completes business settlement; retry preserves failed/uncertain work. */
export async function settleLendSandboxes(row: LendRow, d: LendDeps): Promise<Settlement> {
  const p = d.sandbox;
  if (!p) return "remove";
  try {
    p.active();
    const mode = p.mode();
    if (mode === "off") return "remove";
    if (!isTerminal(row.state) || ((row.payload || row.work) && !row.receipt)) throw new Error("订单仍活或结果待交");
    if (row.agent && (p.card(row.agent) || await d.worker.alive(row.agent) !== "no_window")) throw new Error("worker 仍活 / 未知 / 关联本机卡，保留");
    const catalog = readCatalog(p.owners, rowBinding(row));
    const own = orderOwners(row, p.owners, catalog);
    if (!own.length && !catalog?.sandboxes.length) {
      if (catalog || (!row.sessionId && !row.startedAt && row.state === "released") || !row.agent) return "remove";
      return await deferSandbox(row, d, "无可信启动绑定，legacy 只读保留", []);
    }
    const requests: SandboxRetireRequest[] = [];
    for (const owner of own) requests.push(await snapshotSandbox(row, owner, d));
    if (requests.some((r) => r.observations.some((x) => x.verdict !== "same" && x.verdict !== "gone"))) throw new Error("进程身份未知或 PID 复用，保留");
    if (catalog?.sandboxes.some((s) => s.mode === "off")) {
      return await deferSandbox(row, d, "off 启动未登记资源，legacy 只读保留", { catalog, requests });
    }
    if (mode === "observe" || !p.retire) {
      return await deferSandbox(row, d, mode === "on" ? "回收入口未接" : "仅观察", requests);
    }
    let complete = true;
    for (const request of requests) {
      p.active();
      const latest = getOrder(d.db, row.orderId);
      if (!latest || terminalProblem(latest, request.owner) || p.card(request.owner.key.worker)) throw new Error("回收前订单 / 代次 / 卡关联已变");
      const result = await p.retire(request);
      p.active();
      if (result.status !== "done") { reportOnce(row, d, "沙箱回收未完成，保留收尾与目录"); complete = false; }
    }
    return complete ? "remove" : "retry";
  } catch (e) {
    p.active(); // Lost scheduler ownership must escape, not become a successful settlement.
    reportOnce(row, d, `沙箱事实未确认，保留收尾与目录：${(e as Error).message}`);
    return "retry";
  }
}
