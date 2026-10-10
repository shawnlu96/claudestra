import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LedgerEvent } from "../src/lib/ledger-stages.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { RECOVERY_POLICY_PATH, type RecoveryMode } from "../src/lib/recovery-policy.js";
import { convergeFollowUp, NEAR_OP } from "../src/lib/review-converge-followup.js";
import { convergeReview, type Downgrade } from "../src/lib/review-converge.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";
import { currentReviewFacts, DOWNGRADE_OP } from "../src/lib/scheduler-review.js";

// i28-CONV6 acceptance 2: a changes verdict whose two P1s only carry near markers (the CVREBOR1 r2 spellings), under off / observe / on.
const HEAD = "e".repeat(40);
const rv: WorkerRef = { agent: "agent-rv", sessionId: "rv-session", taskId: "T1", family: "codex", source: "local" };
const au: WorkerRef = { agent: "agent-au", sessionId: "au-session", taskId: "T1", family: "claude", source: "local" };
const ev = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown>): LedgerEvent =>
  ({ seq, ts: seq, actor: "scheduler", project: "p", target: "T1", kind, data, text: "", dedupKey: null });
const FINDINGS = [
  { findingId: "F1", family: "start-recheck", severity: "P1", probe: "[验收线 1、2;PM 定 4] src/lib/a.ts:10" },
  { findingId: "F2", family: "conv-material", severity: "P1", probe: "src/lib/b.ts:20", description: "[验收线 3;PM 定 7] 冻结材料没核" },
  { findingId: "F3", family: "naming", severity: "P2", probe: "src/lib/c.ts:1" },
];
const REVIEW = ev(20, "review", { round: 1, head: HEAD, reviewer: rv.agent, reviewerSessionId: rv.sessionId, reviewerFamily: rv.family,
  path: "reviews/T1-r1/report.md", verdict: "changes", findings: FINDINGS, p0: 0, p1: 2, p2: 1 });
const EVENTS = [ev(1, "task", { op: "new" }), ev(11, "stage", { from: "build", to: "review", round: 1 }),
  ev(19, "deliver", { round: 1, headSHA: HEAD }), REVIEW];
const port = (m: RecoveryMode) => () => m;

function readFacts() {
  const read = currentReviewFacts({ round: 1, headSHA: HEAD, specRev: 1 }, EVENTS);
  if (read.kind !== "facts") throw new Error(`fixture: ${JSON.stringify(read)}`);
  return read.facts;
}

/** What the planner did before CONV6 (and still does under off): both P1s demoted for no basis, verbatim. */
const OLD_DOWNGRADE: Downgrade = { round: 1, head: HEAD, reportPath: "reviews/T1-r1/report.md", items: [
  { findingId: "F1", family: "start-recheck", probe: "[验收线 1、2;PM 定 4] src/lib/a.ts:10", why: "no_basis" },
  { findingId: "F2", family: "conv-material", probe: "src/lib/b.ts:20", why: "no_basis" },
] };

describe("convergeReview under the nearMarker switch", () => {
  test("off: the old result, byte for byte", () => {
    const c = convergeReview(EVENTS, readFacts(), null, port("off"));
    expect(JSON.stringify(c.downgrade)).toBe(JSON.stringify(OLD_DOWNGRADE));
    expect(c.facts.findings.map((f) => [f.findingId, f.severity, f.basis ?? null])).toEqual([["F1", "P2", null], ["F2", "P2", null], ["F3", "P2", null]]);
  });

  test("observe: still demoted, plus a near record", () => {
    const c = convergeReview(EVENTS, readFacts(), null, port("observe"));
    expect(c.facts.findings.map((f) => f.severity)).toEqual(["P2", "P2", "P2"]);
    expect(c.downgrade).toEqual({ ...OLD_DOWNGRADE, near: [
      { findingId: "F1", basis: "acceptance:1", mode: "observe", counted: false },
      { findingId: "F2", basis: "acceptance:3", mode: "observe", counted: false },
    ] });
  });

  test("on: both stay P1 on their first line, nothing demoted", () => {
    const c = convergeReview(EVENTS, readFacts(), null, port("on"));
    expect(c.facts.findings.map((f) => [f.findingId, f.severity, f.basis ?? null])).toEqual([["F1", "P1", "acceptance:1"], ["F2", "P1", "acceptance:3"], ["F3", "P2", null]]);
    expect(c.downgrade).toEqual({ round: 1, head: HEAD, reportPath: "reviews/T1-r1/report.md", items: [], near: [
      { findingId: "F1", basis: "acceptance:1", mode: "on", counted: true },
      { findingId: "F2", basis: "acceptance:3", mode: "on", counted: true },
    ] });
  });

  test("the switch is read only when a near marker is there; a throwing port is off", () => {
    let reads = 0;
    const counting = () => { reads++; return "on" as const; };
    const strict = { ...readFacts(), findings: [{ findingId: "S", family: "s", severity: "P1" as const, probe: "[验收线 2] x" }] };
    expect(convergeReview(EVENTS, strict, null, counting).downgrade).toBeNull();
    expect(reads).toBe(0);
    convergeReview(EVENTS, readFacts(), null, counting);
    expect(reads).toBe(1);
    const thrown = convergeReview(EVENTS, readFacts(), null, () => { throw new Error("boom"); });
    expect(JSON.stringify(thrown.downgrade)).toBe(JSON.stringify(OLD_DOWNGRADE));
  });
});

