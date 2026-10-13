/**
 * RTO1：卡 worktree 下残留进程回收。假进程表 + 极简台账（tasks / meta 两张表）；最后一个用例在 macOS 上起真的 ppid=1 进程、删掉它的 cwd，
 * 实测 lsof 对已删目录的表现（照样报原路径）并验证巡检能收掉它。
 */
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileObserveLedger, patrolCardProcs, reapCardProcs, resetCardPatrolClock, type CardProcDeps, type CardReapHost,
  type CardReapMode, type ObserveRow } from "../src/lib/card-proc-reap.js";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import { ORPHAN_EVERY_MS } from "../src/lib/lend-proc-reap.js";
import { systemProcPorts } from "../src/lib/lend-proc-reap.js";
import type { Proc, ProcPorts } from "../src/lib/proc-reap-core.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { schedulerRetireTick, type RetireDeps } from "../src/lib/scheduler-retire.js";

const UID = 501;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); resetCardPatrolClock(); });

function fakePorts(procs: (Proc & { stubborn?: boolean })[]) {
  const sent: string[] = [];
  const live = new Map(procs.map((p) => [p.pid, p]));
  let lists = 0;
  const hooks: ((n: number) => void)[] = [];
  const ports: ProcPorts = {
    uid: UID, self: 4242,
    list: async () => { lists++; for (const h of hooks) h(lists); return [...live.values()].map(({ stubborn: _s, ...p }) => p); },
    signal: (pid, sig) => {
      sent.push(`${sig}:${pid}`);
      const p = live.get(pid);
      if (!p) return false;
      if (sig === "SIGKILL" || !p.stubborn) live.delete(pid);
      return true;
    },
    sleep: async (ms) => void sent.push(`sleep:${ms}`),
  };
  /** 第 n 次枚举进程表之前跑 h（n 从 1 起）：模拟两次快照之间进程 / 目录 / 台账变了 */
  return { ports, sent, live, lists: () => lists, onList: (h: (n: number) => void) => void hooks.push(h) };
}
const proc = (pid: number, cwd: string, extra: Partial<Proc & { stubborn: boolean }> = {}) =>
  ({ pid, ppid: 1, uid: UID, cwd, comm: "/opt/tools/bin/bun", ageSec: 425_000, ...extra });

function fixture(tasks: [string, string, string?][] = []) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "card-reap-"))); // macOS 的 /var 是软链：根路径里有软链会被拒
  const root = join(home, "worktrees");
  mkdirSync(root);
  const db = new Database(":memory:");
  db.run("CREATE TABLE tasks (id TEXT, project TEXT, stage TEXT)");
  db.run("CREATE TABLE meta (project TEXT, key TEXT, value TEXT)");
  for (const [id, stage, project] of tasks) db.query("INSERT INTO tasks VALUES (?, ?, ?)").run(id, project ?? "p", stage);
  cleanups.push(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  const wt = (name: string) => { const d = join(root, name); mkdirSync(join(d, "sub"), { recursive: true }); return d; };
  return { home, root, db, wt };
}

function host(root: string, procs: (Proc & { stubborn?: boolean })[], mode: CardReapMode = "on", now = 1_000_000) {
  const fake = fakePorts(procs);
  const lines: string[] = [], notices: string[] = [], rows: ObserveRow[] = [];
  let failNotify = false;
  const clock = { now };
  const deps: CardProcDeps = { mode, ports: fake.ports, log: (m) => lines.push(m), now: () => clock.now,
    observed: { has: (k) => rows.some((r) => r.key === k), add: (r) => void rows.push(...r) } };
  const h: CardReapHost = { worktreeRoot: root, procs: deps, notifyPm: async (_t, text) => {
    if (failNotify) throw new Error("bridge 不在");
    notices.push(text);
  } };
  return { h, deps, ...fake, lines, notices, rows, clock, failNotify: (v: boolean) => { failNotify = v; } };
}
const task = (id: string, stage = "verified", project = "p") => ({ id, stage, project }) as LedgerTask;

