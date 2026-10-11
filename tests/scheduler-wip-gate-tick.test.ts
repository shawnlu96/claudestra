/**
 * dispatch-recovery-WIPGATE1 已建卡的首次准入：真 schedulerAutoTick（每张卡一步）+ 真 ledger CLI（调度身份），合成台账与临时目录；
 * 会话、出借、git 用替身。合并队列放 N 张 auto merge 卡（Q*，tick 里用 pace.skipTask 跳过，只推目标卡），日志 / 去重状态 / 时钟经 setWipGateIo 注入。
 * [验收线 2] observe 照常执行只多日志与去重；[验收线 3] on 拦首次作者建会话 / 首张 peer write 单（含已存在的未发 pending 意图）与重核点；
 * [验收线 4] 队列降下来下一轮恢复；[验收线 5] 收尾 / 手动 / 续做与 off 逐字相同；[验收线 6] off 与失败兜底。
 */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as queueView from "../src/lib/ledger-merge-queue-view.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { schedulerAutoTick, type AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { ensureLocalAuthor } from "../src/lib/scheduler-local-author.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { specResumeTick } from "../src/lib/scheduler-spec-resume.js";
import { setWipGateIo, WIP_GATE_WINDOW_MS } from "../src/lib/scheduler-wip-gate-log.js";
import { wipGateCard, wipGateNode, wipGateSpecPlace } from "../src/lib/scheduler-wip-gate.js";
import { wipGateConfig } from "../src/lib/scheduler-wip-gate-config.js";
import * as autostart from "../src/lib/scheduler-autostart.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";

const P = "p", PM = "agent-pm", HOUR = WIP_GATE_WINDOW_MS, MIN = 60_000;
type Mode = "on" | "observe" | "off" | null;

interface Fx {
  dir: string; path: string; db: Database; now: number; clock: number;
  calls: string[][]; ensures: string[]; logPath: string; statePath: string;
}
const open: Fx[] = [];
afterEach(() => {
  setWipGateIo(null);
  for (const fx of open.splice(0)) { closeLedger(fx.path); rmSync(fx.dir, { recursive: true, force: true }); }
});

const ctx = (fx: Fx, actor = PM) => ({ actor, now: fx.now++ });
const ledgerDeps = (fx: Fx, actor: string) => ({ db: fx.db, actor, projectIds: [P], now: () => fx.now++, autoProjects: () => [P], autoDispatch: () => true,
  loadRegistry: async () => ({ socket: "", agents: {} }) as unknown as Registry, saveRegistry: async () => {} });
const sched = (fx: Fx, ...args: string[]) => runLedger(args, ledgerDeps(fx, "scheduler")) as Promise<Record<string, unknown>>;

function io(fx: Fx): void {
  setWipGateIo({ logPath: () => fx.logPath, statePath: () => fx.statePath, now: () => fx.clock });
}

/** 合成台账：PM 名单、可选的闸配置（直接写 meta，不留事件，孪生夹具逐字可比）、depth 张 auto merge 卡 */
function fixture(mode: Mode, depth: number, threshold?: number, raw?: string): Fx {
  const dir = mkdtempSync(join(tmpdir(), "wipgate-")), path = join(dir, "ledger.sqlite");
  const fx: Fx = { dir, path, db: openLedger(path), now: 1_000_000, clock: Date.UTC(2026, 9, 11, 10, 0), calls: [], ensures: [],
    logPath: join(dir, "logs", "wip-gate.out"), statePath: join(dir, "state", "wip-gate.json") };
  open.push(fx);
  setMeta(fx.db, ctx(fx, "owner"), { project: P, key: "pms", value: [PM] });
  const value = raw ?? (mode ? JSON.stringify({ wipGate: mode, ...(threshold !== undefined ? { wipGateThreshold: threshold } : {}) }) : null);
  if (value !== null) fx.db.query("INSERT INTO meta (project, key, value) VALUES (?, 'autostart', ?)").run(P, value);
  for (let i = 0; i < depth; i++) queueCard(fx, `Q${String(i).padStart(2, "0")}`);
  io(fx);
  return fx;
}