const snapshot = (): PlannerSnapshot => ({
  task: { id: "T1", project: "p", itemId: null, title: "T", kind: "code", stage: "review", stageBefore: null, round: 1, agent: au.agent,
    assigneeKind: "agent", assignee: au.agent, pm: "agent-pm", branch: "task/T1", pr: null, headSHA: HEAD, spec: null, specRev: 1,
    model: null, rev: 1, extra: {}, createdAt: 1, updatedAt: 1 },
  workflow: { taskId: "T1", project: "p", template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude",
    fallback: "收窄", specRev: 1, rev: 1, createdAt: 1, updatedAt: 1 },
  events: EVENTS, blockedBy: [], queueFrozen: false, fileGlobs: ["src/lib/*.ts"], heldResources: [], workerCount: 0, maxWorkers: 2,
  freeWorkerSlot: "slot:p:0", author: au, reviewer: rv, uiGate: { state: "none" }, screenshotsDigest: null,
  intents: [{ id: "review-r1", taskId: "T1", project: "p", node: "adversarial_review", action: "review", recipient: rv.agent, causalSeq: 14,
    eventSeq: 15, taskRev: 1, specRev: 1, head: HEAD, templateVersion: 2, status: "done", attempts: 0, receipt: null, reason: "x",
    createdAt: 14, updatedAt: 14 }],
  reviewDispatches: [{ intentId: "review-r1", round: 1, head: HEAD, reviewer: rv.agent, reviewerSessionId: rv.sessionId, ackSeq: 16 }],
});

describe("the planner and the ledger record", () => {
  let saved: string | null = null;
  const setSwitch = (mode: RecoveryMode | null) => {
    if (saved === null) saved = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH, "utf8") : "";
    mkdirSync(dirname(RECOVERY_POLICY_PATH), { recursive: true });
    writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: mode ? { p: { keys: { nearMarker: mode } } } : {} }));
  };
  afterEach(() => {
    if (saved === null) return;
    if (saved) writeFileSync(RECOVERY_POLICY_PATH, saved);
    else rmSync(RECOVERY_POLICY_PATH, { force: true });
    saved = null;
  });

  test("off and observe send the card to merge as before; on sends it to fix", () => {
    for (const [mode, stage] of [[null, "merge"], ["off", "merge"], ["observe", "merge"], ["on", "fix"]] as const) {
      setSwitch(mode);
      expect([mode, planScheduler(snapshot())]).toMatchObject([mode, { kind: "intent", action: "stage", targetStage: stage }]);
    }
  });

  test("convergeFollowUp writes one near event per finding, once; on writes no demotion", () => {
    const dir = mkdtempSync(join(tmpdir(), "converge-near-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
    try {
      const ctx = { actor: "scheduler", now: 1000 };
      setMeta(db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: ["pm"] });
      createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "T1", title: "task", kind: "code", pm: "pm" });
      const task = getTask(db, "T1")!;
      const texts = (op: string) => listEvents(db, { project: "p", target: "T1" }).filter((e) => e.data.op === op).map((e) => e.text);
      const off = convergeReview(EVENTS, readFacts(), null, port("off")).downgrade!;
      db.transaction(() => convergeFollowUp(db, ctx, task, off, dir, () => true))();
      expect(texts(NEAR_OP)).toEqual([]);
      expect(texts(DOWNGRADE_OP)).toHaveLength(1);

      const observe = { ...convergeReview(EVENTS, readFacts(), null, port("observe")).downgrade!, round: 2 };
      for (let i = 0; i < 2; i++) db.transaction(() => convergeFollowUp(db, ctx, task, observe, dir, () => true))();
      expect(texts(NEAR_OP)).toEqual(["近似标记：F1 依据 acceptance:1，on 时会按 P1 计", "近似标记：F2 依据 acceptance:3，on 时会按 P1 计"]);
      expect(texts(DOWNGRADE_OP)).toHaveLength(2);

      const on = { ...convergeReview(EVENTS, readFacts(), null, port("on")).downgrade!, round: 3 };
      for (let i = 0; i < 2; i++) db.transaction(() => convergeFollowUp(db, ctx, task, on, dir, () => true))();
      expect(texts(NEAR_OP).slice(2)).toEqual(["近似标记：F1 依据 acceptance:1，已按 P1 计", "近似标记：F2 依据 acceptance:3，已按 P1 计"]);
      expect(texts(DOWNGRADE_OP)).toHaveLength(2);
      const rec = listEvents(db, { project: "p", target: "T1" }).find((e) => e.data.op === NEAR_OP && e.data.round === 3)!;
      expect(rec.data).toMatchObject({ round: 3, head: HEAD, findingId: "F1", basis: "acceptance:1", mode: "on", counted: true });
    } finally { closeLedger(path); rmSync(dir, { recursive: true, force: true }); }
  });
});

