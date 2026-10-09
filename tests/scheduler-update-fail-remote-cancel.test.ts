/**
 * scheduler-update-fail-remote 的取消回收与双错误诊断负例。只复用 fixture，不 import 原 .test.ts（那会再登记原六条）。
 * 三层进程：本文件（驱动）→ 受控父进程（本文件以 CLAUDESTRA_UPDTEST_PROBE 角色跑，经 fixture.runChild 起两份子进程）
 * → 子进程（原入口）→ 后代：hold 角色是拒 TERM、持管道的后代（自己写 ready 回执）；detached 角色是普通 hex / plain 真走到 runBounded
 * 起的 detached gh 组（PATH 里的 gh 替身，写自己的启动回执后等着）。驱动只给自己起且回执核过身份的受控父发信号（只发 pid，不发组），
 * 从首个信号起用同一个 CLEANUP_MS 预算核：父退出、管道排空、UPDTEST-CANCEL 留证、每个 pid / 组真死、根已删；邻居进程 / 目录由驱动另起，
 * 必须活着且没收到信号。groups 回执读不出的负例在本进程直接调同步 / 异步回收：父进程自己记的组照收、根与持有保留、两处错误都可辨。
 * eperm 角色是真实退出下的回收失败：受控父只对自有子进程组注入 EPERM 再被驱动 SIGTERM，保留的根必须搬出 preload 即将删掉的测试临时根（keptAt），
 * 活着的子进程与后代由驱动按回执里的组收掉。
 * 时长：真实子进程用例硬截止 = 45s 进程截止 + 5s 回收（fixture 原预算，不加）；探针用例 = 20s 等回执 + 5s 回收 + 5s 余量。
 */
import { expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  assertChildPassed, awaitReceipts, CHILD_PROCESS_MS, ChildDeadline, ChildRunError, CLEANUP_MS, deadline, exitHookInstalled, GH_RECEIPT_PREFIX,
  ownedChildren, type Receipted, type Reclaimed, reclaimOwned, reclaimOwnedSync, runChild,
} from "./scheduler-update-fail-remote-fixture.ts";
import { testChildEnv } from "./test-env.ts";

const PROBE_ENV = "CLAUDESTRA_UPDTEST_PROBE";
type Role = "hold" | "collide" | "detached" | "eperm";
const PROBE = "UPDTEST-PROBE ";
const CANCEL = "UPDTEST-CANCEL ";
const REAP = "UPDTEST-REAP ";
const RECEIPT_MS = 20_000;
/** collide：子进程截止设短，让父进程的正常 reap（TERM → 1s 宽限 → KILL）正在进行时再收到取消 */
const COLLIDE_WAIT_MS = 6_000;
/** 持管道后代的截止探针：子进程起好、回执写出之后才到点 */
const HOLD_DEADLINE_MS = 6_000;
const CHILD_CASE_MS = CHILD_PROCESS_MS + CLEANUP_MS;
const PROBE_CASE_MS = RECEIPT_MS + CLEANUP_MS + 5_000;
const EXIT_CODE: Record<string, number> = { SIGTERM: 143, SIGINT: 130 };
const SENT = ["SIGKILL sent", "group already gone"];

const role = process.env[PROBE_ENV] as Role | undefined;
type Receipt = { pid: number; children: Receipted[] };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const outcomeOf = <T>(p: Promise<T>) => p.then(() => null as unknown, (e: unknown) => e);

/** 只认 ESRCH 是死了；EPERM 还是活的（别人的 pid） */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

/** 轮询真实状态（回执 / 进程死活），到 ms 没等到就带说明失败——不用裸 sleep 猜时机 */
async function until(check: () => boolean, ms: number, what: () => string): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`${what()}：${ms}ms 内没发生`);
    await Bun.sleep(50);
  }
}

function collect(stream: ReadableStream<Uint8Array>): { text: () => string; done: Promise<void> } {
  let buf = "";
  const done = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) buf += decoder.decode(chunk, { stream: true });
  })();
  return { text: () => buf, done };
}

const linesWith = (text: string, prefix: string) => text.split("\n").filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length));

async function waitForLine(src: { text: () => string }, prefix: string, ms: number): Promise<string[]> {
  await until(() => linesWith(src.text(), prefix).length > 0, ms, () => `等 ${prefix.trim()} 行`);
  return linesWith(src.text(), prefix);
}

