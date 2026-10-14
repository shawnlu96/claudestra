import { expect, test } from "bun:test";
import { autoFixture, H2 } from "./scheduler-auto-helpers.js";
import { addSeat, reviewEffect, reviewEvent } from "./scheduler-review-seat-fixture.test.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { trackReviewSeatWait } from "../src/lib/scheduler-review-seat-wait.js";
import { listEvents } from "../src/lib/ledger-store.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";

function setup() {
  const f = autoFixture();
  f.db.query("UPDATE tasks SET stage='review',headSHA=?,pr='https://github.com/o/r/pull/7' WHERE id='T1'").run(H2);
  const remote = { agents: { claude: 0, codex: 8 }, mode: "balance" as const, roles: [], poolTimeoutMin: 15 };
  const snapshot = () => autoSnapshot(f.reader.get()!, f.task(), { registry: [], maxWorkers: 8, pool: { remote, borrow: [] } });
  const run = async (mode: RecoveryMode = "observe") => {
    const snap = snapshot(), plan = planScheduler(snap);
    await trackReviewSeatWait(f.reader.get()!, f.task(), snap, plan,
      { ...f.tickDeps, recoveryPolicy: () => ({ mode, source: "config", manualAfterMs: null }) });
    return plan;
  };
  const notes = (action: string) => listEvents(f.db, { target: "T1" }).filter((e) => e.data.mechanism === "reviewSeatIdle" && e.data.actionKey === action);
  return { ...f, remote, snapshot, run, notes };
}

test("[验收线 3] observe retains legacy placement and records one counterfactual local admission per round", async () => {
  const f = setup();
  try {
    for (let n = 0; n < 3; n++) addSeat(f.db, `author${n}`, "author", "build");
    for (let n = 0; n < 7; n++) addSeat(f.db, `idle${n}`);
    expect(await f.run()).toMatchObject({ kind: "wait", code: "placement" });
    expect(await f.run()).toMatchObject({ kind: "wait", code: "placement" });
    expect(f.notes("release:r0")).toHaveLength(1);
    expect(f.notes("release:r0")[0].text).toContain("本会 放行：不计空闲审查员 7 个");
    f.db.query("UPDATE tasks SET round=1 WHERE id='T1'").run();
    await f.run(); expect(f.notes("release:r1")).toHaveLength(1);
  } finally { f.close(); }
});

test("[验收线 4] off still records family, effective cap, load breakdown and sanitized peer codes after twenty minutes", async () => {
  const f = setup();
  try {
    for (let n = 0; n < 6; n++) addSeat(f.db, `author${n}`, "author", "build");
    addSeat(f.db, "busy"); reviewEffect(f.db, "busy", "submitted");
    f.db.query(`INSERT INTO task_workflows SELECT 'reserve',project,template,templateVersion,mode,authorFamily,fallback,specRev,rev,createdAt,updatedAt
      FROM task_workflows WHERE taskId='T1'`).run();
    addSeat(f.db, "reserve", "author", "build");
    f.db.query("DELETE FROM scheduler_sessions WHERE taskId='reserve'").run();
    f.db.query("UPDATE task_workflows SET authorFamily='codex' WHERE taskId='reserve'").run();
    reviewEffect(f.db, "reserve", "submitted");
    f.db.query("UPDATE scheduler_intents SET action='ensure_session',node='write',receipt='ensure author codex' WHERE taskId='reserve'").run();
    await f.run("off");
    f.advance(20 * 60_000); await f.run("off");
    // No timestamp is available for T1: the process clock remains exact and writes no start/end notes.
    expect(f.notes("wait-note:r0")).toHaveLength(0);
    expect(listEvents(f.db, { target: "T1" }).filter((e) => e.data.mechanism === "reviewSeatIdle")).toHaveLength(0);
    f.advance(100); await f.run("off"); await f.run("off");
    expect(f.notes("release:r0")).toHaveLength(0);
    expect(f.notes("wait-note:r0")).toHaveLength(1);
    const note = f.notes("wait-note:r0")[0];
    expect(note.text).toContain("家族 codex；本机上限 8，在跑 8（作者 6 / 审查员 1 / 创建预留 1）");
    expect(note.text).toContain("peer 原因码 no_peers");
  } finally { f.close(); }
});

