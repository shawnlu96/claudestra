/**
 * state-protection-F2: the auto tick reads a query_only LedgerReader; a failed follow-up's PM notice is recorded through
 * `ledger scheduler-converge-notice`, so the next tick stays quiet and nothing writes to the read-only connection.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { getEventByDedup, getTask, listEvents } from "../src/lib/ledger-store.js";
import { convergeFollowUp, followUpKey } from "../src/lib/review-converge-followup.js";
import { followUpFailureNotice } from "../src/lib/review-converge-notice.js";
import { convergeNoticeKey, recordFollowUpInformed } from "../src/lib/review-converge-notice-write.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { acquireLock } from "../src/lib/file-lock.js";
import { encodeLease, SchedulerLeaseLost } from "../src/lib/scheduler-lease-env.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { runManagerProcess } from "../src/lib/run-manager.js";
import { createTask } from "../src/lib/ledger-write.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { autoFixture, H1 } from "./scheduler-auto-helpers.js";

import { testChildEnv } from "./test-env.js";

const NOTICE = "后续节点未建立";
let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); });

/** A real downgrade whose follow-up failed (T1 sits in no DAG), written by the production convergeFollowUp on the writer. */
function setup() {
  const f = autoFixture();
  const reader = new LedgerReader(join(f.dir, "ledger.sqlite"));
  cleanup.push(() => { reader.close(); f.close(); });
  writeFileSync(join(f.dir, "report.md"), "F1: 降级发现\n");
  f.db.transaction(() => convergeFollowUp(f.db, { actor: "scheduler", now: 2000 }, f.task(), {
    round: 2, head: H1, reportPath: join(f.dir, "report.md"), items: [{ findingId: "F1", family: "other", probe: "src/y.ts:1", why: "no_basis" }],
  }, f.dir, () => true))();
  const downgrade = listEvents(f.db, { project: "p", target: "T1" }).find((e) => e.data.op === "review_downgrade")!;
  expect(typeof downgrade.data.followUpFailure).toBe("string");
  const ro = reader.get()!;
  expect(() => ro.run("UPDATE meta SET value = value")).toThrow(/readonly/);
  const told = () => f.notices.filter((n) => n.includes(NOTICE));
  return { f, ro, downgrade, told, key: convergeNoticeKey("T1", downgrade.seq) };
}

