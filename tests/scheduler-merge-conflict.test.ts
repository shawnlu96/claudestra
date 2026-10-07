/**
 * i28-M12: a conflicted PR / a red required check on the reviewed head / a PM switch to manual before any merge is a settled
 * outcome — the card goes back to fix (or to the PM), the queue is never frozen. Driver + ledger + service tick, end to end.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { closeLedger, getMeta, getTask, openLedger } from "../src/lib/ledger-store.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { advanceMergeRun, beginMergeRun, getMergeRun, type MergePhase } from "../src/lib/scheduler-merge.js";
import { bounceReceipt, MAX_MERGE_BOUNCES, parseBounceReceipt } from "../src/lib/scheduler-merge-conflict.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";

const H = "a".repeat(40), N = "c".repeat(40), MAIN = "e".repeat(40), M = "b".repeat(40);
const RUN = "https://github.com/example/repo/actions/runs/7";
const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: "/tmp/p" } } });

function addCard(db: ReturnType<typeof openLedger>, id: string, pr: number, mergeIntent = true) {
  const ctx = { actor: "owner", now: 100 };
  createTask(db, ctx, { project: "p", id, title: "merge", kind: "code", agent: "agent-author" });
  setWorkflow(db, ctx, { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "缩小范围" });
  db.query("UPDATE tasks SET stage='merge', round=1, rev=2, headSHA=?, pr=?, branch=? WHERE id=?").run(H, `https://github.com/example/repo/pull/${pr}`, `task/${id}`, id);
  db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (100,'agent-review','p',?,'review','',?)").run(id, JSON.stringify({
    round: 1, head: H, verdict: "pass", reviewer: "agent-review", reviewerSessionId: `rs-${id}`, reviewerFamily: "codex",
    path: `reviews/${id}-r1/report.md`, findings: [], p0: 0, p1: 0, p2: 0 }));
  const intent = (iid: string, node: string, action: string, status: string) => db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,
    causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt) VALUES (?,?,'p',?,?,3,4,2,1,?,2,?,'r',100,100)`)
    .run(iid, id, node, action, H, status);
  if (mergeIntent) intent(`merge-${id}`, "merge_deploy", "merge", "submitted");
  intent(`rc-${id}`, "adversarial_review", "ensure_session", "done");
  if (mergeIntent) db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p',?,?,?,100)").run(`task:${id}`, id, `merge-${id}`);
  db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES (?,'reviewer','agent-review',?,'codex','acp','active',?,100,100)`).run(id, `rs-${id}`, `rc-${id}`);
}

const pr = (p: Partial<PrSnapshot> = {}): PrSnapshot => ({ state: "OPEN", head: H, branch: "task/T1", base: "main", draft: false, crossRepository: false,
  mergeState: "CLEAN", mergeSha: null, checks: [{ name: "check", bucket: "pass" }], ...p });
const dirty = (p: Partial<PrSnapshot> = {}) => pr({ mergeState: "DIRTY", checks: [], ...p });

function fixture(phase: MergePhase = "ready", required: string[] = ["check"]) {
  const dir = mkdtempSync(join(tmpdir(), "m12-merge-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  addCard(db, "T1", 42);
  db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p','merge:p','T1','merge-T1',100)").run();
  beginMergeRun(db, { actor: "scheduler", now: 101 }, "merge-T1", required);
  if (phase !== "ready") db.query("UPDATE scheduler_merges SET phase=? WHERE intentId='merge-T1'").run(phase);
  let snaps: PrSnapshot[] = [pr()];
  const calls: string[] = [];
  const external: MergeExternal = {
    inspect: async () => { calls.push("inspect"); return snaps.length > 1 ? snaps.shift()! : snaps[0]!; },
    freshness: async () => ({ behindBy: 0, mainHead: MAIN }),
    carryReview: async () => ({ ok: false, reason: "不沿用" }),
    updateBranch: async () => { calls.push("update"); },
    merge: async () => { calls.push("merge"); return M; },
  };
  const manager = async (...args: string[]) => runLedger(args.slice(1), { db, actor: "scheduler", projectIds: ["p"],
    loadRegistry: async () => ({} as Registry), saveRegistry: async () => {}, now: () => 300 }) as Promise<Record<string, unknown>>;
  const tick = () => schedulerMergeTick(db, config, manager, () => external);
  const close = () => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); };
  return { db, external, calls, tick, close, set snaps(s: PrSnapshot[]) { snaps = s; } };
}
type F = ReturnType<typeof fixture>;
const with_ = async (phase: MergePhase, body: (f: F) => Promise<void>, required?: string[]) => {
  const f = fixture(phase, required);
  try { await body(f); } finally { f.close(); }
};
const stateOf = (f: F) => ({
  run: getMergeRun(f.db, "merge-T1")?.phase as string | undefined,
  intent: (f.db.query("SELECT status FROM scheduler_intents WHERE id='merge-T1'").get() as { status: string }).status,
  stage: (f.db.query("SELECT stage FROM tasks WHERE id='T1'").get() as { stage: string }).stage,
  frozen: getMeta(f.db, "p").queueFrozen.frozen,
  held: (f.db.query("SELECT count(*) AS n FROM scheduler_resources WHERE intentId='merge-T1'").get() as { n: number }).n,
  mode: (f.db.query("SELECT mode FROM task_workflows WHERE taskId='T1'").get() as { mode: string }).mode,
});
const BOUNCED = { run: "resolved", intent: "cancelled", stage: "fix", frozen: false, held: 0, mode: "auto" };
const conflictEvents = (f: F) => (f.db.query(`SELECT data FROM events WHERE target='T1' AND kind='scheduler'
  AND json_extract(data,'$.op')='merge_conflict' ORDER BY seq`).all() as { data: string }[]).map((r) => JSON.parse(r.data));

describe("i28-M12 conflict goes back to fix without freezing the queue", () => {
  for (const phase of ["ready", "updating", "await_ci"] as const) {
    test(`${phase}: DIRTY on the reviewed head → one transaction: run resolved, intent cancelled, slot freed, merge→fix, no freeze`, async () => {
      await with_(phase, async (f) => {
        f.snaps = [dirty()];
        await f.tick();
        expect(stateOf(f)).toEqual(BOUNCED);
        expect(f.calls).not.toContain("merge");
        expect(f.calls).not.toContain("update");
        const intent = f.db.query("SELECT receipt FROM scheduler_intents WHERE id='merge-T1'").get() as { receipt: string };
        expect(intent.receipt).toContain(H);
        expect(intent.receipt).toContain(MAIN);
        expect(conflictEvents(f)).toEqual([expect.objectContaining({ op: "merge_conflict", cause: "conflict", prHead: H, mainHead: MAIN, count: 1, escalated: false })]);
        const stage = f.db.query("SELECT data FROM events WHERE target='T1' AND kind='stage' ORDER BY seq DESC LIMIT 1").get() as { data: string };
        expect(JSON.parse(stage.data)).toMatchObject({ from: "merge", to: "fix", mergeBounce: { cause: "conflict", prHead: H, mainHead: MAIN } });
        expect(getMergeRun(f.db, "merge-T1")?.reason).toStartWith("conflict: ");
      });
    });
  }
  test("counterexamples: DIRTY with a moved head / closed / fork / draft / other base or branch is never a conflict", async () => {
    for (const [phase, change, expected] of [
      ["ready", { head: N }, "await_review"] /* MCRY2: carry refused → re-review, no freeze */, ["ready", { state: "CLOSED" as const }, "unknown"], ["ready", { crossRepository: true }, "unknown"],
      ["ready", { base: "dev" }, "unknown"], ["ready", { branch: "task/T9" }, "unknown"], ["ready", { draft: true }, "ready"],
      ["await_ci", { head: N }, "unknown"], ["await_ci", { state: "CLOSED" as const }, "unknown"], ["await_ci", { crossRepository: true }, "unknown"],
      ["await_ci", { draft: true }, "await_ci"], ["updating", { state: "CLOSED" as const }, "unknown"], ["updating", { draft: true }, "updating"],
    ] as const) {
      await with_(phase, async (f) => {
        f.snaps = [dirty(change)];
        await f.tick();
        expect([phase, JSON.stringify(change), stateOf(f).run, stateOf(f).stage]).toEqual([phase, JSON.stringify(change), expected, expected === "await_review" ? "review" : "merge"]);
        if (expected === "await_review") expect([getTask(f.db, "T1")?.headSHA, stateOf(f).frozen]).toEqual([N, false]);
        expect(conflictEvents(f)).toEqual([]);
      });
    }
  });
  test("merging (gh merge already sent) + DIRTY stays unknown and freezes: never treated as revocable", async () => {
    await with_("merging", async (f) => {
      f.snaps = [dirty()];
      await f.tick();
      expect(stateOf(f)).toMatchObject({ run: "unknown", stage: "merge", frozen: true });
      expect(() => advanceMergeRun(f.db, { actor: "scheduler", now: 400 }, { intentId: "merge-T1", from: "unknown", to: "resolved", rev: 3,
        receipt: bounceReceipt({ cause: "conflict", prHead: H, mainHead: MAIN, checks: [] }) })).toThrow(/不能从/);
    });
  });
  test("update-branch refused: re-read DIRTY → conflict; re-read anything else → back to fix as update_fail (i28-M12b)", async () => {
    for (const [after, expected] of [[dirty(), "resolved"], [pr({ mergeState: "BEHIND" }), "resolved"], [dirty({ head: N }), "resolved"]] as const) {
      await with_("ready", async (f) => {
        f.snaps = [pr({ mergeState: "BEHIND" }), after];
        f.external.updateBranch = async () => { f.calls.push("update"); throw new Error("gh 失败：merge conflict"); };
        await f.tick();
        expect([expected, stateOf(f).run, stateOf(f).frozen]).toEqual([expected, expected, false]);
        expect(f.calls).toEqual(["inspect", "update", "inspect"]);
      });
    }
  });
});

