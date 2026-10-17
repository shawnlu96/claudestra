/**
 * agents-LEDGERFAST1：总览 / 已完成分页 / 产品板不再逐条读全部历史事件。
 * [验收线 1] 合成台账（330 张卡、各阶段、完成窗口内外、今天和更早完成、依赖边、导入近似时间、残缺事件，3 万+ 条事件）上，
 *   新读法与下面保留的旧读法（改前 src 原样抄来）JSON.stringify 逐字节相同。
 * [验收线 2] 再给窗口外已结束的卡追加 10 万条历史事件：稳态（PM 补 10-17 22:5x）下新读法总览、产品板各自读进 JS 的行数增幅 ≤ 20%，
 *   且执行的 SQL 没有一条整表扫 events（EXPLAIN QUERY PLAN 无 SCAN events，读事件只走索引）；旧读法跟着历史线性涨。用行数断言，不用墙钟。
 * 每卡事实表（ledger-read-fast-memo.ts）：冷启动与命中输出逐字节相同，只给一张卡追加事件后下一次只重读这一张。
 */
import type { Database, Statement } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { actionCtx, withActionState } from "../src/lib/ledger-action-state.js";
import { attentionCtx, withAttentionFacts, type AttentionCtx } from "../src/lib/ledger-attention-facts.js";
import { hasFeatureSchema } from "../src/lib/ledger-dag-board.js";
import { nodePhase } from "../src/lib/ledger-dag-rules.js";
import { depViews } from "../src/lib/ledger-deps.js";
import { featureDeps } from "../src/lib/ledger-feature-deps.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { effectiveNodes, getDagVersion, type Feature } from "../src/lib/ledger-feature.js";
import { nodeCounts, productBoard } from "../src/lib/ledger-product-board.js";
import { productFeatureCards } from "../src/lib/ledger-product-board-cards.js";
import { productEdges } from "../src/lib/ledger-product-board-edges.js";
import { deferredNode, featureEta, phase, projectPace, propagateEtas, type EtaNode } from "../src/lib/ledger-product-board-eta.js";
import { productFrontier } from "../src/lib/ledger-product-board-frontier.js";
import { projectView, PROJECT_EVENTS_LIMIT, type ProjectView } from "../src/lib/ledger-read.js";
import { compactStage, doneCard, eventsByTarget, liveCard, overviewCard, taskView, type TaskView } from "../src/lib/ledger-read-cards.js";
import { dayStartOf, donePage, doneWindow, parseDoneCursor } from "../src/lib/ledger-read-done.js";
import type { LedgerEvent } from "../src/lib/ledger-stages.js";
import { listSteps, stepsByTask } from "../src/lib/ledger-steps.js";
import { stepLineInfo } from "../src/lib/ledger-step-line.js";
import { closeLedger, getMeta, listDeps, listEvents, listItems, listTasks, openLedger, toEvent } from "../src/lib/ledger-store.js";
import { openFindings } from "../src/lib/ledger-audit-store.js";
import { projectMapConfig } from "../src/lib/project-map-config.js";
import { isSourceAcceptedNode, pageAcceptedBySource } from "../src/lib/ui-page-display.js";

// ── 旧读法：改前 src/lib/ledger-read.ts projectViewSnapshot、ledger-read-done.ts donePage、ledger-product-board.ts productBoard 原样 ──