describe("failed follow-up notice on the read-only scheduler connection", () => {
  test("two auto ticks over the same downgrade: one notice, one informed record via the CLI, no readonly write", async () => {
    const { f, ro, downgrade, told, key } = setup();
    const errors: string[] = [];
    for (let i = 0; i < 2; i++) errors.push(...(await schedulerAutoTick(ro, { p: { maxActiveWorkers: 2 } }, f.tickDeps)).failed.map((x) => x.error));
    expect({ notices: told().length, readonlyErrors: errors.filter((e) => /readonly/.test(e)) }).toEqual({ notices: 1, readonlyErrors: [] });
    const rec = getEventByDedup(f.db, key)!;
    expect(rec).toMatchObject({ actor: "scheduler", kind: "scheduler", target: "T1", text: told()[0],
      data: { op: "review_followup_failed", downgradeSeq: downgrade.seq, informed: true } });
    expect(listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "review_followup_failed")).toHaveLength(1);
  });

  test("a failed send records nothing; a failed record keeps it pending with backoff; lost lease stops the pass", async () => {
    const { f, ro, downgrade, told, key } = setup();
    const offline = { ...f.tickDeps, notifyPm: async () => { throw new Error("bridge down"); } };
    await followUpFailureNotice(ro, f.task(), offline);
    expect(getEventByDedup(f.db, key)).toBeNull();
    const calls: string[][] = [];
    const broken = { ...f.tickDeps, manager: async (...a: string[]) => { calls.push(a); return { ok: false, code: "busy", error: "库忙" }; } };
    await followUpFailureNotice(ro, f.task(), broken);
    await followUpFailureNotice(ro, f.task(), broken); // inside the backoff: no second notice, no second write
    expect(told()).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(getEventByDedup(f.db, key)).toBeNull();
    f.advance(120_000);
    await followUpFailureNotice(ro, f.task(), f.tickDeps); // backoff over: only the record is retried, PM already has it
    expect(told()).toHaveLength(1);
    expect(getEventByDedup(f.db, key)?.data.downgradeSeq).toBe(downgrade.seq);
    await followUpFailureNotice(ro, f.task(), f.tickDeps);
    expect(told()).toHaveLength(1);

    const g = setup();
    const lost = { ...g.f.tickDeps, manager: async () => ({ ok: false, code: "lease-lost", error: "失租" }) };
    await expect(followUpFailureNotice(g.ro, g.f.task(), lost)).rejects.toBeInstanceOf(SchedulerStopped);
    expect(getEventByDedup(g.f.db, g.key)).toBeNull();
  });

  test("a manager that throws (real runManagerProcess, spawn ENOENT) backs off like a refusal: one notice, one attempt", async () => {
    const { f, ro, told, key } = setup();
    let attempts = 0;
    const spawnFails = { ...f.tickDeps, manager: async (...args: string[]) => {
      attempts++;
      return runManagerProcess(args, { bunPath: join(f.dir, "missing-bun"), managerPath: join(f.dir, "manager.ts"), env: {}, timeoutMs: 1000 });
    } };
    const errors: string[] = [];
    for (let i = 0; i < 3; i++) await followUpFailureNotice(ro, f.task(), spawnFails).catch((e) => errors.push((e as Error).message));
    expect({ notices: told().length, attempts, errors, informed: getEventByDedup(f.db, key) }).toEqual({ notices: 1, attempts: 1, errors: [], informed: null });
    f.advance(120_000);
    await followUpFailureNotice(ro, f.task(), spawnFails);
    expect({ notices: told().length, attempts }).toEqual({ notices: 1, attempts: 2 });
    f.advance(240_000);
    await followUpFailureNotice(ro, f.task(), f.tickDeps);
    expect(told()).toHaveLength(1);
    expect(getEventByDedup(f.db, key)?.data.informed).toBe(true);
    const lost = setup();
    const thrown = { ...lost.f.tickDeps, manager: async () => { throw new SchedulerLeaseLost("gone"); } };
    await expect(followUpFailureNotice(lost.ro, lost.f.task(), thrown)).rejects.toBeInstanceOf(SchedulerStopped);
  });

  test("a record that failed before the card fell back to manual is still retried by later auto ticks", async () => {
    const { f, ro, told, key } = setup();
    let records = 0;
    const busy = { ...f.tickDeps,
      manager: async (...args: string[]) => {
        if (args[1] !== "scheduler-converge-notice") return f.tickDeps.manager(...args);
        records++;
        return { ok: false, code: "busy", error: "transient record failure" };
      },
      ensure: async () => ({ kind: "manual" as const, reason: "author session cannot be used" }),
    };
    const first = await schedulerAutoTick(ro, { p: { maxActiveWorkers: 2 } }, busy);
    expect(first.cards.map((c) => c.step)).toEqual(["manual"]);
    expect({ notices: told().length, records, informed: getEventByDedup(f.db, key) }).toEqual({ notices: 1, records: 1, informed: null });
    f.advance(900_000);
    const counted = { ...f.tickDeps, manager: async (...args: string[]) => {
      if (args[1] === "scheduler-converge-notice") records++;
      return f.tickDeps.manager(...args);
    } };
    const next = await schedulerAutoTick(ro, { p: { maxActiveWorkers: 2 } }, counted);
    expect({ cards: next.cards, failed: next.failed }).toEqual({ cards: [], failed: [] });
    expect({ notices: told().length, records }).toEqual({ notices: 1, records: 2 });
    expect(getEventByDedup(f.db, key)?.data.informed).toBe(true);
    await schedulerAutoTick(ro, { p: { maxActiveWorkers: 2 } }, counted);
    expect(records).toBe(2);
  });

  test("notice-pending-exit: manual fallback survives reader and process restart through guarded CLI", async () => {
    const { f, ro, told, key } = setup();
    const busy = { ...f.tickDeps,
      manager: async (...args: string[]) => args[1] === "scheduler-converge-notice"
        ? { ok: false, code: "busy", error: "temporary record failure" } : f.tickDeps.manager(...args),
      ensure: async () => ({ kind: "manual" as const, reason: "author unavailable" }),
    };
    expect((await schedulerAutoTick(ro, { p: { maxActiveWorkers: 2 } }, busy)).cards[0].step).toBe("manual");
    expect(told()).toHaveLength(1);
    expect(getEventByDedup(f.db, key)).toBeNull();
    const singletonPath = join(f.dir, "singleton.lock"), maintenancePath = join(f.dir, "maintenance.lock");
    const singleton = (await acquireLock(singletonPath, 0))!, maintenance = (await acquireLock(maintenancePath, 0))!;
    cleanup.push(() => { singleton.release(); maintenance.release(); });
    const home = join(f.dir, "home"), runtime = join(f.dir, "runtime");
    mkdirSync(home); mkdirSync(runtime);
    const env = testChildEnv({ PATH: process.env.PATH!, HOME: home, TMPDIR: process.env.TMPDIR!, CLAUDESTRA_STATE_DIR: f.dir,
      CLAUDESTRA_RUNTIME_DIR: runtime, CLAUDESTRA_TEST: "1", CLAUDESTRA_SCHEDULER_SERVICE: "1",
      BRIDGE_URL: "ws://127.0.0.1:9", BRIDGE_PORT: "9",
      CLAUDESTRA_SCHEDULER_LEASE: encodeLease({ singleton: { path: singletonPath, token: singleton.token },
        maintenance: { path: maintenancePath, token: maintenance.token } }) });
    const script = join(f.dir, "restart.ts");
    const modulePath = (p: string) => JSON.stringify(resolve(p));
    writeFileSync(script, `
      import { LedgerReader } from ${modulePath("src/lib/ledger-read.ts")};
      import { schedulerAutoTick } from ${modulePath("src/lib/scheduler-auto-tick.ts")};
      const reader = new LedgerReader(${JSON.stringify(join(f.dir, "ledger.sqlite"))});
      let notices = 0, records = 0;
      const unexpected = async () => { throw new Error("unexpected worker action"); };
      const deps = { now: () => Date.now(), notifyPm: async () => { notices++; if (process.argv[2] === "unknown") throw new Error("delivery unknown"); },
        manager: async (...args) => {
          records++;
          const p = Bun.spawn([process.execPath, "--no-env-file", ${modulePath("src/manager.ts")}, ...args],
            { env: process.env, stdout: "pipe", stderr: "pipe" });
          const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
          await p.exited;
          if (err) throw new Error(err);
          return JSON.parse(out);
        },
        ensure: unexpected, worker: unexpected, pinReview: unexpected, reviewDirty: unexpected };
      const first = await schedulerAutoTick(reader.get(), { p: { maxActiveWorkers: 2 } }, deps);
      reader.close();
      const second = await schedulerAutoTick(reader.get(), { p: { maxActiveWorkers: 2 } }, deps);
      reader.close();
      console.log(JSON.stringify({ notices, records, first, second }));
    `);
    const unknown = Bun.spawn([process.execPath, "--no-env-file", script, "unknown"], { env, stdout: "pipe", stderr: "pipe" });
    const [unknownOut, unknownErr] = await Promise.all([new Response(unknown.stdout).text(), new Response(unknown.stderr).text()]);
    expect(await unknown.exited).toBe(0);
    expect(unknownErr).toContain("delivery unknown");
    expect(JSON.parse(unknownOut)).toMatchObject({ notices: 2, records: 0 });
    expect(getEventByDedup(f.db, key)).toBeNull();
    const child = Bun.spawn([process.execPath, "--no-env-file", script], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit: await child.exited, stderr }).toEqual({ exit: 0, stderr: "" });
    console.log("RESTART_RECOVERY", stdout.trim());
    expect(JSON.parse(stdout)).toEqual({ notices: 1, records: 1, first: { cards: [], failed: [] }, second: { cards: [], failed: [] } });
    expect(getEventByDedup(f.db, key)?.data.informed).toBe(true);
    expect(listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "review_followup_failed")).toHaveLength(1);
  });

  test("the CLI only takes the scheduler, this card's own failed downgrade at its round/head, and replays idempotently", async () => {
    const { f, downgrade, key } = setup();
    const args = (task: string, seq: number, round = 2, head = H1) =>
      ["scheduler-converge-notice", task, "--downgrade-seq", String(seq), "--round", String(round), "--head", head];
    expect(await f.cli("pm", ...args("T1", downgrade.seq))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await f.cli("agent-task-one", ...args("T1", downgrade.seq))).toMatchObject({ ok: false, code: "forbidden" });
    createTask(f.db, { actor: "owner", now: 3000 }, { project: "p", id: "T2", title: "other", kind: "code" });
    expect(await f.cli("scheduler", ...args("T2", downgrade.seq))).toMatchObject({ ok: false, code: "conflict" });
    expect(await f.cli("scheduler", ...args("T1", downgrade.seq - 1))).toMatchObject({ ok: false, code: "conflict" });
    expect(await f.cli("scheduler", ...args("T1", downgrade.seq, 3))).toMatchObject({ ok: false, code: "conflict" });
    expect(await f.cli("scheduler", ...args("T1", downgrade.seq, 2, "2".repeat(40)))).toMatchObject({ ok: false, code: "conflict" });
    const lease = await f.cliWith({ assertLease: () => { throw new SchedulerLeaseLost("gone"); } },
      "scheduler", ...args("T1", downgrade.seq));
    expect(lease).toMatchObject({ ok: false, code: "lease-lost" });
    expect(getEventByDedup(f.db, key)).toBeNull();
    expect(await f.cli("scheduler", ...args("T1", downgrade.seq))).toMatchObject({ ok: true, duplicate: false });
    expect(await f.cli("scheduler", ...args("T1", downgrade.seq))).toMatchObject({ ok: true, duplicate: true });
    expect(listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "review_followup_failed")).toHaveLength(1);
  });
});


