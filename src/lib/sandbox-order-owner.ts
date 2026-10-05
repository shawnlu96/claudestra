/**
 * 订单沙箱的显式属主记录：哪一单、哪个 worker、第几代拥有哪些进程（私有 tmux server / 沙箱 bridge / 登记的子进程）和临时目录。
 * 清理只认这里的记录（lib/sandbox-order-cleanup.ts），不按目录名、进程名推断归属。
 * - 身份 = pid + 启动时刻（ps lstart）+ 命令行哈希 + 真实 cwd；只存哈希和入口名，命令行原文可能带凭据，不落盘。
 * - 记录由创建端登记时自己探测进程得来，调用方只给 pid / 目录；根目录、socket、cwd、目录（真实路径 + dev/ino）都核过才写。
 * - 存放在沙箱根之外的属主目录（records/ archive/ locks/），终态、重启后仍可读；任何一步读不清都是 unknown，不是「没有」。
 * tests/sandbox-order-owner.test.ts
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { acquireLock, type LockHandle } from "./file-lock.js";
import { DEFAULT_RUNTIME_DIR, RUNTIME_DIR, STATE_DIR, stateDirIn } from "./paths.js";
import { canonicalPath, denyDirs, pathsOverlap } from "./sandbox.js";
import { parseState, writeJsonAtomic } from "./state-file.js";

type OwnedKind = "tmux" | "bridge" | "child";

export interface SandboxOwnerKey { orderId: string; worker: string; generation: number; scope: string }

/** 一个自有进程的身份；startedAt 是 lstart 解析出的毫秒（秒级精度），同一进程每次读都相同 */
export interface OwnedResource {
  kind: OwnedKind;
  pid: number;
  startedAt: number;
  commandHash: string;
  entry: string;
  cwd: string;
  /** 仅 tmux：私有 socket 的真实路径 */
  socket?: string;
}

/** 创建端显式登记的自有临时目录：真实路径 + dev/ino，同名换了一个目录就对不上 */
export interface OwnedDir { path: string; dev: number; ino: number }

export interface CleanupMark { attempts: number; lastAt: number; done: boolean; outcomes: string[] }

export interface SandboxOwnerRecord {
  v: 1;
  key: SandboxOwnerKey;
  /** 沙箱私有根目录的真实路径 */
  root: string;
  createdAt: number;
  resources: OwnedResource[];
  dirs: OwnedDir[];
  cleanup?: CleanupMark;
}

export type OwnerRead = { status: "ok"; record: SandboxOwnerRecord } | { status: "unknown"; reason: string };

export type ProcessProbe =
  | { state: "gone" }
  | { state: "unknown"; reason: string }
  | { state: "alive"; startedAt: number; commandHash: string; entry: string; cwd: string; command: string };

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;
const LOCK_WAIT_MS = 10_000;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const inside = (child: string, parent: string) => {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

/** 记录文件名：key 的哈希（orderId 里有冒号等字符，不拿它直接拼路径）；读出来还要核 key 本身 */
export function ownerRecordId(key: SandboxOwnerKey): string {
  return sha(JSON.stringify([key.orderId, key.worker, key.generation, key.scope])).slice(0, 32);
}

function keyProblem(key: SandboxOwnerKey): string | null {
  if (!NAME_RE.test(key.orderId) || !NAME_RE.test(key.worker) || !NAME_RE.test(key.scope)) return "订单 / worker / 作用域名字不合法";
  return Number.isSafeInteger(key.generation) && key.generation >= 0 ? null : "代次必须是非负整数";
}

// ── 进程身份 ──

async function run(cmd: string[]): Promise<{ code: number | null; out: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", timeout: 10_000, env: { ...process.env, LC_ALL: "C", LANG: "C", LC_TIME: "C" } });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { code, out };
}

/** kill(pid, 0)：ESRCH 才是确定不在；EPERM（别人的进程）等其他错误都是不知道 */
function pidPresence(pid: number): "alive" | "gone" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown";
  }
}