test("[验收线 1] 收卡：执行者 / 审查员 worktree（含子目录）下 TERM → 宽限 → 只 KILL 仍在的；别的卡、根外、别的 uid、自己零信号", async () => {
  const f = fixture();
  const mine = f.wt("t1"), rv = f.wt("rv-t1"), other = f.wt("t2");
  const x = host(f.root, [proc(10, mine, { ppid: 777 }), proc(11, join(rv, "sub"), { stubborn: true }), proc(20, other), proc(21, f.home),
    proc(22, mine, { uid: 0 }), proc(4242, mine), proc(23, `${mine}-x`), proc(24, join(f.root, "rv-t1x"))]);
  expect(await reapCardProcs(task("T1"), x.h)).toBe(2);
  expect(x.sent).toEqual(["SIGTERM:10", "SIGTERM:11", "sleep:4000", "SIGKILL:11"]);
  expect(x.lines).toHaveLength(3);
  expect(x.lines[0]).toBe("回收残留进程 pid=10 命令=bun 卡=T1 存活=425000s 信号=SIGTERM 结果=已发");
  for (const l of x.lines) expect(l).not.toContain("/opt/tools");
});

test("[验收线 1] 收卡：卡目录是软链、worktrees 根是软链、根的祖先是软链：零信号，各记一行", async () => {
  const f = fixture();
  const real = f.wt("elsewhere");
  symlinkSync(real, join(f.root, "t1"));
  const x = host(f.root, [proc(10, real), proc(11, join(f.root, "t1"))]);
  expect(await reapCardProcs(task("T1"), x.h)).toBe(0);
  expect(x.lines.some((l) => l.includes("worktrees/t1：是软链"))).toBe(true);
  const linkRoot = join(f.home, "link");
  symlinkSync(f.root, linkRoot);
  f.wt("t1b");
  const y = host(linkRoot, [proc(10, join(f.root, "t1b")), proc(11, join(linkRoot, "t1b"))]);
  expect(await reapCardProcs(task("T1b"), y.h)).toBe(0);
  const linkHome = `${f.home}-link`; // 祖先目录是软链：<home>-link -> <home>，根 = <home>-link/worktrees
  symlinkSync(f.home, linkHome);
  cleanups.push(() => rmSync(linkHome));
  const z = host(join(linkHome, "worktrees"), [proc(10, join(f.root, "t1b"))]);
  expect(await reapCardProcs(task("T1b"), z.h)).toBe(0);
  expect([...x.sent, ...y.sent, ...z.sent]).toEqual([]);
  expect([...y.lines, ...z.lines].every((l) => l.includes("软链"))).toBe(true);
});

test("[验收线 1] 收卡 / 巡检：没停的 agent 还在里面工作的 worktree 零信号、记一行；已停的不挡", async () => {
  const f = fixture([["T1", "done"]]);
  const mine = f.wt("t1"), rv = f.wt("rv-t1");
  const x = host(f.root, [proc(10, mine), proc(11, rv)]);
  x.h.agents = async () => [{ name: "w-shared", cwd: join(mine, "sub"), status: "active", pending: false, window: true },
    { name: "w-old", cwd: rv, status: "stopped", pending: false, window: false }];
  expect(await reapCardProcs(task("T1"), x.h)).toBe(1);
  expect(x.sent).toEqual(["SIGTERM:11", "sleep:4000"]);
  expect(x.lines.some((l) => l.includes("worktrees/t1：w-shared 还在这里工作"))).toBe(true);
  const y = host(f.root, [proc(10, mine)]);
  y.h.agents = x.h.agents;
  expect(await patrolCardProcs(f.db, y.h)).toBe(0);
  expect(y.sent).toEqual([]);
  expect(y.lines).toEqual(["卡残留进程巡检跳过 worktrees/t1：w-shared 还在这里工作（agent 没停）"]);
});

test("[验收线 1] 收卡：进程表读不出只记一行不挡收卡；失租原样抛出", async () => {
  const f = fixture();
  f.wt("t1");
  const x = host(f.root, []);
  x.ports.list = async () => { throw new Error("lsof 炸了"); };
  expect(await reapCardProcs(task("T1"), x.h)).toBe(0);
  expect(x.lines[0]).toContain("不挡收卡");
  const y = host(f.root, [proc(10, join(f.root, "t1"))]);
  y.deps.active = () => { throw new SchedulerStopped("lease lost"); };
  await expect(reapCardProcs(task("T1"), y.h)).rejects.toBeInstanceOf(SchedulerStopped);
  expect(y.sent).toEqual([]);
});

