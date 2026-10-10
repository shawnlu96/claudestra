/**
 * AUTOACK1 fixture (shared by tests/scheduler-manual-review-source*.test.ts): a real temp ledger and the real ledger CLI. An auto card's
 * bound codex reviewer (s-rv) reviews r1; round 2 is taken over by PM (workflow manual), PM assigns the review step to another codex
 * agent who takes it with take_review and answers with submit_verdict (the MCP ticket); PM then hands the card back with workflow-resume.
 * Helpers only (no tests here: importers would run them again).
 */
import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { takeReview } from "../src/lib/review-order.js";
import { submitVerdict } from "../src/lib/review-verdict.js";
import { autoFixture, H1, H2, P1, P2, toBuild } from "./scheduler-auto-helpers.js";

export type Fx = ReturnType<typeof autoFixture>;
export const RV = "agent-rv-b", RV_SESSION = "s-rvb";
export const finding = (id: string, severity: "P1" | "P2") => ({ findingId: id, family: "gate", severity, probe: `[验收线 1] 复现 ${id}`, description: `说明 ${id}` });

export const events = (f: Fx) => listEvents(f.db, { project: "p", target: "T1" });
export const reviewsDir = (f: Fx): string => { const d = join(f.dir, "reviews"); mkdirSync(d, { recursive: true }); return d; };

/** Auto card through r1 (bound reviewer s-rv asks for a fix) to the r2 delivery of H2, no r2 review dispatched yet. */
export async function toRound2(f: Fx): Promise<void> {
  await toBuild(f);
  await f.tick(); // write order
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  await f.tick(); // ensure reviewer
  await f.tick(); // review order
  expect((await f.review("changes", H1, [P1, P2])).ok).toBe(true);
  expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→fix" });
  await f.tick(); // fix order
  expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", H2)).ok).toBe(true);
  expect(f.task()).toMatchObject({ stage: "review", round: 2, headSHA: H2 });
}

export async function toManual(f: Fx, actor = "pm"): Promise<void> {
  const w = getWorkflow(f.db, "T1")!;
  expect(await f.cli(actor, "workflow-set", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(w.rev), "--template", w.template,
    "--version", "2", "--mode", "manual", "--author-family", "claude", "--fallback", "只报错不修", "--reason", "PM 接管，人工审查")).toMatchObject({ ok: true });
}

/** PM assigns the r2 review step to `agent`; the agent takes it (take_review) and submits its verdict (submit_verdict). */
export function mcpReview(f: Fx, opts: { agent?: string; session?: string; family?: string; rows?: ReturnType<typeof finding>[]; verdict?: "pass" | "changes" } = {}) {
  const agent = opts.agent ?? RV, session = opts.session ?? RV_SESSION, family = opts.family ?? "codex";
  expect(assignStep(f.db, f.at("pm"), { taskId: "T1", step: "review", executor: agent, executorKind: "agent" }).row.length).toBeGreaterThan(0);
  const me = { agent, sessionId: session, family: family === "claude" ? "claude-code" : family, verified: true }; // the bridge identity carries the runtime
  const taken = takeReview(f.db, me, reviewsDir(f));
  if (!taken.ok || !taken.orders[0]) throw new Error(`take_review: ${JSON.stringify(taken)}`);
  const order = taken.orders[0];
  const rows = opts.rows ?? [finding("name-2", "P2")];
  const report = join(reviewsDir(f), `T1-r${f.task().round}.md`);
  writeFileSync(report, "# 审查报告\n");
  return submitVerdict(f.db, me, { v: 1, orderId: order.orderId, head: order.head, verdict: opts.verdict ?? (rows.some((r) => r.severity === "P1") ? "changes" : "pass"),
    p0: 0, p1: rows.filter((r) => r.severity === "P1").length, p2: rows.filter((r) => r.severity === "P2").length, findings: rows, reportPath: report },
  { registry: [{ name: "agent-task-one", runtime: "claude-code" }, { name: agent, runtime: family === "claude" ? "claude-code" : "codex" }], reviewsDir: reviewsDir(f), now: 900_000 });
}

export const resume = (f: Fx, actor = "pm") => {
  const w = getWorkflow(f.db, "T1")!;
  return f.cli(actor, "workflow-resume", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(w.rev), "--reason", "人工审查已完成，交回自动");
};

/** Row counts of every table an adoption must never touch (intents, sessions, resources, merges, lend orders). */
export function sideTables(f: Fx): Record<string, number> {
  const n = (t: string) => (f.db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  return { intents: n("scheduler_intents"), sessions: n("scheduler_sessions"), resources: n("scheduler_resources"),
    sessionRows: (f.db.query("SELECT group_concat(sessionId || ':' || state) AS s FROM scheduler_sessions").get() as { s: string }).s.length };
}

export { H1, H2, P1, P2 };

