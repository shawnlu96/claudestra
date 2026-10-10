/**
 * scheduler-update-fail-remote 的私有子进程：每个用例由原入口（本测试文件）在 `env -i` + `bun --no-env-file test` 的子进程里真跑，
 * 显式临时 HOME / XDG / GH_CONFIG_DIR / STATE / RUNTIME / TMP，BRIDGE_URL 与 HTTP(S) 代理都指向拒连的 127.0.0.1:9。
 * 旧红：fix 单出池前 probeFixStart 用默认 realGh 起真 `gh api repos/o/r/compare/…`，继承父进程 env 与 HOME——本机登录的 gh
 * 会读 keyring 凭据真连 GitHub（404 → 走「gh compare 失败」告警），一次往返 0.8s 起、上限 60s，全量负载下单条用例撞 5s 超时。
 * 子进程里没有 gh 凭据、代理拒连：gh 在本地就失败（exit 4），走同一条告警分支，生产 gate / 配置与断言都不动。
 * 子进程只登记 CLAUDESTRA_UPDTEST_MODE 指定的那一条原用例；父进程核退出码、Ran 1 / 1 pass / 0 fail 与 expect 数，并清掉临时根。
 * 父进程持有它起的每个子进程组（pid + 临时根）直到组确认收干净：runBounded 起的 gh 是另一个 detached 组，子进程把这些组号写进私有 HOME 的
 * groups.json，父进程定期读、自己也记一份（known），回收时连它们一起 KILL。tests/preload.ts 把 SIGINT / SIGTERM 变成 process.exit(130 / 143)，
 * 信号监听轮不到，所以只有同步的 exit 钩子能回收——整组 SIGKILL、按 ps 核到成员全死才删根，写一行 UPDTEST-CANCEL 留证；回执读不出、信号发不出
 * 或预算内没死的组不删根、保留持有，并且把根搬到 preload 随后要整个删掉的测试临时根外面（keptAt），不然「保留」只剩报告一句话。
 */