test("[验收线 2] 巡检：ppid=1 且（卡终态 或 cwd 已删）才收；活卡目录在、ppid≠1 不碰", async () => {
  const f = fixture([["T-done", "done"], ["T-live", "build"], ["T-gone", "review"], ["T-cx", "cancelled"]]);
  const done = f.wt("t-done"), live = f.wt("t-live"), gone = join(f.root, "rv-t-gone", "sub"), cx = f.wt("t-cx");
  const x = host(f.root, [proc(10, join(done, "sub")), proc(11, live), proc(12, gone, { stubborn: true }), proc(13, cx, { ppid: 99 }),
    proc(14, f.home), proc(15, join(live, "deleted-sub"))]);
  expect(await patrolCardProcs(f.db, x.h)).toBe(3);
  expect(x.sent).toEqual(["SIGTERM:10", "SIGTERM:12", "SIGTERM:15", "sleep:4000", "SIGKILL:12"]);
  expect(x.lines.filter((l) => l.includes("跳过"))).toEqual([]);
});

test("[验收线 2] 巡检：卡未知（目录名对不上 / 状态不认识 / 两张卡撞名 / 项目冻结 / 软链）零信号，每个目录记一行", async () => {
  const f = fixture([["T-odd", "weird"], ["Dup", "done"], ["DUP", "done"], ["T-frz", "done", "frozen"], ["T-ln", "done"]]);
  f.db.query("INSERT INTO meta VALUES ('frozen', 'queueFrozen', ?)").run(JSON.stringify({ frozen: true, reason: "x", since: 1 }));
  const real = f.wt("elsewhere");
  symlinkSync(real, join(f.root, "rv-t-ln"));
  const dirs = ["stray", "t-odd", "dup", "t-frz", "rv-t-ln"];
  const x = host(f.root, [...dirs.map((d, i) => proc(10 + i, join(f.root, d))), proc(30, join(f.root, "stray", "sub"))]);
  for (const d of dirs) if (d !== "rv-t-ln") f.wt(d);
  expect(await patrolCardProcs(f.db, x.h)).toBe(0);
  expect(x.sent).toEqual([]);
  expect(x.lines).toHaveLength(5);
  expect(x.lines.some((l) => l.includes("worktrees/stray：目录名对不上任何卡"))).toBe(true);
  expect(x.lines.some((l) => l.includes("T-odd 状态未知"))).toBe(true);
  expect(x.lines.some((l) => l.includes("worktrees/dup：目录名对上不止一张卡"))).toBe(true);
  expect(x.lines.some((l) => l.includes("队列冻结"))).toBe(true);
  expect(x.lines.some((l) => l.includes("worktrees/rv-t-ln：是软链"))).toBe(true);
});

test("[验收线 2] 巡检：节流 ORPHAN_EVERY_MS；台账读不出整轮跳过记一行；off 连进程表都不读", async () => {
  const f = fixture([["T1", "done"]]);
  const x = host(f.root, [proc(10, f.wt("t1"))]);
  expect(await patrolCardProcs(f.db, x.h)).toBe(1);
  x.live.set(11, proc(11, join(f.root, "t1")));
  x.clock.now += ORPHAN_EVERY_MS - 1;
  expect(await patrolCardProcs(f.db, x.h)).toBe(0);
  x.clock.now += 1;
  expect(await patrolCardProcs(f.db, x.h)).toBe(1);
  resetCardPatrolClock();
  const y = host(f.root, [proc(10, join(f.root, "t1"))]);
  f.db.run("DROP TABLE tasks");
  expect(await patrolCardProcs(f.db, y.h)).toBe(0);
  expect(y.lines[0]).toContain("台账读不到");
  const z = host(f.root, [proc(10, join(f.root, "t1"))], "off");
  expect(await patrolCardProcs(f.db, z.h)).toBe(0);
  expect(await reapCardProcs(task("T1"), z.h)).toBe(0);
  expect(z.lists()).toBe(0);
  expect([...y.sent, ...z.sent]).toEqual([]);
});