function queueCard(fx: Fx, id: string): void {
  createTask(fx.db, ctx(fx, "owner"), { project: P, id, title: id, kind: "code", agent: `agent-${id}`, extra: { fileGlobs: [`src/${id}.ts`] } });
  setWorkflow(fx.db, ctx(fx, "owner"), { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "x" });
  fx.db.query("UPDATE tasks SET stage = 'merge' WHERE id = ?").run(id);
}
const dequeue = (fx: Fx, id = "Q00") => fx.db.query("UPDATE tasks SET stage = 'done' WHERE id = ?").run(id);

/** PM 建的 auto 卡（交回自动），从没开过工 */
function newCard(fx: Fx, id = "N1", agent?: string): void {
  createTask(fx.db, ctx(fx), { project: P, id, title: id, kind: "code", ...(agent ? { agent } : {}), extra: { fileGlobs: [`src/${id}.ts`] } });
  setWorkflow(fx.db, ctx(fx), { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "x" });
}

function rawIntent(fx: Fx, id: string, taskId: string, node: string, action: string, recipient: string | null, status = "pending"): void {
  const t = getTask(fx.db, taskId)!;
  fx.db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq, eventSeq, taskRev, specRev, head, templateVersion,
    status, reason, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 2, ?, 'fixture', ?, ?)`)
    .run(id, taskId, P, node, action, recipient, t.rev, t.specRev, t.headSHA, status, fx.now, fx.now);
}

const deps = (fx: Fx): AutoTickDeps => ({
  manager: async (...args) => { fx.calls.push(args); return sched(fx, ...args.slice(1)); },
  worker: () => ({ manual: "fixture" }),
  ensure: async (task, role, family) => { fx.ensures.push(`${task.id}:${role}:${family}`); return { kind: "wait", reason: "fixture" }; },
  pinReview: async () => ({ manual: "fixture" }), reviewDirty: async () => null, notifyPm: async () => {}, now: () => fx.now,
});
const tick = (fx: Fx, skip: (id: string) => boolean = (id) => id.startsWith("Q")) =>
  schedulerAutoTick(fx.db, { [P]: { maxActiveWorkers: 3 } }, deps(fx), { yieldNow: () => false, cursor: {}, skipTask: skip });

const logs = (fx: Fx) => (existsSync(fx.logPath) ? readFileSync(fx.logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const intents = (fx: Fx, id = "N1") => fx.db.query("SELECT id, node, action, status, recipient FROM scheduler_intents WHERE taskId = ? ORDER BY rowid").all(id);
const events = (fx: Fx) => fx.db.query("SELECT actor, project, target, kind, text, data, dedupKey FROM events ORDER BY seq").all();
/** 一轮之后外部可见的一切：tick 结果、manager 调用、建会话、意图、台账事件 */
const world = async (fx: Fx, skip?: (id: string) => boolean) => ({ out: await tick(fx, skip), calls: fx.calls, ensures: fx.ensures, intents: intents(fx), events: events(fx) });

/** 用真 scheduler-plan 写一条本轮计划的 pending 意图，不驱动（「预先存在的未发意图」） */
async function pendingPlan(fx: Fx, id = "N1"): Promise<string> {
  const t = getTask(fx.db, id)!, plan = planScheduler(autoSnapshot(fx.db, t, { registry: [], maxWorkers: 3, now: fx.now }));
  if (plan.kind !== "intent") throw new Error(`fixture: ${plan.kind}`);
  const seq = (fx.db.query("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s;
  const r = await sched(fx, "scheduler-plan", id, "--id", plan.id, "--rev", String(t.rev), "--workflow-rev", "1", "--seq", String(seq), "--node", plan.node,
    "--action", plan.action, "--reason", plan.reason, ...(plan.resources.length ? ["--resources", plan.resources.join(",")] : []));
  if (r.ok !== true) throw new Error(String(r.error));
  return plan.id;
}

describe("[验收线 2] observe：照常执行，只多一条日志", () => {
  test("深度 15 = 阈值：本机首次作者照常建会话，执行序列与 off 相同；记录带深度 / 阈值 / 档位 / 入口；深度 14 无记录", async () => {
    const off = fixture("off", 15), offWorld = (newCard(off), await world(off));
    const obs = fixture("observe", 15, 15); newCard(obs);
    expect(await world(obs)).toEqual(offWorld);
    expect(obs.ensures).toEqual(["N1:author:claude"]);
    expect(logs(obs)).toEqual([{ at: new Date(obs.clock).toISOString(), project: P, task: "N1", entry: "author", depth: 15, threshold: 15, mode: "observe" }]);
    expect(existsSync(off.logPath) || existsSync(off.statePath)).toBe(false);
    const low = fixture("observe", 14, 15); newCard(low);
    await tick(low);
    expect(low.ensures).toEqual(["N1:author:claude"]);
    expect(existsSync(low.logPath) || existsSync(low.statePath)).toBe(false);
  });

  test("peer 首张 write 单：pending 挂池意图照常进 scheduler-pool，与 off 相同，只多日志", async () => {
    const make = (mode: Mode) => {
      const fx = fixture(mode, 15); newCard(fx); fx.db.query("UPDATE tasks SET stage = 'build' WHERE id = 'N1'").run();
      rawIntent(fx, "w1", "N1", "write", "dispatch", "peer:hx");
      return fx;
    };
    const off = make("off"), obs = make("observe");
    const a = await world(off), b = await world(obs);
    expect(b).toEqual(a);
    expect(obs.calls.some((c) => c[1] === "scheduler-pool" && c[2] === "w1")).toBe(true);
    expect(logs(obs).map((l) => [l.task, l.entry, l.depth])).toEqual([["N1", "author", 15]]);
  });

  test("同项目同卡跨入口滚动 60 分钟只一条：0 / 59 分钟、重启、spec 放置与自动开卡入口都不重记，满 60 分钟才有第二条；整点前后按滚动算", async () => {
    const fx = fixture("observe", 15);
    newCard(fx);
    fx.clock = Date.UTC(2026, 9, 11, 10, 59, 30); // 10:59:30 记第一条
    await tick(fx);
    fx.clock += 1 * MIN; await tick(fx); // 11:00:30（跨整点）
    fx.clock += 58 * MIN; await tick(fx); // 11:58:30（59 分钟）
    closeLedger(fx.path); fx.db = openLedger(fx.path); setWipGateIo(null); io(fx); // 重启：新连接、新 IO，去重状态从磁盘读
    await tick(fx);
    expect(wipGateSpecPlace(fx.db, getTask(fx.db, "N1")!)).toBeNull();
    expect(wipGateNode(fx.db, P, "N1")).toBeNull();
    expect(logs(fx)).toHaveLength(1);
    fx.clock += 59 * 1000; await tick(fx); // 11:59:29：差 1 秒满一小时
    expect(logs(fx)).toHaveLength(1);
    fx.clock += 1000; await tick(fx); // 11:59:30：满 60 分钟
    expect(logs(fx).map((l) => l.at)).toEqual(["2026-10-11T10:59:30.000Z", "2026-10-11T11:59:30.000Z"]);
    expect(fx.ensures.length).toBeGreaterThan(0); // 照常开卡（建会话退避与改前相同，不数次数）
  });
});

describe("[验收线 3] on：首次入口不开新卡，原处不动", () => {
  for (const depth of [15, 16]) {
    test(`深度 ${depth}：新计划不写意图、不建作者；预存 pending 作者意图与 write 意图都保留；台账无新事件`, async () => {
      const fx = fixture("on", depth); newCard(fx); newCard(fx, "N2"); newCard(fx, "N3");
      const author = await pendingPlan(fx, "N2");
      fx.db.query("UPDATE tasks SET stage = 'build' WHERE id = 'N3'").run();
      rawIntent(fx, "w3", "N3", "write", "dispatch", "peer:hx");
      const before = events(fx);
      const out = await tick(fx);
      expect(out.cards.map((c) => [c.taskId, c.step])).toEqual([["N1", "waiting"], ["N2", "waiting"], ["N3", "waiting"]]);
      expect(out.cards[0].detail).toContain(`合并队列 ${depth} 张，已到 WIP 闸阈值 15`);
      expect(fx.ensures).toEqual([]);
      expect(fx.calls.filter((c) => ["scheduler-plan", "scheduler-settle", "scheduler-pool", "scheduler-fallback-manual"].includes(c[1]))).toEqual([]);
      expect(intents(fx, "N1")).toEqual([]);
      expect(intents(fx, "N2")).toEqual([expect.objectContaining({ id: author, status: "pending" })]);
      expect(intents(fx, "N3")).toEqual([expect.objectContaining({ id: "w3", status: "pending" })]);
      expect(events(fx)).toEqual(before);
      expect(logs(fx).map((l) => [l.task, l.mode, l.depth])).toEqual([["N1", "on", depth], ["N2", "on", depth], ["N3", "on", depth]]);
    });
  }

  test("重核点：真 scheduler-pool 挂首张 write 单回 conflict、意图留 pending；本机建首个作者回 wait；off 时两处照旧往下走", async () => {
    const run = async (mode: Mode) => {
      const fx = fixture(mode, 16); newCard(fx); fx.db.query("UPDATE tasks SET stage = 'build' WHERE id = 'N1'").run();
      rawIntent(fx, "w1", "N1", "write", "dispatch", "peer:hx");
      const pool = await sched(fx, "scheduler-pool", "w1", "--max-workers", "3", "--mode", "overflow", "--roles", "review,write", "--timeout-min", "30",
        "--repo", "example/repo");
      newCard(fx, "N2"); rawIntent(fx, "e2", "N2", "restate", "ensure_session", null, "submitted");
      const env = { db: fx.db, registryRow: () => undefined, worktreeRoot: join(fx.dir, "wt"), active: () => {}, git: async () => { throw new Error("git"); },
        create: async () => { throw new Error("create"); }, ledger: async () => { throw new Error("ledger"); } };
      const author = await ensureLocalAuthor(env as never, getTask(fx.db, "N2")!, { configPath: join(fx.dir, "none.json") });
      return { pool, author, w1: intents(fx)[0] };
    };
    const on = await run("on"), off = await run("off");
    expect(on.pool).toMatchObject({ ok: false, code: "conflict", error: expect.stringContaining("合并队列 16 张") });
    expect(on.w1).toMatchObject({ status: "pending" });
    expect(on.author).toEqual({ kind: "wait", reason: expect.stringContaining("合并队列 16 张") });
    expect(off.pool.code).not.toBe("conflict");
    expect(off.author.kind).not.toBe("wait");
  });

  test("spec 放置：on 不调放置、不写 placement / 等待状态；off 照常放置并落等待", async () => {
    const run = async (mode: Mode) => {
      const fx = fixture(mode, 15); newCard(fx);
      const placed: string[] = [], ledger: string[][] = [];
      const failed = await specResumeTick({ db: fx.db, projects: [P], repoDir: async () => fx.dir, notifyPm: async () => {},
        place: async (_db, q) => { placed.push(q.taskId); return { where: "refused", reason: "没空位" } as never; },
        ledger: async (...args) => { ledger.push(args); return sched(fx, ...args.slice(1)); } });
      return { failed, placed, ledger: ledger.map((a) => a[1]), waits: events(fx).filter((e) => String((e as { text: string }).text).includes("等写代码的空位")).length };
    };
    expect(await run("on")).toEqual({ failed: [], placed: [], ledger: [], waits: 0 });
    const off = await run("off");
    expect(off.placed).toEqual(["N1"]);
    expect(off.ledger).toContain("scheduler-spec-place");
  });
});

describe("[验收线 4] 恢复：队列降下来下一轮自动开工，不清 hold、不重新武装", () => {
  test("同一份台账：15 拦，移出一张 merge 卡到 14，下一轮照常建作者", async () => {
    const fx = fixture("on", 15); newCard(fx);
    expect((await tick(fx)).cards[0].step).toBe("waiting");
    dequeue(fx);
    await tick(fx);
    expect(fx.ensures).toEqual(["N1:author:claude"]);
  });

  test("阈值 3：深度 3 拦、2 恢复；重启后按当前深度重算", async () => {
    const fx = fixture("on", 3, 3); newCard(fx);
    expect((await tick(fx)).cards[0].step).toBe("waiting");
    dequeue(fx, "Q00");
    await tick(fx);
    expect(fx.ensures).toHaveLength(1);
    queueCard(fx, "Q99");
    closeLedger(fx.path); fx.db = openLedger(fx.path);
    expect((await tick(fx)).cards[0].step).toBe("waiting");
    dequeue(fx, "Q99");
    closeLedger(fx.path); fx.db = openLedger(fx.path);
    await tick(fx);
    expect(fx.ensures).toHaveLength(2);
  });
});

/** 同一组输入分别在 off 与 on（深度 20）里跑一轮，外部可见的一切逐字相同 */
async function twins(setup: (fx: Fx) => void, skip?: (id: string) => boolean): Promise<void> {
  const off = fixture("off", 20), on = fixture("on", 20);
  setup(off); setup(on);
  expect(await world(on, skip)).toEqual(await world(off, skip));
  expect(logs(on)).toEqual([]);
}

describe("[验收线 5] 收尾与手动：深度 20、on 与 off 相同", () => {
  test("本机 fix：已开工（执行者在卡上）的修复单照常", () => twins((fx) => {
    newCard(fx, "N1", "agent-n1"); fx.db.query("UPDATE tasks SET stage = 'fix', round = 1 WHERE id = 'N1'").run();
  }));
  test("peer fix 单：按节点放行（即使卡上没有别的开工事实）", () => twins((fx) => {
    newCard(fx); fx.db.query("UPDATE tasks SET stage = 'fix', round = 1 WHERE id = 'N1'").run();
    rawIntent(fx, "f1", "N1", "fix", "dispatch", "peer:hx");
  }));
  test("review 单：按动作放行", () => twins((fx) => {
    newCard(fx); fx.db.query("UPDATE tasks SET stage = 'review', round = 1 WHERE id = 'N1'").run();
    rawIntent(fx, "r1", "N1", "adversarial_review", "review", "peer:hx");
  }));
  test("已开工后 specRev 变化：作者已绑定，规格变了也是续做", () => twins((fx) => {
    newCard(fx); rawIntent(fx, "e1", "N1", "restate", "ensure_session", null, "done");
    fx.db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
      VALUES ('N1', 'author', 'agent-n1', 's-n1', 'claude', 'acp', 'retired', 'e1', 1, 1)`).run();
    fx.db.query("UPDATE tasks SET specRev = 2 WHERE id = 'N1'").run();
    fx.db.query("UPDATE task_workflows SET specRev = 2 WHERE taskId = 'N1'").run();
  }));
  test("作者重建：卡上执行者不在 registry，重新建会话照常", () => twins((fx) => {
    newCard(fx, "N1", "agent-n1"); fx.db.query("UPDATE tasks SET stage = 'build' WHERE id = 'N1'").run();
  }));
  test("已有 write 单同步：挂过池（pool_offer）的意图照常进 scheduler-pool", () => twins((fx) => {
    newCard(fx); fx.db.query("UPDATE tasks SET stage = 'build' WHERE id = 'N1'").run();
    rawIntent(fx, "w1", "N1", "write", "dispatch", "peer:hx");
    fx.db.query(`INSERT INTO events (ts, actor, project, target, kind, text, data, dedupKey) VALUES (1, 'scheduler', ?, 'N1', 'scheduler', '挂池', ?, 'pool-link:w1')`)
      .run(P, JSON.stringify({ op: "pool_offer", id: "w1", orderId: "o1", peer: "hx" }));
  }));
  test("merge：队列里的卡自己照常推进", () => twins(() => {}, (id) => id.startsWith("Q") && id !== "Q00"));
  test("PM 手动 start_node 的卡：后续自动建作者不补拦", () => twins((fx) => {
    newCard(fx);
    fx.db.query(`INSERT INTO events (ts, actor, project, target, kind, text, data, dedupKey) VALUES (1, ?, ?, 'N1', 'note', 'start_node', '{}', 'dag-start:N1:ab12:task-new')`)
      .run(PM, P);
  }));

  test("从没开过工、只改过规格的卡仍拦；shared-ledger 跳过的卡零副作用（无日志、无去重状态、无调用）", async () => {
    const fx = fixture("on", 20); newCard(fx);
    fx.db.query("UPDATE tasks SET specRev = 3 WHERE id = 'N1'").run();
    fx.db.query("UPDATE task_workflows SET specRev = 3 WHERE taskId = 'N1'").run();
    const held = await tick(fx);
    expect(held.cards.map((c) => c.step)).toEqual(["waiting"]);
    expect(held.cards[0].detail).toContain("合并队列 20 张，已到 WIP 闸阈值 15");
    expect(fx.ensures).toEqual([]);
    const skipped = fixture("observe", 20); newCard(skipped);
    const out = await tick(skipped, () => true);
    expect(out.cards).toEqual([]);
    expect(skipped.calls.filter((c) => c.includes("N1"))).toEqual([]);
    expect(existsSync(skipped.logPath) || existsSync(skipped.statePath)).toBe(false);
  });
});