test("[验收线 4] fallback process timing resets on restart and on a recovered placement", async () => {
  const f = setup();
  try {
    for (let n = 0; n < 8; n++) addSeat(f.db, `author${n}`, "author", "build");
    await f.run("off"); f.advance(19 * 60_000);
    f.reader.close(); await f.run("off");
    expect(f.notes("wait-note:r0")).toHaveLength(0);
    f.db.query("UPDATE tasks SET stage='merge' WHERE id='author0'").run();
    expect(await f.run("off")).toMatchObject({ kind: "intent", action: "ensure_session" });
    f.db.query("UPDATE tasks SET stage='build' WHERE id='author0'").run();
    await f.run("off"); f.advance(2 * 60_000); await f.run("off");
    expect(f.notes("wait-note:r0")).toHaveLength(0);
    f.reader.close(); f.advance(19 * 60_000); await f.run("off");
    expect(f.notes("wait-note:r0")).toHaveLength(0);
    f.advance(21 * 60_000); await f.run("off");
    expect(f.notes("wait-note:r0")).toHaveLength(1);
    expect(f.notes("wait-note:r0")[0].data.clock).toBe("process");
  } finally { f.close(); }
});

test("[验收线 2] eight actual reviewers still block a ninth; verdict permits it without an idle observation", async () => {
  const f = setup();
  try {
    for (let n = 0; n < 8; n++) { addSeat(f.db, `busy${n}`); reviewEffect(f.db, `busy${n}`, "done"); }
    expect(await f.run()).toMatchObject({ kind: "wait", code: "placement" });
    expect(f.notes("release:r0")).toHaveLength(0);
    reviewEvent(f.db, "busy0");
    // Observe continues to count this review-stage binding: it can only report a would-be admission.
    expect(await f.run()).toMatchObject({ kind: "wait", code: "placement" });
    expect(f.notes("release:r0")).toHaveLength(1);
  } finally { f.close(); }
});

test("production auto tick records only the overdue diagnosis through the read-only scheduler handle", async () => {
  const f = setup();
  try {
    for (let n = 0; n < 8; n++) addSeat(f.db, `author${n}`, "author", "build");
    const tick = () => schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 8, remote: f.remote } }, { ...f.tickDeps, borrow: async () => [] });
    expect((await tick()).failed).toEqual([]);
    f.advance(21 * 60_000);
    expect((await tick()).failed).toEqual([]);
    expect(f.notes("wait-note:r0")).toHaveLength(1);
    expect(f.sent).toHaveLength(0);
  } finally { f.close(); }
});

test("[验收线 4] peer diagnosis records codes without raw hello errors or peer identifiers", async () => {
  const f = setup();
  try {
    for (let n = 0; n < 8; n++) addSeat(f.db, `author${n}`, "author", "build");
    const run = async () => {
      const s = f.snapshot();
      s.projectRepo = "other/repo";
      s.pool!.peers = [
        { peer: "secret-host", open: 0, maxOpen: 1, v2: null },
        { peer: "private-address", open: 0, maxOpen: 1, v2: { why: "token=secret-value", roles: [], repos: ["o/r"], slots: { claude: 0, codex: 0 } } },
        { peer: "slots", open: 0, maxOpen: 1, v2: { why: null, roles: [], repos: ["o/r"], slots: { claude: 0, codex: 0 } } },
        { peer: "grant", open: 0, maxOpen: 1, v2: { why: null, roles: [], repos: ["elsewhere/r"], slots: { claude: 0, codex: 1 } } },
      ];
      const plan = planScheduler(s);
      expect(plan).toMatchObject({ kind: "wait", code: "placement" });
      await trackReviewSeatWait(f.reader.get()!, f.task(), s, plan, f.tickDeps);
    };
    await run(); f.advance(21 * 60_000); await run();
    const text = f.notes("wait-note:r0")[0].text;
    expect(text).toContain("private_repo_peer_only,no_hello,hello_unusable,family_no_slot,repo_unauthorized");
    expect(text).not.toMatch(/secret|private-address|elsewhere|token=/);
  } finally { f.close(); }
});