/**
 * state-protection-F4: after a connection's first sweep, a tick reads the pending sources plus the events since the last tick
 * (rowid range) of the configured projects, not done-card / closed / successful / other-project history; one card's read failure — a busy read or a
 * corrupt source row — is reported in the tick's `failed` with that card's id while other cards and the auto card go on.
 */
type Reads = { rows: number; log: { sql: string; args: unknown[] }[]; fault: ((sql: string, args: unknown[]) => boolean) | null };
/** The reader's connection, counting rows that tasks / events statements hand back; `fault` makes matching reads throw busy. */
function watched(db: Database): { db: Database; reads: Reads } {
  const reads: Reads = { rows: 0, log: [], fault: null };
  const stmt = (s: object, sql: string) => new Proxy(s, { get(t, k) {
    const v = Reflect.get(t, k, t);
    if (typeof v !== "function") return v;
    if (k !== "all" && k !== "get" && k !== "values") return v.bind(t);
    return (...args: unknown[]) => {
      if (reads.fault?.(sql, args)) throw new Error("SQLITE_BUSY: database is locked");
      const r = v.apply(t, args);
      reads.log.push({ sql, args });
      if (/\b(events|tasks)\b/.test(sql)) reads.rows += Array.isArray(r) ? r.length : r ? 1 : 0;
      return r;
    };
  } });
  const proxy = new Proxy(db, { get(t, k) {
    const v = Reflect.get(t, k, t);
    if (k === "query" || k === "prepare") return (sql: string) => stmt(v.call(t, sql), sql);
    return typeof v === "function" ? v.bind(t) : v;
  } });
  return { db: proxy, reads };
}

