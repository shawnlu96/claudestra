import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { ledgerOrigin } from "../src/lib/ledger-origin.js";
import { observeMemory } from "../src/lib/memory-auto.js";
import { projectMemories } from "../src/lib/memory-auto-common.js";
import { prepareSummary, configuredLesson } from "../src/lib/memory-auto-summary.js";
import { SchedulerLeaseLost } from "../src/lib/scheduler-lease-env.js";
import { schedulerObserveTick } from "../src/lib/scheduler-observe-tick.js";
import { runLedger } from "../src/manager/ledger.js";
import type { LedgerDeps } from "../src/manager/ledger-context.js";
import { isTestProcess } from "../src/lib/test-guard.js";

const P = "demo", H = "a".repeat(40);
let db: Database, now: number;
const at = () => ({ actor: "owner", now: ++now });
const add = (kind: "stage" | "review" | "deliver" | "decision", data: Record<string, unknown>, text = "", target = "A") =>
  insertEvent(db, at(), { project: P, target, kind, data, text }, false);
function card(id = "A", kind: "code" | "ops" | "investigate" = "code") {
  createTask(db, at(), { id, project: P, kind, title: `Transaction boundaries ${id}` });
  db.query("UPDATE tasks SET stage = ?, round = 2, headSHA = ?, extra = ? WHERE id = ?")
    .run(kind === "code" ? "verified" : "done", H, JSON.stringify({ fileGlobs: ["src/lib/x.ts", "src/lib/y.ts", "tests/x.test.ts"] }), id);
}
const deps = (actor = "scheduler", assertLease: (() => void) | undefined = () => {}): LedgerDeps => ({
  db, actor, projectIds: [P], assertLease, now: () => ++now, loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {},
});
const run = () => observeMemory(db, "scheduler", P, { assertLease: () => {} });
const summaries = () => projectMemories(db, P).filter((m) => m.kind === "summary");
beforeEach(() => {
  db = openLedger(":memory:"); now = 1000; ledgerOrigin(db, () => "ab12");
  setMeta(db, at(), { project: P, key: "pms", value: ["agent-pm"] });
});
afterEach(() => closeLedger(":memory:"));

test("verified factual summary carries rounds/P1 resolution/files/decisions/final deliver and survives unavailable model", async () => {
  card();
  add("review", { round: 1, p1: 1, findings: [{ severity: "P1", family: "widget-tx", probe: "读 revision 跳号" }] });
  add("review", { round: 2, p1: 0, findings: [] });
  add("decision", {}, "Keep the transaction atomic");
  add("deliver", {}, "Atomic writes preserve revision ordering");
  const done = add("stage", { from: "live", to: "verified" });
  let calls = 0;
  const options = { assertLease: () => {}, files: async () => ["src/lib/actual.ts", "tests/actual.test.ts"],
    lesson: async () => { calls++; throw new Error("model offline"); } };
  await observeMemory(db, "scheduler", P, options);
  expect(calls).toBe(1);
  const m = summaries()[0]!;
  expect(m.sources).toEqual([{ origin: "ab12", originSeq: done.originSeq! }]);
  expect(m.body).toContain("轮数 2"); expect(m.body).toContain("widget-tx(下一轮消失)");
  expect(m.body).toContain("Keep the transaction atomic"); expect(m.body).toContain("Atomic writes preserve");
  expect(m.body).not.toContain("教训"); expect(Buffer.byteLength(String(m.body))).toBeLessThanOrEqual(400);
  expect(m.files).toEqual(["src/lib/actual.ts", "tests/actual.test.ts"]);
  await observeMemory(db, "scheduler", P, options); expect(calls).toBe(1); expect(summaries()).toHaveLength(1);
});

test("lesson NONE/unavailable/unsafe/overlong falls back; valid lesson passes output lint", async () => {
  card(); const e = add("stage", { to: "verified" });
  for (const lesson of [null, "NONE", "x".repeat(181), "token ghp_" + "Ab12".repeat(8)]) {
    const m = await prepareSummary(db, e, { lesson: async () => lesson });
    expect(m!.body).not.toContain("教训");
  }
  const enriched = await prepareSummary(db, e, { lesson: async () => "Keep revision and writes in the same transaction." });
  expect(enriched!.body).toContain("教训：Keep revision");
});

