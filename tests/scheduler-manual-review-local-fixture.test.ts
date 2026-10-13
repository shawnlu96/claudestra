/**
 * AUTOACK2 fixture (shared by tests/scheduler-manual-review-local*.test.ts): the AUTOACK1 world (real temp ledger + real ledger CLI, an auto
 * card whose bound reviewer did r1, round 2 taken over by PM) plus a local codex reviewer RV registered with its own session and a checkout
 * outside the fixture root (the author's cwd). PM assigns the r2 review to RV; RV take_review, the bridge's recordTaken (run = the fixture
 * CLI as RV), submit_verdict with injected git IO. The switch is the real recovery-policy file, removed after every test. Helpers only.
 */
import { expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { recordTaken } from "../src/lib/order-mark.js";
import { RECOVERY_POLICY_PATH, type RecoveryMode } from "../src/lib/recovery-policy.js";
import { takeReview } from "../src/lib/review-order.js";
import { submitVerdict } from "../src/lib/review-verdict.js";
import { ADOPT_OP } from "../src/lib/scheduler-manual-review-source.js";
import { events, finding, H2, reviewsDir, type Fx } from "./scheduler-manual-review-source-fixture.test.js";

export const RV = "agent-rv-local", RV_SESSION = "s-rvl";
export const NOT_POOL = "不是 PM 挂池、对方经 take_review / submit_verdict 签票据交回的结论（本机人工结论台账没有可核的领单与独立检出证据；PM 代记、CLI 复制同样没有），继续人工合并队列";

export function setMode(mode: RecoveryMode | null): void {
  if (mode === null) rmSync(RECOVERY_POLICY_PATH, { force: true });
  else writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { localReviewAdopt: mode } } } }));
}

type Row = { runtime?: string; sessionId?: string; cwd?: string } | null;
/** Edit one agent's registry row (null removes it). */
export function setAgent(f: Fx, name: string, row: Row | ((old: Record<string, unknown>) => Row)): void {
  const j = JSON.parse(readFileSync(f.registryPath, "utf8")) as { agents: Record<string, Record<string, unknown>> };
  const next = typeof row === "function" ? row(j.agents[name] ?? {}) : row;
  if (next) j.agents[name] = next as Record<string, unknown>;
  else delete j.agents[name];
  writeFileSync(f.registryPath, JSON.stringify(j));
}

const made: string[] = [];
/** afterEach: the reviewer checkouts this file made, and the switch file. */
export function cleanup(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  setMode(null);
}

/** RV's own checkout, outside the fixture root (the author agent-task-one works in the root itself). */
export function addReviewer(f: Fx, o: { runtime?: string; cwd?: string } = {}): string {
  const dir = o.cwd ?? mkdtempSync(join(tmpdir(), "autoack2-rv-"));
  if (!o.cwd) made.push(dir);
  setAgent(f, RV, { runtime: o.runtime ?? "codex", sessionId: RV_SESSION, cwd: dir });
  return dir;
}

export const identity = (session = RV_SESSION, runtime = "codex") => ({ agent: RV, sessionId: session, family: runtime, verified: true });
export const assignRv = (f: Fx, step: "review" | "final_review" = "review") =>
  assignStep(f.db, f.at("pm"), { taskId: "T1", step, executor: RV, executorKind: "agent" }).event;

/** The bridge's take_review: the order, then recordTaken with run = the fixture's real CLI as RV. Returns the order id and manager runs. */
export async function take(f: Fx, session = RV_SESSION, runtime = "codex"): Promise<{ orderId: string; runs: number; marked: string[] }> {
  const taken = takeReview(f.db, identity(session, runtime), reviewsDir(f));
  if (!taken.ok || !taken.orders[0]) throw new Error(`take_review: ${JSON.stringify(taken)}`);
  let runs = 0;
  const run = async (args: string[]) => { runs++; expect(args.slice(0, 2)).toEqual(["ledger", "order-taken"]); return await f.cli(RV, ...args.slice(1)) as { ok?: unknown; error?: unknown }; };
  const call = { agent: RV, sessionId: session, family: runtime, channelId: "ch-rvl" };
  const marked = await recordTaken(f.db, call, [taken.orders[0].orderId], run, () => {});
  return { orderId: taken.orders[0].orderId, runs, marked };
}

export interface SubmitOpts { session?: string; runtime?: string; head?: string | null; dirty?: string | null; rows?: ReturnType<typeof finding>[] }
/** RV's submit_verdict (r2, H2) with the checkout IO injected; the report is written under the fixture's reviews dir. */
export function submit(f: Fx, o: SubmitOpts = {}) {
  const rows = o.rows ?? [finding("name-2", "P2")];
  const report = join(reviewsDir(f), `T1-r${f.task().round}.md`);
  writeFileSync(report, "# 审查报告\n");
  const runtime = o.runtime ?? "codex";
  return submitVerdict(f.db, identity(o.session, runtime), { v: 1, orderId: `T1:review:r${f.task().round}`, head: H2,
    verdict: rows.some((r) => r.severity === "P1") ? "changes" : "pass", p0: 0, p1: rows.filter((r) => r.severity === "P1").length,
    p2: rows.filter((r) => r.severity === "P2").length, findings: rows, reportPath: report },
  { registry: [{ name: "agent-task-one", runtime: "claude-code" }, { name: RV, runtime }], reviewsDir: reviewsDir(f), now: 900_000,
    registryPath: f.registryPath, gitHead: () => (o.head === undefined ? H2 : o.head), gitDirty: () => o.dirty ?? null });
}

export const verdictEvent = (f: Fx) => events(f).findLast((e) => e.kind === "review")!;
export const adoptEvent = (f: Fx) => events(f).find((e) => e.data.op === ADOPT_OP);
export const resumeEvent = (f: Fx) => events(f).findLast((e) => e.data.op === "workflow_resume")!;