describe("[验收线 6] off 与失败兜底", () => {
  test("off：不读队列、不写日志与去重状态；与 observe 低于阈值的执行逐字相同", async () => {
    const spy = spyOn(queueView, "mergeQueueCards");
    try {
      const off = fixture("off", 20); newCard(off);
      const a = await world(off);
      expect(spy).not.toHaveBeenCalled();
      expect(existsSync(off.logPath) || existsSync(off.statePath)).toBe(false);
      const low = fixture("observe", 20, 21); newCard(low);
      expect(await world(low)).toEqual(a);
    } finally { spy.mockRestore(); }
  });

  const BAD: [string, string][] = [["非法档位", JSON.stringify({ wipGate: "maybe" })], ["阈值 0", JSON.stringify({ wipGate: "on", wipGateThreshold: 0 })],
    ["阈值小数", JSON.stringify({ wipGate: "on", wipGateThreshold: 1.5 })], ["阈值字符串", JSON.stringify({ wipGate: "on", wipGateThreshold: "3" })],
    ["阈值 null", JSON.stringify({ wipGate: "on", wipGateThreshold: null })], ["档位 null", JSON.stringify({ wipGate: null })]];
  for (const [name, raw] of BAD) {
    test(`${name}：按 off，与 off 逐字相同、无日志`, async () => {
      const off = fixture("off", 20); newCard(off);
      const bad = fixture(null, 20, undefined, raw); newCard(bad);
      expect(await world(bad)).toEqual(await world(off));
      expect(existsSync(bad.logPath)).toBe(false);
    });
  }

  test("读开关抛错 / 坏 JSON：按 off，不拦也不记", async () => {
    const off = fixture("off", 20); newCard(off);
    const a = await world(off);
    const spy = spyOn(autostart, "readSwitch").mockImplementation(() => { throw new Error("开关读不出"); });
    try {
      const on = fixture("on", 20); newCard(on);
      expect(await world(on)).toEqual(a);
      expect(existsSync(on.logPath)).toBe(false);
    } finally { spy.mockRestore(); }
    const bad = fixture("on", 20); newCard(bad);
    bad.db.query("UPDATE meta SET value = '{' WHERE project = ? AND key = 'autostart'").run(P); // 坏 JSON：getMeta 别处也读不了，这里只核闸自己的读法
    expect(wipGateConfig(bad.db, P)).toEqual({ mode: "off", threshold: 15 });
    expect(wipGateCard(bad.db, getTask(bad.db, "N1")!, null, { registry: [], maxWorkers: 3, now: bad.now })).toBeNull();
    expect(existsSync(bad.logPath)).toBe(false);
  });

  test("队列读取抛错：按 off（不伪造深度 0、不拦）", async () => {
    const off = fixture("off", 20); newCard(off);
    const a = await world(off);
    const spy = spyOn(queueView, "mergeQueueCards").mockImplementation(() => { throw new Error("队列读不出"); });
    try {
      const on = fixture("on", 20); newCard(on);
      expect(await world(on)).toEqual(a);
      expect(existsSync(on.logPath)).toBe(false);
    } finally { spy.mockRestore(); }
  });

  test("未设档位按 observe（只多日志）；observe 日志写失败仍开卡，也不记成已记录", async () => {
    const off = fixture("off", 15); newCard(off);
    const unset = fixture(null, 15); newCard(unset);
    expect(await world(unset)).toEqual(await world(off));
    expect(logs(unset).map((l) => [l.mode, l.threshold])).toEqual([["observe", 15]]);
    const broken = fixture("observe", 15); newCard(broken);
    mkdirSync(broken.logPath, { recursive: true }); // 日志路径是目录：追加必失败
    await tick(broken);
    expect(broken.ensures).toEqual(["N1:author:claude"]);
    expect(existsSync(broken.statePath)).toBe(false);
  });
});
