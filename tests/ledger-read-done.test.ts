/**
 * 已完成卡窗口与分页（i28-V1p，lib/ledger-read-done.ts）：总览字节数不随已完成卡数涨、游标翻页不重不漏（含同一毫秒完成的）、
 * 窗口外的卡在子 DAG 看板上状态照旧、跨时区（服务器 Asia/Shanghai、浏览器 America/Los_Angeles，网页传自己的零点）今日完成卡带小圆点、
 * GET /ledger/:project/done 的参数校验；网页侧：窗口 + doneRest 算出的计数和全量一致、翻页状态机在窗口挪动时补段不漏。
 */
import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLedgerFeedForTest } from "../src/bridge/ledger-feed.js";
import { handleLedgerApi, setLedgerApiProjectsForTest } from "../src/bridge/local-api/ledger.js";
import { dagBoard } from "../src/lib/ledger-dag-board.js";
import { projectView, taskDetail } from "../src/lib/ledger-read.js";
import { dayStartOf, DONE_RECENT, donePage, parseDoneCursor } from "../src/lib/ledger-read-done.js";
import { closeLedger, LEDGER_SCHEMA_VERSION, openLedger } from "../src/lib/ledger-store.js";
import { addDep } from "../src/lib/ledger-deps-write.js";
import { createItem, importTask, setMeta } from "../src/lib/ledger-write.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Principal } from "../src/lib/principals.js";
import { homeView, type LedgerOverview, type LedgerTaskView } from "../web/features/collab/collab-model";
import { stepLineView } from "../web/features/collab/collab-step-line-model";
import { causalCanvas } from "../web/features/collab/v4/causal-model";
import { filterCount, FILTERS, metricsOf, stageCounts } from "../web/features/collab/v4/v4-model";
import { chainLoadMore, chainOnOverview, chainOnPage, newChain, type DoneChain } from "../web/lib/api/ledger-done";
import { seedLedger, tempLedgerPath } from "./ledger-test-helpers.js";

const H = 3_600_000, MIN = 60_000;
const NOW = Date.UTC(2026, 9, 2, 4);
const OWNER = { actor: "owner", now: NOW - 30 * 86_400_000 };
const DONE_STAGES = ["verified", "done", "cancelled"] as const;
const LIVE_STAGES = ["build", "review", "fix", "merge", "live"] as const;

afterEach(() => closeLedger(":memory:"));

/** 一张卡：在 review 建、end 时刻进最终阶段；带一轮审查、一条备注、五个步骤行（体量和生产的一张卡相当） */
function card(db: Database, id: string, stage: string, end: number, item: string | null): void {
  importTask(db, OWNER, {
    createdTs: end - 3 * H, initialStage: "review",
    events: [
      { kind: "review", ts: end - 30 * MIN, text: `第 1 轮审查：P1 两处\n${"细节".repeat(20)}`, data: { round: 1, verdict: "changes", p0: 0, p1: 2, p2: 1 } },
      ...(stage === "review" ? [] : [{ kind: "stage" as const, ts: end, data: { from: "review", to: stage } }]),
      { kind: "note", ts: end + MIN, text: `执行者回报：${"进展说明。".repeat(4)}`, data: {} },
    ],
    task: {
      project: "p", id, itemId: item ?? undefined, stage: stage as never, title: `${id} 一张卡的标题大约二十个汉字那么长`, kind: "code",
      agent: `agent-task-${id}`, pm: "agent-claudestra", pr: `https://github.com/o/r/pull/${id.length}`, extra: { goal: "目标句。" },
    },
  });
  db.run("UPDATE tasks SET updatedAt = ? WHERE id = ?", [end + MIN, id]);
  for (const [step, round] of [["write", 0], ["review", 1], ["fix", 1], ["final_review", 2], ["merge", 0]] as const) {
    db.run(`INSERT INTO task_steps (taskId, step, round, executor, executorKind, state, headFrom, headTo, verdict, verified, claims, rev, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, 'agent', 'done', NULL, NULL, NULL, '{}', '{}', 1, ?, ?)`, [id, step, round, `agent-task-${id}`, end - H, end - H]);
  }
}

