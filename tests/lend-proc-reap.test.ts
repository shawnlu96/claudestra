import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrder, openLendJournal, patchOrder, recordAsked, type LendState } from "../src/lib/lend-journal.js";
import { orderDir } from "../src/lib/lend-clone.js";
import { settleOrder } from "../src/lib/lend-drive.js";
import { lendTickWithRetention, STOPPED_RETENTION_MS as DAY } from "../src/lib/lend-work-retention.js";
import { ORPHAN_EVERY_MS, ORPHAN_IDLE_MS, parseEtime, parseLsofCwd, parsePs, reapOrder, reapOrphans, systemProcPorts, type Proc, type ProcPorts } from "../src/lib/lend-proc-reap.js";
import { harness } from "./lend-harness.js";

const UID = 501;
const NOW = 10 * DAY;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "proc-reap-"))); // macOS 的 /var 是软链：根路径里有软链会被拒
  const root = join(home, "lend");
  const db = openLendJournal(join(root, "journal.sqlite"));
  cleanups.push(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  const real = realpathSync(join(root));
  function add(id: string, state: LendState, at = NOW - DAY) {
    recordAsked(db, { orderId: id, peer: "test", fp: null, family: "codex", preview: {} }, at - 100);
    db.query("UPDATE lend_orders SET state = ?, updatedAt = ? WHERE orderId = ?").run(state, at, id);
    const dir = orderDir(id, root);
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "f"), id);
    age(dir);
    return join(real, "work", dir.split("/").pop()!);
  }
  return { home, root, real, db, add };
}

/** 把目录树的写入时间拨回 31 分钟前（相对真实时钟，兜底判写入用 o.now） */
function age(dir: string, at = (NOW - ORPHAN_IDLE_MS - 60_000) / 1000) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) age(p, at); else utimesSync(p, at, at);
  }
  utimesSync(dir, at, at);
}

/** 假进程表：stubborn 的进程不理 TERM，只有 KILL 能收 */
function fakePorts(procs: (Proc & { stubborn?: boolean })[]) {
  const sent: string[] = [];
  const live = new Map(procs.map((p) => [p.pid, p]));
  const ports: ProcPorts = {
    uid: UID, self: 4242,
    list: async () => [...live.values()].map(({ stubborn: _s, ...p }) => p),
    signal: (pid, sig) => {
      sent.push(`${sig}:${pid}`);
      const p = live.get(pid);
      if (!p) return false;
      if (sig === "SIGKILL" || !p.stubborn) live.delete(pid);
      return true;
    },
    sleep: async (ms) => void sent.push(`sleep:${ms}`),
  };
  return { ports, sent, live };
}
const proc = (pid: number, cwd: string, extra: Partial<Proc & { stubborn: boolean }> = {}) =>
  ({ pid, uid: UID, cwd, comm: "/opt/tools/bin/bun", ageSec: 400_000, ...extra });

test("结单回收：该单目录（含子目录）TERM → 宽限 → 只 KILL 仍在的；别的单、根外、别的 uid、自己一律不碰", async () => {
  const f = fixture();
  const mine = f.add("done", "acked");
  const other = f.add("busy", "started");
  const { ports, sent } = fakePorts([
    proc(10, mine), proc(11, join(mine, "sub"), { stubborn: true }),
    proc(20, other), proc(21, f.home), proc(22, mine, { uid: 0 }), proc(4242, mine), proc(23, `${mine}-x`),
  ]);
  const lines: string[] = [];
  expect(await reapOrder("done", { root: f.root, ports, log: (m) => lines.push(m) })).toBe(2);
  expect(sent).toEqual(["SIGTERM:10", "SIGTERM:11", "sleep:4000", "SIGKILL:11"]);
  expect(lines).toHaveLength(3);
  expect(lines[0]).toContain("pid=10 命令=bun 单=done 存活=400000s 信号=SIGTERM");
  for (const l of lines) expect(l).not.toContain("/opt/tools");
});