const DOWNGRADE = (f: ReturnType<typeof autoFixture>) => ({
  round: 1, head: H1, reportPath: join(f.dir, "report.md"), items: [{ findingId: "F1", family: "other", probe: "src/y.ts:1", why: "no_basis" as const }],
});

/** A card with a real failed follow-up (no DAG) on the writer; `informed` also closes it through the guarded record. */
function failedSource(f: ReturnType<typeof autoFixture>, id: string, informed: boolean, project = "p") {
  createTask(f.db, { actor: "owner", now: 3000 }, { project, id, title: id, kind: "code" });
  f.db.transaction(() => convergeFollowUp(f.db, { actor: "scheduler", now: 3000 }, getTask(f.db, id)!, DOWNGRADE(f), f.dir, () => true))();
  const d = getEventByDedup(f.db, followUpKey(id, 1))!;
  expect(typeof d.data.followUpFailure).toBe("string");
  if (informed) recordFollowUpInformed(f.db, { actor: "scheduler", now: 3000 }, { taskId: id, downgradeSeq: d.seq, round: 1, head: H1 });
}

/** A card in a real DAG whose follow-up node was created: a review_downgrade source with no failure and no notice key. */
function okSource(f: ReturnType<typeof autoFixture>, id: string) {
  const ctx = { actor: "owner", now: 3000 };
  createTask(f.db, ctx, { project: "p", id, title: id, kind: "code" });
  const feature = createFeature(f.db, ctx, { project: "p", slug: id.toLowerCase(), title: id }).row;
  initDag(f.db, ctx, { id: feature.id, rev: feature.rev, nodes: [{ key: "A", taskId: id, fileGlobs: ["src/old.ts"] }] });
  f.db.transaction(() => convergeFollowUp(f.db, { actor: "scheduler", now: 3000 }, getTask(f.db, id)!, DOWNGRADE(f), f.dir, () => true))();
  const d = getEventByDedup(f.db, followUpKey(id, 1))!;
  expect({ op: d.data.op, failure: d.data.followUpFailure }).toEqual({ op: "review_downgrade", failure: null });
}

