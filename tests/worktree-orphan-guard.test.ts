/**
 * RTO2-1：残留进程回收的生产护栏（worktree-orphan-guard.ts）。假进程表 + 假 ps / launchctl 事实走收卡 / 巡检两个入口；
 * 最后两个用例在 macOS 上起一个 ppid=1、没有控制终端、忽略 SIGTERM 的空转进程（同 10-13 的 pid 20285），observe / on 各跑一次。
 */
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patrolCardProcs, reapCardProcs, resetCardPatrolClock, type CardProcDeps, type CardReapMode, type ObserveRow } from "../src/lib/card-proc-reap.js";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import { systemProcPorts } from "../src/lib/lend-proc-reap.js";
import type { Proc, ProcPorts } from "../src/lib/proc-reap-core.js";
import { writeFileSync } from "node:fs";
import { fileActionSink, guardReap, parseCpuTime, parseDaemons, parseFacts, systemGuardSources, type ActionRow, type GuardSources,
  type ProcFacts } from "../src/lib/worktree-orphan-guard.js";

const UID = 501;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); resetCardPatrolClock(); });

function fixture(tasks: [string, string][]) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "wt-orphan-"))); // macOS 的 /var 是软链：根路径里有软链会被拒
  const root = join(home, "worktrees");
  mkdirSync(root);
  const db = new Database(":memory:");
  db.run("CREATE TABLE tasks (id TEXT, project TEXT, stage TEXT)");
  db.run("CREATE TABLE meta (project TEXT, key TEXT, value TEXT)");
  for (const [id, stage] of tasks) db.query("INSERT INTO tasks VALUES (?, 'p', ?)").run(id, stage);
  cleanups.push(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  const wt = (name: string) => { const d = join(root, name); mkdirSync(d, { recursive: true }); return d; };
  return { home, root, db, wt };
}

type FakeProc = Proc & { stubborn?: boolean; tty?: string; daemon?: boolean; cpuSec?: number };
const proc = (pid: number, cwd: string, extra: Partial<FakeProc> = {}): FakeProc =>
  ({ pid, ppid: 1, uid: UID, cwd, comm: "/opt/tools/bin/bun", ageSec: 425_000, cpuSec: 420_000, ...extra });

/** 假进程表 + 假 ps / launchctl；facts / daemons 置 null = 读不出 */
function rig(procs: FakeProc[], mode: CardReapMode = "on") {
  const live = new Map(procs.map((p) => [p.pid, p]));
  const sent: string[] = [], lines: string[] = [], notices: string[] = [], actions: ActionRow[] = [], observed: ObserveRow[] = [];
  const base: ProcPorts = {
    uid: UID, self: 4242,
    list: async () => [...live.values()].map(({ stubborn: _s, tty: _t, daemon: _d, cpuSec: _c, ...p }) => p),
    signal: (pid, sig) => {
      sent.push(`${sig}:${pid}`);
      const p = live.get(pid);
      if (!p) return false;
      if (sig === "SIGKILL" || !p.stubborn) live.delete(pid);
      return true;
    },
    sleep: async (ms) => void sent.push(`sleep:${ms}`),
  };
  const src = { facts: true, daemons: true };
  const sources: GuardSources = {
    facts: async () => (src.facts ? new Map<number, ProcFacts>([...live.values()].map((p) => [p.pid, { tty: p.tty ?? null, cpuSec: p.cpuSec ?? null, comm: p.comm }])) : null),
    daemons: async () => (src.daemons ? new Set([...live.values()].filter((p) => p.daemon).map((p) => p.pid)) : null),
  };
  const g = guardReap(base, sources, (rows) => void actions.push(...rows), (m) => lines.push(m), () => 7);
  const deps: CardProcDeps = { mode, ports: g.ports, log: (m) => lines.push(m), now: () => 1_000_000,
    observed: g.observed({ has: (k) => observed.some((r) => r.key === k), add: (r) => void observed.push(...(r as ObserveRow[])) }) };
  const host = { worktreeRoot: "", procs: deps, notifyPm: async (_t: LedgerTask, text: string) => void notices.push(text) };
  return { host, deps, live, sent, lines, notices, actions, observed, src };
}
const task = (id: string, stage = "verified") => ({ id, stage, project: "p" }) as LedgerTask;