/** live 张在跑卡 + done 张已完成卡（全部完成于 2 天以前，按 37 分钟一张往前铺；每 7 张里有 3 张同一毫秒完成） */
function fixture(done: number, live = 30): Database {
  const db = openLedger(":memory:");
  for (let i = 0; i < 6; i++) createItem(db, OWNER, { project: "p", id: `i${i}`, title: `事项 ${i}`, status: "doing", oneLine: "一句话目标" });
  for (let n = 0; n < live; n++) card(db, `l${n}`, LIVE_STAGES[n % LIVE_STAGES.length]!, NOW - (n + 1) * 7 * MIN, `i${n % 6}`);
  for (let k = 0; k < done; k++) card(db, `d${String(k).padStart(4, "0")}`, DONE_STAGES[k % 3]!, NOW - 2 * 86_400_000 - Math.floor(k / 3) * 37 * MIN, `i${k % 6}`);
  for (let k = 0; k < 5 && k * 9 < done && k < live; k++) addDep(db, OWNER, { from: `d${String(k * 9).padStart(4, "0")}`, to: `l${k}`, when: "前置上线" });
  return db;
}

const wire = (v: object) => Buffer.byteLength(JSON.stringify({ ok: true, project: "p", exists: true, schema: LEDGER_SCHEMA_VERSION, projectEventsLimit: 20, ...v, now: NOW }));
const compactIds = (db: Database) => (db.query("SELECT id FROM tasks WHERE stage IN ('verified', 'done', 'cancelled')").all() as { id: string }[]).map((r) => r.id).sort();

/** 从总览的游标一路翻到底：每页的 id、和窗口并起来的全集 */
function walk(db: Database, limit: number) {
  const view = projectView(db, "p", NOW);
  const pages: string[][] = [];
  let before = view.doneCursor;
  while (before) {
    const page = donePage(db, "p", parseDoneCursor(before), limit, NOW);
    pages.push(page.tasks.map((t) => t.id));
    expect(page.tasks.every((t) => (t.stepLine?.steps.length ?? 0) > 0 && !("extra" in t))).toBe(true);
    before = page.nextCursor;
  }
  return { view, pages, windowIds: view.tasks.filter((t) => DONE_STAGES.includes(t.stage as never)).map((t) => t.id) };
}