function oldProjectView(db: Database, project: string, now: number, clientDayStart: number | null, facts: AttentionCtx): ProjectView {
  return db.transaction(() => {
    const dayStart = dayStartOf(now, clientDayStart);
    const byTarget = eventsByTarget(listEvents(db, { project }));
    const recent = db
      .query(`SELECT * FROM events WHERE project = ? AND target = '' AND kind NOT IN ('ask', 'ask_expire', 'ask_cancel', 'ask_reopen')
        AND NOT (kind = 'decision' AND json_extract(data, '$.askId') IS NOT NULL) ORDER BY seq DESC LIMIT ?`)
      .all(project, PROJECT_EVENTS_LIMIT) as Record<string, unknown>[];
    const tasks = listTasks(db, project);
    const deps = depViews(listDeps(db, project), tasks);
    const rows = stepsByTask(db);
    const act = actionCtx(db, project, now);
    const views = tasks.map((t) => ((own) => withActionState(withAttentionFacts(taskView(t, own, now, deps), own, facts), own, act))(byTarget.get(t.id) ?? []));
    const win = doneWindow(views.filter((v) => compactStage(v.stage)), deps, dayStart);
    const visible = new Set(views.filter((v) => !compactStage(v.stage) || win.keep.has(v.id)).map((v) => v.id));
    const line = (v: TaskView) => stepLineInfo(v, rows.get(v.id) ?? [], byTarget.get(v.id) ?? []);
    return {
      meta: getMeta(db, project),
      items: listItems(db, project).map((i) => ({ id: i.id, title: i.title, oneLine: i.oneLine })),
      tasks: views.flatMap((v) => (!compactStage(v.stage) ? [liveCard(v, line(v))] : win.keep.has(v.id) ? [doneCard(v, win.today.has(v.id) ? line(v) : null)] : [])).map(overviewCard),
      doneCursor: win.cursor,
      doneRest: win.rest,
      deps: deps.filter((d) => visible.has(d.from) && visible.has(d.to)),
      projectEvents: recent.reverse().map(toEvent),
      audit: openFindings(db, project),
    };
  }).deferred();
}

