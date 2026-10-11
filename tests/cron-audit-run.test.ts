/**
 * hardening-CRONRUN1：cron 运行身份落盘，重启后恢复去重和监督。
 * 上半是 lib 级（合成台账 + 临时目录 + fake manager 端口，注入 ENOSPC / 读失败）；
 * 下半在子进程里跑真实入口 src/cron.ts（临时 HOME，PATH 里的 tmux / bun 是假的并记调用），碰不到真实状态。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { CronJob } from "../src/lib/cron-job";
import { createCronRunStore, cronRunKey, type CronRunRecord, type CronRunStore } from "../src/lib/cron-run-state";
import { runCronJobGuarded, runCronTempAgent, type CronExecDeps, type CronHistoryRow, type CronTempDeps } from "../src/lib/cron-run-state-exec";
import { guardedStopTempAgent, markLegacyRunningHistory, recoverCronRuns, type CronAgentRow, type CronRecoveryDeps } from "../src/lib/cron-run-recovery";
import { testChildEnv } from "./test-env.ts";

const SRC = join(import.meta.dir, "..", "src");
const MINUTE = 60_000;
const T0 = Date.parse("2026-10-11T08:00:00Z");
const enospc = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
const job = (id: string, extra: Partial<CronJob> = {}): CronJob => ({
  id, name: id, schedule: "* * * * *", prompt: "跑一次", dir: "/tmp", enabled: true, createdAt: "2026-01-01T00:00:00Z", ...extra,
});

let root = "";
let dir = "";
let seq = 0;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "cron-run-")); });
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => { dir = join(root, `case-${seq++}`); mkdirSync(dir); });
const runsPath = () => join(dir, "cron-runs.json");
const readRuns = () => (JSON.parse(readFileSync(runsPath(), "utf8")) as { runs: CronRunRecord[] }).runs;

/** 一个「daemon 实例」：自己的内存占位、自己的 owner，台账文件与别的实例共用 */
function instance(owner: string, over: Partial<CronExecDeps> = {}, store: CronRunStore = createCronRunStore(runsPath())) {
  const history: CronHistoryRow[] = [];
  const executed: string[] = [];
  const errors: string[] = [];
  const deps: CronExecDeps = {
    running: new Set(), liveKeys: new Set(), store, owner,
    maxRuntimeMs: () => 30 * MINUTE, deadlineSlackMs: MINUTE, reportChannel: () => undefined,
    appendHistory: async (e) => { history.push(e); },
    updateHistory: async (id, patch) => { Object.assign(history.find((h) => h.id === id) ?? {}, patch); },
    execute: async (j) => { executed.push(j.id); return { status: "success" }; },
    notifyFailure: async () => {}, touchLastRun: async () => {},
    log: () => {}, error: (m) => { errors.push(m); },
    ...over,
  };
  return { deps, history, executed, errors, run: (j: CronJob, at: number) => runCronJobGuarded(deps, j, new Date(at)) };
}

