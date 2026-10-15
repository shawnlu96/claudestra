/**
 * agents-PMJOB1 验收线 6：处理员并发上限 1、与 ask_codex 共用槽位合计不超过 3（持有者崩溃后能回收）、额度线 min(70, 项目线)、
 * 未知 / 过期读数不上模型；超时、落盘失败、额度异常都把原问题原路交给 PM。另：worker 启动入口、开关命令和只读统计。
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pmJob, PM_JOB_DEADLINE_MS } from "../src/bridge/pm-job.js";
import type { InventoryQuota } from "../src/lib/ai-quota.js";
import { buildCodexArgs, type CodexResult } from "../src/lib/codex.js";
import { getAsk } from "../src/lib/ledger-asks.js";
import { pmJobQuotaGate } from "../src/lib/pm-job-quota.js";
import { acquireCodexSlot, codexSlotsHeld, withCodexSlot } from "../src/lib/pm-job-slots.js";
import { pmJobWorkerTick } from "../src/lib/pm-job-spawn.js";
import { pmJobCmds, pmJobStats } from "../src/manager/pm-job-cmds.js";
import { pmJobWorkerMain } from "../src/manager/pm-job-worker.js";
import { A, ASKER, jobWorld, ORDER, P, type JobWorld } from "./pm-job-world.test.js";
import { askNoticeText } from "../src/lib/order-ask.js";

let w: JobWorld | undefined;
const dirs: string[] = [];
afterEach(() => { w?.close(); w = undefined; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "pm-job-slots-")); dirs.push(d); return d; };
const until = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); };
const NOW = 1_000_000;
const quota = (usedPct: number | null, o: Partial<InventoryQuota["windows"][number]> = {}, top: Partial<InventoryQuota> = {}): InventoryQuota => ({
  status: "known", source: "live", observedAt: NOW, plan: "pro", reason: null,
  windows: [{ id: "codex-weekly", kind: "weekly", usedPct, resetsAtMs: NOW + 3600_000, resetPassed: false, ...o }], ...top });
const gate = (q: InventoryQuota | Error, line = 85) => pmJobQuotaGate(P, async () => { if (q instanceof Error) throw q; return q; }, NOW, () => line);

// [验收线 6]
test("four jobs at once run one at a time, each exactly once, even with two workers", async () => {
  w = await jobWorld("on");
  for (let i = 0; i < 4; i++) await w.ask(`验收线 1 的行数上限是多少（第 ${i} 问）？`);
  expect(w.store.list().map((j) => j.state)).toEqual(["queued", "queued", "queued", "queued"]);
  let active = 0, peak = 0;
  const slow = async (): Promise<CodexResult> => {
    peak = Math.max(peak, ++active);
    expect(w!.store.list().filter((j) => j.state === "running")).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 15));
    active--;
    return { ok: true, message: "{}", sessionId: null, elapsedMs: 15 };
  };
  const done = await Promise.all([w.work(slow), w.work(slow), w.work(slow)]);
  expect(done.reduce((a, b) => a + b, 0)).toBe(4);
  expect(peak).toBe(1);
  expect(w.runs).toHaveLength(4);
  expect(new Set(w.runs.map((r) => r.prompt)).size).toBe(4);
  expect(w.store.list().every((j) => j.state === "drafted")).toBe(true);
});

// [验收线 6]
test("the worker shares the three Codex slots with ask_codex, waits when they are full, and a crashed holder's slot is reclaimed", async () => {
  const path = join(tmp(), "codex-slots.json"), dead = new Set<number>();
  let clock = NOW;
  const deps = (pid: number) => ({ path, now: () => clock, alive: (p: number) => !dead.has(p), pid });
  const a = await acquireCodexSlot("ask_codex", deps(101)), b = await acquireCodexSlot("ask_codex", deps(102));
  w = await jobWorld("on");
  const { askId } = await w.ask("验收线 1 的行数上限是多少？");
  const mine = () => acquireCodexSlot("pm-job", deps(200));
  let during = -1;
  expect(await w.work(async () => { during = (await codexSlotsHeld(deps(1)))!.length; return { ok: true, message: "{}", sessionId: null, elapsedMs: 1 }; },
    { slot: mine })).toBe(1); // 两路 ask_codex + 处理员 = 3
  expect(during).toBe(3);
  expect((await codexSlotsHeld(deps(1)))!.map((s) => s.owner)).toEqual(["ask_codex", "ask_codex"]); // 用完归还
  const c = await acquireCodexSlot("ask_codex", deps(103));
  expect(await acquireCodexSlot("ask_codex", deps(104))).toBeNull(); // 第四路不给
  expect(await withCodexSlot("ask_codex", async () => 1, deps(105))).toEqual({ ran: false });
  const second = await w.ask("src/lib/thing.ts 里 b 在哪一行？");
  expect(await w.work(undefined, { slot: mine })).toBe(0); // 槽位满：不跑，放回队列
  expect(w.runs).toHaveLength(1);
  expect(w.store.get(second.askId)).toMatchObject({ state: "queued" });
  expect(w.store.get(second.askId)?.lease).toBeUndefined();
  dead.add(101); // 持有者崩溃：没有归还，下次计数时回收
  expect(await w.work(undefined, { slot: mine })).toBe(1);
  expect(w.store.get(second.askId)?.state).toBe("drafted");
  clock += 16 * 60_000; // 过期的也回收，不会永久占住
  expect(await codexSlotsHeld(deps(1))).toEqual([]);
  await Promise.all([a, b, c].map((s) => s!.release()));
  expect(await withCodexSlot("ask_codex", async () => 7, deps(106))).toEqual({ ran: true, value: 7 });
  expect(w.store.get(askId)?.state).toBe("drafted");
});

// [验收线 6]
test("quota line is min(70, project line): 69 runs, 70 does not, a 60 project line stops at 60; unknown or stale readings never count as budget", async () => {
  expect(await gate(quota(69))).toEqual({ ok: true, line: 70, usedPct: 69 });
  expect(await gate(quota(70))).toMatchObject({ ok: false, kind: "over", reason: expect.stringContaining("70% 线") });
  expect(await gate(quota(84), 100)).toMatchObject({ ok: false, kind: "over" }); // 项目线更松也不超过 70
  expect(await gate(quota(59), 60)).toMatchObject({ ok: true, line: 60 });
  expect(await gate(quota(60), 60)).toMatchObject({ ok: false, kind: "over", reason: expect.stringContaining("60% 线") });
  const unknown: (InventoryQuota | Error)[] = [
    quota(null), quota(10, { resetPassed: true }), quota(10, { resetsAtMs: NOW - 1 }), quota(10, {}, { status: "unknown", reason: "没登录" }),
    { ...quota(10), windows: [] }, { ...quota(10), windows: [...quota(10).windows, ...quota(null, { id: "scoped", kind: "weekly_scoped" }).windows] },
    new Error("inventory 读不到"),
  ];
  for (const q of unknown) expect(await gate(q)).toMatchObject({ ok: false, kind: "unknown" });
  expect(await gate(quota(1, {}, { limitReached: true }))).toMatchObject({ ok: false, kind: "over" });
});

// [验收线 6]
test("timeout, quota over the line, unknown quota and a failed run all escalate the original to the PM without a direct answer", async () => {
  w = await jobWorld("on");
  const cases: [string, Parameters<JobWorld["work"]>, number, RegExp][] = [
    ["超时", [() => ({ ok: false, message: "Codex 超时(1s)被终止。", sessionId: null, elapsedMs: 1000 })], 1, /运行失败：Codex 超时/],
    ["运行抛错", [() => { throw new Error("spawn EACCES"); }], 1, /处理员出错：spawn EACCES/],
    ["额度到线", [undefined, { quota: () => gate(quota(70)) }], 0, /70% 线，处理员未启动/],
    ["额度未知", [undefined, { quota: () => gate(new Error("读不到")) }], 0, /额度读不到.*未启动/],
    ["额度核对抛错", [undefined, { quota: async () => { throw new Error("boom"); } }], 0, /额度核对出错/],
  ];
  for (const [label, args, runs, reason] of cases) {
    const q = `验收线 1 的行数上限是多少（${label}）？`, { askId } = await w.ask(q), before = { pm: w.pm.length, runs: w.runs.length };
    expect(await w.work(...args)).toBe(1);
    expect(w.runs.length - before.runs).toBe(runs); // 额度不够 / 不明不上模型
    await pmJob.sweep();
    expect(w.store.get(askId)).toMatchObject({ state: "escalated", note: expect.stringMatching(reason) });
    const got = w.pm.slice(before.pm);
    expect(got.map((m) => [m.to, m.id])).toEqual([[A, `ledger-ask:${askId}`]]);
    expect(got[0]!.content.startsWith(askNoticeText({ taskId: "T1", orderId: ORDER, from: ASKER, askId, question: q, options: [], class: "blocker" }))).toBe(true);
    expect(getAsk(w.f.db, askId)?.state).toBe("open");
  }
  expect(w.asker).toEqual([]);
});

// [验收线 6]
test("when the job cannot be persisted the original notice goes to the PM unchanged; a state file that stops taking writes still escalates once", async () => {
  w = await jobWorld("on");
  writeFileSync(w.store.dir, "不是目录"); // 状态目录建不出来
  const q = "验收线 1 的行数上限是多少？", { askId } = await w.ask(q);
  expect(w.pm).toEqual([{ to: A, id: `ledger-ask:${askId}`, content: askNoticeText({ taskId: "T1", orderId: ORDER, from: ASKER, askId, question: q, options: [], class: "blocker" }) }]);
  await expect(w.work()).rejects.toThrow(/EEXIST/); // worker 也写不了：不跑模型
  expect(w.runs).toEqual([]);
  rmSync(w.store.dir);
  // 接下了、之后状态写不进：过了时限原问题照样交 PM，一次
  const second = await w.ask("src/lib/thing.ts 里 b 在哪一行？");
  expect(w.pm).toHaveLength(1);
  const update = w.store.update.bind(w.store);
  w.store.update = async () => { throw new Error("EROFS"); };
  w.advance(PM_JOB_DEADLINE_MS);
  await pmJob.sweep();
  await pmJob.sweep();
  w.store.update = update;
  expect(w.pm.slice(1).map((m) => [m.to, m.id])).toEqual([[A, `ledger-ask:${second.askId}`]]);
  expect(w.asker).toEqual([]);
});

test("the scheduler-side tick spawns one detached worker only when a job is queued and none is running; the bridge never does", async () => {
  w = await jobWorld("on");
  const spawned: string[][] = [], tick = () => pmJobWorkerTick({ store: w!.store, now: w!.now, spawn: (argv) => void spawned.push(argv) });
  expect(tick()).toBe(false);
  const { askId } = await w.ask("验收线 1 的行数上限是多少？");
  await pmJob.sweep(); // bridge 扫单不起 worker、不跑模型
  expect(w.runs).toEqual([]);
  expect(tick()).toBe(true);
  expect(spawned).toHaveLength(1);
  expect(spawned[0]![1]).toMatch(/src\/manager\/pm-job-worker\.ts$/);
  void w.work(() => new Promise<CodexResult>(() => {}));
  await until(() => w!.store.get(askId)?.state === "running");
  expect(tick()).toBe(false); // 有一单在跑、租约还活着：不再起
  w.advance(120_000);
  await w.ask("src/lib/thing.ts 里 b 在哪一行？");
  expect(tick()).toBe(true); // 租约过期 + 有排队的：重启后不靠新流量也会再起
  expect(await pmJobWorkerMain(async () => 2)).toBe(0); // 进程入口：跑完退 0，出错退 1
  expect(await pmJobWorkerMain(async () => { throw new Error("状态目录写不了"); })).toBe(1);
});

test("pm-job-mode switches the project mode for the real PM only and bumps the generation; pm-job reports worker cost without bodies", async () => {
  w = await jobWorld(null);
  const cmds = pmJobCmds(w.store), denied: string[] = [];
  const cli = (mode: string, real: boolean) => ({ project: () => P, p: { pos: ["pm-job-mode", mode] }, deps: { now: w!.now },
    requireRealPm: (_: string, what: string) => { if (!real) { denied.push(what); throw new Error("不是真 PM"); } } }) as never;
  expect(w.store.mode(P)).toBe("observe");
  await expect(cmds["pm-job-mode"]!.run(cli("on", false))).rejects.toThrow("不是真 PM");
  await expect(cmds["pm-job-mode"]!.run(cli("maybe", true))).rejects.toThrow(/on \/ observe \/ off/);
  expect(await cmds["pm-job-mode"]!.run(cli("on", true))).toMatchObject({ ok: true, from: "observe", jobMode: "on", modeGen: 1 });
  expect(w.digest.mode(P)).toBe("on"); // PMDIG / PMROUTE 的开关原样
  expect(w.digest.routeMode(P)).toBe("observe");
  await w.digest.setRouteMode(P, "on");
  expect(w.store.mode(P)).toBe("on");
  const { askId } = await w.ask("验收线 1 的行数上限是多少？");
  w.advance(4000);
  await w.work();
  await pmJob.sweep();
  const stats = pmJobStats(w.store, P, w.now());
  expect(stats).toMatchObject({ mode: "on", modeGen: 1, jobs: 1, direct: 1, escalated: 0, failed: 0, byState: { sent: 1 },
    codex: { requests: 1, elapsedMs: 5 }, queueWaitMs: { avg: 4000, max: 4000 } });
  expect(JSON.stringify(stats)).not.toContain("行数上限");
  expect(await cmds["pm-job"]!.run(cli("", true))).toMatchObject({ ok: true, jobs: 1 });
  expect(w.store.get(askId)?.state).toBe("sent");
});

test("codex args: MCP isolation is opt-in; without it the arguments are unchanged", () => {
  const base = buildCodexArgs({ prompt: "p", cwd: "/repo" }, null, "/tmp/last.txt");
  expect(base).toEqual(["exec", "--json", "-o", "/tmp/last.txt", "-s", "read-only", "--skip-git-repo-check", "--color", "never", "-C", "/repo", "-"]);
  expect(buildCodexArgs({ prompt: "p", cwd: "/repo", isolateMcp: true }, null, "/tmp/last.txt")).toEqual([...base.slice(0, -1), "-c", "mcp_servers={}", "-"]);
});