test("settleOrder：acked / cancelled / released 都先回收进程再删目录；回收失败不挡结单", async () => {
  for (const state of ["acked", "cancelled", "released"] as LendState[]) {
    const h = harness();
    cleanups.push(() => h.db.close());
    const order: string[] = [];
    h.d.reapOrder = async (id) => void order.push(`reap:${id}`);
    h.d.removeDir = (id) => void order.push(`rm:${id}`);
    recordAsked(h.db, { orderId: "o1", peer: "team-a", fp: null, family: "codex", preview: {} }, 1);
    h.db.query("UPDATE lend_orders SET state = ? WHERE orderId = 'o1'").run(state);
    await settleOrder(patchOrder(h.db, "o1", [state], { settle: { notify: null, removeDir: true } }, 2), h.d);
    expect(order).toEqual(["reap:o1", "rm:o1"]);
    expect(getOrder(h.db, "o1")!.settle).toBeNull();
  }
  const f = fixture();
  const dir = f.add("x", "acked");
  const { ports } = fakePorts([proc(10, dir)]);
  const lines: string[] = [];
  ports.list = async () => { throw new Error("lsof 炸了"); };
  expect(await reapOrder("x", { root: f.root, ports, log: (m) => lines.push(m) })).toBe(0);
  expect(lines[0]).toContain("不挡结单");
});

test("软链根 / 软链 work / 软链单目录：拒绝回收，什么信号都不发", async () => {
  const f = fixture();
  const dir = f.add("x", "acked");
  const { ports, sent } = fakePorts([proc(10, dir)]);
  const lines: string[] = [];
  const link = join(f.home, "link");
  symlinkSync(f.root, link);
  expect(await reapOrder("x", { root: link, ports, log: (m) => lines.push(m) })).toBe(0);
  const linkedWork = join(f.home, "lw");
  mkdirSync(linkedWork);
  symlinkSync(join(f.root, "work"), join(linkedWork, "work"));
  expect(await reapOrder("x", { root: linkedWork, ports, log: (m) => lines.push(m) })).toBe(0);
  const leafRoot = join(f.home, "leaf");
  mkdirSync(join(leafRoot, "work"), { recursive: true });
  symlinkSync(dir, orderDir("x", leafRoot));
  expect(await reapOrder("x", { root: leafRoot, ports, log: (m) => lines.push(m) })).toBe(0);
  expect(sent).toEqual([]);
  expect(lines.filter((l) => l.includes("软链"))).toHaveLength(3);
});

test("兜底：孤儿目录（非活单 + 30 分钟没写入）回收；活单、新近写入、对不上单的目录不碰；节流 10 分钟", async () => {
  const f = fixture();
  const orphan = f.add("old", "stopped");
  const live = f.add("run", "result_pending");
  const fresh = f.add("new", "cancelled");
  writeFileSync(join(fresh, "sub", "f"), "touched"); // mtime = 真实现在，晚于 o.now - 30 分钟
  const stray = join(f.real, "work", "not-an-order");
  mkdirSync(stray);
  const { ports, sent } = fakePorts([proc(1, f.home), proc(10, join(orphan, "sub")), proc(20, live), proc(30, fresh), proc(40, stray)]);
  const lines: string[] = [];
  const o = { root: f.root, ports, log: (m: string) => lines.push(m), now: NOW };
  expect(await reapOrphans(f.db, o)).toBe(1);
  expect(sent).toEqual(["SIGTERM:10", "sleep:4000"]);
  expect(lines.some((l) => l.includes("not-an-order：目录名对不上任何出借单"))).toBe(true);
  expect(await reapOrphans(f.db, { ...o, now: NOW + ORPHAN_EVERY_MS - 1 })).toBe(0);
  expect(sent).toHaveLength(2);
});

test("祖先目录是软链（/x/link -> /x/real，root=/x/link/lend）：拒绝回收", async () => {
  const f = fixture();
  const dir = f.add("x", "acked");
  const { ports, sent } = fakePorts([proc(10, dir)]);
  const lines: string[] = [];
  const link = join(f.home, "..", `${f.home.split("/").pop()}-link`);
  symlinkSync(f.home, link);
  cleanups.push(() => rmSync(link));
  expect(await reapOrder("x", { root: join(link, "lend"), ports, log: (m) => lines.push(m) })).toBe(0);
  expect(await reapOrphans(f.db, { root: join(link, "lend"), ports, log: (m) => lines.push(m), now: NOW })).toBe(0);
  expect(sent).toEqual([]);
  expect(lines.every((l) => l.includes("软链"))).toBe(true);
});