test("parseCpuTime / parseFacts / parseDaemons：macOS 与 Linux 的 time 格式、无终端写法、只认 com.claudestra.* 在跑的 pid", () => {
  expect(parseCpuTime("707:41.56")).toBe(42_462);
  expect(parseCpuTime("0:00.03")).toBe(0);
  expect(parseCpuTime("02:03:04")).toBe(7384);
  expect(parseCpuTime("4-22:00:00")).toBe(4 * 86_400 + 22 * 3600);
  expect(parseCpuTime("x")).toBeNull();
  expect(parseFacts("   12 ??       1:02.50 /Users/u/.bun/bin/bun\n  13 ttys043  0:00.01 -zsh\n 14 ?  00:00:09 sleep a b\n")).toEqual(new Map([
    [12, { tty: null, cpuSec: 63, comm: "/Users/u/.bun/bin/bun" }], [13, { tty: "ttys043", cpuSec: 0, comm: "-zsh" }], [14, { tty: null, cpuSec: 9, comm: "sleep a b" }]]));
  expect(parseDaemons("PID\tStatus\tLabel\n1830\t0\tcom.claudestra.bridge\n-\t0\tcom.claudestra.cron\n99\t0\tcom.apple.x\n1843\t0\tcom.claudestra.scheduler\n"))
    .toEqual(new Set([1830, 1843]));
  expect(parseDaemons("")).toBeNull(); // 命令不在 / 失败：没有表头 = 读不出
  expect(parseDaemons("PID\tStatus\tLabel\n")).toEqual(new Set());
});

test("[验收线 1] 巡检选择：已收卡 worktree 下 ppid=1 选中、目录已删但对得上已收卡的选中；活跃卡、根外、带 tty、daemon 都不选", async () => {
  const f = fixture([["T-done", "verified"], ["T-live", "build"], ["T-gone", "done"]]);
  const x = rig([
    proc(10, f.wt("t-done")), proc(11, f.wt("t-live")), proc(12, join(f.root, "t-gone", "sub")), proc(13, join(f.home, "elsewhere")),
    proc(14, f.wt("rv-t-done"), { tty: "ttys001" }), proc(15, join(f.root, "t-done"), { daemon: true }),
  ]);
  x.host.worktreeRoot = f.root;
  expect(await patrolCardProcs(f.db, x.host)).toBe(2);
  expect(x.sent.filter((s) => s.startsWith("SIG")).sort()).toEqual(["SIGTERM:10", "SIGTERM:12"]);
  expect([...x.live.keys()].sort()).toEqual([11, 13, 14, 15]);
});

test("[验收线 1] 收卡：本卡 worktree 下的进程收，带 tty 的、daemon 不收；ps / launchctl 读不出或命令名对不上（pid 复用）一个都不给", async () => {
  const f = fixture([]);
  const dir = f.wt("t1");
  const x = rig([proc(20, dir), proc(21, dir, { tty: "ttys009" }), proc(22, dir, { daemon: true })]);
  x.host.worktreeRoot = f.root;
  expect(await reapCardProcs(task("T1"), x.host)).toBe(1);
  expect(x.sent).toEqual(["SIGTERM:20", "sleep:4000"]);
  for (const off of ["facts", "daemons"] as const) {
    const y = rig([proc(30, dir)]);
    y.host.worktreeRoot = f.root;
    y.src[off] = false;
    expect(await reapCardProcs(task("T1"), y.host)).toBe(0);
    expect(y.sent).toEqual([]);
    expect(y.lines.join("\n")).toContain("这轮一个进程都不给");
  }
  const base: ProcPorts = { uid: UID, self: 1, list: async () => [proc(40, dir)], signal: () => true, sleep: async () => {} };
  const g = guardReap(base, { facts: async () => new Map([[40, { tty: null, cpuSec: 1, comm: "/bin/other" }]]), daemons: async () => new Set() },
    () => {}, () => {}); // 事实表里同 pid 换了命令：当成 pid 被复用，不给
  expect(await g.ports.list()).toEqual([]);
});