describe("[验收线 1] 初写失败不留内存占位，零派发", () => {
  test("appendHistory 抛 ENOSPC：这次不派发、台账记 error、占位释放；下一分钟照常跑", async () => {
    let fail = true;
    const d = instance("a");
    const append = d.deps.appendHistory;
    d.deps.appendHistory = async (e) => { if (fail) throw enospc(); await append(e); };
    expect(await d.run(job("j1"), T0)).toBe("failed");
    expect(d.executed).toEqual([]); // 外部 create / 发 prompt 一次都没有
    expect([...d.deps.running]).toEqual([]);
    expect([...d.deps.liveKeys]).toEqual([]);
    expect(readRuns().map((r) => [r.key, r.status, r.error])).toEqual([[cronRunKey("j1", T0 / MINUTE), "error", "ENOSPC: no space left on device, write"]]);
    fail = false;
    expect(await d.run(job("j1"), T0 + MINUTE)).toBe("ran");
    expect(d.executed).toEqual(["j1"]);
    expect(d.history.map((h) => h.status)).toEqual(["success"]);
  });

  test("台账认领写不进去（ENOSPC）/ 读坏 / 抢不到锁：零派发，占位释放，history 也不写", async () => {
    let mode: "write" | "ok" = "write";
    const store = createCronRunStore(runsPath(), { io: { write: async (p, data) => { if (mode === "write") throw enospc(); writeFileSync(p, JSON.stringify(data)); } } });
    const d = instance("a", {}, store);
    expect(await d.run(job("j1"), T0)).toBe("state-unavailable");
    expect([d.executed, d.history, [...d.deps.running]]).toEqual([[], [], []]);
    expect(existsSync(runsPath())).toBe(false);
    mode = "ok";
    expect(await d.run(job("j1"), T0)).toBe("ran"); // 上次没认领成，同一分钟还能认领

    writeFileSync(runsPath(), "{ 半截");
    expect(await d.run(job("j1"), T0 + MINUTE)).toBe("state-unavailable");
    expect(d.executed).toEqual(["j1"]);
    expect(readFileSync(runsPath(), "utf8")).toBe("{ 半截"); // 坏文件不覆盖
    rmSync(runsPath());

    mkdirSync(`${runsPath()}.lock`);
    writeFileSync(join(`${runsPath()}.lock`, "owner"), "别的进程");
    const locked = instance("b", {}, createCronRunStore(runsPath(), { lockWaitMs: 0 }));
    expect(await locked.run(job("j1"), T0 + 2 * MINUTE)).toBe("state-unavailable"); // 不降级放行
    expect([locked.executed, [...locked.deps.running]]).toEqual([[], []]);
  });

  test("执行抛错、收尾的 history / 台账 / lastRun 回写全失败：占位照样释放，下一次不被挡", async () => {
    const boom = async () => { throw enospc(); };
    const d = instance("a", { execute: async () => { throw new Error("目标 agent 不存在或未运行: agent-x"); }, updateHistory: boom, touchLastRun: boom, notifyFailure: boom });
    expect(await d.run(job("j1"), T0)).toBe("failed");
    expect([...d.deps.running]).toEqual([]);
    expect(readRuns()[0].status).toBe("error");
    expect(await d.run(job("j1"), T0 + MINUTE)).toBe("failed"); // 跑到了 execute，没被「上一次尚未完成」挡掉
    expect(readRuns().map((r) => r.status)).toEqual(["error", "error"]);
  });

  test("临时 agent：名字 / create 尝试落不进台账就不 create", async () => {
    let writes = 0;
    const store = createCronRunStore(runsPath(), { io: { write: async (p, data) => { if (++writes > 1) throw enospc(); writeFileSync(p, JSON.stringify(data)); } } });
    const t = tempDeps(store, []);
    const d = instance("a", { execute: (j, run) => runCronTempAgent(t.deps, j, run, 30 * MINUTE) }, store);
    expect(await d.run(job("j1"), T0)).toBe("failed");
    expect(t.calls).toEqual([]); // create、list、kill、send 都是零
    expect([...d.deps.running]).toEqual([]);
  });
});