test("[验收线 4] ledger clock uses the latest review entry, ended intent or verdict and survives restart without clock notes", async () => {
  const f = setup();
  try {
    for (let n = 0; n < 8; n++) addSeat(f.db, `author${n}`, "author", "build");
    const entered = f.tickDeps.now();
    f.db.query(`INSERT INTO events (ts,actor,project,target,kind,text,data)
      VALUES (?,'pm','p','T1','stage','','{"to":"review","round":0}')`).run(entered);
    f.advance(10 * 60_000);
    const ended = f.tickDeps.now();
    reviewEffect(f.db, "T1", "cancelled");
    f.db.query("UPDATE scheduler_intents SET updatedAt=? WHERE taskId='T1'").run(ended);
    f.advance(10 * 60_000);
    const verdict = f.tickDeps.now();
    f.db.query(`INSERT INTO events (ts,actor,project,target,kind,text,data)
      VALUES (?,'reviewer','p','T1','review','','{"round":-1}')`).run(verdict);
    await f.run("off");
    expect(f.notes("wait-note:r0")).toHaveLength(0);
    expect(listEvents(f.db, { target: "T1" }).filter((e) => e.data.mechanism === "reviewSeatIdle")).toHaveLength(0);
    f.reader.close(); f.advance(20 * 60_000); await f.run("off");
    expect(f.notes("wait-note:r0")).toHaveLength(0);
    f.advance(1); await f.run("off");
    expect(f.notes("wait-note:r0")).toHaveLength(1);
    expect(f.notes("wait-note:r0")[0].data).toMatchObject({ since: verdict, clock: "ledger" });
  } finally { f.close(); }
});

test("[验收线 4] an in-flight review prevents a placement note even when an old ledger timestamp exceeds the threshold", async () => {
  const f = setup();
  try {
    for (let n = 0; n < 8; n++) addSeat(f.db, `author${n}`, "author", "build");
    f.db.query(`INSERT INTO events (ts,actor,project,target,kind,text,data)
      VALUES (0,'pm','p','T1','stage','','{"to":"review","round":0}')`).run();
    reviewEffect(f.db, "T1", "submitted");
    f.advance(21 * 60_000);
    const s = f.snapshot();
    await trackReviewSeatWait(f.reader.get()!, f.task(), s, { kind: "wait", code: "placement", reason: "capacity" }, f.tickDeps);
    expect(f.notes("wait-note:r0")).toHaveLength(0);
    expect(listEvents(f.db, { target: "T1" }).filter((e) => e.data.mechanism === "reviewSeatIdle")).toHaveLength(0);
  } finally { f.close(); }
});

test("[验收线 4] private local-only security review explains the policy conflict even when a peer has room", async () => {
  const f = setup();
  try {
    const run = async () => {
      const s = f.snapshot();
      s.workflow!.template = "security";
      s.projectRepo = "other/repo";
      s.pool!.peers = [{ peer: "available", open: 0, maxOpen: 1,
        v2: { why: null, roles: [], repos: ["o/r"], slots: { claude: 0, codex: 1 } } }];
      const plan = planScheduler(s);
      expect(plan).toMatchObject({ kind: "wait", code: "placement" });
      await trackReviewSeatWait(f.reader.get()!, f.task(), s, plan, f.tickDeps);
    };
    await run(); f.advance(21 * 60_000); await run();
    const text = f.notes("wait-note:r0")[0].text;
    expect(text).toContain("private_local_review_conflict");
    expect(text).not.toContain("peer_available");
  } finally { f.close(); }
});