// r1 near-open: a near P1 that on kept in round 2 (its counted record) stays last round's open finding in round 3, so the
// scope rule cannot demote the same unfixed problem outside the fix diff and slip the card into merge.
describe("across rounds under on", () => {
  const H2 = "a".repeat(40), H3 = "b".repeat(40);
  const ROWS = [
    { findingId: "F1", family: "gate", severity: "P1", probe: "[验收线 1、2;PM 定 4] src/lib/a.ts:10" },
    { findingId: "F2", family: "material", severity: "P1", probe: "[验收线 3;PM 定 7] src/lib/c.ts:20" },
  ];
  const NEW = { findingId: "F9", family: "fresh", severity: "P1", probe: "[验收线 5;PM 定 2] src/lib/d.ts:1" };
  const review = (seq: number, round: number, head: string, rows: Record<string, string>[]) => ev(seq, "review", { round, head, reviewer: rv.agent,
    reviewerSessionId: rv.sessionId, reviewerFamily: rv.family, path: "report.md", verdict: "changes", findings: rows, p0: 0, p1: rows.length, p2: 0 });
  const R2 = review(20, 2, H2, ROWS);
  const nearRecords = (mode: RecoveryMode) => {
    const read = currentReviewFacts({ round: 2, headSHA: H2, specRev: 1 }, [R2]);
    if (read.kind !== "facts") throw new Error(`fixture: ${JSON.stringify(read)}`);
    const r2 = convergeReview([R2], read.facts, null, port(mode));
    return (r2.downgrade?.near ?? []).map((n, i) => ev(21 + i, "scheduler", { op: NEAR_OP, round: 2, head: H2, reportPath: "report.md", ...n }));
  };
  const round3 = (nears: LedgerEvent[], rows = ROWS) => [ev(1, "task", { op: "new" }), ev(19, "deliver", { round: 2, headSHA: H2 }), R2, ...nears,
    ev(31, "stage", { from: "fix", to: "review", round: 3 }), ev(49, "deliver", { round: 3, headSHA: H3 }), review(50, 3, H3, rows)];
  const DIFF = { from: H2, to: H3, files: ["src/lib/b.ts"] };
  const facts3 = (events: LedgerEvent[]) => {
    const read = currentReviewFacts({ round: 3, headSHA: H3, specRev: 1 }, events);
    if (read.kind !== "facts") throw new Error(`fixture: ${JSON.stringify(read)}`);
    return read.facts;
  };
  const severities = (events: LedgerEvent[], mode: RecoveryMode) =>
    convergeReview(events, facts3(events), DIFF, port(mode)).facts.findings.map((f) => [f.findingId, f.severity]);

  test("kept in round 2 → still open in round 3 outside the diff; a new near P1 there is still scoped out", () => {
    const events = round3(nearRecords("on"), [...ROWS, NEW]);
    expect(events.filter((e) => e.data.op === NEAR_OP).map((e) => e.data.counted)).toEqual([true, true]);
    const c = convergeReview(events, facts3(events), DIFF, port("on"));
    expect(c.facts.findings.map((f) => [f.findingId, f.severity])).toEqual([["F1", "P1"], ["F2", "P1"], ["F9", "P2"]]);
    expect(c.downgrade?.items.map((i) => [i.findingId, i.why])).toEqual([["F9", "outside_diff"]]);
  });

  test("no counted record (round 2 under observe / off) keeps the old scope demotion", () => {
    expect(severities(round3(nearRecords("observe")), "on")).toEqual([["F1", "P2"], ["F2", "P2"]]);
    expect(severities(round3(nearRecords("off")), "on")).toEqual([["F1", "P2"], ["F2", "P2"]]);
  });

  test("the real planner sends round 3 back to fix, not merge", () => {
    const saved = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH, "utf8") : null;
    mkdirSync(dirname(RECOVERY_POLICY_PATH), { recursive: true });
    writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { nearMarker: "on" } } } }));
    try {
      const base = snapshot();
      const events = round3(nearRecords("on"));
      const s: PlannerSnapshot = { ...base, task: { ...base.task, round: 3, headSHA: H3 }, events, fixDiff: DIFF,
        intents: [{ ...base.intents[0], id: "review-r3", causalSeq: 44, eventSeq: 45, head: H3, createdAt: 44, updatedAt: 44 }],
        reviewDispatches: [{ intentId: "review-r3", round: 3, head: H3, reviewer: rv.agent, reviewerSessionId: rv.sessionId, ackSeq: 46 }] };
      expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "stage", targetStage: "fix" });
    } finally {
      if (saved === null) rmSync(RECOVERY_POLICY_PATH, { force: true });
      else writeFileSync(RECOVERY_POLICY_PATH, saved);
    }
  });
});