describe("[验收线 2] 同一任务同一分钟只启动一次，换实例也一样", () => {
  test("第一个实例跑成功后，第二个实例同一分钟不再执行；下一分钟正常认领", async () => {
    const a = instance("a");
    const b = instance("b"); // 新 daemon：内存里什么都不记得
    expect(await a.run(job("j1"), T0 + 5_000)).toBe("ran");
    expect(readRuns()[0].status).toBe("success");
    expect(await b.run(job("j1"), T0 + 40_000)).toBe("duplicate");
    expect(b.executed).toEqual([]);
    expect(b.history).toEqual([]);
    expect(await b.run(job("j1"), T0 + MINUTE)).toBe("ran");
    expect(await b.run(job("j2"), T0 + 40_000)).toBe("ran"); // 别的任务不受影响
    expect(readRuns().map((r) => [r.key, r.owner])).toEqual([["j1@" + T0 / MINUTE, "a"], ["j1@" + (T0 / MINUTE + 1), "b"], ["j2@" + T0 / MINUTE, "b"]]);
  });

  test("未结 / 结果未知的记录不盲目重发：同一分钟拒绝，下一分钟照常", async () => {
    for (const status of ["running", "unknown", "error", "timeout"] as const) {
      rmSync(runsPath(), { force: true });
      const seeded = createCronRunStore(runsPath());
      await seeded.claim({ jobId: "j1", jobName: "j1", epochMinute: T0 / MINUTE, historyId: "h-old", owner: "dead", startedAt: "s", deadlineAt: "d" });
      if (status !== "running") await seeded.update(cronRunKey("j1", T0 / MINUTE), (r) => { r.status = status; });
      const b = instance("b");
      expect([status, await b.run(job("j1"), T0 + 30_000)]).toEqual([status, "duplicate"]);
      expect(b.executed).toEqual([]);
      expect(readRuns()[0].status).toBe(status); // 原记录原样
      expect([status, await b.run(job("j1"), T0 + MINUTE)]).toEqual([status, "ran"]);
    }
  });

  test("两个实例并发抢同一分钟：只有一个启动", async () => {
    const all = Array.from({ length: 6 }, (_, i) => instance(`d${i}`));
    const results = await Promise.all(all.map((d) => d.run(job("j1"), T0)));
    expect(results.filter((r) => r === "ran").length).toBe(1);
    expect(results.filter((r) => r === "duplicate").length).toBe(5);
    expect(all.flatMap((d) => d.executed)).toEqual(["j1"]);
    expect(readRuns().length).toBe(1);
  });

  test("结束的记录只留最近若干条，没结束的一条不丢", async () => {
    const store = createCronRunStore(runsPath(), { keepFinished: 2 });
    for (let i = 0; i < 5; i++) {
      await store.claim({ jobId: "j", jobName: "j", epochMinute: i, historyId: `h${i}`, owner: "a", startedAt: "s", deadlineAt: "d" });
      if (i !== 1) await store.update(cronRunKey("j", i), (r) => { r.status = "success"; });
    }
    await store.claim({ jobId: "j", jobName: "j", epochMinute: 9, historyId: "h9", owner: "a", startedAt: "s", deadlineAt: "d" });
    expect(readRuns().map((r) => [r.epochMinute, r.status])).toEqual([[1, "running"], [3, "success"], [4, "success"], [9, "running"]]);
  });
});

/** fake manager 端口：agents 是「现在在跑的 agent」，calls 记每一次外部动作 */
function fakeAgents(agents: CronAgentRow[]) {
  const calls: string[] = [];
  const state = { agents, listError: "", killError: "", idle: false };
  const ports = {
    listAgents: async () => { calls.push("list"); if (state.listError) throw new Error(state.listError); return state.agents; },
    killAgent: async (name: string) => {
      calls.push(`kill ${name}`);
      if (state.killError) return state.killError;
      state.agents = state.agents.filter((a) => a.name !== `agent-${name}`);
      return null;
    },
    isIdle: async (name: string) => { calls.push(`idle ${name}`); return state.idle; },
  };
  return { ports, calls, state, kills: () => calls.filter((c) => c.startsWith("kill")) };
}

function tempDeps(store: CronRunStore, agents: CronAgentRow[], created: { ok: boolean; sessionId?: string; error?: string } = { ok: true, sessionId: "S1" }) {
  const f = fakeAgents(agents);
  let clock = T0;
  const notices: string[] = [];
  const deps: CronTempDeps = {
    store, agents: f.ports,
    create: async (name) => { f.calls.push("create"); if (created.ok) f.state.agents.push({ name: `agent-${name}`, sessionId: created.sessionId }); return created; },
    sendPrompt: async () => { f.calls.push("send"); },
    summary: async () => "",
    notify: async (t) => { notices.push(t); },
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    log: () => {}, error: () => {},
    timing: { readyMs: 3000, coldStartMs: 15_000, pollMs: 10_000, cleanupDelayMs: 2000 },
  };
  return { deps, notices, ...f };
}

