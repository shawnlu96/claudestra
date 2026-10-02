/** i28-MQ2: once the merge lock frees, the merge-stage card that entered merge first and can merge takes it; `ledger merge-queue` lists the same order. */
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { finishFirst } from "../src/lib/scheduler-agent-pool.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { schedulerAutoTick, type AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import { mergeFirst } from "../src/lib/scheduler-merge-order.js";
import { paceCards, type TickPace } from "../src/lib/scheduler-yield.js";
import { runLedger } from "../src/manager/ledger.js";
import type { LedgerDeps } from "../src/manager/ledger-context.js";
import type { Registry } from "../src/manager/core.js";
import { isWriteInvocation } from "../src/manager/write-commands.js";
import { testChildEnv } from "./test-env.js";

const H = "a".repeat(40);
const OVERLAP = (holder: string) => `资源 merge:p 与 merge:p 重叠（${holder} 占用）`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mq2-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  let now = 1_000_000;
  const at = (actor: string) => ({ actor, now: (now += 10) });
  db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'pms', '[\"pm\"]')").run();
  const deps = (actor: string, over: Partial<LedgerDeps> = {}): LedgerDeps => ({
    db, actor, projectIds: ["p"], now: () => (now += 10), autoProjects: () => ["p"], autoDispatch: () => true,
    loadRegistry: async () => ({ socket: "", agents: {} }) as unknown as Registry, saveRegistry: async () => {}, ...over,
  });
  const event = (target: string, kind: string, data: object, dedupKey: string | null = null) =>
    (db.query("INSERT INTO events (ts, actor, project, target, kind, data, dedupKey) VALUES (?, 'pm', 'p', ?, ?, ?, ?) RETURNING seq")
      .get(now += 10, target, kind, JSON.stringify(data), dedupKey) as { seq: number }).seq;
  const intent = (id: string, taskId: string, node: string, action: string, status: string, eventSeq: number, recipient: string | null = null) =>
    db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq, eventSeq, taskRev, specRev, head,
      templateVersion, status, reason, createdAt, updatedAt) VALUES (?, ?, 'p', ?, ?, ?, 0, ?, 1, 1, ?, 2, ?, 'fixture', ?, ?)`)
      .run(id, taskId, node, action, recipient, eventSeq, H, status, now, now);
  /** An auto card (本机) with a passed cross-family review on head H, sitting in build; `enterMerge` moves it on. */
  const card = (id: string) => {
    createTask(db, at("owner"), { project: "p", id, title: `本机 卡 ${id}`, kind: "code", agent: `agent-${id}`, extra: { fileGlobs: [`src/${id}.ts`] } });
    setWorkflow(db, at("owner"), { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "只报错不修" });
    const reviewer = `rv-${id}`, session = `s-rv-${id}`;
    intent(`ens-${id}`, id, "adversarial_review", "ensure_session", "done", 0);
    db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
      VALUES (?, 'reviewer', ?, ?, 'codex', 'acp', 'active', ?, ?, ?)`).run(id, reviewer, session, `ens-${id}`, now, now);
    event(id, "stage", { from: "build", to: "review", round: 1, specRev: 1 });
    intent(`rv-${id}`, id, "adversarial_review", "review", "done", event(id, "scheduler", { op: "plan", id: `rv-${id}` }), reviewer);
    event(id, "scheduler", { op: "settle", to: "submitted" }, `scheduler:rv-${id}:submitted`);
    event(id, "review", { round: 1, head: H, verdict: "pass", reviewer, reviewerSessionId: session, reviewerFamily: "codex",
      path: `reviews/${id}-r1/report.md`, findings: [], p0: 0, p1: 0, p2: 0 });
    db.query("UPDATE tasks SET round = 1, headSHA = ?, pr = ?, branch = ? WHERE id = ?").run(H, `https://github.com/example/repo/pull/${id.charCodeAt(0)}`, `task/${id}`, id);
  };
  const enterMerge = (id: string) => {
    event(id, "stage", { from: getTask(db, id)!.stage, to: "merge", round: 1, specRev: 1 });
    db.query("UPDATE tasks SET stage = 'merge' WHERE id = ?").run(id);
  };
  /** The merge gate bounced the card to fix, it came back: a fresh entry. */
  const bounce = (id: string) => {
    event(id, "stage", { from: "merge", to: "fix", round: 1, specRev: 1 });
    db.query("UPDATE tasks SET stage = 'fix' WHERE id = ?").run(id);
    enterMerge(id);
  };
  /** Another card (peer A side, not auto) holds the project merge lock. */
  const holdLock = () => {
    createTask(db, at("owner"), { project: "p", id: "Z0", title: "peer A 卡", kind: "code" });
    intent("merge-z0", "Z0", "merge_deploy", "merge", "submitted", 0);
    db.query("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt) VALUES ('p', 'merge:p', 'Z0', 'merge-z0', ?)").run(now);
  };
  const tickDeps: AutoTickDeps = {
    manager: async (...args) => runLedger(args.slice(1), deps("scheduler")),
    worker: () => ({ manual: "fixture" }),
    ensure: async () => { throw new Error("no session in fixture"); },
    pinReview: async () => ({ manual: "fixture" }),
    reviewDirty: async () => null,
    notifyPm: async () => {},
    now: () => now,
  };
  const tick = async (cursor?: string) => {
    const pace: TickPace = { yieldNow: () => false, cursor: { auto: cursor } };
    const r = await schedulerAutoTick(db, { p: { maxActiveWorkers: 4 } }, tickDeps, pace);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards;
  };
  const step = (cards: Awaited<ReturnType<typeof tick>>, id: string) => cards.find((c) => c.taskId === id);
  const mergeIntents = () => db.query("SELECT taskId, status FROM scheduler_intents WHERE action = 'merge' AND taskId != 'Z0'").all();
  const close = () => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); };
  return { db, path, deps, card, enterMerge, bounce, holdLock, intent, tick, step, mergeIntents, close, cli: (actor: string, ...a: string[]) => runLedger(a, deps(actor)) };
}