test("[验收线 2] on：TERM → 宽限 → KILL；TERM 收不掉的才 KILL；每个动作落台账（pid / 命令 / cwd / 存活 / 累计 CPU / 信号 / 结果）", async () => {
  const f = fixture([]);
  const dir = f.wt("t2");
  const x = rig([proc(50, dir, { stubborn: true }), proc(51, join(dir, "sub"))]);
  x.host.worktreeRoot = f.root;
  mkdirSync(join(dir, "sub"));
  expect(await reapCardProcs(task("T2"), x.host)).toBe(2);
  expect(x.sent).toEqual(["SIGTERM:50", "SIGTERM:51", "sleep:4000", "SIGKILL:50"]);
  expect(x.live.size).toBe(0);
  const base = { at: 7, comm: "bun", ageSec: 425_000, cpuSec: 420_000 };
  expect(x.actions).toEqual([
    { ...base, pid: 50, cwd: dir, signal: "SIGTERM", result: "已发" },
    { ...base, pid: 51, cwd: join(dir, "sub"), signal: "SIGTERM", result: "已发" },
    { ...base, pid: 51, cwd: join(dir, "sub"), signal: "SIGTERM", result: "TERM 后已退出" },
    { ...base, pid: 50, cwd: dir, signal: "SIGKILL", result: "已发" },
  ]);
});

test("[验收线 3] observe：零信号，只出台账与 PM 推送；同一 pid 不重复推、不重复记", async () => {
  const f = fixture([["T3", "done"]]);
  const dir = f.wt("t3");
  const x = rig([proc(60, dir, { stubborn: true })], "observe");
  x.host.worktreeRoot = f.root;
  expect(await reapCardProcs(task("T3", "done"), x.host)).toBe(0);
  expect(await patrolCardProcs(f.db, x.host)).toBe(0);
  resetCardPatrolClock();
  expect(await patrolCardProcs(f.db, x.host)).toBe(0);
  expect(x.sent).toEqual([]);
  expect(x.live.has(60)).toBe(true);
  expect(x.notices).toHaveLength(1);
  expect(x.notices[0]).toContain("pid=60");
  expect(x.actions).toEqual([{ at: 7, pid: 60, comm: "bun", cwd: dir, ageSec: 425_000, cpuSec: 420_000, signal: "无（observe）",
    result: "只记录，已推 PM（卡已 done）", owner: "卡=T3" }]);
});

test("动作台账文件：追加；写失败只记日志不挡信号", async () => {
  const f = fixture([]);
  const path = join(f.home, "actions.json");
  const sink = fileActionSink(path);
  const row: ActionRow = { at: 1, pid: 2, comm: "bun", cwd: "/x", ageSec: 3, cpuSec: 4, signal: "SIGTERM", result: "已发" };
  sink([row]);
  sink([{ ...row, pid: 3 }]);
  expect(JSON.parse(readFileSync(path, "utf8")).map((r: ActionRow) => r.pid)).toEqual([2, 3]);
  const lines: string[] = [];
  const base: ProcPorts = { uid: UID, self: 1, list: async () => [], signal: () => true, sleep: async () => {} };
  const g = guardReap(base, { facts: async () => new Map(), daemons: async () => new Set() }, () => { throw new Error("磁盘满"); }, (m) => lines.push(m));
  expect(g.ports.signal(9, "SIGTERM")).toBe(true);
  expect(lines[0]).toContain("磁盘满");
});

