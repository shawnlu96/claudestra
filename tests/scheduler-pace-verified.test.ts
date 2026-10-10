import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { finishFirst } from "../src/lib/scheduler-agent-pool.js";
import { mergeFirst } from "../src/lib/scheduler-merge-order.js";
import { paceCards, passPace } from "../src/lib/scheduler-yield.js";
import { retireCandidates, schedulerRetireTick } from "../src/lib/scheduler-retire.js";
import { runLedger } from "../src/manager/ledger.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pace-verified-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const at = { actor: "owner", now: 1000 };
  const card = (id: string, stage: string, mode: "auto" | "observe" = "auto") => {
    createTask(db, at, { project: "p", id, title: id, kind: "code" });
    setWorkflow(db, at, { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode,
      authorFamily: "codex", fallback: "只报错不修" });
    db.query("UPDATE tasks SET stage = ? WHERE id = ?").run(stage, id);
  };
  const intent = (id: string, status: string, action = "retire") => {
    db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev,
      templateVersion, status, reason, createdAt, updatedAt) VALUES (?, ?, 'p', 'retire', ?, 0, 1, 1, 2, ?, 'test', 0, 0)`)
      .run(`intent-${id}`, id, action, status);
  };
  return { db, dir, card, intent, close: () => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); } };
}

test("AUTOFAIR1: 250 idle verified cards cannot starve restate in the first or next ten passes", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 250; i++) f.card(`V${String(i).padStart(3, "0")}`, "verified");
    f.card("R", "restate");
    f.db.query(`INSERT INTO events (ts, actor, project, target, kind, data)
      VALUES (1000, 'executor', 'p', 'R', 'stage', '{"from":"spec","to":"restate","text":"复述记录"}')`).run();
    let now = 0;
    const cursor: Record<string, string | undefined> = {}, seen: number[] = [];
    for (let round = 0; round < 10; round++) {
      const pass = passPace(cursor, { budgetMs: 60_000, now: () => now, request: join(f.dir, "no-request") });
      pass.phase(); pass.phase();
      const pace = pass.phase();
      // This is the production auto loop's ordering, yield check and cursor update; each card step costs one second.
      const cards = mergeFirst(f.db, finishFirst(paceCards(f.db, { p: null }, "auto", pace),
        (c) => getTask(f.db, c.taskId)?.stage ?? ""));
      for (const c of cards) {
        if (pace.yieldNow()) break;
        cursor.auto = `${c.project}/${c.taskId}`;
        if (c.taskId === "R") seen.push(round);
        now += 1000;
      }
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  } finally { f.close(); }
});

for (const mode of ["auto", "observe"] as const) {
  test(`AUTOFAIR1: ${mode} retains every in-flight verified intent and every unfinished stage`, () => {
    const f = fixture();
    try {
      for (const status of ["pending", "submitted", "unknown", "done", "cancelled"]) {
        f.card(status, "verified", mode); f.intent(status, status);
      }
      f.card("idle", "verified", mode);
      for (const stage of ["spec", "restate", "build", "review", "fix", "merge", "live", "blocked", "done", "cancelled"]) {
        f.card(`stage-${stage}`, stage, mode);
      }
      expect(paceCards(f.db, { p: null }, mode).map((c) => c.taskId).sort()).toEqual([
        "pending", "submitted", "unknown", ...["spec", "restate", "build", "review", "fix", "merge", "live", "blocked"].map((s) => `stage-${s}`),
      ].sort());
    } finally { f.close(); }
  });
}

test("AUTOFAIR1: excluded verified card is still discovered and processed by retirement", async () => {
  const f = fixture();
  try {
    f.card("V", "verified"); f.intent("V", "done", "ensure_session");
    f.db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
      VALUES ('V', 'author', 'worker', 'session', 'codex', 'peer', 'active', 'intent-V', 0, 0)`).run();
    expect(paceCards(f.db, { p: null }, "auto")).toEqual([]);
    expect(retireCandidates(f.db, ["p"])).toEqual(["V"]);
    const result = await schedulerRetireTick(f.db, ["p"], {
      ledger: async (...args) => runLedger(args.slice(1), { db: f.db, actor: "scheduler", projectIds: ["p"], now: () => 2000,
        loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {} }),
      agent: async () => { throw new Error("no real agent calls allowed"); },
      git: async () => { throw new Error("no real git calls allowed"); },
      exists: () => false, worktreeRoot: join(f.dir, "worktrees"), agents: async () => [], notifyPm: async () => {},
    });
    expect(result.failed).toEqual([]);
    expect(result.cards).toMatchObject([{ taskId: "V", step: "retired" }]);
    expect(f.db.query("SELECT state FROM scheduler_sessions WHERE taskId = 'V'").get()).toEqual({ state: "retired" });
  } finally { f.close(); }
});
