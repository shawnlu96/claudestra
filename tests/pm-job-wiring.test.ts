/**
 * agents-PMJOB1 第 1 轮审查的四条：调度服务真的会起 worker（不用测试手动调 worker）、ask_codex 入口与处理员共用持久槽位、
 * 白名单类型只认自有的三类（继承键不算）、英文的决策 / 改范围 / 删数据问法和不像查证的问题都不当直回候选。
 * 服务那条起真实的 `bun src/scheduler.ts` 子进程，状态在测试的临时状态目录，HOME 是空的临时目录（额度读数未知，不上模型）。
 */
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pmJob } from "../src/bridge/pm-job.js";
import type { CodexResult } from "../src/lib/codex.js";
import { getAsk } from "../src/lib/ledger-asks.js";
import { askNoticeText } from "../src/lib/order-ask.js";
import { statePath } from "../src/lib/paths.js";
import { forbiddenOf, judgePmJobOutput } from "../src/lib/pm-job-rules.js";
import { acquireCodexSlot, CODEX_SLOT_MAX, codexSlotsHeld, withCodexSlot } from "../src/lib/pm-job-slots.js";
import { pmJobWorkerTick } from "../src/lib/pm-job-spawn.js";
import { PmJobStore } from "../src/lib/pm-job-store.js";
import { SRC_DIR } from "../src/lib/repo-root.js";
import { pmJobWorkerMain } from "../src/manager/pm-job-worker.js";
import { A, ASKER, goodAnswer, jobWorld, ORDER, type JobWorld } from "./pm-job-world.test.js";

let w: JobWorld | undefined;
const dirs: string[] = [], cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  w?.close();
  w = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "pm-job-wiring-")); dirs.push(d); return d; };
const until = async (cond: () => boolean, ms = 15_000) => { for (const t0 = Date.now(); Date.now() - t0 < ms && !cond();) await new Promise((r) => setTimeout(r, 25)); };
const original = (askId: string, question: string) => askNoticeText({ taskId: "T1", orderId: ORDER, from: ASKER, askId, question, options: [], class: "blocker" });
const ok = (message: string): CodexResult => ({ ok: true, message, sessionId: null, elapsedMs: 5 });
const lines = () => 10;