describe("总览窗口", () => {
  test("500 张已完成 + 30 张在跑 vs 50 张：总览字节差 < 5KB；窗口 = 最近 30 张 ∪ 连着在跑卡的", () => {
    // openLedger(":memory:") 按路径缓存同一个库：量完一份关掉再造下一份
    const vs = projectView(fixture(50), "p", NOW);
    closeLedger(":memory:");
    const vb = projectView(fixture(500), "p", NOW);
    console.log(`overview bytes: 50 done=${wire(vs)} 500 done=${wire(vb)} diff=${wire(vb) - wire(vs)}`);
    expect(Math.abs(wire(vb) - wire(vs))).toBeLessThan(5_000);
    for (const v of [vs, vb]) {
      const done = v.tasks.filter((t) => DONE_STAGES.includes(t.stage as never));
      expect(v.tasks.filter((t) => !DONE_STAGES.includes(t.stage as never))).toHaveLength(30);
      // 依赖边连着的 d0000 / d0009 / … 都在窗口里（最近 30 张之外的也在）
      for (let k = 0; k < 5; k++) expect(done.map((t) => t.id)).toContain(`d${String(k * 9).padStart(4, "0")}`);
      expect(done.length).toBeLessThanOrEqual(DONE_RECENT + 5);
      // 都是两天前完成的：不算今天，不带小圆点 / 最近事件
      expect(done.every((t) => !("stepLine" in t) && !("lastEvent" in t))).toBe(true);
    }
    expect(vb.doneRest.n).toBe(500 - vb.tasks.filter((t) => DONE_STAGES.includes(t.stage as never)).length);
    expect(vb.doneRest.groups.reduce((s, g) => s + g.n, 0)).toBe(vb.doneRest.n);
    expect(Object.values(vb.doneRest.byItem).reduce((s, m) => s + Object.values(m).reduce((a, b) => a + (b ?? 0), 0), 0)).toBe(vb.doneRest.n);
  });

  test("未满足前置 50 / 500 张：每张卡最多 10 个阻塞 ID、总览字节封顶，详情保留全量", () => {
    const sample = (n: number) => {
      const db = fixture(0, 1);
      const ids = Array.from({ length: n }, (_, k) => `cancelled-card-${String(k).padStart(4, "0")}`);
      for (const [k, id] of ids.entries()) {
        card(db, id, "cancelled", NOW - 48 * H - k * MIN, "i0");
        addDep(db, OWNER, { from: id, to: "l0", when: "前置上线" });
      }
      // 已完成卡也可能有未满足前置：总览所有卡都要限长。
      for (const id of ids.slice(1)) addDep(db, OWNER, { from: id, to: ids[0]!, when: "前置上线" });
      const view = projectView(db, "p", NOW);
      const live = view.tasks.find((t) => t.id === "l0")!;
      const done = view.tasks.find((t) => t.id === ids[0])!;
      expect([live.blockedBy, live.blockedByMore, live.runnable]).toEqual([ids.slice(0, 10), n - 10, false]);
      expect([done.blockedBy.length, done.blockedByMore, done.runnable]).toEqual([10, n - 11, false]);
      expect(view.tasks.every((t) => t.blockedBy.length <= 10)).toBe(true);
      const detail = taskDetail(db, "p", "l0", NOW)!;
      expect(detail.task.blockedBy).toEqual(ids);
      expect(detail.task.runnable).toBe(false);
      expect(detail.deps.in).toHaveLength(n);
      expect("blockedByMore" in detail.task).toBe(false);
      expect(wire(view)).toBeLessThan(35_000);
      closeLedger(":memory:");
      return view;
    };
    const small = sample(50), large = sample(500);
    console.log(`waiting overview bytes: 50=${wire(small)} 500=${wire(large)} diff=${wire(large) - wire(small)}`);
    expect(Math.abs(wire(large) - wire(small))).toBeLessThan(5_000);
  });

  test("今日完成与最近窗口共用 30 张上限、只有今天的带小圆点；不足补到 30；没有更早的 = doneCursor null", () => {
    const db = fixture(0, 0);
    for (let k = 0; k < 60; k++) card(db, `t${k}`, "verified", NOW - k * 30 * MIN, "i0");
    const ids = (n: number) => Array.from({ length: n }, (_, k) => `t${k}`).sort();
    const dotted = (v: ReturnType<typeof projectView>) => v.tasks.filter((t) => t.stepLine && t.lastEvent).map((t) => t.id).sort();
    const long = projectView(db, "p", NOW, NOW - 20 * H); // 0 … 40 号在 20 小时内
    expect([long.tasks.map((t) => t.id).sort(), dotted(long)]).toEqual([ids(DONE_RECENT), ids(DONE_RECENT)]);
    const short = projectView(db, "p", NOW, NOW - 2 * H); // 今天只有 0 … 4 号
    expect([short.tasks.map((t) => t.id).sort(), dotted(short)]).toEqual([ids(DONE_RECENT), ids(5)]);
    expect(long.doneCursor).not.toBeNull();
    closeLedger(":memory:");
    const all = projectView(fixture(3, 0), "p", NOW);
    expect([all.doneCursor, all.doneRest.n, all.doneRest.groups]).toEqual([null, 0, []]);
  });

  test.each(["deps", "today"] as const)("%s：500 vs 50 张字节差 < 5KB；只带窗口内的边，溢出卡分页仍有步骤点", (mode) => {
    const sample = (n: number) => {
      const db = fixture(0, mode === "deps" ? 1 : 30);
      for (let k = 0; k < n; k++) {
        const id = `c${String(k).padStart(4, "0")}`;
        card(db, id, "verified", NOW - (mode === "deps" ? 48 * H : 0) - k * MIN, "i0");
        // 今日窗口外再挂 30 张依赖卡，也不能把今日完成扩到 60 张。
        if (mode === "deps" || k >= DONE_RECENT) addDep(db, OWNER, { from: id, to: "l0", when: "前置完成" });
      }
      const view = projectView(db, "p", NOW, NOW - 20 * H);
      const ids = new Set(view.tasks.map((t) => t.id));
      expect(view.tasks.filter((t) => t.stage === "verified")).toHaveLength(DONE_RECENT);
      expect(view.doneRest.n).toBe(n - DONE_RECENT);
      expect(view.deps.every((d) => ids.has(d.from) && ids.has(d.to))).toBe(true);
      expect(view.deps).toHaveLength(mode === "deps" ? DONE_RECENT : 0);
      expect(view.tasks.find((t) => t.id === "l0")?.runnable).toBe(true);
      const page = donePage(db, "p", parseDoneCursor(view.doneCursor!), 10, NOW);
      expect(page.tasks.map((t) => t.id)).toEqual(Array.from({ length: 10 }, (_, k) => `c${String(k + DONE_RECENT).padStart(4, "0")}`));
      expect(page.tasks.every((t) => stepLineView(t.stepLine, t.stage)?.slots.some((s) => s.filled))).toBe(true);
      closeLedger(":memory:");
      return view;
    };
    const small = sample(50), large = sample(500);
    console.log(`${mode} overview bytes: 50=${wire(small)} 500=${wire(large)} diff=${wire(large) - wire(small)}`);
    expect(Math.abs(wire(large) - wire(small))).toBeLessThan(5_000);
  });

  test("独立历史依赖窗口按完成时间取最近 30 张，两方向都封顶；被省略的边仍在详情里", () => {
    const db = fixture(100, 2);
    for (let k = 40; k < 100; k++) {
      const id = `d${String(k).padStart(4, "0")}`;
      addDep(db, OWNER, k % 2 ? { from: id, to: "l0", when: "历史前置" } : { from: "l1", to: id, when: "历史后续" });
    }
    const view = projectView(db, "p", NOW);
    const done = view.tasks.filter((t) => DONE_STAGES.includes(t.stage as never));
    expect(done.length).toBeLessThanOrEqual(2 * DONE_RECENT);
    expect(done.some((t) => t.id === "d0040")).toBe(true);
    expect(done.some((t) => t.id === "d0099")).toBe(false);
    expect(view.deps.every((d) => view.tasks.some((t) => t.id === d.from) && view.tasks.some((t) => t.id === d.to))).toBe(true);
    expect(taskDetail(db, "p", "l0", NOW)!.deps.in.some((d) => d.from === "d0099")).toBe(true);
  });
});