test("[验收线 2] observe：收卡与巡检全程零信号，只记录；PM 摘要同一进程只推一次，推失败下次再推", async () => {
  const f = fixture([["T1", "done"], ["T2", "build", "q"]]);
  const t1 = f.wt("t1");
  const x = host(f.root, [proc(10, t1), proc(11, join(f.root, "rv-t2", "sub"))], "observe");
  x.failNotify(true);
  expect(await reapCardProcs(task("T1", "done"), x.h)).toBe(0);
  expect(x.rows).toEqual([]);
  x.failNotify(false);
  expect(await reapCardProcs(task("T1", "done"), x.h)).toBe(0);
  expect(await patrolCardProcs(f.db, x.h)).toBe(0);
  expect(x.sent).toEqual([]);
  expect(x.lines.some((l) => l.includes("pid=10 命令=bun 卡=T1") && l.includes("信号=无（observe）"))).toBe(true);
  expect(x.notices).toHaveLength(2); // T1 一条（收卡），T2 一条（巡检：目录已删）；巡检再看到 pid 10 不再推
  expect(x.notices[0]).toContain("pid=10 卡=T1 命令=bun");
  expect(x.notices[1]).toContain("pid=11 卡=T2 命令=bun");
  expect(x.notices[1]).toContain("cwd 目录已删");
  for (const n of x.notices) expect(n).not.toContain("/opt/tools");
  expect(x.rows.map((r) => r.pid)).toEqual([10, 11]);
});

test("台账文件去重、读坏了当空", () => {
  const f = fixture();
  const path = join(f.home, "observed.json");
  const l = fileObserveLedger(path);
  expect(l.has("1|/a")).toBe(false);
  l.add([{ key: "1|/a", card: "T", pid: 1, comm: "bun", at: 1, why: "x" }]);
  expect(l.has("1|/a")).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8"))).toHaveLength(1);
  Bun.write(path, "{bad");
  expect(fileObserveLedger(path).has("1|/a")).toBe(false);
});

test("调度器接线：退役 tick 跑巡检；没注入 procs 且不是真 worktrees 根 = 不碰进程表", async () => {
  const f = fixture([["T1", "verified"]]);
  const x = host(f.root, [proc(10, f.wt("t1"))]);
  const deps = { worktreeRoot: f.root, notifyPm: x.h.notifyPm, procs: x.deps } as unknown as RetireDeps;
  await schedulerRetireTick(f.db, ["p"], deps);
  expect(x.sent).toEqual(["SIGTERM:10", "sleep:4000"]);
  resetCardPatrolClock();
  const y = host(f.root, [proc(10, join(f.root, "t1"))]);
  expect(await reapCardProcs(task("T1"), { worktreeRoot: f.root, notifyPm: y.h.notifyPm })).toBe(0);
  expect(y.lists()).toBe(0);
});

test.if(process.platform === "darwin")("[验收线 2] 真进程（macOS）：ppid=1 的 sleep，cwd 目录删掉后 lsof 仍报原路径，巡检收掉它", async () => {
  const f = fixture([["T-real", "build"]]);
  const dir = f.wt("t-real");
  const sh = Bun.spawn(["sh", "-c", "sleep 60 >/dev/null 2>&1 & echo $!"], { cwd: join(dir, "sub"), stdout: "pipe" });
  const pid = Number((await new Response(sh.stdout).text()).trim());
  await sh.exited;
  cleanups.unshift(() => { try { process.kill(pid, "SIGKILL"); } catch { /* 已收 */ } });
  rmSync(dir, { recursive: true });
  expect(existsSync(dir)).toBe(false);
  const ports = systemProcPorts();
  let seen: Proc | undefined;
  for (let i = 0; i < 20 && seen?.ppid !== 1; i++) { seen = (await ports.list()).find((p) => p.pid === pid); if (seen?.ppid !== 1) await Bun.sleep(100); }
  expect(seen?.cwd).toBe(join(dir, "sub"));
  expect(seen?.ppid).toBe(1);
  const lines: string[] = [];
  const h: CardReapHost = { worktreeRoot: f.root, notifyPm: async () => {}, procs: { mode: "on", ports, log: (m) => lines.push(m), now: Date.now,
    observed: { has: () => false, add: () => {} }, graceMs: 300 } };
  expect(await patrolCardProcs(f.db, h)).toBe(1);
  expect(lines[0]).toContain(`pid=${pid} 命令=sleep 卡=T-real`);
  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) { try { process.kill(pid, 0); await Bun.sleep(50); } catch { gone = true; } }
  expect(gone).toBe(true);
});

