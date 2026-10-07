/**
 * Shared MQ1 fixture (no tests of its own; named *.test.ts to stay inside the card's file globs): manual cards on the MTR1 world
 * (tests/scheduler-merge-reclaim-world.ts), the policy file the pass reads by default, and PM / scheduler ledger CLI calls.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindHash } from "../src/lib/ask-bind.js";
import { answerAsk, openAskFull } from "../src/lib/ledger-asks.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";
import type { ReclaimWorld } from "./scheduler-merge-reclaim-world.js";

export const writePolicy = (mode: "on" | "observe" | "off") =>
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { manualMergeQueue: mode } } } }));

/** The real ledger CLI as `actor` against the world's ledger. */
export const ledgerAs = (w: ReclaimWorld, actor: string, ...args: string[]) => runLedger(args, { db: w.db, actor, projectIds: ["p"],
  loadRegistry: async () => ({} as Registry), saveRegistry: async () => {}, now: () => Date.now() }) as Promise<Record<string, unknown>>;

/**
 * A card PM took over by hand: the engine's review dispatch, its ack and the reviewer session row are gone (RD1 / SBH2 shape), so
 * the auto merge gate would answer merge_review_unproven. The real cross-family review is then recorded the official manual way:
 * `ledger review` by a project PM (`recorder`) naming the actual reviewer, its session, family, findings file and report path.
 */
export async function manualCard(world: ReclaimWorld, id: string, recorder = "agent-pm") {
  const c = world.card(id), db = world.db;
  db.query("DELETE FROM scheduler_sessions WHERE taskId = ?").run(id);
  db.query("DELETE FROM scheduler_intents WHERE taskId = ?").run(id);
  setWorkflow(db, { actor: "owner", now: Date.now() }, { taskId: id, taskRev: getTask(db, id)!.rev, workflowRev: 1, template: "code", templateVersion: 2,
    mode: "manual", authorFamily: "claude", fallback: "缩小范围", reason: "PM 接管，人工审查后合并" });
  db.query("UPDATE tasks SET stage = 'review', rev = rev + 1 WHERE id = ?").run(id); // the review lands in review and moves the card to merge
  const dir = mkdtempSync(join(tmpdir(), "mmq-findings-")), findings = join(dir, "findings.json");
  writeFileSync(findings, "[]");
  const r = await ledgerAs(world, recorder, ...manualReviewArgs(id, c.head, findings));
  rmSync(dir, { recursive: true, force: true });
  if (r.ok !== true) throw new Error(`manual review CLI: ${String(r.error)}`);
  const review = listEvents(db, { project: "p", target: id }).findLast((e) => e.kind === "review")!;
  return { ...c, reviewSeq: review.seq };
}

/** `ledger review` as PM records an independent reviewer's structured report on a manual card. */
export const manualReviewArgs = (id: string, head: string, findings: string, reviewer = "agent-review") =>
  ["review", id, "--reviewer", reviewer, "--verdict", "pass", "--p0", "0", "--p1", "0", "--p2", "0", "--head", head,
    "--session", `rs-${id}`, "--family", "codex", "--findings", findings, "--path", "r.md", "--to", "merge"];

export const requestArgs = (c: { taskId: string; head: string; reviewSeq: number }, ...extra: string[]) =>
  ["manual-merge-request", c.taskId, "--head", c.head, "--spec-rev", "1", "--round", "1", "--review-seq", String(c.reviewSeq), "--reason", "人工审过，排队合并", ...extra];

/**
 * An owner authorization on the card, bound like every authorize ask (approve = the "go" button). The decision it belongs to is its
 * asker + ask key (the action when none) + binding hash: the same arguments again = the same decision re-asked.
 */
export function authorize(world: ReclaimWorld, taskId: string, action = "manual_merge", o: { askKey?: string; params?: unknown; fromAgent?: string } = {}) {
  const from = o.fromAgent ?? "scheduler", binding = { action, params: o.params ?? { task: taskId }, approve: ["go"] };
  return openAskFull(world.db, { project: "p", taskId, source: "system", kind: "authorize", title: "可以合吗", fromAgent: from, askKey: o.askKey,
    options: [{ type: "buttons", buttons: [{ id: "go", label: "合" }, { id: "no", label: "不合" }] }],
    bind: { ...binding, paramsHash: bindHash(binding, from) } } as never, Date.now()).ask;
}

export const answer = (world: ReclaimWorld, id: string, button: string) => answerAsk(world.db, id, { choices: [`[button:${button}]`], labels: [button], text: "",
  principal: "owner:self", via: "web_card", at: Date.now(), owner: true });

/**
 * An auto ui card the planner may merge: the world's reviewed card with template ui, a screenshots digest, and PM's `ledger ui-approve`
 * (the real CLI, recorded in review as in production) before it sits in merge. Not a train candidate (trains never carry ui cards).
 */
export async function uiAutoCard(world: ReclaimWorld, id: string, pm = "agent-pm") {
  const c = world.card(id), digest = "ab".repeat(32);
  world.db.query("UPDATE task_workflows SET template = 'ui' WHERE taskId = ?").run(id);
  world.db.query("UPDATE tasks SET stage = 'review', extra = json_set(extra, '$.screenshotsDigest', ?), rev = rev + 1 WHERE id = ?").run(digest, id);
  const r = await ledgerAs(world, pm, "ui-approve", id, "--head", c.head, "--digest", digest);
  if (r.ok !== true) throw new Error(`ui-approve CLI: ${String(r.error)}`);
  world.db.query("UPDATE tasks SET stage = 'merge', rev = rev + 1 WHERE id = ?").run(id);
  return c;
}