/** The sweep statements of one tick: rows handed back, and the events each planned range covers (EXPLAIN + COUNT on its args). */
function sweepCost(ro: Database, reads: Reads) {
  const sweeps = reads.log.filter((l) => l.sql.includes("'scheduler:converge:'"));
  const plans = sweeps.map((l) => (ro.query(`EXPLAIN QUERY PLAN ${l.sql}`).all(...(l.args as (number | string)[])) as { detail: string }[]).map((r) => r.detail).join(" "));
  const scanned = sweeps.map((l) => l.sql.includes("seq > ?") // the cursor range: (after, upTo, ...held projects)
    ? (ro.query("SELECT COUNT(*) AS n FROM events WHERE seq > ? AND seq <= ?").get(...(l.args.slice(0, 2) as number[])) as { n: number }).n : -1);
  return { plans, scanned };
}

/** `history` done cards each of closed failed / successful / other-project closed sources (20 notes each) + `pending` open ones. */
async function sweepTicks(history: number, pending: number) {
  const { f, ro, told } = setup();
  const notes = f.db.prepare("INSERT INTO events (ts, actor, project, target, kind, text) VALUES (?, 'owner', ?, ?, 'note', 'x')");
  for (let i = 0; i < history; i++) {
    failedSource(f, `D${i}`, true); okSource(f, `S${i}`); failedSource(f, `X${i}`, true, "o");
    f.db.transaction(() => { for (const [p, id] of [["p", `D${i}`], ["p", `S${i}`], ["o", `X${i}`]]) for (let j = 0; j < 20; j++) notes.run(4000 + j, p, id); })();
    f.db.run("UPDATE tasks SET stage = 'done' WHERE id IN (?, ?, ?)", [`D${i}`, `S${i}`, `X${i}`]);
  }
  for (let i = 0; i < pending; i++) failedSource(f, `Q${i}`, false);
  // no auto card left: the card planner's own per-card reads are paced elsewhere; an observe / done source is still found
  f.db.run("UPDATE task_workflows SET mode = 'observe' WHERE taskId = 'T1'");
  f.db.run("UPDATE tasks SET stage = 'done' WHERE id = 'Q0'");
  const w = watched(ro), ticks = [];
  for (let i = 0; i < 3; i++) {
    w.reads.rows = 0; w.reads.log = [];
    const r = await schedulerAutoTick(w.db, { p: { maxActiveWorkers: 2 } }, f.tickDeps);
    ticks.push({ rows: w.reads.rows, failed: r.failed, told: told().length, ...sweepCost(ro, w.reads) });
  }
  return { ticks, f };
}