const doneAt = (v: TaskView): number => v.metrics.endTs ?? v.updatedAt;
const byDone = (a: TaskView, b: TaskView) => doneAt(b) - doneAt(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

function oldDonePage(db: Database, project: string, before: { at: number; id: string } | null, limit: number, now: number, facts: AttentionCtx) {
  return db.transaction(() => {
    const tasks = listTasks(db, project);
    const deps = depViews(listDeps(db, project), tasks);
    const done = tasks.filter((t) => compactStage(t.stage));
    const byTarget = eventsByTarget(listEvents(db, { project }), new Set(done.map((t) => t.id)));
    const act = actionCtx(db, project, now);
    const views = done.map((t) => ((own) => withActionState(withAttentionFacts(taskView(t, own, now, deps), own, facts), own, act))(byTarget.get(t.id) ?? []));
    const rest = views.filter((v) => !before || doneAt(v) < before.at || (doneAt(v) === before.at && v.id < before.id)).sort(byDone);
    const page = rest.slice(0, limit);
    return {
      tasks: page.map((v) => doneCard(v, stepLineInfo(v, listSteps(db, v.id), byTarget.get(v.id) ?? []))),
      nextCursor: rest.length > limit ? `${doneAt(page.at(-1)!)}:${page.at(-1)!.id}` : null,
    };
  }).deferred();
}

function oldProductBoard(db: Database, project: string, now: number) {
  const map = projectMapConfig(project), grouped = map.areas.length > 0;
  const areaOf = new Map(map.areas.flatMap((a) => a.features.map((id) => [id, a.id] as const)));
  const tasks = listTasks(db, project), own = new Map(tasks.map((t) => [t.id, t]));
  const events = new Map<string, LedgerEvent[]>();
  for (const e of listEvents(db, { project })) {
    const list = events.get(e.target) ?? []; list.push(e); events.set(e.target, list);
  }
  const fs = hasFeatureSchema(db) ? db.query("SELECT * FROM features WHERE project=? ORDER BY id").all(project) as Feature[] : [];
  const entries = fs.map((f) => {
    const v = f.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null;
    const accepted = !!v && pageAcceptedBySource(db, f, v.version);
    const nodes: EtaNode[] = v ? effectiveNodes(db, v).map((n) => ({ ...n, task: n.taskId ? own.get(n.taskId) ?? null : null,
      ...(accepted && isSourceAcceptedNode(n) ? { accepted: true } : {}) })) : [];
    return { f, nodes };
  });
  const all = entries.flatMap((e) => e.nodes), pace = projectPace(all, tasks, events, now);
  const active = all.filter((n) => !deferredNode(n) && phase(n) === "active").length;
  const features = entries.map(({ f, nodes }) => {
    const cards = f.currentVersion ? nodes.flatMap((n) => n.task ? [n.task] : []) : tasks.filter((t) => t.featureId === f.id);
    const counts = f.currentVersion ? nodeCounts(nodes) : { total: cards.length,
      completed: cards.filter((t) => nodePhase(t.id, t.stage) === "done").length,
      active: cards.filter((t) => nodePhase(t.id, t.stage) === "active").length, waiting: 0 };
    return { id: f.id, title: f.title, status: f.status, hasDag: f.currentVersion > 0, version: f.currentVersion,
      ...(!f.currentVersion ? { cards: productFeatureCards(tasks, project, f.id) } : {}), ...(grouped ? { area: areaOf.get(f.id) ?? null } : {}),
      counts, eta: f.currentVersion ? featureEta(nodes, pace, active, events, now) : null,
      lastActivityAt: cards.length ? Math.max(...cards.map((t) => t.updatedAt)) : null,
      ...productFrontier({ status: f.status, nodes: f.currentVersion ? nodes : null, cards, events, now, frozen: map.frozen }) };
  });
  const deps = featureDeps(db, project).map(({ from, to, note }) => ({ from, to, note }));
  propagateEtas(features, deps);
  return { throughput: { verified12h: pace.verified12h, perHour: pace.perHour }, features,
    ...(grouped ? { areas: map.areas.map(({ id, name }) => ({ id, name })) } : {}), ...productEdges(db, { project, deps, features, tasks, entries }) };
}

// ── 合成台账 ──

const H = 3_600_000, MIN = 60_000, DAY = 24 * H;
const NOW = Date.UTC(2026, 9, 17, 10);
const DAY_START = NOW - 6 * H;
const P = "p";
const LIVE = ["spec", "restate", "build", "review", "fix", "merge", "live", "blocked"] as const;
const DONE = ["verified", "done", "cancelled"] as const;

/** 可复现的伪随机 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function seed(db: Database): void {
  const rand = rng(7), pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const ev = db.prepare("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const add = (ts: number, target: string, kind: string, data: Record<string, unknown> = {}, text = "", project = P) =>
    ev.run(ts, pick(["owner", "agent-a", "agent-b", "scheduler"]), project, target, kind, text, JSON.stringify(data));
  for (const i of ["i1", "i2", "i3"]) db.run("INSERT INTO items (project, id, title, status, createdAt, updatedAt) VALUES (?, ?, ?, 'doing', 0, 0)", [P, i, `事项 ${i}`]);
  const ids: string[] = [];
  for (let n = 0; n < 330; n++) {
    const id = `T${String(n).padStart(3, "0")}`;
    ids.push(id);
    // 前 230 张已结束：完成时刻铺在近 12 天，今天完成的若干；每 9 张里 3 张同一毫秒完成
    const done = n < 230;
    const stage = done ? DONE[n % 3]! : LIVE[n % LIVE.length]!;
    const kind = pick(["code", "code", "investigate", "ops"] as const);
    const end = done ? (n % 9 < 3 ? NOW - 2 * DAY : NOW - Math.floor(rand() * 12 * DAY)) : NOW;
    const start = end - (2 + Math.floor(rand() * 40)) * H;
    const approx = n % 17 === 0;
    db.run(`INSERT INTO tasks (id, project, itemId, title, kind, stage, stageBefore, round, agent, pm, pr, extra, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, P, n % 4 === 3 ? null : pick(["i1", "i2", "i3"]), `${id} 标题`, kind, stage,
      stage === "blocked" ? "build" : null, n % 4, n % 5 ? `agent-task-${id}` : null, "agent-pm", n % 3 ? `https://github.com/o/r/pull/${n}` : null,
      JSON.stringify(n % 6 ? { goal: `目标 ${id}`, fileGlobs: ["a"] } : {}), start, end + (n % 7) * MIN]);
    // 建任务：有的直接落在 review（导入），有的缺省 spec
    add(start, id, "task", { op: "new", ...(n % 5 === 0 ? { patch: { stage: "review" } } : n % 11 === 0 ? { patch: null } : {}), ...(approx ? { approxTime: true } : {}) });
    let ts = start, cur: string = n % 5 === 0 ? "review" : "spec";
    const move = (to: string | undefined, at = (ts += Math.floor(rand() * 2 * H) + 1)) => {
      add(at, id, "stage", { from: cur, ...(to === undefined ? {} : { to }), ...(approx ? { approxTime: true } : {}) });
      if (to) cur = to;
    };
    const path = ["restate", "build", "review", "fix", "review", "merge", "live"];
    // 开工的第一个取点是残缺 stage 事件（没有 to），紧跟一次 cancelled：开工时刻按它算，取消的卡完成时刻就落在这次 cancelled 上
    if (n % 23 === 0) move(undefined), move("cancelled", ts + 1), cur = "spec";
    const until = done ? path.length : (LIVE.indexOf(stage as never) + n) % path.length;
    for (const to of path.slice(0, until)) {
      move(to);
      for (let k = 0; k < 10 + Math.floor(rand() * 40); k++) {
        const t = (ts += Math.floor(rand() * 5 * MIN));
        const r = rand();
        if (r < 0.25) add(t, id, "note", {}, `备注\n第二行 ${k}`);
        else if (r < 0.4) add(t, id, "step", { op: pick(["assign", "done", "claim"]), step: pick(["write", "review", "final_review", "merge"]),
          executor: pick(["agent-a", "x@peer1", "local:me"]), executorKind: pick(["agent", "peer", "human"]) });
        else if (r < 0.55) add(t, id, "scheduler", { op: pick(["plan", "session_bind", "session_retire", "tick"]), role: "reviewer", agent: "agent-r", id: `i:r${k}:x` });
        else if (r < 0.65) add(t, id, "deliver", { headSHA: `h${k}` });
        else if (r < 0.75) add(t, id, "review", { round: k, verdict: pick(["pass", "changes", "block"]), reviewer: "agent-r",
          p0: pick([0, 1, 2, "3", null]), p1: pick([0, 1, 4, 1.5]), p2: 1 }, `第 ${k} 轮\n细节`);
        else if (r < 0.8) add(t, id, "ask", { askId: `a${k}` });
        else if (r < 0.85) add(t, id, "decision", { askId: `a${k}` });
        else if (r < 0.9) add(t, id, "dep", { op: "add" });
        else if (r < 0.95) add(t, id, "rollback", { result: "fail" }, "回滚");
        else add(t, id, "verify", { result: pick(["pass", "fail"]) });
      }
      if (n % 13 === 0 && to === "build") move(undefined); // 残缺 stage 事件（没有 to）
      if (n % 19 === 0 && to === "review") move("blocked"), move("review");
    }
    if (done) {
      // 有的卡先进过一次 verified 又回退（重复验收）；有的结束标记时刻早于开工（导入时间倒挂）
      if (n % 8 === 0) move("verified", start - H), move("live");
      move(stage, end);
      if (n % 10 === 0) add(end + 2 * MIN, id, "note", {}, "完成后补的备注");
    } else if (stage !== cur) move(stage);
  }
  // 依赖边：已结束 → 在跑、在跑 → 在跑、已结束 → 已结束
  const dep = db.prepare("INSERT OR IGNORE INTO task_deps (project, fromTask, toTask, kind, cond, state, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, 'blocks', '', NULL, 'owner', 0, 0)");
  for (let k = 0; k < 140; k++) {
    const a = pick(ids), b = pick(ids.slice(200));
    if (a !== b) dep.run(P, a, b);
  }
  for (let k = 0; k < 30; k++) dep.run(P, ids[k]!, ids[k + 40]!);
  // 步骤行
  const step = db.prepare(`INSERT OR IGNORE INTO task_steps (taskId, step, round, executor, executorKind, state, headFrom, headTo, verdict, verified, claims, rev, createdAt, updatedAt)
    VALUES (?, ?, ?, 'agent-a', 'agent', ?, NULL, NULL, NULL, '{}', '{}', 1, 0, 0)`);
  for (const id of ids) for (const [s, r] of [["write", 0], ["review", 1], ["fix", 1], ["merge", 0]] as const) if (rand() < 0.6) step.run(id, s, r, pick(["done", "active"]));
  // 项目级事件与别的项目
  for (let k = 0; k < 60; k++) add(NOW - k * MIN, "", pick(["freeze", "meta", "ask", "decision", "note"]), k % 3 ? {} : { askId: `x${k}` });
  for (let k = 0; k < 500; k++) add(NOW - k * MIN, pick(ids), "note", {}, "别的项目", "q");
  // 产品板：一个带 DAG 的 feature（绑了在跑、已结束、本项目没有的卡）+ 一个没 DAG、按卡算的 feature
  const ctx = { actor: "owner", now: NOW - 30 * DAY };
  const f = createFeature(db, ctx, { project: P, slug: "dag", title: "带 DAG" }).row;
  const nodes = ids.filter((_, i) => i % 7 === 0).map((id, i, all) => ({ key: `k${i}`, taskId: id, oneLine: i % 9 === 4 ? "（远期）以后" : `节点 ${i}`,
    estimate: pick(["S", "半天", "2 小时", "1–2 天", "?"]), deps: i > 2 ? [`k${i - 1 - (i % 3)}`] : [], ...(i === all.length - 1 ? {} : {}) }));
  initDag(db, ctx, { id: f.id, rev: 1, nodes: [...nodes, { key: "plan", oneLine: "没开卡的", deps: ["k1"] }] });
  // 全部完成的 DAG：完成时刻取各卡第一次进 verified / done，没有就取 done / cancelled
  const h = createFeature(db, ctx, { project: P, slug: "finished", title: "已完成" }).row;
  initDag(db, ctx, { id: h.id, rev: 1, nodes: ids.slice(0, 200).filter((_, i) => i % 11 === 2 && i % 7 !== 0).map((id, i) => ({ key: `d${i}`, taskId: id, oneLine: `完成 ${i}`, estimate: "S" })) });
  const g = createFeature(db, ctx, { project: P, slug: "cards", title: "按卡" }).row;
  db.run("UPDATE tasks SET featureId = ? WHERE project = ? AND CAST(substr(id, 2) AS INTEGER) % 5 = 1", [g.id, P]);
}

/** 读进 JS 的行数与执行过的 SQL：包住 query / prepare 出来的语句，数 all / get / values 的返回行，记下 SQL 和参数 */
function counting(db: Database): { db: Database; rows: () => number; sqls: () => { sql: string; args: unknown[] }[]; reset: () => void } {
  let rows = 0, sqls: { sql: string; args: unknown[] }[] = [];
  const wrap = (stmt: Statement, sql: string) => new Proxy(stmt, {
    get(t, k) {
      const v = Reflect.get(t, k, t);
      if (typeof v !== "function") return v;
      if (k === "all" || k === "values") return (...a: unknown[]) => { sqls.push({ sql, args: a }); const r = v.apply(t, a) as unknown[]; rows += r.length; return r; };
      if (k === "get") return (...a: unknown[]) => { sqls.push({ sql, args: a }); const r = v.apply(t, a); if (r) rows++; return r; };
      if (k === "run") return (...a: unknown[]) => { sqls.push({ sql, args: a }); return v.apply(t, a); };
      return v.bind(t);
    },
  });
  const proxy = new Proxy(db, {
    get(t, k) {
      const v = Reflect.get(t, k, t);
      if (typeof v !== "function") return v;
      if (k === "query" || k === "prepare") return (sql: string) => wrap(v.call(t, sql) as Statement, sql);
      return v.bind(t);
    },
  });
  return { db: proxy, rows: () => rows, sqls: () => sqls, reset: () => { rows = 0; sqls = []; } };
}

/** 执行过的 SQL 里有没有整表扫 events 的（EXPLAIN QUERY PLAN 出现 SCAN events）：有就返回那条 SQL */
function eventScans(db: Database, sqls: readonly { sql: string; args: unknown[] }[]): string[] {
  const out = new Set<string>();
  for (const { sql, args } of sqls) {
    if (!/\bevents\b/.test(sql)) continue;
    const plan = db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as never[])) as { detail: string }[];
    if (plan.some((p) => /^SCAN events\b/.test(p.detail))) out.add(sql);
  }
  return [...out];
}