test("small cards skip model; no head ops and investigate done still summarize", async () => {
  card(); db.query("UPDATE tasks SET extra = ?, round = 1 WHERE id = 'A'").run(JSON.stringify({ fileGlobs: ["src/lib/x.ts"] }));
  let calls = 0;
  const m = await prepareSummary(db, add("stage", { to: "verified" }), { lesson: async () => { calls++; return "lesson"; } });
  expect(m!.body).not.toContain("教训"); expect(calls).toBe(0);
  for (const kind of ["ops", "investigate"] as const) {
    card(kind, kind); db.query("UPDATE tasks SET headSHA = NULL WHERE id = ?").run(kind);
    add("stage", { to: "done" }, "", kind);
  }
  await run(); expect(summaries()).toHaveLength(3);
  expect(summaries().find((m) => m.taskId === "ops")!.head).toBe("no-code");
});

test("CLI rejects ordinary agents and missing/lost lease; losing lease during model wait writes no completion receipt", async () => {
  card(); const e = add("stage", { to: "verified" });
  for (const actor of ["owner", "agent-pm", "agent-x"]) {
    expect(await runLedger(["memory-auto", "--project", P], deps(actor))).toMatchObject({ ok: false, code: "forbidden" });
  }
  const unleased = deps(); delete unleased.assertLease;
  expect(await runLedger(["memory-auto", "--project", P], unleased)).toMatchObject({ ok: false, code: "forbidden" });
  const lost = () => { throw new SchedulerLeaseLost("lost"); };
  expect(await runLedger(["memory-auto", "--project", P], deps("scheduler", lost))).toMatchObject({ ok: false, code: "lease-lost" });
  let held = true;
  await expect(observeMemory(db, "scheduler", P, { assertLease: () => { if (!held) lost(); },
    lesson: async () => { held = false; return "Keep writes atomic."; } })).rejects.toBeInstanceOf(SchedulerLeaseLost);
  expect(summaries()).toEqual([]);
  expect(listEvents(db, { project: P }).some((r) => r.dedupKey === `memory-auto:demo:ab12/${e.originSeq}`)).toBe(false);
});

test("observe tick sends guarded CLI writes for auto and manual completions even without observe-mode cards", async () => {
  for (const id of ["AUTO", "MANUAL"]) { card(id); add("stage", { to: "verified" }, "", id); }
  const calls: string[][] = [];
  const result = await schedulerObserveTick(db, { demo: { maxActiveWorkers: 2 } }, async (...args) => {
    calls.push(args); return runLedger(args.slice(1), deps());
  });
  expect(result.failed).toEqual([]); expect(calls).toEqual([["ledger", "memory-auto", "--project", P]]);
  expect(summaries().map((m) => m.taskId).sort()).toEqual(["AUTO", "MANUAL"]);
});

test("observer has bounded resumable pages", async () => {
  card(); for (let i = 0; i < 5; i++) add("decision", {}, `Transaction decision ${i}`);
  expect((await observeMemory(db, "scheduler", P, { assertLease: () => {}, limit: 2 })).recorded).toBe(2);
  expect((await observeMemory(db, "scheduler", P, { assertLease: () => {}, limit: 2 })).recorded).toBe(2);
  expect((await observeMemory(db, "scheduler", P, { assertLease: () => {}, limit: 2 })).recorded).toBe(1);
  expect((await run()).recorded).toBe(0);
});

test("configured provider is unavailable without service credentials; tests never send production data", async () => {
  expect(isTestProcess()).toBe(true);
  const prior = process.env.ANTHROPIC_API_KEY, token = process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
  try { expect(await configuredLesson("fixture")).toBeNull(); }
  finally {
    if (prior === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prior;
    if (token === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = token;
  }
});

test("memory tick propagates both lease-lost reply and SchedulerStopped before another project runs", async () => {
  const { memoryAutoTick } = await import("../src/lib/memory-auto-tick.js");
  const { SchedulerStopped } = await import("../src/lib/scheduler-maintenance.js");
  card(); add("stage", { to: "verified" });
  for (const returned of [true, false]) {
    let calls = 0;
    await expect(memoryAutoTick(db, ["demo", "second"], async () => {
      calls++;
      if (!returned) throw new SchedulerStopped("lost");
      return { ok: false, code: "lease-lost" };
    })).rejects.toBeInstanceOf(SchedulerStopped);
    expect(calls).toBe(1);
  }
  const failed = await memoryAutoTick(db, ["demo", "second"], async () => ({ ok: false, error: "offline" }));
  expect(failed).toHaveLength(1);
});

test("non-memory startup stages and clean review verdicts do not spawn an observer ahead of auto dispatch", async () => {
  card(); add("stage", { from: "spec", to: "restate" }); add("stage", { from: "restate", to: "build" });
  add("review", { p1: 0, findings: [] });
  const calls: string[][] = [];
  await schedulerObserveTick(db, { demo: { maxActiveWorkers: 2 } }, async (...args) => { calls.push(args); return { ok: true }; });
  expect(calls).toEqual([]); expect((await run()).recorded).toBe(0);
});