describe("state-protection-F4 targeted sweep and per-card isolation", () => {
  test("sweep-cost: after the first sweep a tick reads pending sources and new events, not any kind of history", async () => {
    const small = await sweepTicks(5, 1), large = await sweepTicks(300, 1), more = await sweepTicks(300, 4);
    console.log("SWEEP_TICKS", JSON.stringify([small, large, more].map((s) => s.ticks.map(({ rows, scanned, told }) => ({ rows, scanned, told })))));
    for (const s of [small, large, more]) {
      expect(s.ticks.flatMap((t) => t.failed)).toEqual([]);
      // tick 1 told T1 + every Q once and recorded each through the CLI; later ticks stay quiet
      const n = s === more ? 5 : 2;
      expect(s.ticks.map((t) => t.told)).toEqual([n, n, n]);
      expect(s.ticks[1].plans).toEqual([expect.stringMatching(/SEARCH events USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/)]);
      expect(s.ticks[2].plans).toEqual([]); // nothing written since: no sweep statement at all
    }
    // tick 2 sees only the notice records tick 1 wrote (one per pending source) and closes them; tick 3 reads nothing new
    expect(large.ticks[1]).toMatchObject({ rows: small.ticks[1].rows, scanned: small.ticks[1].scanned });
    expect(large.ticks[2]).toMatchObject({ rows: small.ticks[2].rows, scanned: [] });
    expect(more.ticks[1].scanned).toEqual([large.ticks[1].scanned[0] + 3]);
    expect(more.ticks[1].rows).toBeGreaterThan(large.ticks[1].rows);
    expect(more.ticks[2].rows).toBe(large.ticks[2].rows);
    for (const id of ["T1", "Q0", "Q3"]) expect(getEventByDedup(more.f.db, convergeNoticeKey(id, getEventByDedup(more.f.db, followUpKey(id, id === "T1" ? 2 : 1))!.seq))).not.toBeNull();
  }, 60_000);

  test("sweep-cost: a failure written between ticks is found by the cursor range; a reopened reader finds the old ones", async () => {
    const { f, ro, told } = setup();
    failedSource(f, "D0", true);
    const w = watched(ro);
    await schedulerAutoTick(w.db, { p: { maxActiveWorkers: 2 } }, f.tickDeps);
    expect(told()).toHaveLength(1);
    failedSource(f, "Q0", false);
    f.db.run("UPDATE tasks SET stage = 'done' WHERE id = 'Q0'");
    expect((await schedulerAutoTick(w.db, { p: { maxActiveWorkers: 2 } }, f.tickDeps)).failed).toEqual([]);
    expect(told().filter((t) => / Q0 /.test(t))).toHaveLength(1);
    failedSource(f, "Q1", false);
    // a fresh connection (process restart) sweeps the history once: Q1 is told, closed ones stay quiet
    const fresh = new LedgerReader(join(f.dir, "ledger.sqlite"));
    cleanup.push(() => fresh.close());
    await schedulerAutoTick(fresh.get()!, { p: { maxActiveWorkers: 2 } }, f.tickDeps);
    expect(told().map((t) => t.split(" ")[1])).toEqual(["T1", "Q0", "Q1"]);
  });

  test("sweep-project: unconfigured projects' open sources are never read or held; configuring one later finds its old ones", async () => {
    for (const foreign of [5, 300]) {
      const { f, ro, told } = setup();
      f.db.run("UPDATE task_workflows SET mode = 'observe' WHERE taskId = 'T1'");
      const w = watched(ro);
      await schedulerAutoTick(w.db, { p: { maxActiveWorkers: 2 } }, f.tickDeps); // T1 told and closed: p has nothing pending
      for (let i = 0; i < foreign; i++) failedSource(f, `O${i}`, false, "o");
      // the review's probe: visits of project-o rows by any Array#filter callback during a tick, plus o rows any sweep read
      const filter = Array.prototype.filter, visits: number[] = [], oRows: number[] = [];
      for (let t = 0; t < 3; t++) {
        let n = 0;
        Array.prototype.filter = function (this: unknown[], cb: (v: unknown, i: number, a: unknown[]) => unknown, that?: unknown) {
          return filter.call(this, (v: unknown, i: number, a: unknown[]) => {
            if (v && typeof v === "object" && (v as { project?: unknown }).project === "o" && "dedupKey" in v) n++;
            return cb.call(that, v, i, a);
          });
        } as typeof filter;
        w.reads.log = [];
        try {
          expect((await schedulerAutoTick(w.db, { p: { maxActiveWorkers: 2 } }, f.tickDeps)).failed).toEqual([]);
        } finally { Array.prototype.filter = filter; }
        visits.push(n);
        oRows.push(w.reads.log.filter((l) => l.sql.includes("'scheduler:converge:'"))
          .reduce((k, l) => k + (ro.query(l.sql).all(...(l.args as string[])) as { project: string }[]).filter((r) => r.project === "o").length, 0));
      }
      expect({ foreign, visits, oRows, told: told().length }).toEqual({ foreign, visits: [0, 0, 0], oRows: [0, 0, 0], told: 1 });
      // o configured: its old sources, written before any tick looked at o, are told once each and closed
      const both = { p: { maxActiveWorkers: 2 }, o: { maxActiveWorkers: 2 } };
      expect((await schedulerAutoTick(w.db, both, f.tickDeps)).failed).toEqual([]);
      expect(told()).toHaveLength(1 + foreign);
      await schedulerAutoTick(w.db, both, f.tickDeps);
      expect(told()).toHaveLength(1 + foreign);
      // o dropped then re-added: a new failure written meanwhile is found, the informed ones stay quiet
      await schedulerAutoTick(w.db, { p: { maxActiveWorkers: 2 } }, f.tickDeps);
      failedSource(f, "O-late", false, "o");
      await schedulerAutoTick(w.db, { p: { maxActiveWorkers: 2 } }, f.tickDeps);
      expect(told()).toHaveLength(1 + foreign);
      await schedulerAutoTick(w.db, both, f.tickDeps);
      expect(told().slice(1 + foreign).map((t) => t.split(" ")[1])).toEqual(["O-late"]);
    }
  }, 120_000);

  test("sweep-isolation: one card's busy read is reported, the others and the auto card go on, then it is told", async () => {
    const { f, ro, told } = setup();
    failedSource(f, "Q0", false); failedSource(f, "Q1", false); failedSource(f, "Q2", false);
    const w = watched(ro);
    w.reads.fault = (sql, args) => args.includes("Q1") && (sql.includes("FROM events") || sql.includes("FROM tasks WHERE id"));
    const r = await schedulerAutoTick(w.db, { p: { maxActiveWorkers: 2 } }, f.tickDeps);
    expect(r.failed).toEqual([{ taskId: "Q1", error: "后续节点失败通知：SQLITE_BUSY: database is locked" }]);
    expect(r.cards.map((c) => c.taskId)).toEqual(["T1"]);
    expect(told().filter((t) => / Q1 /.test(t))).toEqual([]);
    expect(told()).toHaveLength(3);
    failedSource(f, "Q3", false);
    // the sweep itself busy: reported, not read as "no events"; Q1 (already swept) still goes out, Q3 waits for the next sweep
    w.reads.fault = (sql) => sql.includes("'scheduler:converge:'");
    const busy = await schedulerAutoTick(w.db, { p: { maxActiveWorkers: 2 } }, f.tickDeps);
    expect(busy.failed).toEqual([{ taskId: "*", error: "后续节点失败通知：SQLITE_BUSY: database is locked" }]);
    expect(busy.cards.map((c) => c.taskId)).toEqual(["T1"]);
    expect(told().filter((t) => / Q1 /.test(t))).toHaveLength(1);
    expect(told().filter((t) => / Q3 /.test(t))).toEqual([]);
    w.reads.fault = null;
    expect((await schedulerAutoTick(w.db, { p: { maxActiveWorkers: 2 } }, f.tickDeps)).failed).toEqual([]);
    expect(told().filter((t) => / Q3 /.test(t))).toHaveLength(1);
    expect(getEventByDedup(f.db, convergeNoticeKey("Q1", getEventByDedup(f.db, followUpKey("Q1", 1))!.seq))?.data.informed).toBe(true);
    await schedulerAutoTick(w.db, { p: { maxActiveWorkers: 2 } }, f.tickDeps);
    expect(told()).toHaveLength(5);

    const g = setup();
    failedSource(g.f, "Q0", false);
    const lost = watched(g.ro);
    lost.reads.fault = (sql, args) => args.includes("Q0") && sql.includes("FROM tasks WHERE id");
    const deps = { ...g.f.tickDeps, manager: async () => { throw new SchedulerLeaseLost("gone"); } };
    await expect(schedulerAutoTick(lost.db, { p: { maxActiveWorkers: 2 } }, deps)).rejects.toBeInstanceOf(SchedulerStopped);
  });

  test("sweep-isolation: a corrupt source row fails only its own card, with its id; the other sources are told", async () => {
    for (const reopen of [false, true]) {
      const { f, ro, told } = setup();
      f.db.run("UPDATE task_workflows SET mode = 'observe' WHERE taskId = 'T1'"); // the auto card's own JSON reads are not this sweep
      const w = watched(ro);
      if (reopen) await schedulerAutoTick(w.db, { p: { maxActiveWorkers: 2 } }, f.tickDeps); // corrupt row arrives via the cursor range
      createTask(f.db, { actor: "owner", now: 3000 }, { project: "p", id: "Q0", title: "Q0", kind: "code" });
      f.db.run("INSERT INTO events (ts, actor, project, target, kind, text, data, dedupKey) VALUES (3000, 'scheduler', 'p', 'Q0', 'scheduler', 'x', '{', ?)",
        [followUpKey("Q0", 1)]);
      failedSource(f, "Q1", false);
      for (let i = 0; i < 2; i++) {
        const r = await schedulerAutoTick(w.db, { p: { maxActiveWorkers: 2 } }, f.tickDeps);
        expect(r.failed).toEqual([{ taskId: "Q0", error: expect.stringMatching(/^后续节点失败通知：事件 \d+ 读不出：.*JSON/) }]);
      }
      expect(told().map((t) => t.split(" ")[1])).toEqual(["T1", "Q1"]);
    }
  });
});
