/**
 * scheduler-update-fail-remote 的取消回收与双错误诊断负例。只复用 fixture，不 import 原 .test.ts（那会再登记原六条）。
 * 三层进程：本文件（驱动）→ 受控父进程（本文件以 CLAUDESTRA_UPDTEST_PROBE 角色跑，经 fixture.runChild 起两份 hold 子进程）
 * → hold 子进程（原入口 + hold 钩子）→ 拒 TERM、持管道的后代。驱动只给自己起且回执核过身份的受控父发信号（只发 pid，不发组），
 * 看 UPDTEST-CANCEL 留证，再独立核 pid 真死；邻居进程 / 目录由驱动另起，必须活着且没收到信号。
 * 时长：真实子进程用例硬截止 = 45s 进程截止 + 5s 回收（fixture 原预算，不加）；探针用例 = 20s 等回执 + 5s 回收 + 5s 余量。
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertChildPassed, awaitHoldReceipts, CHILD_PROCESS_MS, ChildDeadline, ChildRunError, CLEANUP_MS, deadline, exitHookInstalled, type HoldReceipt,
  type Owned, ownedChildren, runChild,
} from "./scheduler-update-fail-remote-fixture.ts";
import { testChildEnv } from "./test-env.ts";

const PROBE_ENV = "CLAUDESTRA_UPDTEST_PROBE";
type Role = "hold" | "collide";
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

const role = process.env[PROBE_ENV] as Role | undefined;
type Receipt = { pid: number; children: (Owned & { hold: HoldReceipt })[] };
interface Reclaimed { pid: number; root: string; kill: string; rootRemoved: boolean | string }

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
  // 受控父进程：起两份 hold 子进程，回执齐了就把身份打到 stdout，然后等它们结束（hold 角色只会被驱动的信号或 hold 自身的预算结束）
  const waitMs = role === "collide" ? COLLIDE_WAIT_MS : undefined;
  const runs = [runChild("hex", "hold", undefined, waitMs), runChild("plain", "hold", undefined, waitMs)];
  const children = await awaitHoldReceipts(2, RECEIPT_MS);
  console.log(`${PROBE}${JSON.stringify({ pid: process.pid, children } satisfies Receipt)}`);
  const settled = await Promise.allSettled(runs);
  console.log(`UPDTEST-PROBE-DONE ${JSON.stringify(settled.map((s) => (s.status === "rejected" ? message(s.reason) : "ok")))}`);
}

/** 驱动另起的邻居：同一驱动进程组里的无关进程 + 自己的目录；它会把收到的信号打出来 */
const NEIGHBOR_SCRIPT = "for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => console.log('signal ' + s)); console.log('up'); setInterval(() => {}, 1_000);";

function startNeighbor(base: string) {
  const dir = mkdtempSync(join(base, "neighbor-"));
  writeFileSync(join(dir, "keep"), "neighbor");
  const proc = Bun.spawn([process.execPath, "-e", NEIGHBOR_SCRIPT], { stdin: "ignore", stdout: "pipe", stderr: "inherit", env: testChildEnv() });
  return { dir, proc, out: collect(proc.stdout) };
}

