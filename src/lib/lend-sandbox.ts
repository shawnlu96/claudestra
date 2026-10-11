/** SBXC2 records ownership and settlement facts. Only LIFESBX1 may supply the retire executor; this module sends no signals. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getOrder, isTerminal, LEND_JOURNAL_PATH, type LendRow } from "./lend-journal.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import type { LifecyclePolicy } from "./agent-lifecycle-config.js";
import type { CardWorker } from "./agent-lifecycle-store.js";
import type { LendDeps } from "./lend-drive.js";
import { canonicalPath, SANDBOX_MARKER } from "./sandbox.js";
import { writeJsonAtomic } from "./state-file.js";
import {
  addSandboxOwned, archiveOwnerEvidence, dirIdentity, identityVerdict, listSandboxOwners, probeProcess, readSandboxOwner, registerSandboxOwner, socketProblem,
  type SandboxOwnerKey, type SandboxOwnerRecord,
} from "./sandbox-order-owner.js";

const BINDING = "claudestra-sandbox-owner.json";
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const sandboxOwnersDir = (journal = LEND_JOURNAL_PATH): string => join(dirname(journal), "sandbox-owners");
type Mode = LifecyclePolicy["mode"];
interface Binding { v: 1; orderId: string; worker: string; generation: number; journal: string }

/** Written by the lender before creating the worker, outside tracked files; never guess an order from its directory name. */
export async function bindLendSandbox(row: LendRow, journal = LEND_JOURNAL_PATH): Promise<void> {
  if (!row.dir || !row.agent || !Number.isSafeInteger(row.leaseGen) || row.leaseGen! < 0) throw new Error("沙箱属主缺少订单 / worker / 代次");
  const git = lstatSync(join(row.dir, ".git"));
  if (!git.isDirectory() || git.isSymbolicLink()) throw new Error("沙箱属主只登记本单的独立 clone");
  // An empty readable catalog distinguishes a new order with no sandboxes from lost ownership evidence.
  mkdirSync(join(sandboxOwnersDir(journal), "records"), { recursive: true, mode: 0o700 });
  await writeJsonAtomic(join(row.dir, ".git", BINDING), {
    v: 1, orderId: row.orderId, worker: row.agent, generation: row.leaseGen!, journal: canonicalPath(journal),
  } satisfies Binding, { mode: 0o600, noFollow: true });
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
  if ((readSchedulerConfig(join(dirname(binding.journal), "..", "scheduler.json")).lifecycle?.mode ?? "observe") === "off") return null;
  if (lstatSync(join(root, SANDBOX_MARKER), { throwIfNoEntry: false })) throw new Error("已有沙箱不追认属主，请使用新的沙箱根");
  const dir = sandboxOwnersDir(binding.journal);
  const key = { orderId: row.orderId, worker: row.agent!, generation: row.leaseGen!, scope: `sandbox-${hash(canonicalPath(root)).slice(0, 24)}` };
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

/** Executor must revalidate identities and order under LIFE1's lifecycle lease before any effect; done means verified completion. */
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

/** Returns permission to continue the old checkout deletion. Observe, missing executor and uncertainty retain settlement for retry. */
export async function settleLendSandboxes(row: LendRow, d: LendDeps): Promise<boolean> {
  const p = d.sandbox;
  if (!p) return true; // Older injected callers retain their existing semantics; production always installs the facts adapter.
  try {
    p.active();
    const mode = p.mode();
    if (mode === "off") return true;
    const all = listSandboxOwners(p.owners);
    if (all.status !== "ok") throw new Error("属主目录失读，不能当没有沙箱");
    if (all.entries.some((e) => e.read.status !== "ok")) throw new Error("属主记录有未知对象，只读复核");
    const own = all.entries.flatMap((e) => e.read.status === "ok" && e.read.record.key.orderId === row.orderId ? [e.read.record] : []);
    if (!own.length && row.agent) {
      const binding = row.dir ? bindingIn(row.dir) : null;
      if (!binding || binding.orderId !== row.orderId || binding.worker !== row.agent || binding.generation !== row.leaseGen ||
        canonicalPath(sandboxOwnersDir(binding.journal)) !== canonicalPath(p.owners)) throw new Error("无可信启动绑定，legacy 只读保留");
    }
    let complete = true;
    for (const owner of own) {
      const request = await snapshotSandbox(row, owner, d);
      d.log(`${row.orderId} 沙箱 ${owner.key.scope} ${mode}：${owner.resources.map((r) => `${r.kind}:${r.pid}`).join(",")}；目录 ${owner.dirs.length}`);
      if (mode === "observe" || !p.retire) {
        d.log(`${row.orderId} ${mode === "on" ? "回收入口未接" : "仅观察"}，无信号 / 不删目录`);
        complete = false;
        continue;
      }
      if (request.observations.some((x) => x.verdict !== "same" && x.verdict !== "gone")) throw new Error("进程身份未知或 PID 复用，保留");
      p.active();
      const latest = getOrder(d.db, row.orderId);
      if (!latest || terminalProblem(latest, owner) || p.card(owner.key.worker)) throw new Error("回收前订单 / 代次 / 卡关联已变");
      const result = await p.retire(request);
      p.active();
      if (result.status !== "done") { d.log(`${row.orderId} 沙箱回收未完成：${result.reason ?? "retained"}`); complete = false; }
    }
    return complete;
  } catch (e) {
    p.active(); // Lost scheduler ownership must escape, not become a successful settlement.
    d.log(`${row.orderId} 沙箱事实未确认，保留收尾与目录：${(e as Error).message}`);
    return false;
  }
}