async function processCwd(pid: number): Promise<string | null> {
  if (process.platform === "linux") {
    try { return canonicalPath(readlinkSync(`/proc/${pid}/cwd`)); } catch { return null; /* 读不到 cwd：调用方按 unknown 处理 */ }
  }
  const r = await run(["lsof", "-a", "-d", "cwd", "-p", String(pid), "-Fn"]);
  const line = r.code === 0 ? r.out.split("\n").find((l) => l.startsWith("n/")) : undefined;
  return line ? canonicalPath(line.slice(1)) : null;
}

/** 读一个 pid 此刻的身份；ps / cwd 任何一步失败而进程又没确定消失，就是 unknown */
export async function probeProcess(pid: number): Promise<ProcessProbe> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return { state: "unknown", reason: `pid ${pid} 不合法` };
  const before = pidPresence(pid);
  if (before !== "alive") return before === "gone" ? { state: "gone" } : { state: "unknown", reason: `pid ${pid} 探不了（无权限）` };
  const ps = await run(["ps", "-ww", "-o", "lstart=,command=", "-p", String(pid)]);
  const line = ps.out.split("\n").find((l) => l.trim()) ?? "";
  // C locale 下 lstart 固定 24 个字符（"Mon Oct  5 18:33:42 2026"），后面是命令行
  const startedAt = Date.parse(line.slice(0, 24));
  const command = line.slice(24).trim();
  const cwd = ps.code === 0 && Number.isFinite(startedAt) && command ? await processCwd(pid) : null;
  if (cwd === null) {
    if (pidPresence(pid) === "gone") return { state: "gone" };
    return { state: "unknown", reason: `pid ${pid} 的启动时刻 / 命令行 / cwd 读不全` };
  }
  return { state: "alive", startedAt, commandHash: sha(command), entry: basename(command.split(/\s+/)[0] ?? ""), cwd, command };
}

/** 探测结果与登记身份对照：启动时刻不同 = pid 已被复用（原进程必然已退）；时刻相同但命令 / cwd 对不上 = 说不清 */
export function identityVerdict(r: OwnedResource, p: ProcessProbe): "same" | "gone" | "reused" | "unknown" {
  if (p.state !== "alive") return p.state === "gone" ? "gone" : "unknown";
  if (p.startedAt !== r.startedAt) return "reused";
  return p.commandHash === r.commandHash && p.cwd === r.cwd ? "same" : "unknown";
}

// ── 路径核对 ──