describe("i28-M12 red required CI on the reviewed head goes back to fix", () => {
  test("UNSTABLE / BLOCKED with a failed or cancelled required check → ci_fail bounce with check names and run links", async () => {
    for (const [phase, mergeState, bucket] of [["ready", "UNSTABLE", "fail"], ["ready", "BLOCKED", "cancel"], ["await_ci", "UNSTABLE", "fail"],
      ["await_ci", "BEHIND", "fail"], ["updating", "UNSTABLE", "cancel"]] as const) {
      await with_(phase, async (f) => {
        f.snaps = [pr({ mergeState, checks: [{ name: "check", bucket, link: RUN }, { name: "lint", bucket: "pass" }] })];
        await f.tick();
        expect(stateOf(f)).toEqual(BOUNCED);
        expect(conflictEvents(f)[0]).toMatchObject({ cause: "ci_fail", checks: [{ name: "check", link: RUN }], count: 1 });
        expect(f.calls).not.toContain("update");
      });
    }
  });
  test("a failed non-required check, or a red required check on a moved head, keeps the old unknown", async () => {
    for (const p of [{ mergeState: "UNSTABLE", checks: [{ name: "check", bucket: "pass" as const }, { name: "lint", bucket: "fail" as const }] },
      { head: N, mergeState: "UNSTABLE", checks: [{ name: "check", bucket: "fail" as const }] }]) {
      await with_("await_ci", async (f) => {
        f.snaps = [pr(p)];
        await f.tick();
        expect(stateOf(f)).toMatchObject({ run: "unknown", frozen: true, stage: "merge" });
      });
    }
  });
});