/** 起一个 cwd 在 dir、父进程已退出（ppid=1）、setsid 脱离终端、忽略 SIGTERM 的空转 perl，等 lsof 看见它 */
async function spinner(dir: string): Promise<number> {
  const sh = Bun.spawn(["perl", "-MPOSIX", "-e", 'exit if fork; POSIX::setsid(); $SIG{TERM}="IGNORE"; print "$$\\n"; close STDOUT; 1 while 1'],
    { cwd: dir, stdout: "pipe", stderr: "ignore" });
  const pid = Number((await new Response(sh.stdout).text()).trim());
  await sh.exited;
  cleanups.unshift(() => { try { process.kill(pid, "SIGKILL"); } catch { /* 已收 */ } });
  for (let i = 0; i < 30; i++) {
    const p = (await systemProcPorts().list()).find((q) => q.pid === pid);
    if (p?.ppid === 1 && p.cwd === dir) return pid;
    await Bun.sleep(100);
  }
  throw new Error(`pid ${pid} 没等到 ppid=1 + cwd=${dir}`);
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test.if(process.platform === "darwin")("[验收线 2/4] 真进程（macOS）：忽略 TERM 的 ppid=1 空转进程，observe 零信号只记台账；on 下 TERM 收不掉、KILL 收掉", async () => {
  const f = fixture([["T-real", "verified"]]);
  const dir = f.wt("t-real");
  const pid = await spinner(dir);
  const path = join(f.home, "actions.json");
  const run = async (mode: CardReapMode) => {
    const lines: string[] = [], rows: ObserveRow[] = [];
    const g = guardReap(systemProcPorts(), systemGuardSources(), fileActionSink(path), (m) => lines.push(m));
    const deps: CardProcDeps = { mode, ports: g.ports, log: (m) => lines.push(m), now: Date.now, graceMs: 500,
      observed: g.observed({ has: (k) => rows.some((r) => r.key === k), add: (r) => void rows.push(...(r as ObserveRow[])) }) };
    return reapCardProcs(task("T-real"), { worktreeRoot: f.root, procs: deps, notifyPm: async () => {} });
  };
  expect(await run("observe")).toBe(0);
  expect(alive(pid)).toBe(true);
  expect(await run("on")).toBe(1);
  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) { gone = !alive(pid); if (!gone) await Bun.sleep(50); }
  expect(gone).toBe(true);
  const rows = JSON.parse(readFileSync(path, "utf8")) as ActionRow[];
  expect(rows.map((r) => `${r.signal}:${r.result.slice(0, 4)}`)).toEqual(["无（observe）:只记录，", "SIGTERM:已发", "SIGKILL:已发"]);
  for (const r of rows) expect(r).toMatchObject({ pid, comm: "perl", cwd: dir });
  expect(rows[2].cpuSec).not.toBeNull();
  if (process.env.RTO2_EVIDENCE) console.log(JSON.stringify(rows, null, 2));
});

test("[r1 P1 daemon-probe-partial-fail-open 复现] launchctl / ps 只出表头或部分输出后非零退出 = 读不出：护栏整轮不给进程", async () => {
  const header = "PID\tStatus\tLabel\n";
  const runner = (code: number) => async (argv: string[]) => (argv[0] === "launchctl" ? { out: header, code }
    : { out: "  77 ??  0:01.00 /opt/tools/bin/bun\n", code: 0 });
  expect(await systemGuardSources(runner(1)).daemons()).toBeNull();
  expect(await systemGuardSources(runner(0)).daemons()).toEqual(new Set());
  const psFail = systemGuardSources(async (argv) => (argv[0] === "ps" ? { out: "  77 ??  0:01.00 /opt/tools/bin/bun\n", code: 1 } : { out: header, code: 0 }));
  expect(await psFail.facts()).toBeNull();
  expect(await guardReap({ uid: UID, self: 1, list: async () => [proc(77, "/w/t")], signal: () => true, sleep: async () => {} }, psFail, () => {}, () => {})
    .ports.list()).toEqual([]); // ps 打印了 pid=77 后 exit 1：一样不给
  const base: ProcPorts = { uid: UID, self: 1, list: async () => [proc(77, "/w/t")], signal: () => true, sleep: async () => {} };
  const lines: string[] = [];
  const g = guardReap(base, systemGuardSources(runner(1)), () => {}, (m) => lines.push(m));
  expect(await g.ports.list()).toEqual([]);
  expect(lines.join("\n")).toContain("这轮一个进程都不给");
});

test("[r1 P2 corrupt-action-ledger-overwrite 复现] 台账文件损坏：拒绝覆盖、原文件原样保留，错误记日志，信号照发", () => {
  const f = fixture([]);
  const path = join(f.home, "actions.json");
  writeFileSync(path, '[{"pid": 1, "res');
  const lines: string[] = [];
  const base: ProcPorts = { uid: UID, self: 1, list: async () => [], signal: () => true, sleep: async () => {} };
  const g = guardReap(base, { facts: async () => new Map(), daemons: async () => new Set() }, fileActionSink(path), (m) => lines.push(m));
  expect(g.ports.signal(9, "SIGTERM")).toBe(true);
  expect(readFileSync(path, "utf8")).toBe('[{"pid": 1, "res');
  expect(lines[0]).toContain("拒绝覆盖写");
});