async function seedRun(store: CronRunStore, over: Partial<CronRunRecord> & { temp?: CronRunRecord["temp"] } = {}, minute = T0 / MINUTE) {
  const claim = await store.claim({
    jobId: "j1", jobName: "j1", epochMinute: minute, historyId: `h${minute}`, owner: "dead-daemon",
    startedAt: new Date(T0).toISOString(), deadlineAt: new Date(T0 + 30 * MINUTE).toISOString(),
  });
  if (!claim.claimed) throw new Error("seed 没认领上");
  await store.update(claim.record.key, (r) => { Object.assign(r, over); });
  return claim.record.key;
}
const tempOf = (agentName: string, over: Partial<NonNullable<CronRunRecord["temp"]>> = {}) => ({
  agentName, createAttemptedAt: new Date(T0).toISOString(), sessionId: "S1", confirmedAt: new Date(T0 + 1000).toISOString(),
  promptAttemptedAt: new Date(T0 + 4000).toISOString(), supervision: "supervising" as const, ...over,
});

function recovery(store: CronRunStore, agents: CronAgentRow[]) {
  const f = fakeAgents(agents);
  const notices: string[] = [];
  const history: { id: string; status: string }[] = [];
  const logs: string[] = [];
  const clock = { now: T0 + 5 * MINUTE };
  const deps: CronRecoveryDeps = {
    store, agents: f.ports, owner: "new-daemon", liveKeys: new Set(), now: () => clock.now, ownerAlive: () => false,
    finishHistory: async (id, patch) => { history.push({ id, status: patch.status }); },
    notify: async (_r, text) => { notices.push(text); },
    log: (m) => { logs.push(m); }, idleStreaks: new Map(), createSettleMs: 330_000, ownerGraceMs: 2 * MINUTE,
  };
  return { deps, notices, history, logs, clock, ...f, pass: () => recoverCronRuns(deps) };
}