import { Database } from "bun:sqlite";
import { afterAll, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { testChildEnv } from "./test-env.ts";

// The runner budget covers fixture + ticks; the process deadline also covers imports and preload cleanup.
export const CHILD_TEST_MS = 15_000;
export const CHILD_PROCESS_MS = CHILD_TEST_MS + 30_000;
export const CLEANUP_MS = 5_000;
/** hold 子进程最多等父进程的组信号这么久（短于 CHILD_TEST_MS），到点自己杀后代并失败，不让持管道后代无限留着 */
const HOLD_MS = 10_000;

export const MODES = ["hex", "plain", "secret"] as const;
export type Mode = (typeof MODES)[number];
/** 每条原用例跑完的 expect() 数：少了即断言被跳过或提前返回 */
const EXPECTS: Record<Mode, number> = { hex: 13, plain: 10, secret: 17 };

const MODE_ENV = "CLAUDESTRA_UPDTEST_MODE";
const HOOK_ENV = "CLAUDESTRA_UPDTEST_HOOK";
const REPORT = "UPDTEST-CHILD ";
const REFUSED = "http://127.0.0.1:9";
const ENTRY = join(import.meta.dir, "scheduler-update-fail-remote.test.ts");

/**
 * corrupt：故意改坏一条子断言；failSetup：fixture 建好后 setup 抛错（finally 照常关库）；
 * hold：fixture 建好后停在 holdForParent（持管道、拒 TERM 的后代 + 身份回执），只给取消探针用，普通三模式不会走到。
 */
export type Hook = "corrupt" | "failSetup" | "hold";
const HOOKS: readonly Hook[] = ["corrupt", "failSetup", "hold"];
export interface Child { mode: Mode; hook: Hook | null }

/** 子进程侧：本进程是不是父进程起的私有子进程、跑哪条 */
export function childCase(): Child | null {
  const mode = process.env[MODE_ENV] as Mode | undefined;
  if (!mode) return null;
  if (!MODES.includes(mode)) throw new Error(`未知 ${MODE_ENV}=${mode}`);
  const hook = (process.env[HOOK_ENV] || null) as Hook | null;
  if (hook !== null && !HOOKS.includes(hook)) throw new Error(`未知 ${HOOK_ENV}=${hook}`);
  return { mode, hook };
}

export interface ChildInfo {
  pid: number; home: string; state: string; runtime: string; tmp: string; bridge: string;
  fixtureDir: string; ledger: string; nonce: string; nonces: string[];
  timing: { startedAt: number; fixtureMs: number; tickMs: number; cleanupMs: number; testMs: number };
}

/** Report the original isolation receipt and phase timings; closing still runs if receipt creation fails. */
export function reportChild(f: { db: Database; dir: string; close(): void }, timing: Omit<ChildInfo["timing"], "cleanupMs" | "testMs">): void {
  let info: ChildInfo;
  let cleanupMs = 0;
  try {
    const nonce = crypto.randomUUID();
    f.db.run("INSERT INTO meta (project, key, value) VALUES ('updtest', ?, ?)", [`nonce:${nonce}`, nonce]);
    const nonces = (f.db.query("SELECT value FROM meta WHERE project = 'updtest' ORDER BY value").all() as { value: string }[]).map((r) => r.value);
    const e = process.env;
    info = { pid: process.pid, home: e.HOME!, state: e.CLAUDESTRA_STATE_DIR!, runtime: e.CLAUDESTRA_RUNTIME_DIR!, tmp: e.TMPDIR!,
      bridge: e.BRIDGE_URL!, fixtureDir: f.dir, ledger: join(f.dir, "ledger.sqlite"), nonce, nonces,
      timing: { ...timing, cleanupMs: 0, testMs: 0 } };
  } finally {
    const start = performance.now();
    f.close();
    cleanupMs = performance.now() - start;
  }
  info.timing.cleanupMs = cleanupMs;
  info.timing.testMs = Date.now() - timing.startedAt;
  process.stdout.write(`${REPORT}${JSON.stringify(info)}\n`);
}

/** 回执都在子进程私有 HOME 里，只有本次的进程树会写；写完改名，读方不会读到半截 */
const HOLD_RECEIPT = "hold.json";
const DESCENDANT_RECEIPT = "hold-descendant.json";
const GROUPS_RECEIPT = "groups.json";
/** 取消探针的 gh 替身写 `gh-<pid>.json`（pid 即它的 detached 组号） */
export const GH_RECEIPT_PREFIX = "gh-";
interface StartReceipt { pid: number; ppid: number }
interface HoldReceipt { pid: number; descendant: number; descendantReady: StartReceipt }
interface GroupsReceipt { pid: number; groups: number[] }

function writeReceipt(file: string, data: unknown): void {
  writeFileSync(`${file}.tmp`, JSON.stringify(data));
  renameSync(`${file}.tmp`, file);
}

const readJson = <T>(file: string): T | null => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as T : null);

/**
 * 子进程侧的 hold 钩子：起一个拒 TERM、继承本进程 stdout 管道的后代；后代装好 handler 后自己写 ready 回执，核过身份才把两者 pid
 * 写进私有 HOME 的回执，再等父进程的组信号。没等到就自己 SIGKILL 后代并失败：持管道后代不能活过本用例的预算。
 */
export async function holdForParent(): Promise<void> {
  const home = process.env.HOME!;
  const ready = join(home, DESCENDANT_RECEIPT);
  const script = `process.on('SIGTERM', () => {}); const fs = require('node:fs'); const file = ${JSON.stringify(ready)};
    fs.writeFileSync(file + '.tmp', JSON.stringify({ pid: process.pid, ppid: process.ppid })); fs.renameSync(file + '.tmp', file); setInterval(() => {}, 1_000);`;
  const start = Date.now();
  const descendant = Bun.spawn([process.execPath, "-e", script], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  try {
    const receipt = await deadline((async () => { for (;;) { const r = readJson<StartReceipt>(ready); if (r) return r; await Bun.sleep(20); } })(), HOLD_MS);
    if (receipt.pid !== descendant.pid || receipt.ppid !== process.pid) throw new Error(`hold 后代的 ready 回执身份不符：${JSON.stringify(receipt)}`);
    writeReceipt(join(home, HOLD_RECEIPT), { pid: process.pid, descendant: descendant.pid, descendantReady: receipt } satisfies HoldReceipt);
    await deadline(descendant.exited, HOLD_MS - (Date.now() - start));
  } finally { descendant.kill("SIGKILL"); }
  throw new Error("hold 后代在父进程发组信号前自己退出了");
}

export interface ChildRun {
  mode: Mode; hook: Hook | null; root: string; code: number | null; out: string; err: string;
  info: ChildInfo | null; ran: number; pass: number; fail: number; expects: number;
  /** 子进程退出后、父进程删临时根之前，它自己的 fixture 目录还在不在（应已由 f.close 删掉） */
  fixtureLeft: boolean; rootRemoved: boolean;
}

const count = (text: string, re: RegExp) => Number(re.exec(text)?.[1] ?? -1);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class ChildDeadline extends Error {}

/** A cleared timer also bounds pipe draining, not just the direct child's exit. */
export async function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ChildDeadline(`UPDTEST process deadline ${ms}ms exceeded`)), ms);
    })]);
  } finally { clearTimeout(timer!); }
}