/** 目录本身不是软链、是目录；返回真实路径 */
function realDir(path: string, what: string): string {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) throw new Error(`${what} ${path} 不存在`);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${what} ${path} 不是普通目录（软链 / 文件）`);
  return canonicalPath(path);
}

/** 沙箱根 / 自有目录不许是家目录 / 生产状态目录 / 运行目录本身或它们的祖先，也不许落在共享运行目录里或与属主目录重叠 */
function rootProblem(root: string, ownerDir: string, what = "沙箱根"): string | null {
  const guarded = [homedir(), stateDirIn(homedir()), STATE_DIR, DEFAULT_RUNTIME_DIR, RUNTIME_DIR, ...denyDirs(process.env)].map(canonicalPath);
  if (guarded.some((g) => inside(g, root))) return `${what} ${root} 包含家目录或生产目录`;
  if (inside(root, canonicalPath(DEFAULT_RUNTIME_DIR))) return `${what} ${root} 在共享运行目录里`;
  return pathsOverlap(root, ownerDir) ? `${what} ${root} 与属主目录重叠` : null;
}

/** 此刻的目录身份；不在 = null，软链 / 不是目录抛错；真实路径与 dev/ino 由调用方和登记值比 */
export function dirIdentity(path: string): OwnedDir | null {
  if (!lstatSync(path, { throwIfNoEntry: false })) return null;
  const real = realDir(path, "自有目录");
  const st = lstatSync(path);
  return { path: real, dev: st.dev, ino: st.ino };
}

/** 私有 socket：必须是 socket 文件、不是软链、真实路径在沙箱根下，且不是任何共享 master socket */
export function socketProblem(socket: string, root: string): string | null {
  const st = lstatSync(socket, { throwIfNoEntry: false });
  if (!st || st.isSymbolicLink() || !st.isSocket()) return `${socket} 不是 socket 文件（不存在 / 软链）`;
  const real = canonicalPath(socket);
  if (!inside(real, root)) return `socket ${real} 不在沙箱根 ${root} 下`;
  const shared = [DEFAULT_RUNTIME_DIR, RUNTIME_DIR].map(canonicalPath).find((d) => inside(real, d)); // 共享 master socket 所在的运行目录
  return shared ? `socket ${real} 在共享运行目录 ${shared} 里` : null;
}

/** 只建子目录：属主目录本身只由登记创建，清理时它不见了是 unknown，不能悄悄建一个空的 */
function ownerArea(dir: string, area: "records" | "archive" | "locks", create: boolean): string {
  const base = realDir(dir, "属主目录");
  if (create) mkdirSync(join(dir, area), { recursive: true, mode: 0o700 }); // base 已核过存在：recursive 只为并发建同一子目录不报 EEXIST
  const sub = realDir(join(dir, area), "属主目录");
  if (sub !== join(base, area)) throw new Error(`属主目录 ${area} 越出 ${base}`);
  return sub;
}

// ── 记录读写 ──

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function validResource(r: unknown): r is OwnedResource {
  const o = r as OwnedResource;
  if (!o || !["bridge", "child", "tmux"].includes(o.kind) || !Number.isSafeInteger(o.pid) || o.pid <= 1) return false;
  if (!isNum(o.startedAt) || !/^[0-9a-f]{64}$/.test(String(o.commandHash)) || typeof o.entry !== "string" || !isStr(o.cwd)) return false;
  return o.kind === "tmux" ? isStr(o.socket) : o.socket === undefined;
}

const validDir = (x: unknown) => isStr((x as OwnedDir)?.path) && isAbsolute((x as OwnedDir).path) && isNum((x as OwnedDir).dev) && isNum((x as OwnedDir).ino);

function validRecord(d: unknown): d is SandboxOwnerRecord {
  const o = d as SandboxOwnerRecord;
  if (!o || o.v !== 1 || !o.key || keyProblem(o.key) !== null || !isStr(o.root) || !isAbsolute(o.root) || !isNum(o.createdAt)) return false;
  if (!Array.isArray(o.resources) || !o.resources.every(validResource) || !Array.isArray(o.dirs) || !o.dirs.every(validDir)) return false;
  const c = o.cleanup;
  if (c !== undefined && (!c || typeof c !== "object" || !Number.isSafeInteger(c.attempts) || c.attempts < 1 || !isNum(c.lastAt) || typeof c.done !== "boolean" ||
    !Array.isArray(c.outcomes) || !c.outcomes.every((x) => typeof x === "string"))) return false;
  return o.resources.length + o.dirs.length > 0;
}

const sameKey = (a: SandboxOwnerKey, b: SandboxOwnerKey) => ownerRecordId(a) === ownerRecordId(b) && a.orderId === b.orderId &&
  a.worker === b.worker && a.generation === b.generation && a.scope === b.scope;

/** 结构损坏一律 unknown；本单核根，完成记录允许根已被创建端移除，结构列举仍保留未完成的资源声明。 */
function readRecordFile(file: string, requireRoot = true): OwnerRead {
  const st = lstatSync(file, { throwIfNoEntry: false });
  if (!st) return { status: "unknown", reason: "没有属主记录" };
  if (st.isSymbolicLink() || !st.isFile()) return { status: "unknown", reason: "属主记录不是普通文件（软链？）" };
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch (e) { return { status: "unknown", reason: `属主记录读不了：${(e as Error).message}` }; }
  const parsed = parseState(raw, validRecord);
  if (parsed.status !== "ok") return { status: "unknown", reason: `属主记录损坏：${parsed.status === "corrupt" ? parsed.error : "缺失"}` };
  const record = parsed.data as SandboxOwnerRecord;
  if (basename(file) !== `${ownerRecordId(record.key)}.json`) return { status: "unknown", reason: "属主记录文件名与内容的 key 对不上" };
  if (!requireRoot || (record.cleanup?.done && !lstatSync(record.root, { throwIfNoEntry: false }))) return { status: "ok", record };
  try {
    if (realDir(record.root, "沙箱根") !== record.root) return { status: "unknown", reason: "沙箱根的真实路径变了" };
  } catch (e) {
    return { status: "unknown", reason: (e as Error).message };
  }
  return { status: "ok", record };
}

export function readSandboxOwner(dir: string, key: SandboxOwnerKey): OwnerRead {
  const bad = keyProblem(key);
  if (bad) return { status: "unknown", reason: bad };
  let records: string;
  try { records = ownerArea(dir, "records", false); } catch (e) { return { status: "unknown", reason: (e as Error).message }; }
  const r = readRecordFile(join(records, `${ownerRecordId(key)}.json`));
  return r.status === "ok" && !sameKey(r.record.key, key) ? { status: "unknown", reason: "属主记录的 key 与请求不一致" } : r;
}

export interface OwnerListing { id: string; read: OwnerRead }

/** 列举保留结构完整的历史资源声明；本单根活性由 readSandboxOwner 核，根缺失不能毒化无关订单。 */
export function listSandboxOwners(dir: string): { status: "ok"; entries: OwnerListing[] } | { status: "unknown"; reason: string } {
  let records: string;
  let names: string[];
  try {
    records = ownerArea(dir, "records", false);
    names = readdirSync(records);
  } catch (e) {
    return { status: "unknown", reason: `属主目录读不了：${(e as Error).message}` };
  }
  const entries = names.filter((n) => !n.endsWith(".tmp")).sort().map((n) => ({ id: n.replace(/\.json$/, ""), read: readRecordFile(join(records, n), false) }));
  return { status: "ok", entries };
}

/** 属主目录共享锁（跨 key 创建、追加、清理互斥）；拿不到锁就抛，不像命令锁那样降级放行 */
export async function lockSandboxOwner(dir: string, key: SandboxOwnerKey): Promise<LockHandle> {
  const lock = await acquireLock(join(ownerArea(dir, "locks", true), "ownership.lock"), LOCK_WAIT_MS);
  if (!lock) throw new Error(`属主记录 ${key.orderId} 正被别的进程占用`);
  return lock;
}

/** 清理长流程的 per-key 锁；共享归属锁只在冻结/写回短事务内拿，不能跨停进程等待。 */
export async function lockSandboxCleanupKey(dir: string, key: SandboxOwnerKey): Promise<LockHandle> {
  const bad = keyProblem(key);
  if (bad) throw new Error(bad);
  const lock = await acquireLock(join(ownerArea(dir, "locks", true), `${ownerRecordId(key)}.lock`), LOCK_WAIT_MS);
  if (!lock) throw new Error(`属主记录 ${key.orderId} 正在清理`);
  return lock;
}

/** 原子冻结当前资源快照；补登记同样用共享锁并拒绝 cleanup 标记，重试保留已登记资源。 */
export async function beginSandboxCleanup(dir: string, key: SandboxOwnerKey, now: number, keyLock: LockHandle): Promise<SandboxOwnerRecord> {
  const lock = await lockSandboxOwner(dir, key);
  try {
    const read = readSandboxOwner(dir, key);
    if (read.status !== "ok") throw new Error(read.reason);
    if (!keyLock.held()) throw new Error("清理记录锁已失，不冻结");
    const record = { ...read.record, cleanup: { attempts: (read.record.cleanup?.attempts ?? 0) + 1, lastAt: now, done: false, outcomes: [] } };
    return await commitRecord(dir, record, lock);
  } finally { lock.release(); }
}

async function writeRecord(dir: string, record: SandboxOwnerRecord, lock: LockHandle): Promise<void> {
  if (!lock.held()) throw new Error("属主记录锁已失，不写");
  await writeJsonAtomic(join(ownerArea(dir, "records", true), `${ownerRecordId(record.key)}.json`), record, { mode: 0o600, noFollow: true });
}

/** 写之前核全目录：有说不清的记录、或别单声称同一资源，就不写 */
async function commitRecord(dir: string, record: SandboxOwnerRecord, lock: LockHandle): Promise<SandboxOwnerRecord> {
  const all = listSandboxOwners(dir);
  if (all.status !== "ok") throw new Error(all.reason);
  const conflict = ownershipConflict(record, all.entries);
  if (conflict) throw new Error(conflict);
  await writeRecord(dir, record, lock);
  return record;
}

/** 另一份记录也声称拥有同一个根 / socket / 进程：谁的都说不清 */
function ownershipConflict(record: SandboxOwnerRecord, others: OwnerListing[]): string | null {
  const id = ownerRecordId(record.key);
  for (const o of others) {
    if (o.id === id) continue;
    if (o.read.status !== "ok") return `属主目录里有说不清的记录 ${o.id}：${o.read.reason}`;
    const other = o.read.record;
    const mine = claimedPaths(record);
    if (claimedPaths(other).some((p) => mine.some((m) => pathsOverlap(p, m)))) return `沙箱根 / 目录与 ${other.key.orderId} 的记录重叠`;
    if (other.cleanup?.done) continue;
    for (const r of record.resources) {
      if (other.resources.some((x) => (x.pid === r.pid && x.startedAt === r.startedAt) || (r.socket && x.socket === r.socket))) {
        return `${r.kind} pid ${r.pid} 也登记在 ${other.key.orderId} 名下`;
      }
    }
  }
  return null;
}

/** 完成记录的已消失路径不再保留预订；现存日志根/保留目录仍不能被另一单覆盖。 */
function claimedPaths(record: SandboxOwnerRecord): string[] {
  const paths = [record.root, ...record.dirs.map((d) => d.path)];
  return record.cleanup?.done ? paths.filter((p) => lstatSync(p, { throwIfNoEntry: false })) : paths;
}

interface OwnedSpawn { kind: OwnedKind; pid: number; socket?: string }

/** 登记自有目录：必须现存、不是软链、不碰生产 / 属主目录 */
function captureDir(path: string, ownerDir: string): OwnedDir {
  const id = dirIdentity(path);
  if (!id) throw new Error(`自有目录 ${path} 不存在`);
  const bad = rootProblem(id.path, ownerDir, "自有目录");
  if (bad) throw new Error(bad);
  return id;
}

/** 创建端刚起的进程：自己探测身份，并核它确实绑在这个沙箱根上（tmux 看 socket，其余严格核真实 cwd） */
async function captureResource(s: OwnedSpawn, root: string): Promise<OwnedResource> {
  if (s.pid === process.pid || s.pid === process.ppid) throw new Error(`pid ${s.pid} 是登记者自己 / 父进程`);
  const p = await probeProcess(s.pid);
  if (p.state !== "alive") throw new Error(`pid ${s.pid} 登记时${p.state === "gone" ? "已经不在" : `探不清：${p.reason}`}`);
  const base = { kind: s.kind, pid: s.pid, startedAt: p.startedAt, commandHash: p.commandHash, entry: p.entry, cwd: p.cwd };
  if (s.kind !== "tmux") {
    if (s.socket !== undefined) throw new Error(`${s.kind} 不带 socket`);
    if (!inside(p.cwd, root)) throw new Error(`${s.kind} pid ${s.pid} 的 cwd / 入口不在沙箱根 ${root} 下`);
    return base;
  }
  if (!s.socket) throw new Error("tmux 必须给私有 socket");
  const bad = socketProblem(s.socket, root);
  if (bad) throw new Error(bad);
  // ps 不保留 argv 引号：含空白的路径不能凭命令文字推断，按无法绑定拒绝。
  const argv = p.command.split(/\s+/);
  const i = argv.indexOf("-S");
  const bound = i >= 0 && [s.socket, canonicalPath(s.socket)].includes(argv[i + 1] ?? "");
  if (p.entry !== "tmux" || !bound) {
    throw new Error(`pid ${s.pid} 不是这个 socket 上的 tmux server`);
  }
  return { ...base, socket: canonicalPath(s.socket) };
}

export interface RegisterInput { key: SandboxOwnerKey; root: string; resources: OwnedSpawn[]; dirs?: string[] }

/** producer：登记一个新沙箱。探测不持共享锁，冲突检查/写回在锁内；同一 key 拒覆盖历史 */
export async function registerSandboxOwner(dir: string, input: RegisterInput, now = Date.now()): Promise<SandboxOwnerRecord> {
  const bad = keyProblem(input.key);
  if (bad) throw new Error(bad);
  if (!input.resources.length && !input.dirs?.length) throw new Error("没有可登记的进程 / 目录");
  const root = realDir(input.root, "沙箱根");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ownerDir = dirname(ownerArea(dir, "records", true));
  const problem = rootProblem(root, ownerDir);
  if (problem) throw new Error(problem);
  const resources: OwnedResource[] = [];
  for (const child of input.resources) resources.push(await captureResource(child, root));
  const dirs = (input.dirs ?? []).map((d) => captureDir(d, ownerDir));
  if (new Set(dirs.map((d) => d.path)).size !== dirs.length) throw new Error("自有目录重复登记");
  const record: SandboxOwnerRecord = { v: 1, key: { ...input.key }, root, createdAt: now, resources, dirs };
  const lock = await lockSandboxOwner(dir, input.key);
  try {
    if (lstatSync(join(ownerArea(dir, "records", false), `${ownerRecordId(input.key)}.json`), { throwIfNoEntry: false })) {
      throw new Error(`${input.key.orderId} 这一代已经登记过`);
    }
    return await commitRecord(dir, record, lock);
  } finally { lock.release(); }
}

/** producer：后起的子进程 / 临时目录补登记（同样自己探测身份、核绑定根目录） */
export async function addSandboxOwned(dir: string, key: SandboxOwnerKey, item: { pid: number } | { dir: string }): Promise<SandboxOwnerRecord> {
  const before = readSandboxOwner(dir, key);
  if (before.status !== "ok") throw new Error(before.reason);
  if (before.record.cleanup) throw new Error("已经开始清理，不再登记新资源");
  const child = "pid" in item ? await captureResource({ kind: "child", pid: item.pid }, before.record.root) : undefined;
  const addedDir = "dir" in item ? captureDir(item.dir, dirname(ownerArea(dir, "records", false))) : undefined;
  const lock = await lockSandboxOwner(dir, key);
  try {
    const cur = readSandboxOwner(dir, key);
    if (cur.status !== "ok") throw new Error(cur.reason);
    if (cur.record.cleanup) throw new Error("已经开始清理，不再登记新资源");
    if (cur.record.root !== before.record.root) throw new Error("沙箱根已变，不补登记");
    let record: SandboxOwnerRecord;
    if (child) {
      if (cur.record.resources.some((r) => r.pid === child.pid)) throw new Error(`pid ${child.pid} 已在这份记录里`);
      record = { ...cur.record, resources: [...cur.record.resources, child] };
    } else {
      if (cur.record.dirs.some((d) => d.path === addedDir!.path)) throw new Error(`目录 ${addedDir!.path} 已在这份记录里`);
      record = { ...cur.record, dirs: [...cur.record.dirs, addedDir!] };
    }
    return await commitRecord(dir, record, lock);
  } finally { lock.release(); }
}

/** 清理前的证据保全：记录 + 本次探测摘要写进 archive/，读回逐字比对；任何一步失败都抛，清理方据此零动作 */
export async function archiveOwnerEvidence(dir: string, record: SandboxOwnerRecord, snapshot: unknown, now: number): Promise<string> {
  const file = join(ownerArea(dir, "archive", true), `${ownerRecordId(record.key)}-${now}.json`);
  const body = { record, snapshot, at: now };
  await writeJsonAtomic(file, body, { mode: 0o600, noFollow: true });
  const back = lstatSync(file);
  if (back.isSymbolicLink() || !back.isFile() || readFileSync(file, "utf8") !== JSON.stringify(body, null, 2)) throw new Error("证据读回不一致");
  return file;
}

/** 清理结果记回记录（持锁调用）：记录本身永不删除，留作属主证据 */
export async function markSandboxCleanup(dir: string, record: SandboxOwnerRecord, mark: CleanupMark, lock: LockHandle): Promise<void> {
  await writeRecord(dir, { ...record, cleanup: mark }, lock);
}

/** TTL 只决定「该复核了」，不是可清理的证据 */
export function ownerReviewDue(record: SandboxOwnerRecord, now: number, ttlMs: number): boolean {
  return !record.cleanup?.done && now - record.createdAt >= ttlMs;
}