describe("分页", () => {
  test.each([7, 50, 100])("每页 %i 张：游标连续、页内页间不重复，并上窗口 = 全部已完成卡", (limit) => {
    const db = fixture(500);
    const { pages, windowIds } = walk(db, limit);
    const flat = pages.flat();
    expect(new Set(flat).size).toBe(flat.length);
    expect(pages.slice(0, -1).every((p) => p.length === limit)).toBe(true);
    expect([...new Set([...windowIds, ...flat])].sort()).toEqual(compactIds(db));
    // 次序：完成时刻倒序（d 编号每 3 张一组，组号越大完成越早）、同一毫秒的三张按 id 倒序
    const key = (id: string) => [Math.floor(Number(id.slice(1)) / 3), id] as const;
    const late = flat.filter((id) => !windowIds.includes(id));
    expect(late).toEqual([...late].sort((a, b) => key(a)[0] - key(b)[0] || (a < b ? 1 : -1)));
  });

  test("before = null 从最新一张起；游标格式不对 = null", () => {
    const db = fixture(40);
    const first = donePage(db, "p", null, 5, NOW);
    expect(first.tasks.map((t) => t.id)).toEqual(["d0002", "d0001", "d0000", "d0005", "d0004"]);
    for (const bad of ["", "abc", "12", ":x", "-1:x", "1.5:x", "99999999999999999:x"]) expect(parseDoneCursor(bad)).toBeNull();
    expect(parseDoneCursor("12:a:b")).toEqual({ at: 12, id: "a:b" });
  });

  test("窗口外的已完成节点在子 DAG 看板上状态照旧（看板按库里的卡读，不靠总览的卡列表）", async () => {
    const db = fixture(200);
    const view = projectView(db, "p", NOW);
    const out = compactIds(db).filter((id) => !view.tasks.some((t) => t.id === id)).slice(0, 3);
    expect(out).toHaveLength(3);
    const run = (...args: string[]) => runLedger(args, {
      db, actor: "agent-claudestra", actorProject: "p", projectIds: ["p"], now: () => NOW,
      loadRegistry: async () => ({ socket: "", agents: {} }) as never, saveRegistry: async () => {}, notifyOwner: async () => true,
    }) as Promise<Record<string, unknown>>;
    setMeta(db, OWNER, { project: "p", key: "pms", value: ["agent-claudestra"] });
    expect((await run("feature-new", "i28", "--title", "协作底座")).ok).toBe(true);
    const nodes = [...out.map((id) => ({ key: id, taskId: id, oneLine: id, deps: [] })), { key: "L", taskId: "l1", oneLine: "在跑", deps: [out[0]] }];
    expect((await run("dag-init", "i28", "--rev", "1", "--nodes", JSON.stringify(nodes)))).toMatchObject({ ok: true });
    const board = db.transaction(() => dagBoard(db, "p", NOW)).deferred();
    const stage = (id: string) => (db.query("SELECT stage FROM tasks WHERE id = ?").get(id) as { stage: string }).stage;
    for (const id of out) {
      const n = board.features[0]!.nodes.find((x) => x.key === id)!;
      expect([n.status as string, n.missing]).toEqual([stage(id), false]);
      expect(n.phase).toBe(stage(id) === "cancelled" ? n.phase : "done");
    }
  });
});