test("[验收线 1] 收卡 / 巡检：cwd 下层有软链（含已删 cwd 的仍在祖先是软链）零信号，记一行；已删 cwd 本身不算软链", async () => {
  const f = fixture([["T1", "done"]]);
  const mine = f.wt("t1"), out = join(f.home, "outside");
  mkdirSync(out);
  symlinkSync(out, join(mine, "link"));
  const procs = () => [proc(10, join(mine, "link")), proc(11, join(mine, "link", "gone")), proc(12, join(mine, "sub", "gone"))];
  const x = host(f.root, procs());
  expect(await reapCardProcs(task("T1"), x.h)).toBe(1);
  expect(x.sent).toEqual(["SIGTERM:12", "sleep:4000"]);
  expect(x.lines.filter((l) => l.includes("软链"))).toHaveLength(2);
  const y = host(f.root, procs());
  expect(await patrolCardProcs(f.db, y.h)).toBe(1);
  expect(y.sent).toEqual(["SIGTERM:12", "sleep:4000"]);
  expect(y.lines.filter((l) => l.includes("软链"))).toHaveLength(2);
});

test("[验收线 1] 收卡 / 巡检：宽限期间卡目录换成根外软链，不追加 KILL", async () => {
  const f = fixture([["T1", "done"]]);
  const out = join(f.home, "outside");
  mkdirSync(out);
  const swap = (x: ReturnType<typeof host>) => {
    x.ports.sleep = async (ms) => { x.sent.push(`sleep:${ms}`); rmSync(join(f.root, "t1"), { recursive: true, force: true }); symlinkSync(out, join(f.root, "t1")); };
  };
  const mine = f.wt("t1");
  const x = host(f.root, [proc(10, mine, { stubborn: true })]);
  swap(x);
  expect(await reapCardProcs(task("T1"), x.h)).toBe(1);
  expect(x.sent).toEqual(["SIGTERM:10", "sleep:4000"]);
  rmSync(mine);
  f.wt("t1");
  const y = host(f.root, [proc(10, mine, { stubborn: true })]);
  swap(y);
  expect(await patrolCardProcs(f.db, y.h)).toBe(1);
  expect(y.sent).toEqual(["SIGTERM:10", "sleep:4000"]);
});

// ── REAPALIVE1：observe 摘要发出前再枚举一次进程表、重核全部资格 ──
type Fx = ReturnType<typeof fixture>;
type Hx = ReturnType<typeof host>;
const ENTRIES = ["收卡", "巡检"] as const;
const enter = (kind: (typeof ENTRIES)[number], f: Fx, x: Hx) => (kind === "收卡" ? reapCardProcs(task("T1", "done"), x.h) : patrolCardProcs(f.db, x.h));
/** 一张已 done 的 T1、worktree 在、里面一个 ppid=1 的进程（两个入口都够格），observe 档；第二次枚举（发送前复查）之前跑 change */
function recheckCase(change?: (c: { f: Fx; x: Hx; t1: string; state: { busy: boolean } }) => void) {
  const f = fixture([["T1", "done"]]);
  const t1 = f.wt("t1"), state = { busy: false };
  const x = host(f.root, [proc(10, t1)], "observe");
  x.h.agents = async () => (state.busy ? [{ name: "w-back", cwd: t1, status: "active", pending: false, window: true }] : []);
  x.onList((n) => { if (n === 2) change?.({ f, x, t1, state }); });
  return { f, x, t1 };
}
const nothingSaid = (x: Hx) => { expect(x.notices).toEqual([]); expect(x.rows).toEqual([]); expect(x.sent).toEqual([]); };

test("[REAPALIVE1 红测] observe：第一次枚举是候选、发送前复查已退出 → 零摘要、零信号、零已通知记录；下轮还在才报", async () => {
  for (const kind of ENTRIES) {
    const { f, x, t1 } = recheckCase(({ x }) => x.live.clear());
    await enter(kind, f, x);
    nothingSaid(x);
    expect(x.lists()).toBe(2);
    expect(x.lines.some((l) => l.includes("发送前复查") && l.includes("pid=10") && l.includes("不报"))).toBe(true);
    x.live.set(10, proc(10, t1));
    x.clock.now += ORPHAN_EVERY_MS;
    await enter(kind, f, x);
    expect(x.notices).toHaveLength(1);
    expect(x.rows.map((r) => r.pid)).toEqual([10]);
  }
});

