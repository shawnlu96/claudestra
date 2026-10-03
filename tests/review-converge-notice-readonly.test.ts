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
 * state-protection-F4: the pass reads only pending sources (convergence dedupKey range anti-joined with the notice key), and one
 * card's read failure is reported in the tick's `failed` while other cards' notices and the normal auto card go on.
 */
type Reads = { rows: number; fault: ((sql: string, args: unknown[]) => boolean) | null };
/** The reader's connection, counting rows that tasks / events statements hand back; `fault` makes matching reads throw busy. */
function watched(db: Database): { db: Database; reads: Reads } {
  const reads: Reads = { rows: 0, fault: null };
  const stmt = (s: object, sql: string) => new Proxy(s, { get(t, k) {
    const v = Reflect.get(t, k, t);
    if (typeof v !== "function") return v;
    if (k !== "all" && k !== "get" && k !== "values") return v.bind(t);
    return (...args: unknown[]) => {
      if (reads.fault?.(sql, args)) throw new Error("SQLITE_BUSY: database is locked");
      const r = v.apply(t, args);
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

/** A card with a real failed follow-up (no DAG) on the writer; `informed` also closes it through the guarded record. */
function failedSource(f: ReturnType<typeof autoFixture>, id: string, informed: boolean) {
  createTask(f.db, { actor: "owner", now: 3000 }, { project: "p", id, title: id, kind: "code" });
  f.db.transaction(() => convergeFollowUp(f.db, { actor: "scheduler", now: 3000 }, getTask(f.db, id)!, {
    round: 1, head: H1, reportPath: join(f.dir, "report.md"), items: [{ findingId: "F1", family: "other", probe: "src/y.ts:1", why: "no_basis" }],
  }, f.dir, () => true))();
  const d = getEventByDedup(f.db, followUpKey(id, 1))!;
  expect(typeof d.data.followUpFailure).toBe("string");
  if (informed) recordFollowUpInformed(f.db, { actor: "scheduler", now: 3000 }, { taskId: id, downgradeSeq: d.seq, round: 1, head: H1 });
}

/** `history` done cards with closed sources and 20 events each, `pending` open sources; the rows one real auto tick read. */
async function sweepRows(history: number, pending: number) {
  const { f, ro, told } = setup();
  for (let i = 0; i < history; i++) {
    failedSource(f, `D${i}`, true);
    const add = f.db.prepare("INSERT INTO events (ts, actor, project, target, kind, text) VALUES (?, 'owner', 'p', ?, 'note', 'x')");
    f.db.transaction(() => { for (let j = 0; j < 20; j++) add.run(4000 + j, `D${i}`); })();
    f.db.run("UPDATE tasks SET stage = 'done' WHERE id = ?", [`D${i}`]);
  }
  for (let i = 0; i < pending; i++) failedSource(f, `Q${i}`, false);
  // no auto card left: the card planner's own per-card reads are paced elsewhere; an observe / done source is still found
  f.db.run("UPDATE task_workflows SET mode = 'observe' WHERE taskId = 'T1'");
  f.db.run("UPDATE tasks SET stage = 'done' WHERE id = 'Q0'");
  const w = watched(ro);
  const result = await schedulerAutoTick(w.db, { p: { maxActiveWorkers: 2 } }, f.tickDeps);
  return { rows: w.reads.rows, told: told().length, result, f, ro };
}

describe("state-protection-F4 targeted sweep and per-card isolation", () => {
  test("sweep-cost: a tick's ledger reads follow pending sources, not done-card history", async () => {
    const small = await sweepRows(5, 1), large = await sweepRows(300, 1), more = await sweepRows(300, 4);
    console.log("SWEEP_ROWS", JSON.stringify({ small: small.rows, large: large.rows, more: more.rows }));
    expect(large.rows).toBe(small.rows);
    expect(more.rows).toBeGreaterThan(large.rows);
    expect(more.rows).toBeLessThan(large.rows + 20 * 3);
    expect({ small: small.told, large: large.told, more: more.told }).toEqual({ small: 2, large: 2, more: 5 });
    for (const id of ["T1", "Q0", "Q3"]) expect(getEventByDedup(more.f.db, convergeNoticeKey(id, getEventByDedup(more.f.db, followUpKey(id, id === "T1" ? 2 : 1))!.seq))).not.toBeNull();
    const plan = more.ro.query(`EXPLAIN QUERY PLAN SELECT d.* FROM events d WHERE d.dedupKey >= 'scheduler:converge:'
      AND d.dedupKey < 'scheduler:converge;' AND +d.project = ? AND d.kind = 'scheduler'`).all("p") as { detail: string }[];
    expect(plan.map((r) => r.detail).join(" ")).toMatch(/SEARCH d USING INDEX/);
    await schedulerAutoTick(more.ro, { p: { maxActiveWorkers: 2 } }, more.f.tickDeps);
    expect(more.f.notices.length).toBe(5);
  });

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
    w.reads.fault = (sql) => sql.includes("'scheduler:converge:'");
    const busy = await schedulerAutoTick(w.db, { p: { maxActiveWorkers: 2 } }, f.tickDeps);
    expect(busy.failed).toEqual([{ taskId: "p/*", error: "后续节点失败通知：SQLITE_BUSY: database is locked" }]);
    expect(busy.cards.map((c) => c.taskId)).toEqual(["T1"]);
    w.reads.fault = null;
    expect((await schedulerAutoTick(w.db, { p: { maxActiveWorkers: 2 } }, f.tickDeps)).failed).toEqual([]);
    expect(told().filter((t) => / Q1 /.test(t))).toHaveLength(1);
    expect(getEventByDedup(f.db, convergeNoticeKey("Q1", getEventByDedup(f.db, followUpKey("Q1", 1))!.seq))?.data.informed).toBe(true);
    await schedulerAutoTick(w.db, { p: { maxActiveWorkers: 2 } }, f.tickDeps);
    expect(told()).toHaveLength(4);

    const g = setup();
    failedSource(g.f, "Q0", false);
    const lost = watched(g.ro);
    lost.reads.fault = (sql, args) => args.includes("Q0") && sql.includes("FROM tasks WHERE id");
    const deps = { ...g.f.tickDeps, manager: async () => { throw new SchedulerLeaseLost("gone"); } };
    await expect(schedulerAutoTick(lost.db, { p: { maxActiveWorkers: 2 } }, deps)).rejects.toBeInstanceOf(SchedulerStopped);
  });
});