/** true = 信号已发；false = 组已经不在（ESRCH，成功收尾的组不用再发）；其他失败照抛，不藏 */
function signalGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean {
  try { process.kill(-pid, signal); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** 组里一个进程都不剩（已被收尸）才算空；EPERM 是还有成员（僵尸或别人的），不算 */
function groupGone(pgid: number): boolean {
  try { process.kill(-pgid, 0); return false; } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return true;
    if (code === "EPERM") return false;
    throw error;
  }
}

/**
 * 子进程侧：Bun test 在用例超时时不跑 exit 钩子，所以 runBounded 起的 detached gh 组由这里持有到 afterAll；
 * 每次增减都把在世的组号写进私有 HOME 的 groups.json，父进程回收时按这份回执连它们一起收（子进程被 KILL 就没机会自己收）。
 */
export function trackChildProcesses(): void {
  const spawn = childProcess.spawn;
  const groups = new Set<{ pid: number; closed: Promise<void> }>();
  const receipt = process.env.HOME ? join(process.env.HOME, GROUPS_RECEIPT) : null;
  const publish = () => { if (receipt) writeReceipt(receipt, { pid: process.pid, groups: [...groups].map((g) => g.pid) } satisfies GroupsReceipt); };
  const watcher = spyOn(childProcess, "spawn").mockImplementation(((...args: unknown[]) => {
    const child = Reflect.apply(spawn, childProcess, args) as ReturnType<typeof spawn>;
    const options = (Array.isArray(args[1]) ? args[2] : args[1]) as { detached?: boolean } | undefined;
    if (child.pid && options?.detached) {
      let closed!: () => void;
      const owned = { pid: child.pid, closed: new Promise<void>((resolve) => { closed = resolve; }) };
      groups.add(owned);
      publish();
      child.once("close", () => { groups.delete(owned); publish(); closed(); });
    }
    return child;
  }) as typeof spawn);
  afterAll(async () => {
    try {
      const owned = [...groups];
      for (const group of owned) signalGroup(group.pid, "SIGKILL");
      await deadline(Promise.all(owned.map((group) => group.closed)), CLEANUP_MS);
    } finally { watcher.mockRestore(); }
  }, CLEANUP_MS + 1_000);
}

export interface Owned { pid: number; root: string; mode: Mode; hook: Hook | null }
/** 父进程此刻持有的子进程组：runChild 起进程时登记，组确认收干净、根删掉后才注销；exit 钩子只碰这里登记的 pid / root */
const owned = new Map<number, Owned>();
let exitHooked = false;
/** 父进程自己记的、每个子进程上次核过 pid 的 detached 组号（runChild 每 KNOWN_POLL_MS 读一次回执刷新）：回执以后读不出，这些组照样要收 */
const known = new Map<number, number[]>();
const KNOWN_POLL_MS = 200;

/** 子进程自己登记的 detached 组（runBounded 起的 gh）；回执 pid 必须是持有的那个子进程。读得出就刷新 known；读不出 / 不对 / 核过后不见了都算回执失败 */
function detachedGroups(o: Owned): { groups: number[]; error?: string } {
  const file = join(o.root, "home", GROUPS_RECEIPT);
  try {
    const r = readJson<GroupsReceipt>(file);
    if (!r) return known.get(o.pid)?.length ? { groups: [], error: `groups 回执不见了（之前核过的组：${known.get(o.pid)!.join(",")}）` } : { groups: [] };
    if (r.pid !== o.pid) return { groups: [], error: `groups 回执 pid ${r.pid} 不是持有的 ${o.pid}` };
    known.set(o.pid, r.groups);
    return { groups: r.groups };
  } catch (error) {
    return { groups: [], error: `groups 回执读不出：${message(error)}` }; // the caller keeps root + ownership and falls back to `known`
  }
}

/** 本次要收的组：回执可信就用它；不可信就退回父进程记的上次核过的组并带上回执错误——回执失败抹不掉已知的组，也不能换来删根 */
function groupsToKill(o: Owned): { pgids: number[]; receipt?: string; known: boolean } {
  const found = detachedGroups(o);
  if (!found.error) return { pgids: [o.pid, ...found.groups], known: false };
  return { pgids: [o.pid, ...(known.get(o.pid) ?? [])], receipt: found.error, known: true };
}

/** known：组号来自父进程自己的记录（当前回执不可信）；dead：同步路径按 ps 核过成员全死（见 liveGroupsSync），没核过的没有这个键 */
interface GroupReclaim { pgid: number; kill: string; known?: true; dead?: boolean }
/** keptAt：真实退出时保留的根搬到的新路径（root 仍是旧位置）；keepError：没搬成或身份核不过的诊断——有它就不能当根已保住 */
export interface Reclaimed extends Owned {
  groups: GroupReclaim[]; receipt?: string; verify?: string; keptAt?: string; keepError?: string; rootRemoved: boolean | string; retained: boolean;
}

const killGroup = (pgid: number, fromKnown: boolean): GroupReclaim => {
  const tag = fromKnown ? { known: true as const } : {};
  try { return { pgid, kill: signalGroup(pgid, "SIGKILL") ? "SIGKILL sent" : "group already gone", ...tag }; } catch (error) {
    return { pgid, kill: `error: ${message(error)}`, ...tag }; // the group keeps its root and stays owned; the error is in the receipt line
  }
};

/**
 * 同步看哪些组还有没死的成员：exit 钩子里事件循环已停，自己的子进程死了也收不了尸，而 kill(-pgid, 0) 对只剩僵尸的组 macOS 报 EPERM、
 * Linux 报成功，分不出「还活着」和「死了等收尸」。所以按 ps 看成员状态：没成员，或只剩等本进程收尸的僵尸（Z 且 ppid 是本进程）才算死；
 * 别人的僵尸（init 马上会收）还要再等。只读状态，不按 ps 结果给任何进程发信号。
 */
function liveGroupsSync(pgids: number[]): { alive: number[]; error?: string } {
  try {
    const ps = Bun.spawnSync(["ps", "-A", "-o", "pid=,pgid=,ppid=,stat="], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    if (ps.exitCode !== 0) return { alive: pgids, error: `ps 退出 ${ps.exitCode}：${ps.stderr.toString().trim()}` };
    const live = new Set<number>();
    for (const line of ps.stdout.toString().split("\n")) {
      const [, pgid, ppid, stat] = line.trim().split(/\s+/);
      if (pgid && stat && !(stat.startsWith("Z") && Number(ppid) === process.pid)) live.add(Number(pgid));
    }
    return { alive: pgids.filter((pgid) => live.has(pgid)) };
  } catch (error) {
    return { alive: pgids, error: `ps 起不来：${message(error)}` }; // every group stays unverified, so the caller retains root + ownership
  }
}

/** 已发 SIGKILL 的组逐个核到死或到 endAt（ESRCH 的组本来就空）；ps 出错时剩下的组都算没核过、照抛错误给报告 */
function verifyDeadSync(groups: GroupReclaim[], endAt: number): string | undefined {
  for (const g of groups) if (g.kill === "group already gone") g.dead = true;
  let pending = groups.filter((g) => g.kill === "SIGKILL sent");
  while (pending.length) {
    const { alive, error } = liveGroupsSync(pending.map((g) => g.pgid));
    for (const g of pending) if (!alive.includes(g.pgid)) g.dead = true;
    pending = pending.filter((g) => alive.includes(g.pgid));
    if (!pending.length) break;
    if (error || performance.now() > endAt) { for (const g of pending) g.dead = false; return error; }
    Bun.sleepSync(25);
  }
  return undefined;
}

/** tests/test-tmp-root.ts 给每次 bun test 建的临时根前缀（那边没导出、不在本卡范围）：它的 exit 钩子会整个删掉，保留的根要先搬出去才留得住 */
const RUN_ROOT_PREFIX = "cstra-test-run-";
const RETAINED_PREFIX = "updtest-retained-";

type Kept = { keptAt?: string; keepError?: string };

/**
 * 真实退出时把保留的根搬到本进程 preload 临时根的父目录（真实 tmp；同一文件系统，rename 原子），不动 preload 的钩子。先证明身份再搬：
 * tmpdir() 与根都取规范路径，根得是真目录（不是软链）且直接位于「本进程 pid 的 cstra-test-run 根」之下，目标不能已存在，搬完按 dev/ino 核对
 * 还是同一个目录。tmpdir() 不是 preload 根就没人会删，原地保留、不报。其余任何一步不成立都给 keepError（根留在原地，报告里看得出没保住）。
 */
function keepRootOutside(root: string): Kept {
  try {
    const runRoot = realpathSync(tmpdir());
    if (!basename(runRoot).startsWith(RUN_ROOT_PREFIX)) return {};
    if (!basename(runRoot).startsWith(`${RUN_ROOT_PREFIX}${process.pid}-`)) return { keepError: `${runRoot} 不是本进程的 preload 临时根，不搬` };
    const source = lstatSync(root);
    if (source.isSymbolicLink() || !source.isDirectory()) return { keepError: `${root} 不是真目录，不搬` };
    const real = realpathSync(root);
    if (dirname(real) !== runRoot) return { keepError: `${real} 不直接在本进程的 preload 临时根 ${runRoot} 下，不搬` };
    const target = join(dirname(runRoot), `${RETAINED_PREFIX}${process.pid}-${basename(real)}`);
    if (existsSync(target)) return { keepError: `目标已存在，不覆盖：${target}` };
    renameSync(real, target);
    const moved = lstatSync(target);
    if (moved.dev !== source.dev || moved.ino !== source.ino) return { keptAt: target, keepError: `搬过去的目录 dev/ino 和原来的不一致` };
    return { keptAt: target };
  } catch (error) { return { keepError: `搬不动：${message(error)}` }; }
}

/**
 * 同步回收（process.exit 里只能这么跑，也可由测试直接调）：给持有的每个组（子进程组 + 回执 / known 里的 detached 组）发 SIGKILL，
 * 在同一个 CLEANUP_MS 预算内按 ps 核到全死才删根、注销；回执不可信、信号发不出或没核到死的，保留根与持有，原因写进 rootRemoved，
 * 一行 UPDTEST-CANCEL 留证。atExit = 真的在退出：保留的根搬出 preload 即将删掉的临时根（keptAt）；直接调的留在原地给 reclaimOwned 再收。
 */
export function reclaimOwnedSync(code: number | string, atExit = false): Reclaimed[] {
  const endAt = performance.now() + CLEANUP_MS;
  const reclaimed = [...owned.values()].map((o): Reclaimed => {
    const plan = groupsToKill(o);
    const groups = plan.pgids.map((pgid) => killGroup(pgid, plan.known && pgid !== o.pid));
    const verify = verifyDeadSync(groups, endAt);
    const reasons = [
      plan.receipt && "groups receipt unreadable",
      groups.some((g) => g.kill.startsWith("error")) && "group signal failed",
      groups.some((g) => g.kill === "SIGKILL sent" && g.dead !== true) && "group still alive",
    ].filter(Boolean);
    let rootRemoved: boolean | string = `kept: ${reasons.join(", ")}`;
    let keep: Kept = {};
    if (!reasons.length) {
      try { rmSync(o.root, { recursive: true, force: true }); rootRemoved = !existsSync(o.root); } catch (error) { rootRemoved = `error: ${message(error)}`; }
      release(o.pid);
    } else if (atExit) keep = keepRootOutside(o.root);
    return { ...o, groups, ...(plan.receipt ? { receipt: plan.receipt } : {}), ...(verify ? { verify } : {}), ...keep, rootRemoved, retained: reasons.length > 0 };
  });
  writeSync(2, `UPDTEST-CANCEL ${JSON.stringify({ pid: process.pid, code, reclaimed })}\n`);
  return reclaimed;
}

/** exit 钩子本体（own 装、release 卸）：真的在退出，保留的根要搬出 preload 即将删掉的临时根 */
const reclaimAtExit = (code: number): void => { reclaimOwnedSync(code, true); };

function own(entry: Owned): void {
  owned.set(entry.pid, entry);
  // Ahead of the preload's exit cleanup, which removes the whole test tmp root (these children's roots included) before anything else runs.
  if (!exitHooked) { process.prependListener("exit", reclaimAtExit); exitHooked = true; }
}

function release(pid: number): void {
  owned.delete(pid);
  known.delete(pid);
  if (!owned.size && exitHooked) { process.off("exit", reclaimAtExit); exitHooked = false; }
}

/** 探针 / 测试看父进程此刻持有的组（副本） */
export const ownedChildren = (): Owned[] => [...owned.values()];
export const exitHookInstalled = (): boolean => exitHooked;

/**
 * KILL 一个持有项的全部组，等每个组真空（到 endAt 为止）；发不出信号或没空的照抛，调用方据此保留持有。
 * 回执不可信时仍先给子进程组和 known 里的组发 KILL，再抛回执错误：读不出的回执不能证明没有别的组，所以照样算没收干净。
 */
async function closeGroups(o: Owned, endAt: number): Promise<GroupReclaim[]> {
  const plan = groupsToKill(o);
  const groups = plan.pgids.map((pgid): GroupReclaim => ({ pgid, kill: signalGroup(pgid, "SIGKILL") ? "SIGKILL sent" : "group already gone",
    ...(plan.known && pgid !== o.pid ? { known: true } : {}) }));
  if (plan.receipt) throw new Error(`${plan.receipt}；已给子进程组和记下的组 ${plan.pgids.join(",")} 发 SIGKILL，但回执读不出就不算收干净`);
  for (;;) {
    const alive = groups.filter((g) => !groupGone(g.pgid));
    if (!alive.length) return groups;
    if (performance.now() > endAt) throw new Error(`组在回收预算内没收干净：${alive.map((g) => g.pgid).join(",")}`);
    await Bun.sleep(20);
  }
}

/** 事件循环还在时的有界回收（测试在修好信号故障后调）：每个持有项 KILL、等空、删根、注销；没收干净的保留持有并抛错 */
export async function reclaimOwned(): Promise<Reclaimed[]> {
  const endAt = performance.now() + CLEANUP_MS;
  const out: Reclaimed[] = [];
  for (const o of ownedChildren()) {
    const groups = await closeGroups(o, endAt);
    rmSync(o.root, { recursive: true, force: true });
    release(o.pid);
    out.push({ ...o, groups, rootRemoved: !existsSync(o.root), retained: false });
  }
  return out;
}

export type Receipted = Owned & { hold: HoldReceipt | null; groups: number[]; detached: StartReceipt[] };

/**
 * 等 count 个持有中的子进程交出真实启动回执（轮询文件，不猜时机），到 ms 没齐按截止失败。
 * hold：子进程写的 hold.json（含后代自己写的 ready 回执）；detached：子进程登记的 groups.json 至少一个组，且每个组的 gh 替身
 * 都写了自己的 gh-<pid>.json，pid 等于组号、ppid 等于子进程——都对上才算这个子进程就绪。
 */
export async function awaitReceipts(kind: "hold" | "detached", count: number, ms: number): Promise<Receipted[]> {
  const ready = (o: Owned): Receipted | null => {
    const home = join(o.root, "home");
    if (kind === "hold") {
      const hold = readJson<HoldReceipt>(join(home, HOLD_RECEIPT));
      return hold ? { ...o, hold, groups: [], detached: [] } : null;
    }
    const found = detachedGroups(o);
    if (found.error) throw new Error(found.error);
    const detached = found.groups.map((pgid) => readJson<StartReceipt>(join(home, `${GH_RECEIPT_PREFIX}${pgid}.json`)));
    if (!found.groups.length || detached.some((r) => !r)) return null;
    for (const [i, r] of detached.entries()) {
      if (r!.pid !== found.groups[i] || r!.ppid !== o.pid) throw new Error(`detached 组 ${found.groups[i]} 的回执身份不符：${JSON.stringify(r)}`);
    }
    return { ...o, hold: null, groups: found.groups, detached: detached as StartReceipt[] };
  };
  const poll = async () => {
    for (;;) {
      const got = ownedChildren().flatMap((o) => ready(o) ?? []);
      if (got.length >= count) return got;
      await Bun.sleep(50);
    }
  };
  return deadline(poll(), ms);
}

/**
 * TERM → 1s 宽限（让 runBounded 的退出钩子先收它自己的 detached gh 组）→ 整组 KILL → 等管道排空 → 连子进程登记的 detached 组
 * 一起 KILL、等每个组真空；全程共用 CLEANUP_MS，到点没空就抛，调用方保留持有。
 */
async function reap(child: Bun.Subprocess, output: Promise<unknown>, o: Owned): Promise<GroupReclaim[]> {
  const endAt = performance.now() + CLEANUP_MS;
  const drained = Promise.all([child.exited, output]);
  const graceMs = 1_000;
  console.error(`UPDTEST-REAP ${JSON.stringify({ pid: child.pid, graceMs })}`);
  try {
    signalGroup(child.pid, "SIGTERM");
    try { await deadline(drained, graceMs); } catch (error) {
      // Only the grace deadline triggers escalation; output and exit errors remain visible.
      if (!(error instanceof ChildDeadline)) throw error;
    }
  } finally { signalGroup(child.pid, "SIGKILL"); }
  await deadline(drained, Math.max(1, endAt - performance.now()));
  return closeGroups(o, endAt);
}

/** 只给负例用的故障注入：真实回收 / 删根照做之后再抛这条消息，验证双错误都留得下来 */
export interface Faults { reap?: string; root?: string }

/** 一次 runChild 里不止一处失败：errors[0] 是最早的那个（有原错误时就是原错误），子进程结果（若已拿到）附在消息里 */
export class ChildRunError extends AggregateError {
  constructor(errors: unknown[], label: string, readonly result: Omit<ChildRun, "rootRemoved"> | undefined) {
    super(errors, ChildRunError.describe(errors, label, result));
  }
  static describe(errors: unknown[], label: string, result: ChildRunError["result"]): string {
    const listed = errors.map((e, i) => `[${i + 1}] ${message(e)}`).join("；");
    const context = result ? `；子进程结果 code=${result.code} ran=${result.ran} pass=${result.pass} fail=${result.fail}\n${(result.out + result.err).slice(-2000)}` : "";
    return `私有子进程 ${label} 多处失败：${listed}${context}`;
  }
}

function launchChild(mode: Mode, hook: Hook | null, root: string, parentState: string | undefined): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  const dirs = Object.fromEntries(["home", "config", "state", "runtime", "tmp"].map((name) => [name, join(root, name)]));
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  const env = testChildEnv({
    HOME: dirs.home, XDG_CONFIG_HOME: dirs.config, GH_CONFIG_DIR: join(dirs.config, "gh"),
    CLAUDESTRA_STATE_DIR: dirs.state, CLAUDESTRA_RUNTIME_DIR: dirs.runtime, TMPDIR: dirs.tmp, TMP: dirs.tmp, TEMP: dirs.tmp,
    HTTPS_PROXY: REFUSED, HTTP_PROXY: REFUSED, ALL_PROXY: REFUSED, https_proxy: REFUSED, http_proxy: REFUSED, all_proxy: REFUSED,
    // gh telemetry forks a detached sender that can recreate HOME after the fixture exits.
    GH_TELEMETRY: "false", GH_NO_UPDATE_NOTIFIER: "1", GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", [MODE_ENV]: mode, ...(hook ? { [HOOK_ENV]: hook } : {}),
  });
  return Bun.spawn(["env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), process.execPath, "--no-env-file", "test", ENTRY], {
    cwd: join(import.meta.dir, ".."), env: testChildEnv({ CLAUDESTRA_STATE_DIR: parentState }), stdout: "pipe", stderr: "pipe", detached: true,
  });
}

/**
 * Parent waits for a bounded child run, then reaps its private process group and removes its root on every exit path.
 * parentState is a private contamination sentinel in the env -i launcher's outer environment.
 * waitMs can only shorten the deadline, for isolated timeout/descendant cleanup probes.
 * 失败不互相覆盖：运行、回收、删根各自的错误都收进 errors，只有一个且没拿到结果时原样抛，否则抛 ChildRunError 一起列出。
 * 组没确认收干净（信号发不出 / 预算内没空）就不删根、不注销：持有留给 exit 钩子或 reclaimOwned，错误里写明。
 */
export async function runChild(mode: Mode, hook: Hook | null = null, parentState?: string, waitMs = CHILD_PROCESS_MS, faults: Faults = {}): Promise<ChildRun> {
  if (!(waitMs > 0 && waitMs <= CHILD_PROCESS_MS)) throw new Error("invalid UPDTEST process budget");
  const start = Date.now();
  const root = mkdtempSync(join(tmpdir(), "updtest-child-"));
  const errors: unknown[] = [];
  let result: Omit<ChildRun, "rootRemoved"> | undefined;
  let pid: number | undefined, closed = false, reapMs: number | null = null, groups: GroupReclaim[] = [];
  let watch: ReturnType<typeof setInterval> | undefined;
  try {
    const child = launchChild(mode, hook, root, parentState);
    pid = child.pid;
    const entry = { pid, root, mode, hook };
    own(entry);
    watch = setInterval(() => detachedGroups(entry), KNOWN_POLL_MS); // a good read refreshes `known`; a bad one is reported by reap, not here
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    try {
      const [out, err, code] = await deadline(output, waitMs);
      const lines = out.split("\n").filter((l) => l.startsWith(REPORT));
      const info = lines.length === 1 ? JSON.parse(lines[0]!.slice(REPORT.length)) as ChildInfo : null;
      result = { mode, hook, root, code, out, err, info, fixtureLeft: info ? existsSync(info.fixtureDir) : false,
        ran: count(err, /\bRan (\d+) tests?\b/), pass: count(err, /^\s*(\d+) pass$/m), fail: count(err, /^\s*(\d+) fail$/m),
        expects: count(err, /^\s*(\d+) expect\(\) calls?$/m) };
    } catch (error) {
      errors.push(error); // the run error is thrown below, after reap and root cleanup have run and recorded their own failures
    } finally {
      const reapStart = performance.now();
      try {
        groups = await reap(child, output, entry);
        closed = true;
        if (faults.reap) throw new Error(faults.reap);
      } catch (error) {
        errors.push(error); // kept next to the run error, not instead of it
      } finally { reapMs = performance.now() - reapStart; }
    }
  } catch (error) {
    errors.push(error); // launch (dirs / spawn) failure: nothing was owned yet, the root cleanup below still runs
  } finally {
    clearInterval(watch);
    const cleanupStart = performance.now();
    if (pid === undefined || closed) {
      try {
        rmSync(root, { recursive: true, force: true });
        if (faults.root) throw new Error(faults.root);
      } catch (error) {
        errors.push(error); // a root left behind is reported together with whatever failed before it
      }
      if (pid !== undefined) release(pid);
    } else {
      errors.push(new Error(`组 ${pid} 没确认收干净：保留持有与临时根 ${root}，由 exit 钩子或 reclaimOwned 再收`));
    }
    const timing = result?.info?.timing;
    console.log("UPDTEST-RUN", JSON.stringify({ mode, hook, root, pid, closed, groups, code: result?.code,
      ran: result?.ran, pass: result?.pass, fail: result?.fail, expects: result?.expects, fixtureLeft: result?.fixtureLeft,
      startupMs: timing ? timing.startedAt - start : null, ...timing, reapMs, rootCleanupMs: performance.now() - cleanupStart,
      totalMs: Date.now() - start, rootRemoved: !existsSync(root), errors: errors.map(message) }));
  }
  if (errors.length === 1 && !result) throw errors[0];
  if (errors.length) throw new ChildRunError(errors, `${mode}${hook ? `/${hook}` : ""}`, result);
  return { ...result!, rootRemoved: !existsSync(root) };
}

/** 一条子进程跑绿的全部条件；任一不满足就抛（带子进程输出尾部），父入口据此失败 */
export function assertChildPassed(r: ChildRun): ChildInfo {
  const why = [
    r.code !== 0 && `退出码 ${r.code}`,
    r.ran !== 1 && `Ran ${r.ran}（应为 1）`,
    r.pass !== 1 && `${r.pass} pass（应为 1）`,
    r.fail !== 0 && `${r.fail} fail（应为 0）`,
    r.expects !== EXPECTS[r.mode] && `${r.expects} expect() calls（应为 ${EXPECTS[r.mode]}）`,
    !r.info && "没有恰好一行子进程报告",
    r.fixtureLeft && "子进程退出后 fixture 目录没被它自己关库删掉",
    !r.rootRemoved && "临时根没删掉",
  ].filter(Boolean);
  if (why.length) throw new Error(`私有子进程 ${r.mode}${r.hook ? `/${r.hook}` : ""} 不算通过：${why.join("；")}\n${(r.out + r.err).slice(-6000)}`);
  const info = r.info!;
  const inRoot = (p: string) => p === r.root || p.startsWith(`${r.root}/`);
  const own = [info.home, info.state, info.runtime, info.tmp, info.fixtureDir].filter((p) => !inRoot(p));
  if (own.length || info.bridge !== "ws://127.0.0.1:9" || info.nonces.join() !== info.nonce) {
    throw new Error(`私有子进程 ${r.mode} 的目录 / 连接 / key 不是自己的：${JSON.stringify(info)}`);
  }
  return info;
}
