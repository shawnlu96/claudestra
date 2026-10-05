/**
 * FB1P: after a verified fix start move (lend-fix-start.ts adoptFixStart), the fix strategy, its swap materials and the local
 * take_order read the original finding through the same start chain as fixPackage; review / merge reads stay on currentReviewFacts.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { convergenceOrderLines } from "../src/lib/fix-strategy-order.js";
import { planConvergence } from "../src/lib/fix-strategy-plan.js";
import { adoptFixStart, FIX_START_MOVED_OP } from "../src/lib/lend-fix-start.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { takeOrderResult } from "../src/lib/order-take.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { currentReviewFacts } from "../src/lib/scheduler-review.js";
import { convergenceProbe, repeatedFix } from "./fix-strategy-helpers.js";
import { H2, P1 } from "./scheduler-auto-helpers.js";

const H3 = "3".repeat(40), H4 = "4".repeat(40);
const call = { agent: "agent-task-one", sessionId: "s-one", family: "claude-code", channelId: "ch-one" } as never;
type Fixture = Awaited<ReturnType<typeof repeatedFix>>;

const move = (f: Fixture, from: string, head: string) =>
  adoptFixStart(f.db, f.at("scheduler"), f.task(), { fixStart: { ok: true, from, head } } as never);
const snapshot = (f: Fixture) => autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2 });
const localFindings = (f: Fixture) => {
  const r = takeOrderResult(f.db, call);
  if (!r.ok || !r.order) throw new Error(JSON.stringify(r));
  return { ids: r.order.findings.map((x) => x.findingId), report: r.order.inputs.find((i) => i.startsWith("上一轮审查报告")) ?? null };
};

test("consecutive P1 after a start move: strategy swaps, materials keep the original report, local take carries the finding", async () => {
  const f = await repeatedFix();
  try {
    expect(move(f, H2, H3).headSHA).toBe(H3);
    const events = listEvents(f.db, { project: "p", target: "T1" });
    expect(currentReviewFacts(f.task(), events).kind).toBe("invalid"); // review / merge authorization unchanged
    const local = localFindings(f);
    expect(local.ids).toEqual([P1.findingId]);
    expect(local.report).toContain("reviews/T1-r2/report.md");
    const p = convergenceProbe(f), intent = p.plan();
    expect(intent.action).toBe("fix_swap");
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "waiting" });
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "session" });
    const body = readFileSync(convergenceOrderLines(f.db, f.task()).at(-1)!.split("：").at(-1)!, "utf8");
    expect(body).toContain("original report reviews/T1-r2/report.md");
    expect(body).toContain(P1.probe);
  } finally { f.close(); }
});

test("second mismatch: a contiguous H2→H3→H4 chain still reads the H2 finding", async () => {
  const f = await repeatedFix();
  try {
    move(f, H2, H3); move(f, H3, H4);
    expect(f.task().headSHA).toBe(H4);
    expect(localFindings(f).ids).toEqual([P1.findingId]);
    expect(convergenceProbe(f).plan().action).toBe("fix_swap");
  } finally { f.close(); }
});

const forged: [string, Record<string, unknown>][] = [
  ["missing chain", {}],
  ["foreign actor", { actor: "peer:mate" }],
  ["broken from", { oldHead: H4 }],
  ["other round", { round: 99 }],
];
test.each(forged)("no verified chain (%s): neither strategy nor local take reuse the old report", async (_name, bad) => {
  const f = await repeatedFix();
  try {
    f.db.prepare("UPDATE tasks SET headSHA = ?, rev = rev + 1 WHERE id = 'T1'").run(H3);
    if (Object.keys(bad).length) {
      const t = f.task(), { actor, ...data } = bad;
      insertEvent(f.db, { actor: (actor as string | undefined) ?? "scheduler", now: Date.now() }, { project: t.project, target: t.id, kind: "scheduler",
        text: "forged", data: { op: FIX_START_MOVED_OP, oldHead: H2, newHead: H3, round: t.round, specRev: t.specRev, ...data } }, true);
    }
    expect(localFindings(f)).toEqual({ ids: [], report: null });
    const decision = planScheduler(snapshot(f));
    expect(decision).not.toMatchObject({ action: "fix_swap" });
    expect(decision).toMatchObject({ kind: "escalate" });
  } finally { f.close(); }
});

test("a delivery after the move ends the chain for the strategy", async () => {
  const f = await repeatedFix();
  try {
    move(f, H2, H3);
    const s = snapshot(f);
    const base = () => ({ kind: "intent", action: "dispatch" }) as never;
    expect(planConvergence(s, base)).toMatchObject({ action: "fix_swap" });
    const delivered = { ...s.events.at(-1)!, seq: s.events.at(-1)!.seq + 1, kind: "deliver" as const, data: { headSHA: H3 } };
    expect(planConvergence({ ...s, events: [...s.events, delivered] }, base)).toMatchObject({ action: "dispatch" });
  } finally { f.close(); }
});