test("兜底：node_modules 等任何子树里覆写已有文件也算新近写入，不回收", async () => {
  const f = fixture();
  const dir = f.add("old", "stopped");
  for (const sub of ["node_modules", join(".git", "objects")]) {
    mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, sub, "active.log"), "a");
  }
  age(dir);
  writeFileSync(join(dir, "node_modules", "active.log"), "b"); // 只改文件 mtime，父目录不变
  const { ports, sent } = fakePorts([proc(10, dir)]);
  expect(await reapOrphans(f.db, { root: f.root, ports, log: () => {}, now: NOW })).toBe(0);
  expect(sent).toEqual([]);
});

test("stopped 到期：回收批次与删除批次一致（库内顺序与停止时间相反、超过 5 张）", async () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) f.add(`s${i}`, "stopped", NOW - DAY - i); // s5 最早停，库里最后插入
  const h = harness();
  cleanups.push(() => h.db.close());
  h.lend.enabled = false;
  h.lend.lend = [];
  const reaped: string[] = [];
  const d = { ...h.d, db: f.db, now: () => NOW, reapOrder: async (id: string) => void (existsSync(orderDir(id, f.root)) && reaped.push(id)) };
  await lendTickWithRetention(d, () => {}, f.root);
  const deleted = [0, 1, 2, 3, 4, 5].map((i) => `s${i}`).filter((id) => !existsSync(orderDir(id, f.root)));
  expect(deleted).toHaveLength(5);
  expect(reaped.sort()).toEqual(deleted.sort());
});

test("兜底：journal 读不到整轮跳过，记一行原因", async () => {
  const f = fixture();
  const dir = f.add("old", "stopped");
  const { ports, sent } = fakePorts([proc(10, dir)]);
  const lines: string[] = [];
  f.db.close();
  expect(await reapOrphans(f.db, { root: f.root, ports, log: (m) => lines.push(m), now: NOW })).toBe(0);
  expect(sent).toEqual([]);
  expect(lines[0]).toContain("journal 读不到");
});

test("stopped 到期清理前先回收进程（目录还在时回收）；未到期的不碰", async () => {
  const f = fixture();
  f.add("due", "stopped", NOW - DAY);
  f.add("young", "stopped", NOW - DAY + 1);
  const h = harness();
  cleanups.push(() => h.db.close());
  h.lend.enabled = false;
  h.lend.lend = [];
  const seen: string[] = [];
  const d = { ...h.d, db: f.db, now: () => NOW, reapOrder: async (id: string) => void seen.push(`${id}:${existsSync(orderDir(id, f.root))}`) };
  await lendTickWithRetention(d, () => {}, f.root);
  expect(seen).toEqual(["due:true"]);
  expect(existsSync(orderDir("due", f.root))).toBe(false);
});

test("解析 ps / lsof：comm 带空格、etime 各种格式", () => {
  expect(parseEtime("05:03")).toBe(303);
  expect(parseEtime("02:05:03")).toBe(7503);
  expect(parseEtime("4-16:00:01")).toBe(4 * 86400 + 16 * 3600 + 1);
  expect(parseEtime("x")).toBeNull();
  expect(parsePs("  12   501  01:02 /Applications/A B.app/x\n")).toEqual(new Map([[12, { uid: 501, ageSec: 62, comm: "/Applications/A B.app/x" }]]));
  expect(parseLsofCwd("p12\nfcwd\nn/a b\np13\nfcwd\nn/\n")).toEqual(new Map([[12, "/a b"], [13, "/"]]));
});

test("真进程：cwd 在假单目录里的 sleep 被回收，测试不留进程", async () => {
  const f = fixture();
  const dir = f.add("real", "acked");
  const child = Bun.spawn(["sleep", "60"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
  cleanups.unshift(() => { try { child.kill("SIGKILL"); } catch { /* 已退出：没东西可收 */ } });
  const lines: string[] = [];
  let n = 0;
  for (let i = 0; i < 20 && n === 0; i++) { // lsof 偶尔要等子进程 chdir 落定
    n = await reapOrder("real", { root: f.root, ports: systemProcPorts(), log: (m) => lines.push(m), graceMs: 300 });
    if (n === 0) await Bun.sleep(100);
  }
  expect(n).toBe(1);
  expect(await child.exited).not.toBe(0);
  expect(lines[0]).toContain(`pid=${child.pid} 命令=sleep 单=real`);
});