// [验收线 1] [验收线 4]
test("the scheduler service itself starts the worker for a job queued before it came up; nothing in the test calls the worker", async () => {
  w = await jobWorld("on");
  // 单子落在服务进程和 worker 进程都看得到的默认位置（测试的临时状态目录）
  const store = new PmJobStore(statePath("pm-job"), w.digest.modePath);
  pmJob.deps.store = store;
  cleanup.push(() => rmSync(store.dir, { recursive: true, force: true }));
  const q = "验收线 1 的行数上限是多少？", { askId } = await w.ask(q);
  expect(w.pm).toEqual([]); // on：原通知已压下，只有 worker 跑起来才有下文
  expect(store.get(askId)).toMatchObject({ state: "queued", direct: true });
  const home = tmp(), mark = join(home, "model-ran"), bin = join(home, "codex-stub.sh");
  writeFileSync(bin, `#!/bin/sh\ntouch "${mark}"\n`);
  chmodSync(bin, 0o755);
  const service = Bun.spawn([process.execPath, join(SRC_DIR, "scheduler.ts")], {
    env: { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex"), CODEX_BIN: bin }, stdout: "ignore", stderr: "ignore" });
  cleanup.push(() => service.kill("SIGKILL"));
  await until(() => store.get(askId)?.state === "drafted");
  service.kill("SIGTERM");
  await service.exited;
  const job = store.get(askId)!;
  expect(job).toMatchObject({ state: "drafted", result: { verdict: "escalate", reason: expect.stringContaining("额度") } }); // 额度读数未知：不上模型
  expect(job.lease).toBeUndefined();
  expect(existsSync(mark)).toBe(false);
  expect(readFileSync(job.draftPath, "utf8")).toContain("需 PM 处理");
  await pmJob.sweep();
  expect(w.asker).toEqual([]);
  expect(w.pm).toHaveLength(1);
  expect(w.pm[0]).toMatchObject({ to: A, id: `ledger-ask:${askId}` });
  expect(w.pm[0]!.content.startsWith(original(askId, q))).toBe(true);
  expect(w.pm[0]!.content).toContain(job.draftPath);
  expect(store.get(askId)).toMatchObject({ state: "escalated", pmNotice: "handed" });
}, 30_000);

// [验收线 1]
test("the service wiring is one tick per loop, and a tick alone carries an on job from queued to the asker's answer", async () => {
  const src = readFileSync(join(SRC_DIR, "scheduler.ts"), "utf8"), loop = src.slice(src.indexOf("while (!signal.aborted)"));
  expect(loop).toContain("pmJobWorkerTick();");
  expect(loop.indexOf("pmJobWorkerTick();")).toBeLessThan(loop.indexOf("readSchedulerConfig()")); // 不看调度开关、不靠别的步骤先成功
  w = await jobWorld("on");
  const world = w, { askId } = await w.ask("验收线 1 的行数上限是多少？");
  let worker: Promise<number> | undefined;
  const spawn = (argv: string[]) => {
    expect(argv[1]).toBe(join(SRC_DIR, "manager", "pm-job-worker.ts"));
    worker = pmJobWorkerMain(() => world.work()); // 子进程入口的同一个函数，模型是桩
  };
  expect(pmJobWorkerTick({ store: w.store, now: w.now, spawn })).toBe(true);
  expect(await worker).toBe(0);
  expect(pmJobWorkerTick({ store: w.store, now: w.now, spawn })).toBe(false); // 没有排队的单了，不再起
  await pmJob.sweep();
  expect(w.pm).toEqual([]);
  expect(w.asker).toHaveLength(1);
  expect(w.asker[0]).toMatchObject({ to: ASKER, id: `pm-job-answer:${askId}` });
  expect(getAsk(w.f.db, askId)).toMatchObject({ state: "answered", answer: { principal: "system:pm-job" } });
});

// [验收线 6]
test("ask_codex takes its slot from the same persisted file as the worker: three ask_codex calls keep the worker out, and a fourth caller is refused", async () => {
  const bridge = readFileSync(join(SRC_DIR, "bridge.ts"), "utf8"), entry = bridge.slice(bridge.indexOf('case "ask_codex"'), bridge.indexOf('case "fetch_messages"'));
  expect(entry).toContain('withCodexSlot("ask_codex", ');
  expect(entry.indexOf("withCodexSlot(")).toBeLessThan(entry.indexOf("runCodex(")); // 先拿槽位才跑模型
  expect(bridge).not.toContain("codexInflight"); // 进程内计数已经没有了
  expect(CODEX_SLOT_MAX).toBe(3);
  cleanup.push(() => rmSync(statePath("codex-slots.json"), { force: true }));
  // 两边都用生产缺省：ask_codex 入口那一句调用，和 worker 缺省的 acquireCodexSlot("pm-job")，同一个槽位文件
  const gates: (() => void)[] = [];
  const askCodex = () => withCodexSlot("ask_codex", () => new Promise<string>((r) => gates.push(() => r("done"))));
  const calls = [askCodex(), askCodex(), askCodex()];
  await until(() => gates.length === 3);
  expect((await codexSlotsHeld())!.map((s) => s.owner)).toEqual(["ask_codex", "ask_codex", "ask_codex"]);
  expect(await askCodex()).toEqual({ ran: false }); // 第四路 ask_codex：并发已满
  w = await jobWorld("on");
  const { askId } = await w.ask("验收线 1 的行数上限是多少？"), slot = () => acquireCodexSlot("pm-job");
  expect(await w.work(undefined, { slot })).toBe(0); // 三路 ask_codex 在跑：处理员不上模型，单放回队列
  expect(w.runs).toEqual([]);
  expect(w.store.get(askId)).toMatchObject({ state: "queued" });
  gates.shift()!();
  expect(await calls[0]).toEqual({ ran: true, value: "done" });
  let during: string[] = [], fourth: unknown;
  expect(await w.work(async () => {
    during = (await codexSlotsHeld())!.map((s) => s.owner).sort();
    fourth = await askCodex(); // 两路 ask_codex + 处理员 = 3：再来一路 ask_codex 也不给
    return ok(goodAnswer({ specPath: w!.specPath }));
  }, { slot })).toBe(1);
  expect(during).toEqual(["ask_codex", "ask_codex", "pm-job"]);
  expect(fourth).toEqual({ ran: false });
  for (const open of gates.splice(0)) open();
  await Promise.all(calls);
  expect(await codexSlotsHeld()).toEqual([]);
});

// [验收线 2]
test("only the three own whitelist types answer: inherited object keys are unknown types and escalate", () => {
  for (const type of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf"]) {
    const out = judgePmJobOutput(JSON.stringify({ type, confident: true, answer: "验收线 1 说的是 800 行。", evidence: [{ file: "src/a.ts", line: 1 }] }), { forbidden: null, lines });
    expect(out).toMatchObject({ verdict: "escalate", reason: expect.stringContaining("不在白名单") });
  }
  for (const type of ["acceptance", "standard", "location"]) {
    expect(judgePmJobOutput(goodAnswer({ specPath: "spec.md" }, { type }), { forbidden: null, lines })).toMatchObject({ verdict: "answer", type });
  }
});

const DECISIONS: [string, string][] = [
  ["Can I change the scope to include another module?", "改范围"], ["Can I delete the database records?", "删数据"],
  ["Is it out of scope if I also touch src/lib/outside.ts?", "改范围"], ["Should we relax acceptance line 2?", "改规格"],
  ["Please remove the old ledger backups for me.", "删数据"], ["Could you grant me write access to the ledger?", "权限"],
  ["Do we ship this version to production today?", "release"], ["Shall I bump the quota limit to 90?", "改额度线"],
  ["Do I rename the column in asks?", "schema"], ["Where do I find the api key?", "凭据 / 安全"],
  ["Can I put the helper in src/lib/thing.ts?", "请求批准 / 决策"], ["Is it ok to skip the second test in src/lib/thing.ts?", "请求批准 / 决策"],
  ["验收线 1 我想按 1000 行算，行吗？", "请求批准 / 决策"], ["Ｃａｎ　Ｉ ｃｈａｎｇｅ ｔｈｅ ｓｃｏｐｅ?", "改范围"], ["Can I change the sc​ope?", "改范围"],
];

// [验收线 2]
test("decision questions in English, obfuscated spellings and anything that is not a lookup are not direct candidates; plain lookups still are", () => {
  for (const [q, label] of DECISIONS) expect([q, forbiddenOf(q)]).toEqual([q, label]);
  for (const q of ["验收线 1 的行数上限是多少？", "src/lib/thing.ts 里 b 在哪一行？", "验收线 1 具体指什么？", "What does acceptance line 1 say?",
    "Where is b defined in src/lib/thing.ts?", "Which file implements the lease?", "标准答复里环境那条是怎么说的，指的是哪个命令？",
    // agents-PMJOB2 去掉了「像查证」门：不像查证、但一道门都不中的不再挡在接单时，交给输出核对
    "Thanks, carrying on.", "帮我看看这个", ""]) expect([q, forbiddenOf(q)]).toEqual([q, null]);
});

// [验收线 2]
test("on: an English hard-gate decision goes to the PM at once and is never answered, whatever the model claims", async () => {
  w = await jobWorld("on");
  const asked: [string, string][] = [];
  // agents-PMJOB2：改范围是软门（直回候选，只能按 specDecided 答），不像查证的不再挡；这里只留硬门
  for (const q of ["Could you grant me write access to the ledger?", "Can I delete the database records?", "Where do I find the api key?"]) {
    const before = w.pm.length, { askId } = await w.ask(q);
    asked.push([askId, q]);
    expect(w.store.get(askId)).toMatchObject({ direct: false, forbidden: expect.any(String) });
    expect(w.pm.slice(before)).toEqual([{ to: A, id: `ledger-ask:${askId}`, content: expect.stringContaining(original(askId, q)) }]); // 原文立刻到 PM
  }
  // 模型自称白名单、有把握、有依据
  expect(await w.work(() => ok(goodAnswer({ specPath: w!.specPath }, { answer: "Approved." })))).toBe(asked.length);
  await pmJob.sweep();
  expect(w.asker).toEqual([]);
  expect(w.remote).toEqual([]);
  for (const [askId] of asked) {
    expect(w.store.get(askId)).toMatchObject({ state: "observed", result: { verdict: "escalate" } });
    expect(getAsk(w.f.db, askId)?.state).toBe("open");
  }
});

// [验收线 3]
test("on: an English scope decision is a direct candidate but escalates unless answered as specDecided", async () => {
  w = await jobWorld("on");
  const q = "Can I change the scope to include another module?", { askId } = await w.ask(q);
  expect(w.store.get(askId)).toMatchObject({ direct: true, hard: false, forbidden: "改范围", forbiddenAll: ["改范围", "请求批准 / 决策"] });
  expect(w.pm).toEqual([]);
  expect(await w.work(() => ok(goodAnswer({ specPath: w!.specPath })))).toBe(1);
  await pmJob.sweep();
  expect(w.asker).toEqual([]);
  expect(w.store.get(askId)).toMatchObject({ state: "escalated", note: expect.stringContaining("specDecided") });
  expect(w.pm[0]!.content.startsWith(original(askId, q))).toBe(true);
});

// [验收线 2]
test("on: a lookup question whose answer grants approval is escalated, and a candidate option that asks for a decision blocks the direct path", async () => {
  w = await jobWorld("on");
  const q = "验收线 2 的范围指的是哪个文件？", { askId } = await w.ask(q);
  expect(w.store.get(askId)).toMatchObject({ direct: true, forbidden: null });
  expect(await w.work(() => ok(goodAnswer({ specPath: w!.specPath }, { answer: "Approved, go ahead and edit src/lib/outside.ts too." })))).toBe(1);
  await pmJob.sweep();
  expect(w.asker).toEqual([]);
  expect(w.store.get(askId)).toMatchObject({ state: "escalated", note: expect.stringContaining("批准口吻") });
  expect(w.pm).toHaveLength(1);
  expect(w.pm[0]!.content.startsWith(original(askId, q))).toBe(true);
  expect(forbiddenOf(["验收线 2 的范围指的是哪个文件？", "扩围到 src/lib/outside.ts"].join("\n"))).toBe("改范围"); // intake 把候选项和问题一起判
});
