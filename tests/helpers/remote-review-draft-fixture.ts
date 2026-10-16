/**
 * RRL-3 draft tests' shared setup: the auto card brought to merge at H1 on PR, owner P1s booked on a head, and the real ghPrState
 * driven over a gh stub (tests/remote-review-draft-r1.test.ts, tests/remote-review-draft-r4.test.ts).
 */
import { expect } from "bun:test";
import { join } from "node:path";
import { recordRemoteReview } from "../../src/lib/remote-review-ledger.js";
import { parseRemoteReview } from "../../src/lib/remote-review-parse.js";
import type { runBounded } from "../../src/lib/run-bounded.js";
import { schedulerAutoTick } from "../../src/lib/scheduler-auto-tick.js";
import { ghPrState, type HandoffCarry } from "../../src/lib/scheduler-merge-handoff-tick.js";
import { autoFixture, H1, H2, P2, toBuild } from "../scheduler-auto-helpers.js";
import { pushText } from "./remote-review-fixture.js";

export const PR = "https://github.com/example/repo/pull/7";
export type F = ReturnType<typeof autoFixture>;

export const book = (f: F, head: string) => recordRemoteReview(f.db, f.at("scheduler"), { taskId: "T1",
  review: parseRemoteReview(pushText({ verdict: "changes", p1: 1 }, { head }))!, peer: "Shawn", reportDir: join(f.dir, "reviews") });

export async function toMerge(f: F) {
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1, "--pr", PR);
  await f.tick();
  await f.tick();
  await f.review("pass", H1, [P2]);
  await f.tick();
  expect(f.task().stage).toBe("merge");
}

/** Only main merged in from H1 to H2 (the owner's update-branch); any other hop is not a pure carry. */
const carry: HandoffCarry = async (_ref, from, to) => from === H1 && to === H2
  ? { ok: true, reason: "净 diff 一致", mainParent: "b".repeat(40), mainHead: "c".repeat(40), diffHash: "d".repeat(64), basis: "net-diff" }
  : { ok: false, reason: "净 diff 变了" };

/**
 * The real ghPrState over a gh stub: `view` is the PR as GitHub has it (`gh pr ready [--undo]` flips its isDraft); a successful
 * undo also applies `onUndo`, the PR changing between gh's view and the undo. `calls` = view / ready / undo, in order.
 */
export function ghStub(f: F) {
  const s = { view: { state: "OPEN", headRefOid: H1, mergeCommit: null, baseRefName: "main", isDraft: true } as Record<string, unknown>,
    onUndo: {} as Record<string, unknown>, calls: [] as string[] };
  const command = (async (argv: string[]) => {
    const undo = argv.includes("--undo");
    s.calls.push(argv[2] === "ready" ? (undo ? "undo" : "ready") : argv[2]!);
    if (argv[2] === "ready") s.view = undo ? { ...s.view, ...s.onUndo, isDraft: true } : { ...s.view, isDraft: false };
    return { code: 0, stdout: argv[2] === "view" ? JSON.stringify(s.view) : "", stderr: "", timedOut: false };
  }) as unknown as typeof runBounded;
  const none = () => null, prState = ghPrState(command, () => carry, none, none);
  const tick = async () => {
    const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2, mergeHandoff: true } }, { ...f.tickDeps, prState });
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  return { s, tick };
}