describe("[验收线 3] 重启后接着监督，到期只收原会话", () => {
  test("截止时间没到：继续监督，不停；连续两轮空闲才算完成，只停原会话一次，完成后清理", async () => {
    const store = createCronRunStore(runsPath());
    const key = await seedRun(store, { temp: tempOf("cron-j1-abc") });
    const r = recovery(store, [{ name: "agent-cron-j1-abc", sessionId: "S1" }, { name: "agent-keep", sessionId: "K" }]);
    await r.pass();
    await r.pass();
    expect(r.kills()).toEqual([]); // 还在忙
    expect(readRuns()[0].status).toBe("running");
    r.state.idle = true;
    await r.pass();
    expect([r.kills(), readRuns()[0].status]).toEqual([[], "running"]); // 只空闲了一轮
    await r.pass();
    expect(r.kills()).toEqual(["kill cron-j1-abc"]);
    expect(readRuns().map((x) => [x.key, x.status, x.temp?.supervision])).toEqual([[key, "success", "cleaned"]]);
    expect(r.history).toEqual([{ id: `h${T0 / MINUTE}`, status: "success" }]);
    expect(r.state.agents).toEqual([{ name: "agent-keep", sessionId: "K" }]);
    const before = r.calls.length;
    expect(await r.pass()).toEqual({ scanned: 0, failed: 0 }); // 清理完就不再扫它
    expect(r.calls.length).toBe(before);
    expect(r.notices.length).toBe(1);
  });

  test("到期：记 timeout，只收原会话；kill 失败留 cleanup-pending，下一轮重试成功", async () => {
    const store = createCronRunStore(runsPath());
    await seedRun(store, { temp: tempOf("cron-j1-abc") });
    const r = recovery(store, [{ name: "agent-cron-j1-abc", sessionId: "S1" }]);
    r.clock.now = T0 + 31 * MINUTE;
    r.state.killError = "tmux 没响应";
    await r.pass();
    expect(readRuns().map((x) => [x.status, x.temp?.supervision, x.temp?.cleanupError])).toEqual([["timeout", "cleanup-pending", "tmux 没响应"]]);
    await r.pass();
    expect(r.notices.length).toBe(2); // 超时一条、清理失败一条；重试失败不再刷
    r.state.killError = "";
    await r.pass();
    expect(readRuns().map((x) => [x.status, x.temp?.supervision])).toEqual([["timeout", "cleaned"]]);
    expect(r.kills()).toEqual(Array(3).fill("kill cron-j1-abc"));
    expect(r.history).toEqual([{ id: `h${T0 / MINUTE}`, status: "timeout" }]); // 结果只定一次
  });

  test("同名 agent 换了会话：一个都不停，标待核，通知一次", async () => {
    const store = createCronRunStore(runsPath());
    await seedRun(store, { temp: tempOf("cron-j1-abc") });
    const r = recovery(store, [{ name: "agent-cron-j1-abc", sessionId: "S2-新会话" }]);
    r.clock.now = T0 + 31 * MINUTE; // 就算到期也不停
    await r.pass();
    await r.pass();
    expect(r.kills()).toEqual([]);
    expect(readRuns().map((x) => [x.status, x.temp?.supervision])).toEqual([["unknown", "needs-review"]]);
    expect(r.notices.length).toBe(1);
    expect(r.state.agents.length).toBe(1);
  });

  test("结果已定、待清理时同名 agent 换了会话：不停新会话", async () => {
    const store = createCronRunStore(runsPath());
    await seedRun(store, { status: "success", temp: tempOf("cron-j1-abc", { supervision: "cleanup-pending" }) });
    const r = recovery(store, [{ name: "agent-cron-j1-abc", sessionId: "S2" }]);
    await r.pass();
    await r.pass();
    expect(r.kills()).toEqual([]);
    expect(readRuns().map((x) => [x.status, x.temp?.supervision])).toEqual([["success", "needs-review"]]);
    expect(r.notices.length).toBe(1);
  });

  test("缺身份（create 发过、会话没确认）：只核身份，不停、不重建；create 预算没过先不判", async () => {
    const store = createCronRunStore(runsPath());
    await seedRun(store, { temp: tempOf("cron-j1-abc", { sessionId: undefined, confirmedAt: undefined, promptAttemptedAt: undefined, supervision: "create-attempted" }) });
    await seedRun(store, { temp: tempOf("cron-j1-gone", { sessionId: undefined, supervision: "create-attempted" }) }, T0 / MINUTE + 1);
    const r = recovery(store, [{ name: "agent-cron-j1-abc", sessionId: "S9" }]);
    r.clock.now = T0 + 2 * MINUTE;
    await r.pass();
    expect(r.calls).toEqual([]); // create 可能还在跑
    r.clock.now = T0 + 6 * MINUTE;
    await r.pass();
    await r.pass();
    expect(r.calls).toEqual(["list"]); // 没有 kill，端口里也根本没有 create
    expect(readRuns().map((x) => [x.status, x.temp?.supervision])).toEqual([["unknown", "needs-review"], ["error", "cleaned"]]);
    expect(r.notices.length).toBe(2);
    expect(r.state.agents).toEqual([{ name: "agent-cron-j1-abc", sessionId: "S9" }]);
  });

  test("读失败：台账读不出 / agent 列表查不到，都不停任何对象，记录留着下一轮重试", async () => {
    let readFails = true;
    const base = createCronRunStore(runsPath());
    await seedRun(base, { temp: tempOf("cron-j1-abc") });
    const read = async (p: string) => {
      if (readFails) throw new Error("EIO: i/o error, read");
      return { status: "ok" as const, data: JSON.parse(readFileSync(p, "utf8")) };
    };
    const store = createCronRunStore(runsPath(), { io: { read } });
    const r = recovery(store, [{ name: "agent-cron-j1-abc", sessionId: "S1" }]);
    r.clock.now = T0 + 31 * MINUTE;
    expect((await r.pass()).readError).toContain("EIO");
    expect(r.calls).toEqual([]);
    readFails = false;
    r.state.listError = "manager list 失败: 超时";
    expect(await r.pass()).toEqual({ scanned: 1, failed: 1 });
    expect(r.kills()).toEqual([]);
    expect((await base.list())[0].status).toBe("running");
    r.state.listError = "";
    await r.pass();
    expect(r.kills()).toEqual(["kill cron-j1-abc"]);
    expect(readRuns()[0].status).toBe("timeout");
  });

  test("guardedStopTempAgent：没身份 / 查不到 / 不在 / 会话不符都不发 kill", async () => {
    const f = fakeAgents([{ name: "agent-x", sessionId: "S1" }, { name: "agent-x-2", sessionId: "S1" }]);
    expect((await guardedStopTempAgent(f.ports, "x", undefined)).kind).toBe("no-identity");
    expect((await guardedStopTempAgent(f.ports, "x", "S0")).kind).toBe("session-changed");
    expect((await guardedStopTempAgent(f.ports, "y", "S1")).kind).toBe("gone");
    f.state.listError = "挂了";
    expect((await guardedStopTempAgent(f.ports, "x", "S1")).kind).toBe("failed");
    expect(f.kills()).toEqual([]);
    f.state.listError = "";
    expect((await guardedStopTempAgent(f.ports, "x", "S1")).kind).toBe("stopped");
    expect(f.state.agents).toEqual([{ name: "agent-x-2", sessionId: "S1" }]);
  });

  test("没建临时 agent 的未结记录：只定结果、通知一次，不重发；本实例在跑的和别的活实例的不碰", async () => {
    const store = createCronRunStore(runsPath());
    await seedRun(store, { dispatchAttemptedAt: "x" }, 1);
    await seedRun(store, {}, 2);
    await seedRun(store, { owner: "alive-daemon", temp: tempOf("cron-other") }, 3);
    await seedRun(store, { owner: "new-daemon" }, 4);
    const r = recovery(store, []);
    r.deps.ownerAlive = (o) => o === "alive-daemon";
    (r.deps.liveKeys as Set<string>).add(cronRunKey("j1", 4));
    await r.pass();
    await r.pass();
    expect(readRuns().map((x) => x.status)).toEqual(["unknown", "error", "running", "running"]);
    expect(r.calls).toEqual([]);
    expect(r.notices.length).toBe(2);
    r.clock.now = T0 + 33 * MINUTE; // 那个实例过了截止时间加宽限还没收：接手，agent 已不在
    await r.pass();
    expect(readRuns().map((x) => x.status)).toEqual(["unknown", "error", "unknown", "running"]);
  });

  test("执行路径：只收 create 返回的那个会话；同名换了会话 / create 失败都不按名字停", async () => {
    const store = createCronRunStore(runsPath());
    const run = (minute: number) => seedRun(store, {}, minute).then((key) => ({ key, historyId: "h" }));
    const ok = tempDeps(store, []);
    ok.state.idle = true;
    expect(await runCronTempAgent(ok.deps, job("j1"), await run(1), 30 * MINUTE)).toEqual({ status: "success" });
    expect(ok.calls.filter((c) => !c.startsWith("idle"))).toEqual(["create", "send", "list", expect.stringMatching(/^kill cron-j1-/)]);
    expect(readRuns()[0].temp).toMatchObject({ sessionId: "S1", supervision: "cleaned" });
    expect(readRuns()[0].status).toBe("success");

    const swapped = tempDeps(store, []);
    swapped.state.idle = true;
    swapped.deps.sendPrompt = async () => { swapped.state.agents.forEach((a) => { a.sessionId = "S2"; }); };
    await runCronTempAgent(swapped.deps, job("j1"), await run(2), 30 * MINUTE);
    expect(swapped.kills()).toEqual([]);
    expect(readRuns()[1].temp?.supervision).toBe("needs-review");
    expect(swapped.notices.some((n) => n.includes("清理失败"))).toBe(true);

    const failed = tempDeps(store, [], { ok: false, error: "manager create 超时（>300s）已强杀" });
    await expect(runCronTempAgent(failed.deps, job("j1"), await run(3), 30 * MINUTE)).rejects.toThrow("创建 agent 失败");
    expect(failed.calls).toEqual(["create"]); // 没有身份：不 list、不 kill，留给恢复扫描核
    expect(readRuns()[2].temp).toMatchObject({ supervision: "create-attempted" });
    expect(readRuns()[2].temp?.sessionId).toBeUndefined();
  });

  test("旧的无身份 running 历史：标待核，只标一次，有台账记录的不动", async () => {
    const store = createCronRunStore(runsPath());
    await seedRun(store, {}, 7);
    const history = [
      { id: "old-1", jobName: "nightly", status: "running" },
      { id: "h7", jobName: "j1", status: "running" },
      { id: "old-2", jobName: "nightly", status: "success" },
    ];
    const marked = markLegacyRunningHistory(history, await store.list(), "2026-10-11T09:00:00Z");
    expect(marked.map((h) => h.id)).toEqual(["old-1"]);
    expect(history.map((h) => h.status)).toEqual(["unknown", "running", "success"]);
    expect(markLegacyRunningHistory(history, await store.list(), "x")).toEqual([]);
  });
});