describe("i28-M12 ledger guards on the bounce", () => {
  const step = (f: F, receipt: string) => advanceMergeRun(f.db, { actor: "scheduler", now: 400 }, { intentId: "merge-T1", from: "ready", to: "resolved", rev: 1, receipt });
  test("receipt must carry the reviewed head, a full main head, or only required check names", async () => {
    await with_("ready", async (f) => {
      expect(() => step(f, bounceReceipt({ cause: "conflict", prHead: N, mainHead: MAIN, checks: [] }))).toThrow(/回执缺证据/);
      expect(() => step(f, `退回 fix（conflict）：PR head ${H}，main head short`)).toThrow(/只有 PM 切手动/);
      expect(() => step(f, bounceReceipt({ cause: "ci_fail", prHead: H, mainHead: null, checks: [{ name: "lint", link: "" }] }))).toThrow(/回执缺证据/);
      expect(() => step(f, "随便写的原因")).toThrow(/只有 PM 切手动/);
      expect(stateOf(f)).toMatchObject({ run: "ready", stage: "merge", intent: "submitted" });
    });
  });
  test("a drifted run (head changed on the card) cannot bounce", async () => {
    await with_("ready", async (f) => {
      f.db.query("UPDATE tasks SET headSHA=? WHERE id='T1'").run(N);
      expect(() => step(f, bounceReceipt({ cause: "conflict", prHead: H, mainHead: MAIN, checks: [] }))).toThrow(/已失效/);
    });
  });
  test("receipt round-trips", () => {
    const b = { cause: "ci_fail" as const, prHead: H, mainHead: null, checks: [{ name: "typecheck + test + guard", link: RUN }] };
    expect(parseBounceReceipt(bounceReceipt(b))).toEqual(b);
    expect(parseBounceReceipt(`退回 fix（ci_fail）：PR head ${H}，失败检查 []`)).toBeNull();
  });
  test("3 failed checks with long names and job links: receipt fits the 600 gate, names kept, links narrowed to the run", async () => {
    const names = ["a", "b", "c"].map((x) => `${x} `.repeat(30).trim() + "x".repeat(20));
    const job = (i: number) => `${RUN}0000${i}/job/${"9".repeat(12)}${"?pr=42&check_suite_focus=true".repeat(4)}`;
    await with_("await_ci", async (f) => {
      f.snaps = [pr({ mergeState: "UNSTABLE", checks: names.map((name, i) => ({ name, bucket: "fail" as const, link: job(i) })) })];
      await f.tick();
      expect(stateOf(f)).toEqual(BOUNCED);
      const reason = getMergeRun(f.db, "merge-T1")?.reason as string;
      expect(reason.length - "ci_fail: ".length).toBeLessThanOrEqual(600);
      expect(conflictEvents(f)[0].checks).toEqual(names.map((name, i) => ({ name, link: `${RUN}0000${i}` })));
    }, names);
  });
  test("r1 ci-receipt shape: 3 required 70-char names, 132-char job links (755 chars before) → bounced, not frozen", async () => {
    const names = ["test-", "lint-", "type-"].map((x) => x + "x".repeat(65));
    const link = `https://github.com/${"o".repeat(35)}/${"r".repeat(40)}/actions/runs/12345678900/job/23456789011`;
    await with_("ready", async (f) => {
      f.snaps = [pr({ mergeState: "UNSTABLE", checks: names.map((name) => ({ name, bucket: "fail" as const, link })) })];
      await f.tick();
      expect(stateOf(f)).toEqual(BOUNCED);
      expect(conflictEvents(f)[0].checks.map((c: { name: string }) => c.name)).toEqual(names);
    }, names);
  });
  test("receipt fitting: first check always kept, later links dropped before checks, names never cut", () => {
    const names = Array.from({ length: 8 }, (_, i) => `${i}`.padEnd(80, "n"));
    const b = { cause: "ci_fail" as const, prHead: H, mainHead: null, checks: names.map((name) => ({ name, link: `${RUN}/job/1` })) };
    const receipt = bounceReceipt(b), parsed = parseBounceReceipt(receipt);
    expect(receipt.length).toBeLessThanOrEqual(600);
    expect(parsed?.checks[0]).toEqual({ name: names[0], link: RUN });
    expect(parsed?.checks.every((c, i) => c.name === names[i])).toBe(true);
    expect(parsed!.checks.length).toBeGreaterThan(1);
    expect(parsed!.checks.length).toBeLessThan(names.length);
  });
  test(`bounce ${MAX_MERGE_BOUNCES + 1} is not sent back: card stays in merge, intent cancelled, slot freed, still no freeze`, async () => {
    await with_("ready", async (f) => {
      for (let i = 1; i <= MAX_MERGE_BOUNCES; i++) {
        f.db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (200,'scheduler','p','T1','scheduler','',?)")
          .run(JSON.stringify({ op: "merge_conflict", intentId: `old-${i}`, cause: "conflict", count: i, escalated: false }));
      }
      f.snaps = [dirty()];
      await f.tick();
      expect(stateOf(f)).toEqual({ ...BOUNCED, stage: "merge" });
      expect(conflictEvents(f).at(-1)).toMatchObject({ intentId: "merge-T1", count: MAX_MERGE_BOUNCES + 1, escalated: true });
    });
  });
});