describe("跨时区今日完成", () => {
  const TZ = process.env.TZ;
  afterAll(() => {
    process.env.TZ = TZ;
  });
  test("服务器 Asia/Shanghai 生成、浏览器 America/Los_Angeles 消费：今日完成卡带步骤小点（V1h r2 探针）", () => {
    const now = Date.parse("2026-10-02T01:00:00Z");
    const db = openLedger(":memory:");
    card(db, "complete", "verified", Date.parse("2026-10-01T15:30:00Z"), null);
    process.env.TZ = "America/Los_Angeles";
    const browserMidnight = new Date(now);
    browserMidnight.setHours(0, 0, 0, 0); // web/lib/api/ledger.ts fetchLedger 带上的 dayStart
    process.env.TZ = "Asia/Shanghai";
    // 不带 dayStart（老网页）按服务器零点：这张在服务器看是昨天，不带小圆点——就是 V1h r2 报的现象
    expect(projectView(db, "p", now).tasks[0]).not.toHaveProperty("stepLine");
    expect(dayStartOf(now, null)).toBe(Date.parse("2026-10-01T16:00:00Z"));
    const view = projectView(db, "p", now, browserMidnight.getTime());
    process.env.TZ = "America/Los_Angeles";
    const ov = JSON.parse(JSON.stringify({ exists: true, now, ...view })) as LedgerOverview;
    const hv = homeView(ov, now);
    expect(hv.todayDone).toEqual(["complete"]);
    const dots = stepLineView(ov.tasks[0]!.stepLine, "verified");
    expect(dots?.slots.filter((s) => s.filled).length).toBeGreaterThan(0);
  });
});

