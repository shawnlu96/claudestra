/**
 * AUTOACK1 fixture (shared by tests/scheduler-manual-review-source*.test.ts): a real temp ledger and the real ledger CLI. An auto card's
 * bound codex reviewer (s-rv) reviews r1; round 2 is taken over by PM (workflow manual). The adoptable source: PM puts the round's
 * review in the lend pool (`ledger lend-offer`), the peer "mate" claims it and B's real worker answers through take_review /
 * submit_verdict (signed ticket) → A's production lend-write (signed receipt, archived request); synthetic temp keys, no real peer.
 * The refused local source: PM assigns the review step to a local codex agent who answers with take_review / submit_verdict (MCP).
 * PM then hands the card back with workflow-resume. Helpers only (no tests here: importers would run them again).
 */
import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { planIntent } from "../src/lib/ledger-scheduler-write.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { ADOPT_OP } from "../src/lib/scheduler-manual-review-source.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { takeReview } from "../src/lib/review-order.js";
import { submitVerdict } from "../src/lib/review-verdict.js";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { saveRawResult } from "../src/lib/pool-review-proof-raw.js";
import { autoFixture, H1, H2, P1, P2, toBuild } from "./scheduler-auto-helpers.js";
import { B_WORKER, lendSide } from "./pool-review-proof-helpers.js";

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

export const PEER = "mate";
export const withPr = (fx: Fx) => fx.db.query("UPDATE tasks SET pr = 'https://github.com/o/r/pull/7', branch = 'task/T1' WHERE id = 'T1'").run();
/** The spec card the pool order inlines (the peer cannot read this machine's files). */
const withSpec = (fx: Fx) => {
  const spec = join(fx.dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿\n");
  fx.db.query("UPDATE tasks SET spec = ? WHERE id = 'T1'").run(spec);
};

/** A's lend CLI (result deps under the fixture dir, B's key pinned) and B, the lending side answering with its real worker tools. */
export function lendWorld(f: Fx) {
  const b = lendSide(f.dir);
  const key = instanceKeySync(join(f.dir, "a-key"));
  const reports = join(f.dir, "lend-reports");
  mkdirSync(reports, { recursive: true });
  const lend = { borrow: async () => [{ peer: PEER, projects: ["p"], roles: ["review"], maxOpen: 1 }], notifyPm: async () => {},
    result: { reportDir: () => reports, writeReport: (p: string, t: string) => writeFileSync(p, t), sign: (x: string[]) => signPurpose(RECEIPT_PURPOSE, x, key),
      saveRaw: (text: string) => saveRawResult(join(f.dir, "lend-raw"), text), pinnedKey: async () => b.pinned } };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend } as never, actor, ...args) as Promise<Record<string, any>>;
  return { b, cli, reports };
}

/**
 * PM `lend-offer` of the round-2 review → the peer claims → B take_review / submit_verdict → A lend-write. Returns the order id.
 * `take: false` skips B's take_review (the ticket then fails at entry).
 */
export async function peerReview(f: Fx, o: { actor?: string; findings?: object[]; verdict?: string; take?: boolean } = {}): Promise<string> {
  withPr(f);
  withSpec(f);
  const w = lendWorld(f);
  expect(await w.cli(o.actor ?? "pm", "lend-offer", "T1", "--peer", PEER, "--repo", "o/r")).toMatchObject({ ok: true });
  const order = listLendOrders(f.db, "T1").filter((x) => x.step === "review").at(-1)!;
  const claim = await w.cli("owner", "lend-claim", "--", PEER, JSON.stringify({ v: 1, orderId: order.orderId, worker: B_WORKER }));
  expect(claim.ok).toBe(true);
  const a = await w.b.answer(claim as never, { verdict: o.verdict ?? "pass", findings: o.findings ?? [], report: `## 结论\n\nhead ${H2} 通过\n` },
    (body) => w.cli("owner", "lend-write", "--", PEER, JSON.stringify(body)), { take: o.take });
  expect(a.r).toMatchObject({ ok: true });
  return order.orderId;
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

/** The planner on the production snapshot; `drop` = the old path (no adoption event, no adoption fact). */
export const plan = (fx: Fx, drop = false) => {
  const s = autoSnapshot(fx.db, fx.task(), { registry: [], maxWorkers: 2, now: 5_000_000 });
  return planScheduler(drop ? { ...s, events: s.events.filter((e) => e.data.op !== ADOPT_OP), adoptedSource: null } : s);
};
/** The merge intent the planner asks for, through the real intent writer (requireReviewedMerge runs inside it). */
const projectSeq = (fx: Fx): number => (fx.db.query("SELECT MAX(seq) AS s FROM events WHERE project = 'p'").get() as { s: number }).s;
export const writeMerge = (fx: Fx, id = "mq-test") => planIntent(fx.db, { actor: "scheduler", now: 6_000_000 }, { id, taskId: "T1", taskRev: fx.task().rev,
  workflowRev: getWorkflow(fx.db, "T1")!.rev, causalSeq: projectSeq(fx), node: "merge_deploy", action: "merge", reason: "test", resources: ["merge:p"] });

/** Round-2 peer ticket on the PM's pool order, then the PM hand-back (by `adopter`). */
export async function adopted(fx: Fx, adopter = "pm") {
  await toRound2(fx);
  await toManual(fx);
  const orderId = await peerReview(fx);
  const before = sideTables(fx);
  const r = await resume(fx, adopter);
  expect(r).toMatchObject({ ok: true });
  expect(sideTables(fx)).toEqual(before); // no intent, session, slot or resource row written or changed by the adoption
  return { r: r as Record<string, unknown>, orderId };
}

export { H1, H2, P1, P2 };

