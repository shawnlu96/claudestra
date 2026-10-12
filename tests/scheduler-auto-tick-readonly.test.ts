/**
 * AREB2 [验收线 3]: a throw out of deps.ensure (AREB1's rebuild wrote on the service's read-only handle) must not leave the claimed
 * ensure intent submitted with no reason: the tick settles it unknown with the error as its receipt and goes on with the next card.
 * The tick reads through ledger-read's query_only handle (autoFixture), its ledger writes are the real `ledger` commands.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const READONLY = "SQLiteError: attempt to write a readonly database\n    at recordObserved (src/lib/recovery-policy.ts:128)";

function twoCards(f: F, thrown: unknown) {
  createTask(f.db, f.at("owner"), { project: "p", id: "T2", title: "auto 2", kind: "code", agent: "agent-task-two", extra: { fileGlobs: ["src/lib/y.ts"] } });
  setWorkflow(f.db, f.at("owner"), { taskId: "T2", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "只报错不修" });
  const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
  reg.agents["agent-task-two"] = { runtime: "claude-code", sessionId: "s-two", cwd: f.dir, channelId: "ch-two" };
  writeFileSync(f.registryPath, JSON.stringify(reg));
  const real = f.tickDeps.ensure;
  f.tickDeps.ensure = async (task, role, family) => { if (task.id === "T1") throw thrown; return real(task, role, family); };
  return () => schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 } }, f.tickDeps);
}
const ensureOf = (f: F, taskId: string) => f.db.query("SELECT status, receipt FROM scheduler_intents WHERE taskId = ? AND action = 'ensure_session' ORDER BY eventSeq DESC")
  .get(taskId) as { status: string; receipt: string | null } | null;

describe("AREB2 tick: deps.ensure throws", () => {
  test("[验收线 3] the intent is settled unknown with the error (one line), the pass goes on to the next card", async () => {
    const f = autoFixture();
    try {
      const out = await twoCards(f, new Error(READONLY))();
      expect(out.failed).toEqual([]); // old code: the throw left the card in failed and its intent submitted
      expect(out.cards.find((c) => c.taskId === "T1")).toMatchObject({ step: "held", detail: expect.stringContaining("attempt to write a readonly database") });
      const row = ensureOf(f, "T1")!;
      expect(row.status).toBe("unknown");
      expect(row.receipt).toContain("建 session 抛异常：SQLiteError: attempt to write a readonly database at recordObserved");
      expect(row.receipt).not.toContain("\n");
      expect(out.cards.find((c) => c.taskId === "T2")?.step).toBe("session");
      expect(ensureOf(f, "T2")?.status).toBe("done");
      // the next pass reads the unknown intent as before: held for PM, never re-created
      const next = await schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 } }, f.tickDeps);
      expect(next.failed).toEqual([]);
      expect(f.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE taskId = 'T1' AND action = 'ensure_session'").get()).toEqual({ n: 1 });
    } finally { f.close(); }
  });

  test("a long, multi-line error is cut to one line in the receipt; a non-Error throw is kept as text", async () => {
    const f = autoFixture();
    try {
      await twoCards(f, `boom\n${"x".repeat(2000)}`)();
      const row = ensureOf(f, "T1")!;
      expect(row.status).toBe("unknown");
      expect(row.receipt).toStartWith("建 session 抛异常：boom x");
      expect(row.receipt!.length).toBeLessThanOrEqual(320);
    } finally { f.close(); }
  });

  test("a stopped service (SchedulerStopped) still ends the pass, as before", async () => {
    const f = autoFixture();
    try {
      await expect(twoCards(f, new SchedulerStopped("lease lost"))()).rejects.toBeInstanceOf(SchedulerStopped);
      expect(ensureOf(f, "T1")?.status).toBe("submitted");
    } finally { f.close(); }
  });
});