const CARD_ROWS = /kind IN \('stage', 'review'\)/;

const json = (v: unknown) => JSON.stringify(v);
const facts: AttentionCtx = { frozen: new Set(["T205", "T301"]), spec: (id) => (id === "T290" ? "观察期 2 小时" : null) };

describe("LEDGERFAST1 总览 / 产品板收窄读法", () => {
  let db: Database;
  beforeAll(() => {
    db = openLedger(":memory:");
    seed(db);
  });
  afterAll(() => closeLedger(":memory:"));

  function expectSame(): void {
    for (const [now, dayStart] of [[NOW, DAY_START], [NOW, null], [NOW + 3 * DAY, null], [NOW - 5 * DAY, NOW - 5 * DAY - 2 * H]] as const) {
      expect(json(projectView(db, P, now, dayStart, facts))).toBe(json(oldProjectView(db, P, now, dayStart, facts)));
      expect(json(db.transaction(() => productBoard(db, P, now)).deferred())).toBe(json(db.transaction(() => oldProductBoard(db, P, now)).deferred()));
    }
    let cursor: string | null = null;
    for (let page = 0; page < 8; page++) {
      const before = cursor ? parseDoneCursor(cursor) : null;
      const fresh = donePage(db, P, before, 37, NOW, facts);
      expect(json(fresh)).toBe(json(oldDonePage(db, P, before, 37, NOW, facts)));
      cursor = fresh.nextCursor;
      if (!cursor) break;
    }
  }

  test("[验收线 1] 合成台账：新旧读法输出逐字节相同", () => {
    const n = (sql: string) => (db.query(sql).get() as { n: number }).n;
    expect(n("SELECT COUNT(*) AS n FROM tasks WHERE project = 'p'")).toBeGreaterThanOrEqual(300);
    expect(n("SELECT COUNT(*) AS n FROM events WHERE project = 'p'")).toBeGreaterThanOrEqual(30_000);
    for (const s of [...LIVE, ...DONE]) expect(n(`SELECT COUNT(*) AS n FROM tasks WHERE project = 'p' AND stage = '${s}'`)).toBeGreaterThan(0);
    const view = projectView(db, P, NOW, DAY_START, facts);
    const done = view.tasks.filter((t) => compactStage(t.stage));
    expect(done.some((t) => t.stepLine)).toBe(true); // 今天完成、带小圆点
    expect(done.some((t) => !t.stepLine)).toBe(true); // 窗口里更早完成的
    expect(view.doneRest.n).toBeGreaterThan(0); // 窗口外
    expect(view.doneCursor).not.toBeNull();
    expect(view.deps.length).toBeGreaterThan(0);
    const board = db.transaction(() => productBoard(db, P, NOW)).deferred();
    expect(board.features.length).toBe(3);
    expect(board.features.some((f) => f.eta?.done)).toBe(true);
    expect(board.features.some((f) => f.frontier.length > 0)).toBe(true);
    expectSame();
  }, 60_000);

  test("每卡事实表：冷启动与命中输出逐字节相同；只给一张卡追加事件，下一次只重读这一张", () => {
    const warm = counting(db);
    const build = (d: Database) => json([projectView(d, P, NOW, DAY_START, facts), d.transaction(() => productBoard(d, P, NOW)).deferred()]);
    const cold = build(warm.db);
    warm.reset();
    expect(build(warm.db)).toBe(cold);
    expect(warm.sqls().filter((q) => CARD_ROWS.test(q.sql)).length).toBe(0); // 全命中
    expect(build(counting(db).db)).toBe(cold); // 另一个句柄从冷启动起
    const shown = new Set(projectView(db, P, NOW, DAY_START, facts).tasks.map((t) => t.id));
    const [a, b] = listTasks(db, P).filter((t) => compactStage(t.stage) && !shown.has(t.id)).map((t) => t.id);
    const review = (id: string) => db.run("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, 'agent-r', 'p', ?, 'review', '', ?)", [NOW - 20 * DAY, id!, '{"p0":1,"p1":2}']);
    review(a!);
    warm.reset();
    const view = projectView(warm.db, P, NOW, DAY_START, facts);
    expect(warm.sqls().filter((q) => CARD_ROWS.test(q.sql)).map((q) => q.args[1])).toEqual([a]);
    expect(json(view)).toBe(json(oldProjectView(db, P, NOW, DAY_START, facts)));
    expect(json(view)).not.toBe(json(JSON.parse(cold)[0])); // 窗口外的审查计数跟着变了
    warm.reset();
    warm.db.transaction(() => productBoard(warm.db, P, NOW)).deferred();
    expect(warm.sqls().filter((q) => CARD_ROWS.test(q.sql)).length).toBe(0); // 总览那次已经重读过
    review(b!);
    warm.reset();
    const board = warm.db.transaction(() => productBoard(warm.db, P, NOW)).deferred();
    expect(warm.sqls().filter((q) => CARD_ROWS.test(q.sql)).map((q) => q.args[1])).toEqual([b]);
    expect(json(board)).toBe(json(db.transaction(() => oldProductBoard(db, P, NOW)).deferred()));
  }, 60_000);

  test("[验收线 2] 追加 10 万条已结束卡的历史：稳态下总览、产品板各自读的行数增幅 ≤ 20% 且不整表扫 events，旧读法线性涨", () => {
    // 新读法用同一个句柄（每卡事实表按库句柄记）；稳态 = 冷启动 / 追加后的第一次之后的请求
    const fresh = counting(db);
    const steady = () => {
      fresh.reset();
      projectView(fresh.db, P, NOW, DAY_START, facts);
      const view = { rows: fresh.rows(), sqls: fresh.sqls() };
      fresh.reset();
      fresh.db.transaction(() => productBoard(fresh.db, P, NOW)).deferred();
      const board = { rows: fresh.rows(), sqls: fresh.sqls() };
      expect(eventScans(db, view.sqls)).toEqual([]);
      expect(eventScans(db, board.sqls)).toEqual([]);
      return { view: view.rows, board: board.rows };
    };
    const oldRows = () => {
      const old = counting(db);
      oldProjectView(old.db, P, NOW, DAY_START, facts);
      old.db.transaction(() => oldProductBoard(old.db, P, NOW)).deferred();
      return old.rows();
    };
    steady(); // 冷启动：逐卡读一遍，随历史线性（可接受）
    const before = { ...steady(), old: oldRows() };
    const shown = new Set(projectView(db, P, NOW, DAY_START, facts).tasks.map((t) => t.id));
    const history = listTasks(db, P).filter((t) => compactStage(t.stage) && !shown.has(t.id)).map((t) => t.id);
    expect(history.length).toBeGreaterThan(100);
    const ev = db.prepare("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, 'agent-a', 'p', ?, ?, '历史', ?)");
    const kinds = ["note", "step", "scheduler", "deliver", "review", "ci"];
    db.transaction(() => {
      const data = (i: number) => JSON.stringify({ op: "assign", executor: "agent-a", executorKind: "agent", p0: i % 2, p1: 1 });
      for (let i = 0; i < 100_000; i++) ev.run(NOW - 20 * DAY + i, history[i % history.length]!, kinds[i % kinds.length]!, data(i));
    })();
    steady(); // 追加后的第一次：只重读来了新事件的卡
    const after = { ...steady(), old: oldRows() };
    console.log(`rows read (steady): view ${before.view} → ${after.view}, board ${before.board} → ${after.board}, old ${before.old} → ${after.old}`);
    expect(after.view).toBeLessThanOrEqual(before.view * 1.2);
    expect(after.board).toBeLessThanOrEqual(before.board * 1.2);
    expect(after.old).toBeGreaterThan(before.old * 1.2); // 旧读法在同一条线上是红的
    expectSame(); // 历史变长后仍逐字节相同（窗口外的计数跟着变）
  }, 120_000);
});