if (role) {
  // 受控父进程：起两份子进程，回执齐了就把身份打到 stdout，然后等它们结束（只会被驱动的信号、hold 自身的预算或 gh 替身拖到的截止结束）
  const waitMs = role === "collide" ? COLLIDE_WAIT_MS : undefined;
  const hook = role === "detached" ? null : "hold";
  const runs = [runChild("hex", hook, undefined, waitMs), runChild("plain", hook, undefined, waitMs)];
  const children = await awaitReceipts(role === "detached" ? "detached" : "hold", 2, RECEIPT_MS);
  if (role === "eperm") injectGroupEperm(children.map((c) => c.pid)); // never restored: this process only ends by the driver's signal, nothing runs in it afterwards
  console.log(`${PROBE}${JSON.stringify({ pid: process.pid, children } satisfies Receipt)}`);
  const settled = await Promise.allSettled(runs);
  console.log(`UPDTEST-PROBE-DONE ${JSON.stringify(settled.map((s) => (s.status === "rejected" ? message(s.reason) : "ok")))}`);
}

/** 只对给定的本进程自有子进程组（负 pgid）注入 EPERM，其余 kill 照常；要不要 mockRestore 由调用方定 */
function injectGroupEperm(pids: number[]) {
  const realKill = process.kill;
  return spyOn(process, "kill").mockImplementation(((pid: number, sig?: string | number) => {
    if (!pids.includes(-pid)) return realKill.call(process, pid, sig);
    throw Object.assign(new Error(`kill EPERM (injected for group ${-pid})`), { code: "EPERM", syscall: "kill" });
  }) as typeof process.kill);
}

/** 驱动另起的邻居：同一驱动进程组里的无关进程 + 自己的目录；它会把收到的信号打出来 */
const NEIGHBOR_SCRIPT = "for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => console.log('signal ' + s)); console.log('up'); setInterval(() => {}, 1_000);";

function startNeighbor(base: string) {
  const dir = mkdtempSync(join(base, "neighbor-"));
  writeFileSync(join(dir, "keep"), "neighbor");
  const proc = Bun.spawn([process.execPath, "-e", NEIGHBOR_SCRIPT], { stdin: "ignore", stdout: "pipe", stderr: "inherit", env: testChildEnv() });
  return { dir, proc, out: collect(proc.stdout) };
}

/** gh 替身（exec 保持同一个 pid）：装好拒 TERM 的 handler 后写自己的启动回执到私有 HOME，然后等着被整组 KILL——原路径里它是 runBounded 起的 detached 组 */
const GH_STANDIN = `#!/bin/sh
exec ${JSON.stringify(process.execPath)} -e 'process.on("SIGTERM", () => {}); const fs = require("node:fs");
const file = process.env.HOME + "/${GH_RECEIPT_PREFIX}" + process.pid + ".json";
fs.writeFileSync(file + ".tmp", JSON.stringify({ pid: process.pid, ppid: process.ppid })); fs.renameSync(file + ".tmp", file); setInterval(() => {}, 1_000);'
`;

function ghStandinPath(base: string): string {
  const bin = join(base, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), GH_STANDIN);
  chmodSync(join(bin, "gh"), 0o755);
  return `${bin}:${process.env.PATH}`;
}

/** 回执里每个子进程的身份都对得上本次持有的 pid，才算真实启动；返回这次必须收掉的全部 pid */
function checkReceipt(receipt: Receipt, probeRole: Role, tmpReal: string): number[] {
  expect(receipt.children.map((c) => c.hook)).toEqual(probeRole === "detached" ? [null, null] : ["hold", "hold"]);
  for (const c of receipt.children) {
    expect(c.root.startsWith(`${tmpReal}/`)).toBe(true);
    if (probeRole === "detached") {
      expect(c.groups.length).toBeGreaterThan(0);
      expect(c.detached).toEqual(c.groups.map((pid) => ({ pid, ppid: c.pid })));
    } else {
      expect(c.hold!.pid).toBe(c.pid); // the receipt written by the child names the pid the parent owns
      expect(c.hold!.descendantReady).toEqual({ pid: c.hold!.descendant, ppid: c.pid }); // written by the descendant after its TERM handler is installed
    }
  }
  return receipt.children.flatMap((c) => [c.pid, ...(c.hold ? [c.hold.descendant] : []), ...c.groups]);
}