/** 起受控父进程（本文件的 probe 角色，私有 HOME / STATE / TMPDIR），等它的身份回执，发信号，核留证与真实回收 */
async function cancelProbe(probeRole: Role, signals: ("SIGTERM" | "SIGINT")[]) {
  const base = mkdtempSync(join(tmpdir(), "updtest-cancel-"));
  const dirs = Object.fromEntries(["home", "state", "tmp"].map((name) => [name, join(base, name)]));
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  const neighbor = startNeighbor(base);
  const probe = Bun.spawn([process.execPath, "--no-env-file", "test", import.meta.path], {
    cwd: join(import.meta.dir, ".."), stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: testChildEnv({ HOME: dirs.home, CLAUDESTRA_STATE_DIR: dirs.state, TMPDIR: dirs.tmp, TMP: dirs.tmp, TEMP: dirs.tmp, [PROBE_ENV]: probeRole }),
  });
  const out = collect(probe.stdout), err = collect(probe.stderr);
  try {
    await waitForLine(neighbor.out, "up", RECEIPT_MS);
    const receipt = JSON.parse((await waitForLine(out, PROBE, RECEIPT_MS))[0]!) as Receipt;
    expect(receipt.pid).toBe(probe.pid);
    expect(receipt.children.map((c) => c.hook)).toEqual(["hold", "hold"]);
    const tmpReal = realpathSync(dirs.tmp);
    for (const c of receipt.children) {
      expect(c.hold.pid).toBe(c.pid); // the receipt written by the child names the pid the parent owns
      expect(c.root.startsWith(`${tmpReal}/`)).toBe(true);
    }
    const pids = receipt.children.flatMap((c) => [c.pid, c.hold.descendant]);
    expect(pids.filter(alive)).toEqual(pids);
    if (probeRole === "collide") await waitForLine(err, REAP, COLLIDE_WAIT_MS + RECEIPT_MS);
    const signalledAt = performance.now();
    for (const sig of signals) {
      try { process.kill(probe.pid, sig); } catch (error) {
        // A repeated signal may land after the probe already exited on the first one; anything else is a real failure.
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    const code = await deadline(probe.exited, CLEANUP_MS);
    const exitedMs = performance.now() - signalledAt;
    await deadline(Promise.all([out.done, err.done]), CLEANUP_MS);
    expect(code).toBe(EXIT_CODE[signals[0]!]);
    expect(probe.signalCode).toBeNull();
    const cancels = linesWith(err.text(), CANCEL).map((l) => JSON.parse(l) as { pid: number; code: number; reclaimed: Reclaimed[] });
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!).toMatchObject({ pid: probe.pid, code });
    expect(cancels[0]!.reclaimed.map((r) => r.pid).sort()).toEqual(receipt.children.map((c) => c.pid).sort());
    for (const r of cancels[0]!.reclaimed) expect(r.rootRemoved).toBe(true);
    await until(() => pids.every((p) => !alive(p)), CLEANUP_MS, () => `受控父退出后 owned pid 仍活着：${pids.filter(alive).join(",")}`);
    for (const c of receipt.children) expect(existsSync(c.root)).toBe(false);
    expect(alive(neighbor.proc.pid)).toBe(true);
    expect(neighbor.out.text()).toBe("up\n");
    expect(existsSync(join(neighbor.dir, "keep"))).toBe(true);
    return { code, exitedMs, reclaimed: cancels[0]!.reclaimed, stderr: err.text() };
  } finally {
    // Only the two pids this driver created, never their groups; both are no-ops when they already exited.
    probe.kill("SIGKILL");
    neighbor.proc.kill("SIGKILL");
    await Promise.allSettled([probe.exited, neighbor.proc.exited]);
    rmSync(base, { recursive: true, force: true });
  }
}

if (!role) {
  test("受控父进程收到 SIGTERM：两份 hold 子进程组及后代在回收预算内收掉，退出仍是 143，邻居无恙", async () => {
    const r = await cancelProbe("hold", ["SIGTERM"]);
    expect(r.code).toBe(143);
    expect(r.exitedMs).toBeLessThan(CLEANUP_MS);
    expect(r.reclaimed.map((x) => x.kill)).toEqual(["SIGKILL sent", "SIGKILL sent"]);
  }, PROBE_CASE_MS);

  test("受控父进程连收两次 SIGINT：每组只回收一次，退出 130", async () => {
    const r = await cancelProbe("hold", ["SIGINT", "SIGINT"]);
    expect(r.code).toBe(130);
    expect(r.reclaimed.map((x) => x.kill)).toEqual(["SIGKILL sent", "SIGKILL sent"]);
    expect(linesWith(r.stderr, CANCEL)).toHaveLength(1);
  }, PROBE_CASE_MS);

  test("取消撞上正常 reap（TERM 宽限期内，后代拒 TERM）：组仍只收一次，无残留", async () => {
    const r = await cancelProbe("collide", ["SIGTERM"]);
    expect(r.code).toBe(143);
    // reap 已发过 TERM：子进程本体已退，拒 TERM 的后代还占着组；宽限期内撞上取消就是 KILL，晚于宽限期的 KILL 已由 reap 发出
    for (const x of r.reclaimed) expect(["SIGKILL sent", "group already gone"]).toContain(x.kill);
    expect(linesWith(r.stderr, REAP)).toHaveLength(2);
  }, PROBE_CASE_MS);

  test("持管道、拒 TERM 的后代：截止后 reap 升级 KILL；截止错误 + 注入的删根失败两份都列出，原错误在前", async () => {
    expect({ hook: exitHookInstalled(), owned: ownedChildren().length }).toEqual({ hook: false, owned: 0 });
    const run = runChild("hex", "hold", undefined, HOLD_DEADLINE_MS, { root: "injected root failure" });
    const outcome = outcomeOf(run);
    expect(ownedChildren().map((o) => o.hook)).toEqual(["hold"]);
    expect(exitHookInstalled()).toBe(true);
    const [receipt] = await awaitHoldReceipts(1, HOLD_DEADLINE_MS);
    const pids = [receipt!.pid, receipt!.hold.descendant];
    expect(pids.filter(alive)).toEqual(pids);
    const error = await outcome;
    expect(error).toBeInstanceOf(ChildRunError);
    const e = error as ChildRunError;
    expect(e.errors).toHaveLength(2);
    expect(e.errors[0]).toBeInstanceOf(ChildDeadline);
    expect(e.message).toContain(`[1] UPDTEST process deadline ${HOLD_DEADLINE_MS}ms exceeded；[2] injected root failure`);
    expect(e.result).toBeUndefined();
    await until(() => pids.every((p) => !alive(p)), CLEANUP_MS, () => `截止回收后仍活着：${pids.filter(alive).join(",")}`);
    expect(existsSync(receipt!.root)).toBe(false);
    expect({ hook: exitHookInstalled(), owned: ownedChildren().length }).toEqual({ hook: false, owned: 0 });
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
    expect({ hook: exitHookInstalled(), owned: ownedChildren().length }).toEqual({ hook: false, owned: 0 });
  }, CHILD_CASE_MS);
}