describe("真实入口 src/cron.ts（子进程，临时 HOME，假 tmux / bun）", () => {
  let home = "";
  let env: Record<string, string> = {};
  const state = (n: string) => join(home, ".claude-orchestrator", n);
  const text = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const historyRows = () => (text(state("cron-history.json")) ? JSON.parse(text(state("cron-history.json"))) : []) as { jobName: string; status: string }[];
  const fire = (name: string, body: string) => {
    const script = join(home, name);
    writeFileSync(script, `const cron = await import(${JSON.stringify(join(SRC, "cron.ts"))});\n${body}\n`);
    return Bun.spawnSync([process.execPath, script], { env, stdout: "pipe", stderr: "pipe" });
  };

  beforeEach(() => {
    home = join(dir, "home");
    const bin = join(home, "fakebin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(home, ".claude-orchestrator"));
    writeFileSync(join(bin, "tmux"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(home, "tmux.log")}'\nexit 1\n`, { mode: 0o755 });
    // 假 manager：list 回放 list.json，kill 说成功，其余（create）说失败；每次调用记一行
    const answers = `case "$*" in\n  *" list") cat '${join(home, "list.json")}' ;;\n  *" kill "*) echo '{"ok":true}' ;;\n  *) echo '{"ok":false,"error":"fake"}' ;;\nesac\n`;
    writeFileSync(join(bin, "bun"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(home, "bun.log")}'\n${answers}`, { mode: 0o755 });
    writeFileSync(join(home, "list.json"), JSON.stringify({ ok: true, agents: [] }));
    env = testChildEnv({ PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: home, CLAUDESTRA_RUNTIME_DIR: join(home, "rt"), CONTROL_CHANNEL_ID: "", LANG: "C" });
  });

  test("[验收线 1] history 初写失败后，下一次触发不被 runningJobs 挡住；失败那次没有 create", () => {
    mkdirSync(join(state("cron-history.json"), "占位"), { recursive: true }); // history 路径是个非空目录：初写的 rename 必然失败
    const j = job("init-fail");
    const r = fire("init.ts", `
      const { rmSync, existsSync, readFileSync } = await import("fs");
      const j = ${JSON.stringify(j)};
      await cron.executeJob(j, new Date(${T0})).catch(() => {});
      const log = ${JSON.stringify(join(home, "bun.log"))};
      const createsAfterFailure = existsSync(log) ? readFileSync(log, "utf8").split("\\n").filter((l) => l.includes(" create ")).length : 0;
      rmSync(${JSON.stringify(state("cron-history.json"))}, { recursive: true });
      await cron.executeJob(j, new Date(${T0 + MINUTE})).catch(() => {});
      console.log("CREATES_AFTER_FAILURE=" + createsAfterFailure);`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("CREATES_AFTER_FAILURE=0");
    expect(r.stdout.toString()).not.toContain("上一次执行尚未完成"); // 旧实现：runningJobs 残留，第二次在这里被跳过
    expect(historyRows().map((h) => [h.jobName, h.status])).toEqual([["init-fail", "error"]]); // 第二次真的跑到了 create（假 manager 说失败）
    expect(text(join(home, "bun.log")).split("\n").filter((l) => l.includes(" create ")).length).toBe(1);
  });

  test("[验收线 2] 第二个 daemon 实例同一分钟不重复执行（lastRun 已推进）；下一分钟照常", () => {
    const j = job("twice", { targetAgent: "cc" });
    writeFileSync(state("cron.json"), JSON.stringify([j]));
    const once = (at: number) => fire("twice.ts", `await cron.executeJob(${JSON.stringify(j)}, new Date(${at}));`);
    expect(once(T0 + 5_000).exitCode).toBe(0);
    expect(JSON.parse(text(state("cron.json")))[0].lastRun).toBeDefined();
    expect(once(T0 + 40_000).exitCode).toBe(0); // 另一个进程 = 重启后的 daemon
    expect(historyRows().length).toBe(1); // 旧实现：这里是 2
    expect(text(join(home, "tmux.log")).split("\n").filter((l) => l.includes("list-panes")).length).toBe(1);
    expect(once(T0 + MINUTE).exitCode).toBe(0);
    expect(historyRows().length).toBe(2);
  });

  test("[验收线 3] 重启记录里的临时 agent 到期：只停原会话；同名换了会话的、别的 agent 都不停", () => {
    const rec = (minute: number, agentName: string): CronRunRecord => ({
      key: cronRunKey("nightly", minute), jobId: "nightly", jobName: "nightly", epochMinute: minute, historyId: `h${minute}`, owner: "999999.old.daemon",
      startedAt: new Date(Date.now() - 50 * MINUTE).toISOString(), deadlineAt: new Date(Date.now() - 10 * MINUTE).toISOString(), status: "running",
      temp: { ...tempOf(agentName), createAttemptedAt: new Date(Date.now() - 50 * MINUTE).toISOString() },
    });
    writeFileSync(state("cron-runs.json"), JSON.stringify({ version: 1, runs: [rec(1, "cron-nightly-orig"), rec(2, "cron-nightly-swapped")] }));
    writeFileSync(state("cron-history.json"), JSON.stringify([{ id: "h1", jobId: "nightly", jobName: "nightly", startedAt: "s", status: "running" }]));
    writeFileSync(join(home, "list.json"), JSON.stringify({ ok: true, agents: [
      { name: "agent-cron-nightly-orig", sessionId: "S1" }, { name: "agent-cron-nightly-swapped", sessionId: "S2" }, { name: "agent-cc", sessionId: "S1" },
    ] }));
    const r = fire("recover.ts", `
      if (typeof cron.recoverCronRunsOnce !== "function") { console.log("NO_RECOVERY"); process.exit(0); }
      console.log("RECOVERED=" + JSON.stringify(await cron.recoverCronRunsOnce()));`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).not.toContain("NO_RECOVERY"); // 旧实现：启动后没有任何恢复监督
    expect(r.stdout.toString()).toContain('RECOVERED={"scanned":2,"failed":0}');
    const kills = text(join(home, "bun.log")).split("\n").filter((l) => l.includes(" kill ")).map((l) => l.replace(/.* kill /, ""));
    expect(kills).toEqual(["cron-nightly-orig"]);
    const runs = (JSON.parse(text(state("cron-runs.json"))) as { runs: CronRunRecord[] }).runs;
    expect(runs.map((x) => [x.status, x.temp?.supervision])).toEqual([["timeout", "cleaned"], ["unknown", "needs-review"]]);
    expect(historyRows().map((h) => h.status)).toEqual(["timeout"]);
    expect(text(join(home, "bun.log"))).not.toContain(" create ");
  });
});