describe("i28-M12 other cards keep moving", () => {
  test("A conflicts, B's review → merge still begins and advances; nothing freezes", async () => {
    await with_("ready", async (f) => {
      addCard(f.db, "T2", 43, false);
      const byPr: Record<string, PrSnapshot> = { "42": dirty(), "43": pr({ branch: "task/T2" }) };
      f.external.inspect = async (ref) => byPr[ref.split("/").at(-1)!]!;
      await f.tick();
      expect(stateOf(f)).toEqual(BOUNCED);
      // A's merge slot is free again; the planner can hand it to B, whose merge then runs normally.
      expect(f.db.query("SELECT count(*) AS n FROM scheduler_resources WHERE resource='merge:p'").get()).toEqual({ n: 0 });
      f.db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
        VALUES ('merge-T2','T2','p','merge_deploy','merge',3,999,2,1,?,2,'submitted','r',300,300)`).run(H);
      f.db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p','merge:p','T2','merge-T2',300)").run();
      await f.tick();
      expect(getMergeRun(f.db, "merge-T2")?.phase).toBe("await_ci");
      expect(getMeta(f.db, "p").queueFrozen.frozen).toBe(false);
    });
  });
});

describe("i28-M12 PM switches the card to manual mid-merge", () => {
  for (const phase of ["ready", "updating", "await_ci"] as const) {
    test(`${phase}: run ends as cancelled, slot freed, no freeze, task untouched`, async () => {
      await with_(phase, async (f) => {
        f.db.query("UPDATE task_workflows SET mode='manual' WHERE taskId='T1'").run();
        await f.tick();
        expect(stateOf(f)).toEqual({ run: "resolved", intent: "cancelled", stage: "merge", frozen: false, held: 0, mode: "manual" });
        expect(getMergeRun(f.db, "merge-T1")?.reason).toStartWith("cancelled: ");
        expect(f.calls).toEqual([]);
      });
    });
  }
  test("merging: manual switch after gh merge was sent stays unknown and freezes", async () => {
    await with_("merging", async (f) => {
      f.db.query("UPDATE task_workflows SET mode='manual' WHERE taskId='T1'").run();
      await f.tick();
      expect(stateOf(f)).toMatchObject({ run: "unknown", frozen: true });
    });
  });
  test("await_ci: PM switches to manual while CI runs, the merging claim is refused → cancelled, no merge, no freeze", async () => {
    await with_("await_ci", async (f) => {
      f.external.freshness = async () => {
        f.db.query("UPDATE task_workflows SET mode='manual' WHERE taskId='T1'").run();
        return { behindBy: 0, mainHead: MAIN };
      };
      await f.tick();
      expect(stateOf(f)).toEqual({ run: "resolved", intent: "cancelled", stage: "merge", frozen: false, held: 0, mode: "manual" });
      expect(getMergeRun(f.db, "merge-T1")?.reason).toStartWith("cancelled: PM 切手动");
      expect(f.calls).not.toContain("merge");
    });
  });
  test("await_ci: PM switches to manual through the real setWorkflow while inspect is in flight (r1 manual-race) → cancelled", async () => {
    await with_("await_ci", async (f) => {
      f.external.inspect = async () => {
        const t = getTask(f.db, "T1")!, w = getWorkflow(f.db, "T1")!;
        setWorkflow(f.db, { actor: "owner", now: 250 }, { taskId: "T1", taskRev: t.rev, workflowRev: w.rev, template: "code", templateVersion: 2,
          mode: "manual", authorFamily: "claude", fallback: "缩小范围", reason: "PM 接管" });
        return pr();
      };
      await f.tick();
      expect(f.calls).not.toContain("merge");
      expect(stateOf(f)).toEqual({ run: "resolved", intent: "cancelled", stage: "merge", frozen: false, held: 0, mode: "manual" });
    });
  });
  for (const phase of ["ready", "updating", "await_ci"] as const) {
    test(`${phase}: manual during inspect + a red optional check (the driver writes unknown itself, r2) → cancelled, no freeze`, async () => {
      await with_(phase, async (f) => {
        f.external.inspect = async () => {
          const t = getTask(f.db, "T1")!, w = getWorkflow(f.db, "T1")!;
          setWorkflow(f.db, { actor: "owner", now: 250 }, { taskId: "T1", taskRev: t.rev, workflowRev: w.rev, template: "code", templateVersion: 2,
            mode: "manual", authorFamily: "claude", fallback: "缩小范围", reason: "PM 接管" });
          return pr({ mergeState: "UNSTABLE", checks: [{ name: "check", bucket: "pass" }, { name: "lint", bucket: "fail" }] });
        };
        await f.tick();
        expect(stateOf(f)).toEqual({ run: "resolved", intent: "cancelled", stage: "merge", frozen: false, held: 0, mode: "manual" });
        expect(f.calls).toEqual([]); // inspect is replaced above; no update-branch, no merge
      });
    });
  }
  test("await_ci: a refused merging claim that is not a manual switch (head moved on the card) is still unknown", async () => {
    await with_("await_ci", async (f) => {
      f.external.freshness = async () => {
        f.db.query("UPDATE tasks SET headSHA=? WHERE id='T1'").run(N);
        return { behindBy: 0, mainHead: MAIN };
      };
      await f.tick();
      expect(stateOf(f)).toMatchObject({ run: "unknown", frozen: true, stage: "merge" });
      expect(f.calls).not.toContain("merge");
    });
  });
  test("other drift (head changed) in ready is still unknown", async () => {
    await with_("ready", async (f) => {
      f.db.query("UPDATE tasks SET headSHA=? WHERE id='T1'").run(N);
      await f.tick();
      expect(stateOf(f)).toMatchObject({ run: "unknown", frozen: true });
    });
  });
});