/** Three merge cards whose ids sort opposite to their merge entry: C entered first, then B, then A. */
function reversed() {
  const f = fixture();
  for (const id of ["A", "B", "C"]) f.card(id);
  for (const id of ["C", "B", "A"]) f.enterMerge(id);
  return f;
}

describe("i28-MQ2 merge queue picks by merge entry", () => {
  test("[验收线 1] lock frees: the earliest entry gets the merge intent, the other two wait on the resource; cursor mid-list", async () => {
    const f = reversed();
    try {
      f.holdLock();
      // Rotation after A walks B, C, A: B used to win the lock just by being walked first.
      const held = await f.tick("p/A");
      for (const id of ["A", "B", "C"]) expect(f.step(held, id)).toMatchObject({ step: "wait", detail: OVERLAP("Z0") });
      expect((await f.cli("scheduler", "scheduler-settle", "merge-z0", "--from", "submitted", "--to", "done", "--receipt", "merged")).ok).toBe(true);
      const cards = await f.tick("p/A");
      expect(cards.map((c) => c.taskId)).toEqual(["C", "B", "A"]);
      expect(f.step(cards, "C")).toMatchObject({ step: "merge_queue" });
      expect(f.step(cards, "B")).toMatchObject({ step: "wait", detail: OVERLAP("C") });
      expect(f.step(cards, "A")).toMatchObject({ step: "wait", detail: OVERLAP("C") });
      expect(f.mergeIntents()).toEqual([{ taskId: "C", status: "pending" }]);
    } finally { f.close(); }
  });

  test("[验收线 2] the earliest card is held on an unknown intent: the next earliest that can merge takes the lock", async () => {
    const f = reversed();
    try {
      f.intent("lost-c", "C", "merge_deploy", "stage", "unknown", 0);
      // Rotation after B walks C, A, B: with C held, A used to take the lock ahead of B.
      const cards = await f.tick("p/B");
      expect(f.step(cards, "C")).toMatchObject({ step: "held" });
      expect(f.step(cards, "B")).toMatchObject({ step: "merge_queue" });
      expect(f.step(cards, "A")).toMatchObject({ step: "wait", detail: OVERLAP("B") });
      expect(f.mergeIntents()).toEqual([{ taskId: "B", status: "pending" }]);
    } finally { f.close(); }
  });

  test("[验收线 3] a card bounced to fix and back re-queues behind cards that entered after it", async () => {
    const f = fixture();
    try {
      for (const id of ["A", "B", "C"]) f.card(id);
      for (const id of ["C", "B", "A"]) f.enterMerge(id);
      f.bounce("C");
      expect(mergeFirst(f.db, paceCards(f.db, { p: null }, "auto")).map((c) => c.taskId)).toEqual(["B", "A", "C"]);
      const cards = await f.tick();
      expect(f.step(cards, "B")).toMatchObject({ step: "merge_queue" });
      expect(f.step(cards, "C")).toMatchObject({ step: "wait", detail: OVERLAP("B") });
    } finally { f.close(); }
  });

  test("[验收线 4] non-merge cards keep exactly the finishFirst + rotation order", () => {
    const f = fixture();
    try {
      const stages: Record<string, string> = { A: "build", B: "merge", C: "review", D: "spec", E: "merge", F: "fix", G: "build", H: "live" };
      for (const id of Object.keys(stages)) f.card(id);
      for (const id of ["E", "B"]) f.enterMerge(id);
      for (const [id, stage] of Object.entries(stages)) if (stage !== "merge") f.db.query("UPDATE tasks SET stage = ? WHERE id = ?").run(stage, id);
      for (const cursor of [undefined, "p/A", "p/C", "p/E", "p/G", "p/H"]) {
        const before = finishFirst(paceCards(f.db, { p: null }, "auto", { yieldNow: () => false, cursor: { auto: cursor } }),
          (c) => getTask(f.db, c.taskId)?.stage ?? "");
        const after = mergeFirst(f.db, before).map((c) => c.taskId);
        expect(after.slice(0, 2)).toEqual(["E", "B"]);
        expect(after.slice(2)).toEqual(before.map((c) => c.taskId).filter((id) => stages[id] !== "merge"));
      }
    } finally { f.close(); }
  });

  test("[验收线 5] `ledger merge-queue` lists the tick's pick order and runs on a read-only connection", async () => {
    const f = reversed();
    try {
      f.holdLock();
      const ro = new Database(f.path, { readonly: true });
      try {
        const events = () => (f.db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
        const n = events();
        const r = await runLedger(["merge-queue", "--project", "p"], f.deps("pm", { db: ro }));
        expect(r).toMatchObject({ ok: true, project: "p" });
        expect(events()).toBe(n);
        const rows = r.rows as { task: string; phase: string; blocked: string | null; waitedMin: number }[];
        expect(rows.map((x) => x.task)).toEqual(["C", "B", "A"]);
        for (const row of rows) expect(row).toMatchObject({ phase: "排队", blocked: OVERLAP("Z0") });
        expect(rows[0].waitedMin).toBeGreaterThanOrEqual(0);
        expect((r.lines as string[])[0]).toContain("C｜进 merge");

        expect((await f.cli("scheduler", "scheduler-settle", "merge-z0", "--from", "submitted", "--to", "done", "--receipt", "merged")).ok).toBe(true);
        const picked = (await f.tick("p/A")).map((c) => c.taskId);
        const after = (await runLedger(["merge-queue", "--project", "p"], f.deps("pm", { db: ro }))).rows as typeof rows;
        expect(after.map((x) => x.task)).toEqual(picked);
        expect(after).toMatchObject([{ task: "C", phase: "pending", blocked: null },
          { task: "B", phase: "排队", blocked: OVERLAP("C") }, { task: "A", phase: "排队", blocked: OVERLAP("C") }]);
      } finally { ro.close(); }
    } finally { f.close(); }
  });

  test("[验收线 5] the real `cmdLedger` entry reads through a read-only connection: no db created, no data fixed, unknown callers can read", async () => {
    expect(isWriteInvocation("ledger", ["merge-queue", "--project", "p"])).toBe(false);
    const run = async (state: string) => {
      writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: [{ id: "p", name: "p", dirs: [], createdAt: "2026-10-02T00:00:00Z" }] }));
      // An unregistered channel: a write command would be refused before reaching the handler.
      const env = testChildEnv({ CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(state, "run"), DISCORD_CHANNEL_ID: "999000999" });
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/manager.ts"), "ledger", "merge-queue", "--project", "p"], { env, stdout: "pipe", stderr: "pipe" });
      return JSON.parse((await new Response(proc.stdout).text()).trim().split("\n").at(-1) ?? "");
    };
    const empty = mkdtempSync(join(tmpdir(), "mq2-empty-"));
    try {
      expect((await run(empty)).ok).toBe(false);
      expect(existsSync(join(empty, "ledger.sqlite"))).toBe(false);
    } finally { rmSync(empty, { recursive: true, force: true }); }

    const f = reversed();
    try {
      // Drift openLedger would reconcile (assignee follows agent): a read must leave it alone.
      f.db.query("UPDATE tasks SET assignee = 'agent-stale' WHERE id = 'A'").run();
      const events = (f.db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
      closeLedger(f.path);
      const r = await run(dirname(f.path));
      expect(r).toMatchObject({ ok: true, project: "p" });
      expect((r.rows as { task: string }[]).map((x) => x.task)).toEqual(["C", "B", "A"]);
      const check = new Database(f.path, { readonly: true });
      try {
        expect(check.query("SELECT assignee FROM tasks WHERE id = 'A'").get()).toEqual({ assignee: "agent-stale" });
        expect(check.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: events });
      } finally { check.close(); }
    } finally { f.close(); }
  }, 30_000);
});