test("[REAPALIVE1 红测] observe：复查时同 pid 换了 cwd / uid / 命令 / 是新进程、活 agent 占了目录、目录或根换成软链、档位切走 → 零摘要零记录", async () => {
  const cases: [string, Parameters<typeof recheckCase>[0]][] = [
    ["cwd 变了", ({ x, t1 }) => x.live.set(10, proc(10, join(t1, "sub")))],
    ["uid 变了", ({ x, t1 }) => x.live.set(10, proc(10, t1, { uid: 0 }))],
    ["命令变了", ({ x, t1 }) => x.live.set(10, proc(10, t1, { comm: "/bin/sleep" }))],
    ["pid 被新进程复用（存活时间倒退）", ({ x, t1 }) => x.live.set(10, proc(10, t1, { ageSec: 3 }))],
    ["活 agent 占了目录", ({ state }) => { state.busy = true; }],
    ["卡目录换成根外软链", ({ f, t1 }) => { rmSync(t1, { recursive: true }); symlinkSync(f.home, t1); }],
    ["worktrees 根换成软链", ({ f }) => { renameSync(f.root, `${f.root}-real`); symlinkSync(`${f.root}-real`, f.root); }],
    ["档位切到 off", ({ x }) => { x.deps.mode = "off"; }],
    ["档位切到 on（下轮由 on 去收，这轮不发 observe 摘要）", ({ x }) => { x.deps.mode = "on"; }],
  ];
  for (const [name, change] of cases) for (const kind of ENTRIES) {
    const { f, x } = recheckCase(change);
    await enter(kind, f, x);
    expect(x.lists(), `${kind}：${name}`).toBe(2);
    expect([x.notices, x.rows, x.sent], `${kind}：${name}`).toEqual([[], [], []]);
    resetCardPatrolClock();
  }
});