describe("GET /ledger/:project/done", () => {
  const root = mkdtempSync(join(tmpdir(), "ledger-done-"));
  const dbPath = tempLedgerPath();
  const OWNER_P: Principal = { id: "token:tok_old", role: "external", agents: ["*"], createdAt: "2026-09-28T00:00:00Z" };
  beforeAll(() => {
    writeFileSync(join(root, "projects.json"), JSON.stringify({ projects: [{ id: "p", name: "P", dirs: [] }] }));
    setLedgerApiProjectsForTest(join(root, "projects.json"));
    seedLedger(dbPath);
    setLedgerFeedForTest({ path: dbPath, emit: () => {} });
  });
  afterAll(() => {
    setLedgerApiProjectsForTest(undefined);
    setLedgerFeedForTest(undefined);
    closeLedger(dbPath);
  });
  const get = async (q: string) => {
    const res = (await handleLedgerApi(new Request(`http://bridge.local/api/v1/ledger/p/done${q}`), "/ledger/p/done", OWNER_P))!;
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  test("缺省从最新一张起；坏游标、坏 limit 回 400；总览带 doneCursor / doneRest", async () => {
    const ok = await get("");
    expect(ok.status).toBe(200);
    expect(ok.body.tasks.map((t: { id: string }) => t.id)).toEqual(["T2"]);
    expect(ok.body.nextCursor).toBeNull();
    expect((await get("?before=1:T2&limit=500")).body.tasks).toEqual([]);
    for (const q of ["?before=x", "?limit=0", "?limit=abc", "?limit=1.5"]) expect((await get(q)).status).toBe(400);
    // 总览：dayStart 乱传当没传（不因为它失败）
    for (const q of ["", "?dayStart=abc", "?dayStart=-5", `?dayStart=${Date.now()}`]) {
      const ov = (await handleLedgerApi(new Request(`http://bridge.local/api/v1/ledger/p${q}`), "/ledger/p", OWNER_P))!;
      expect([ov.status, await ov.json()]).toMatchObject([200, { doneCursor: null, doneRest: { n: 0, groups: [], byItem: {} } }]);
    }
    expect(dayStartOf(NOW, NOW - 40 * H)).toBe(dayStartOf(NOW, null)); // 离 now 太远：按服务器零点
  });
});

const asWire = (v: object) => JSON.parse(JSON.stringify({ exists: true, now: NOW, ...v })) as LedgerOverview;

describe("网页：窗口 + doneRest 和全量一致", () => {
  test("筛选芯片、指标条、阶段列、画布框角 ✓ N 和老 bridge 的全量总览算出来一样", () => {
    const db = fixture(300);
    const view = projectView(db, "p", NOW);
    const rest = donePage(db, "p", null, 10_000, NOW).tasks.filter((t) => !view.tasks.some((x) => x.id === t.id));
    const { doneCursor: _c, doneRest: _r, ...old } = view;
    const full = asWire({ ...old, tasks: [...view.tasks, ...rest] });
    const slim = asWire(view);
    expect(slim.tasks.length).toBeLessThan(full.tasks.length / 4);
    for (const f of FILTERS) expect([f, filterCount(slim, f)]).toEqual([f, filterCount(full, f)]);
    expect(metricsOf(slim, 0, 1)).toEqual(metricsOf(full, 0, 1));
    expect(stageCounts(slim)).toEqual(stageCounts(full));
    const ticks = (ov: LedgerOverview) => causalCanvas(ov).groups.map((g) => [g.id, g.done]);
    expect(ticks(slim)).toEqual(ticks(full));
  });
});

describe("网页：翻页状态机（collab-done.tsx 的 useDonePages 只做接线）", () => {
  /** 按单子向「服务端」要一页，直到这一单结清 */
  const settle = (db: Database, c: DoneChain, ov: LedgerOverview): DoneChain => {
    for (let i = 0; c.job && i < 50; i++) c = chainOnPage(c, donePage(db, "p", parseDoneCursor(c.job.before), 7, NOW), ov);
    return c;
  };
  const shownIds = (ov: LedgerOverview, c: DoneChain) => [...ov.tasks, ...c.pages].filter((t) => DONE_STAGES.includes(t.stage as never)).map((t) => t.id);

  test("翻两页 → 新完成 9 张（窗口往新挪）→ 补段 → 翻到底：并起来 = 全部已完成卡，页里不重复、不和总览重叠", () => {
    const db = fixture(120);
    let ov = asWire(projectView(db, "p", NOW));
    let c = newChain(ov);
    for (let i = 0; i < 2; i++) c = settle(db, chainLoadMore(c)!, ov);
    expect(c.pages.length).toBeGreaterThan(10); // 两页 14 张，减去连着在跑卡、本来就在窗口里的
    for (let k = 0; k < 9; k++) card(db, `n${k}`, "verified", NOW - 3 * 86_400_000 + 1 + k, "i0"); // 比窗口新、比页旧：插在中间
    for (let k = 0; k < 9; k++) card(db, `m${k}`, "done", NOW - 26 * H - k, "i1"); // 比窗口里最旧的还新：把窗口往新挤
    ov = asWire(projectView(db, "p", NOW));
    c = chainOnOverview(c, ov);
    expect(c.job?.kind).toBe("gap");
    c = settle(db, c, ov);
    while (c.next) c = settle(db, chainLoadMore(c)!, ov);
    const ids = shownIds(ov, c);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(compactIds(db));
    expect(c.pages.some((t: LedgerTaskView) => ov.tasks.some((x) => x.id === t.id))).toBe(false);
  });

  test("还没翻过页时窗口挪了只换起点；老 bridge（没有 doneCursor）不翻", () => {
    const db = fixture(60);
    const ov = asWire(projectView(db, "p", NOW));
    const c = chainOnOverview(newChain({ doneCursor: "1:x" }), ov);
    expect(c.job).toBeNull();
    expect(c.next).toBe(ov.doneCursor!);
    expect(chainLoadMore(newChain({}))).toBeNull(); // 老 bridge：总览没有 doneCursor
  });
});