/** 起受控父进程（本文件的 probe 角色，私有 HOME / STATE / TMPDIR），等它的身份回执，发信号，在同一个回收预算内核留证与真实回收 */
async function cancelProbe(probeRole: Role, signals: ("SIGTERM" | "SIGINT")[]) {
  const base = mkdtempSync(join(tmpdir(), "updtest-cancel-"));
  const dirs = Object.fromEntries(["home", "state", "tmp"].map((name) => [name, join(base, name)]));
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  const neighbor = startNeighbor(base);
  const probe = Bun.spawn([process.execPath, "--no-env-file", "test", import.meta.path], {
    cwd: join(import.meta.dir, ".."), stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: testChildEnv({ HOME: dirs.home, CLAUDESTRA_STATE_DIR: dirs.state, TMPDIR: dirs.tmp, TMP: dirs.tmp, TEMP: dirs.tmp, [PROBE_ENV]: probeRole,
      ...(probeRole === "detached" ? { PATH: ghStandinPath(base) } : {}) }),
  });
  const out = collect(probe.stdout), err = collect(probe.stderr);
  let receipt: Receipt | undefined;
  try {
    await waitForLine(neighbor.out, "up", RECEIPT_MS);
    receipt = JSON.parse((await waitForLine(out, PROBE, RECEIPT_MS))[0]!) as Receipt;
    expect(receipt.pid).toBe(probe.pid);
    const pids = checkReceipt(receipt, probeRole, realpathSync(dirs.tmp));
    expect(pids.filter(alive)).toEqual(pids);
    if (probeRole === "collide") await waitForLine(err, REAP, COLLIDE_WAIT_MS + RECEIPT_MS);
    const signalledAt = performance.now();
    const left = () => Math.max(1, CLEANUP_MS - (performance.now() - signalledAt)); // one budget from the first signal to the last verified pid
    for (const sig of signals) {
      try { process.kill(probe.pid, sig); } catch (error) {
        // A repeated signal may land after the probe already exited on the first one; anything else is a real failure.
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    const code = await deadline(probe.exited, left());
    await deadline(Promise.all([out.done, err.done]), left());
    expect(code).toBe(EXIT_CODE[signals[0]!]);
    expect(probe.signalCode).toBeNull();
    const cancels = linesWith(err.text(), CANCEL).map((l) => JSON.parse(l) as { pid: number; code: number; reclaimed: Reclaimed[] });
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!).toMatchObject({ pid: probe.pid, code });
    const reclaimed = cancels[0]!.reclaimed;
    expect(reclaimed.map((r) => r.pid).sort()).toEqual(receipt.children.map((c) => c.pid).sort());
    if (probeRole === "eperm") {
      expectRetainedAtExit(reclaimed, receipt, probe.pid, realpathSync(dirs.tmp));
      expect(pids.filter(alive)).toEqual(pids); // the injected EPERM left child + descendant alive: exactly what the retained root is for
      for (const c of receipt.children) process.kill(-c.pid, "SIGKILL"); // only the groups named in the verified receipt; the probe itself has exited
    } else expectReclaimedAtExit(reclaimed, receipt);
    const all = [...new Set([...pids, ...reclaimed.flatMap((r) => r.groups.map((g) => g.pgid))])];
    await until(() => all.every((p) => !alive(p)), left(), () => `受控父退出后 owned pid 仍活着：${all.filter(alive).join(",")}`);
    const reclaimMs = performance.now() - signalledAt;
    for (const c of receipt.children) expect(existsSync(c.root)).toBe(false); // removed by the fixture, or (eperm) wiped by preload after the move-out
    expect(reclaimMs).toBeLessThan(CLEANUP_MS);
    expect(alive(neighbor.proc.pid)).toBe(true);
    expect(neighbor.out.text()).toBe("up\n");
    expect(existsSync(join(neighbor.dir, "keep"))).toBe(true);
    return { code, reclaimMs, reclaimed, stderr: err.text() };
  } finally {
    // Only the two pids this driver created plus (eperm) the groups named in the probe's verified receipt; all no-ops when already gone.
    probe.kill("SIGKILL");
    neighbor.proc.kill("SIGKILL");
    for (const c of probeRole === "eperm" ? receipt?.children ?? [] : []) {
      try { process.kill(-c.pid, "SIGKILL"); } catch (error) {
        // ESRCH = already collected on the success path; EPERM = a zombie awaiting init's reap. Anything else is a real failure.
        if (!["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code!)) throw error;
      }
    }
    await Promise.allSettled([probe.exited, neighbor.proc.exited]);
    rmSync(base, { recursive: true, force: true });
  }
}

/** 正常回收的真实退出：每个子进程自己的组 + 登记的 detached 组都发了信号、按 ps 核过死、根删掉、不再持有 */
function expectReclaimedAtExit(reclaimed: Reclaimed[], receipt: Receipt): void {
  for (const r of reclaimed) {
    const c = receipt.children.find((x) => x.pid === r.pid)!;
    expect(r.groups.map((g) => g.pgid)).toEqual([r.pid, ...c.groups]); // the child's own group, then every detached group it had registered
    expect(r.groups.map((g) => g.dead)).toEqual(r.groups.map(() => true)); // verified by ps inside the exit hook, not inferred from "SIGKILL sent"
    expect({ retained: r.retained, rootRemoved: r.rootRemoved, receipt: r.receipt, verify: r.verify, keptAt: r.keptAt, keepError: r.keepError })
      .toEqual({ retained: false, rootRemoved: true, receipt: undefined, verify: undefined, keptAt: undefined, keepError: undefined });
  }
}

/**
 * 信号发不出的真实退出：组没收、根不能删——但 preload 的 exit 清理随后会删整个测试临时根，所以 fixture 必须把根搬到它外面（同一父目录）
 * 并在报告里写 keptAt；原路径确实已不在，搬出去的目录里还是子进程写的 hold 回执。
 */
function expectRetainedAtExit(reclaimed: Reclaimed[], receipt: Receipt, probePid: number, tmpReal: string): void {
  for (const r of reclaimed) {
    const c = receipt.children.find((x) => x.pid === r.pid)!;
    expect(r).toMatchObject({ retained: true, rootRemoved: "kept: group signal failed", groups: [{ pgid: r.pid, kill: `error: kill EPERM (injected for group ${r.pid})` }] });
    expect(r.groups[0]).not.toHaveProperty("dead"); // a group whose signal failed is not verified, so it must not claim either way
    expect(r.keepError).toBeUndefined();
    expect(typeof r.keptAt).toBe("string");
    expect(r.keptAt!.startsWith(`${tmpReal}/`)).toBe(true); // moved to the parent of the probe's test tmp root, i.e. out of preload's wipe
    expect(basename(r.keptAt!)).toContain(`-${probePid}-`);
    expect(basename(r.keptAt!).endsWith(`-${basename(c.root)}`)).toBe(true);
    expect(existsSync(r.keptAt!)).toBe(true);
    expect(existsSync(dirname(c.root))).toBe(false); // the probe's preload tmp root itself is gone: preload's own exit cleanup ran untouched
    expect(JSON.parse(readFileSync(join(r.keptAt!, "home", "hold.json"), "utf8")).pid).toBe(c.pid); // same root, moved intact
  }
}

const noneOwned = () => ({ hook: exitHookInstalled(), owned: ownedChildren().length });

if (!role) {
  test("受控父进程收到 SIGTERM：两份 hold 子进程组及后代在回收预算内收掉，退出仍是 143，邻居无恙", async () => {
    const r = await cancelProbe("hold", ["SIGTERM"]);
    expect(r.code).toBe(143);
    expect(r.reclaimed.map((x) => x.groups.map((g) => g.kill))).toEqual([["SIGKILL sent"], ["SIGKILL sent"]]);
  }, PROBE_CASE_MS);

  test("受控父进程连收两次 SIGINT：每组只回收一次，退出 130", async () => {
    const r = await cancelProbe("hold", ["SIGINT", "SIGINT"]);
    expect(r.code).toBe(130);
    expect(r.reclaimed.map((x) => x.groups.map((g) => g.kill))).toEqual([["SIGKILL sent"], ["SIGKILL sent"]]);
    expect(linesWith(r.stderr, CANCEL)).toHaveLength(1);
  }, PROBE_CASE_MS);

  test("取消撞上正常 reap（TERM 宽限期内，后代拒 TERM）：组仍只收一次，无残留", async () => {
    const r = await cancelProbe("collide", ["SIGTERM"]);
    expect(r.code).toBe(143);
    // reap 已发过 TERM：子进程本体已退，拒 TERM 的后代还占着组；宽限期内撞上取消就是 KILL，晚于宽限期的 KILL 已由 reap 发出
    for (const g of r.reclaimed.flatMap((x) => x.groups)) expect(SENT).toContain(g.kill);
    expect(linesWith(r.stderr, REAP)).toHaveLength(2);
  }, PROBE_CASE_MS);

  test("原路径的 detached gh 组：普通 hex / plain 经 runBounded 起的 gh 替身在子进程被 KILL 后也按子进程登记的回执一起收掉", async () => {
    const r = await cancelProbe("detached", ["SIGTERM"]);
    expect(r.code).toBe(143);
    for (const x of r.reclaimed) {
      expect(x.groups.length).toBeGreaterThan(1); // the child's group plus at least one gh group it had registered
      for (const g of x.groups) expect(SENT).toContain(g.kill);
    }
  }, PROBE_CASE_MS);

  test("信号发不出（自有组注入 EPERM）时真实 SIGTERM 退出：根搬出测试临时根保住并写 keptAt，退出仍 143，活着的子进程与后代由驱动收", async () => {
    const r = await cancelProbe("eperm", ["SIGTERM"]);
    expect(r.code).toBe(143);
    expect(r.reclaimed.map((x) => [x.retained, typeof x.keptAt])).toEqual([[true, "string"], [true, "string"]]);
  }, PROBE_CASE_MS);

  test("同样的信号失败碰上 SIGINT 退出：根同样搬出保住，退出 130", async () => {
    const r = await cancelProbe("eperm", ["SIGINT"]);
    expect(r.code).toBe(130);
    expect(r.reclaimed.map((x) => [x.retained, typeof x.keptAt, x.keepError])).toEqual([[true, "string", undefined], [true, "string", undefined]]);
  }, PROBE_CASE_MS);

  test("持管道、拒 TERM 的后代：截止后 reap 升级 KILL；截止错误 + 注入的删根失败两份都列出，原错误在前", async () => {
    expect(noneOwned()).toEqual({ hook: false, owned: 0 });
    const run = runChild("hex", "hold", undefined, HOLD_DEADLINE_MS, { root: "injected root failure" });
    const outcome = outcomeOf(run);
    expect(ownedChildren().map((o) => o.hook)).toEqual(["hold"]);
    expect(exitHookInstalled()).toBe(true);
    const [receipt] = await awaitReceipts("hold", 1, HOLD_DEADLINE_MS);
    expect(receipt!.hold!.descendantReady).toEqual({ pid: receipt!.hold!.descendant, ppid: receipt!.pid });
    const pids = [receipt!.pid, receipt!.hold!.descendant];
    expect(pids.filter(alive)).toEqual(pids);
    const error = await outcome;
    expect(error).toBeInstanceOf(ChildRunError);
    const e = error as ChildRunError;
    expect(e.errors).toHaveLength(2);
    expect(e.errors[0]).toBeInstanceOf(ChildDeadline);
    expect(e.message).toContain(`[1] UPDTEST process deadline ${HOLD_DEADLINE_MS}ms exceeded；[2] injected root failure`);
    expect(e.result).toBeUndefined();
    expect(pids.filter(alive)).toEqual([]); // the group was confirmed empty before the root was removed
    expect(existsSync(receipt!.root)).toBe(false);
    expect(noneOwned()).toEqual({ hook: false, owned: 0 });
  }, CHILD_CASE_MS);

  test("信号发不出（注入 EPERM）：同步与异步回收都保留持有和临时根、不卸钩子，错误逐条可辨；修好后 reclaimOwned 在预算内收干净", async () => {
    expect(noneOwned()).toEqual({ hook: false, owned: 0 });
    const outcome = outcomeOf(runChild("hex", "hold", undefined, HOLD_DEADLINE_MS));
    const [receipt] = await awaitReceipts("hold", 1, HOLD_DEADLINE_MS);
    const pids = [receipt!.pid, receipt!.hold!.descendant];
    const realKill = process.kill;
    const spy = injectGroupEperm([receipt!.pid]);
    try {
      const sync = reclaimOwnedSync("injected");
      expect(sync).toEqual([{ pid: receipt!.pid, root: receipt!.root, mode: "hex", hook: "hold", rootRemoved: "kept: group signal failed", retained: true,
        groups: [{ pgid: receipt!.pid, kill: `error: kill EPERM (injected for group ${receipt!.pid})` }] }]);
      expect(existsSync(receipt!.root)).toBe(true);
      expect(ownedChildren().map((o) => o.pid)).toEqual([receipt!.pid]);
      expect(exitHookInstalled()).toBe(true);
      const error = await outcome;
      expect(error).toBeInstanceOf(ChildRunError);
      const e = error as ChildRunError;
      expect(e.errors[0]).toBeInstanceOf(ChildDeadline);
      expect(e.errors.map(message)).toEqual([`UPDTEST process deadline ${HOLD_DEADLINE_MS}ms exceeded`, `kill EPERM (injected for group ${receipt!.pid})`,
        `组 ${receipt!.pid} 没确认收干净：保留持有与临时根 ${receipt!.root}，由 exit 钩子或 reclaimOwned 再收`]);
      expect(pids.filter(alive)).toEqual(pids);
      expect(existsSync(receipt!.root)).toBe(true);
      expect(ownedChildren().map((o) => o.pid)).toEqual([receipt!.pid]);
      expect(exitHookInstalled()).toBe(true);
    } finally { spy.mockRestore(); }
    expect(process.kill).toBe(realKill);
    const start = performance.now();
    const reclaimed = await reclaimOwned();
    expect(performance.now() - start).toBeLessThan(CLEANUP_MS);
    expect(reclaimed.map((r) => ({ pid: r.pid, kill: r.groups.map((g) => g.kill), rootRemoved: r.rootRemoved, retained: r.retained })))
      .toEqual([{ pid: receipt!.pid, kill: ["SIGKILL sent"], rootRemoved: true, retained: false }]);
    expect(pids.filter(alive)).toEqual([]);
    expect(existsSync(receipt!.root)).toBe(false);
    expect(noneOwned()).toEqual({ hook: false, owned: 0 });
  }, CHILD_CASE_MS);

  test("groups 回执读不出（注入坏 JSON）：同步回收按父进程记的组补收 detached gh、保留根与持有；异步路径同样不删根；修好回执后 reclaimOwned 收干净", async () => {
    expect(noneOwned()).toEqual({ hook: false, owned: 0 });
    const base = mkdtempSync(join(tmpdir(), "updtest-receipt-"));
    const priorPath = process.env.PATH!;
    process.env.PATH = ghStandinPath(base);
    let outcome: Promise<unknown>;
    // launchChild copies PATH synchronously inside runChild, so only this one child sees the gh standin; restore before anything else runs.
    try { outcome = outcomeOf(runChild("hex", null)); } finally { process.env.PATH = priorPath; }
    let receipt: Receipted | undefined;
    try {
      [receipt] = await awaitReceipts("detached", 1, RECEIPT_MS);
      const pids = [receipt!.pid, ...receipt!.groups];
      expect(receipt!.groups.length).toBeGreaterThan(0);
      expect(pids.filter(alive)).toEqual(pids);
      const file = join(receipt!.root, "home", "groups.json");
      const good = readFileSync(file, "utf8");
      writeFileSync(file, "{broken");
      const sync = reclaimOwnedSync("injected-receipt");
      expect(sync).toEqual([{ pid: receipt!.pid, root: receipt!.root, mode: "hex", hook: null, retained: true, rootRemoved: "kept: groups receipt unreadable",
        receipt: expect.stringContaining("groups 回执读不出："),
        groups: [{ pgid: receipt!.pid, kill: "SIGKILL sent", dead: true }, ...receipt!.groups.map((pgid) => ({ pgid, kill: "SIGKILL sent", known: true as const, dead: true }))] }]);
      expect(existsSync(receipt!.root)).toBe(true);
      expect(ownedChildren().map((o) => o.pid)).toEqual([receipt!.pid]);
      expect(exitHookInstalled()).toBe(true);
      // The child was killed by the sync path; its own bounded path then hits the same unreadable receipt and must also keep root + ownership.
      const error = await outcome;
      expect(error).toBeInstanceOf(ChildRunError);
      const e = error as ChildRunError;
      expect(e.errors.map(message)).toEqual([expect.stringContaining("groups 回执读不出："),
        `组 ${receipt!.pid} 没确认收干净：保留持有与临时根 ${receipt!.root}，由 exit 钩子或 reclaimOwned 再收`]);
      expect(e.message).toContain(`[1] groups 回执读不出：`);
      expect(e.message).toContain(`；[2] 组 ${receipt!.pid} 没确认收干净`);
      expect(e.result?.code).not.toBe(0);
      expect(existsSync(receipt!.root)).toBe(true);
      expect(ownedChildren().map((o) => o.pid)).toEqual([receipt!.pid]);
      expect(exitHookInstalled()).toBe(true);
      await until(() => pids.every((p) => !alive(p)), CLEANUP_MS, () => `回收后 pid 仍在：${pids.filter(alive).join(",")}`);
      writeFileSync(file, good); // the receipt the parent had already verified once
      const start = performance.now();
      const reclaimed = await reclaimOwned();
      expect(performance.now() - start).toBeLessThan(CLEANUP_MS);
      expect(reclaimed.map((r) => ({ pid: r.pid, kill: r.groups.map((g) => g.kill), rootRemoved: r.rootRemoved, retained: r.retained })))
        .toEqual([{ pid: receipt!.pid, kill: pids.map(() => "group already gone"), rootRemoved: true, retained: false }]);
      expect(existsSync(receipt!.root)).toBe(false);
      expect(noneOwned()).toEqual({ hook: false, owned: 0 });
    } finally {
      // Only the detached groups this test recorded from a verified receipt; ESRCH = gone, EPERM = already a zombie awaiting init's reap.
      for (const pgid of receipt?.groups ?? []) {
        try { process.kill(-pgid, "SIGKILL"); } catch (error) { if (!["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code!)) throw error; }
      }
      rmSync(base, { recursive: true, force: true });
    }
  }, CHILD_CASE_MS);

  test("只有原错误（截止）：原样抛 ChildDeadline，不包一层", async () => {
    const error = await outcomeOf(runChild("hex", null, undefined, 100));
    expect(error).toBeInstanceOf(ChildDeadline);
    expect(message(error)).toBe("UPDTEST process deadline 100ms exceeded");
    expect(ownedChildren()).toEqual([]);
  }, CHILD_CASE_MS);

  test("只有清理失败（注入 reap 失败）：子进程本身通过仍判红，错误里带着子进程结果", async () => {
    const error = await outcomeOf(runChild("hex", null, undefined, undefined, { reap: "injected reap failure" }));
    expect(error).toBeInstanceOf(ChildRunError);
    const e = error as ChildRunError;
    expect(e.errors.map(message)).toEqual(["injected reap failure"]);
    expect(e.message).toContain("[1] injected reap failure；子进程结果 code=0 ran=1 pass=1 fail=0");
    expect(assertChildPassed({ ...e.result!, rootRemoved: !existsSync(e.result!.root) }).pid).toBeGreaterThan(0);
    expect(ownedChildren()).toEqual([]);
  }, CHILD_CASE_MS);

  test("原测试体错误（corrupt）+ reap 失败：子进程的 1 fail 与注入错误都可定位", async () => {
    const error = await outcomeOf(runChild("plain", "corrupt", undefined, undefined, { reap: "injected reap failure" }));
    expect(error).toBeInstanceOf(ChildRunError);
    const e = error as ChildRunError;
    expect(e.errors.map(message)).toEqual(["injected reap failure"]);
    expect(e.result).toMatchObject({ code: 1, ran: 1, pass: 0, fail: 1 });
    expect(e.message).toContain("子进程结果 code=1 ran=1 pass=0 fail=1");
    expect(e.message).toContain("(corrupted)");
    expect(() => assertChildPassed({ ...e.result!, rootRemoved: true })).toThrow(/1 fail（应为 0）/);
  }, CHILD_CASE_MS);

  test("正常路径：子进程自然退出后 owned 清空、exit 钩子卸下，结果照常通过", async () => {
    const before = process.listenerCount("exit");
    const run = runChild("secret", null);
    expect(process.listenerCount("exit")).toBe(before + 1);
    expect(ownedChildren().map((o) => o.mode)).toEqual(["secret"]);
    assertChildPassed(await run);
    expect(process.listenerCount("exit")).toBe(before);
    expect(noneOwned()).toEqual({ hook: false, owned: 0 });
  }, CHILD_CASE_MS);
}