test("[REAPALIVE1 红测] 巡检 observe：复查时卡回到进行中 / 项目冻结 / ppid 不再是 1 → 零摘要零记录", async () => {
  const freeze = JSON.stringify({ frozen: true, reason: "x", since: 1 });
  const cases: [string, Parameters<typeof recheckCase>[0]][] = [
    ["卡状态变了", ({ f }) => void f.db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T1'")],
    ["卡状态不认识了", ({ f }) => void f.db.run("UPDATE tasks SET stage = 'weird' WHERE id = 'T1'")],
    ["项目冻结了", ({ f }) => void f.db.query("INSERT INTO meta VALUES ('p', 'queueFrozen', ?)").run(freeze)],
    ["又有了父进程", ({ x, t1 }) => x.live.set(10, proc(10, t1, { ppid: 99 }))],
    ["台账读不到了", ({ f }) => void f.db.run("ALTER TABLE tasks RENAME TO gone")],
  ];
  for (const [name, change] of cases) {
    const { f, x } = recheckCase(change);
    expect(await patrolCardProcs(f.db, x.h), name).toBe(0);
    expect([x.notices, x.rows, x.sent], name).toEqual([[], [], []]);
    resetCardPatrolClock();
  }
});

test("[REAPALIVE1] observe：一组里只报复查时真正留下的；按项目各复查一次；仍活的同一进程只报一次；摘要写明是发送前快照、切档走恢复键", async () => {
  const f = fixture([["T1", "done"], ["T2", "done", "q"]]);
  const t1 = f.wt("t1"), rv = f.wt("rv-t1"), t2 = f.wt("t2");
  const x = host(f.root, [proc(10, t1), proc(11, rv), proc(12, t2)], "observe");
  x.onList((n) => { if (n === 2) x.live.delete(11); });
  expect(await patrolCardProcs(f.db, x.h)).toBe(0);
  expect(x.lists()).toBe(3); // 首次 + 项目 p 发送前 + 项目 q 发送前
  expect(x.notices).toHaveLength(2);
  expect(x.notices[0]).toContain("有 1 个残留进程");
  expect(x.notices[0]).toContain("pid=10 卡=T1");
  expect(x.notices[0]).not.toContain("pid=11");
  expect(x.notices[0]).toContain("发送前刚复查进程表的快照");
  expect(x.notices[0]).toContain("ledger scheduler-recovery p on --key cardProcReap");
  expect(x.notices[1]).toContain("ledger scheduler-recovery q on --key cardProcReap");
  expect(x.notices.join("\n")).not.toContain("CLAUDESTRA_CARD_PROC_REAP");
  expect(x.rows.map((r) => r.pid)).toEqual([10, 12]);
  x.live.set(11, proc(11, rv)); // 没记过「已通知」的那个再出现：照报；10 / 12 还活着但报过了，不再报
  x.clock.now += ORPHAN_EVERY_MS;
  expect(await patrolCardProcs(f.db, x.h)).toBe(0);
  expect(x.notices).toHaveLength(3);
  expect(x.notices[2]).toContain("pid=11 卡=T1");
  expect(x.notices[2]).not.toContain("pid=10");
  x.clock.now += ORPHAN_EVERY_MS;
  const before = x.lists();
  expect(await patrolCardProcs(f.db, x.h)).toBe(0);
  expect(x.notices).toHaveLength(3);
  expect(x.lists()).toBe(before + 1); // 没有新对象：不复查、不发
  expect(x.sent).toEqual([]);
});

test("[REAPALIVE1] observe：复查异常只记原因、不发不记，下轮可重试；复查 / 推送时失租原样抛、不记已通知", async () => {
  for (const kind of ENTRIES) {
    const { f, x } = recheckCase();
    x.onList((n) => { if (n === 2) throw new Error("lsof 炸了"); });
    await enter(kind, f, x);
    nothingSaid(x);
    expect(x.lines.some((l) => l.includes("发送前复查失败") && l.includes("lsof 炸了") && l.includes("下轮再试"))).toBe(true);
    x.clock.now += ORPHAN_EVERY_MS;
    await enter(kind, f, x);
    expect(x.notices).toHaveLength(1);
    resetCardPatrolClock();

    const y = recheckCase();
    let reads = 0;
    y.x.h.agents = async () => { if (reads++) throw new SchedulerStopped("lease lost"); return []; };
    await expect(enter(kind, y.f, y.x)).rejects.toBeInstanceOf(SchedulerStopped);
    nothingSaid(y.x);
    resetCardPatrolClock();

    const z = recheckCase();
    z.x.h.notifyPm = async () => { throw new SchedulerStopped("lease lost"); };
    await expect(enter(kind, z.f, z.x)).rejects.toBeInstanceOf(SchedulerStopped);
    expect([z.x.rows, z.x.sent]).toEqual([[], []]);
    resetCardPatrolClock();
  }
});

test("[REAPALIVE1] 多项目巡检：档位按每张卡的项目读，on 收、observe 只报、off 零动作零记录；全 off 不枚举进程表", async () => {
  const f = fixture([["TA", "done", "pa"], ["TB", "done", "pb"], ["TC", "done", "pc"]]);
  const procs = () => [proc(10, join(f.root, "ta")), proc(11, join(f.root, "tb")), proc(12, join(f.root, "tc"))];
  for (const d of ["ta", "tb", "tc"]) f.wt(d);
  const modes: Record<string, CardReapMode> = { pa: "on", pb: "observe", pc: "off" };
  const asked: string[] = [];
  const x = host(f.root, procs());
  x.deps.mode = (project) => { asked.push(project); return modes[project]; };
  expect(await patrolCardProcs(f.db, x.h)).toBe(1);
  expect(x.sent).toEqual(["SIGTERM:10", "sleep:4000"]);
  expect(x.notices).toHaveLength(1);
  expect(x.notices[0]).toContain("pid=11 卡=TB");
  expect(x.rows.map((r) => r.pid)).toEqual([11]);
  expect(x.lines.filter((l) => l.includes("TC") || l.includes("pid=12") || l.includes("worktrees/tc"))).toEqual([]);
  expect(new Set(asked)).toEqual(new Set(["pa", "pb", "pc"]));
  expect(await reapCardProcs(task("TC", "done", "pc"), x.h)).toBe(0);
  expect(x.sent).toEqual(["SIGTERM:10", "sleep:4000"]);
  resetCardPatrolClock();
  const y = host(f.root, procs());
  y.deps.mode = () => "off";
  expect(await patrolCardProcs(f.db, y.h)).toBe(0);
  expect(await reapCardProcs(task("TA", "done", "pa"), y.h)).toBe(0);
  expect([y.lists(), y.lines, y.sent, y.notices, y.rows]).toEqual([0, [], [], [], []]);
});
