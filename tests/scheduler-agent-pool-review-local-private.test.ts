/**
 * dispatch-recovery-REVLOCAL1, review finding private-reserve: reserveFinishing's reviewLocalFirst (on) seat must follow the real
 * review path's repository rule. A card in another repository is reviewed by peers only (PRIVPLACE1, agentPoolReview → peersOnly),
 * so its queued review never takes a seat on this machine and never refuses a new local write. Real ledger, real startPlacement.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { FINISH_FIRST_WAIT } from "../src/lib/scheduler-agent-pool-reserve.js";
import { resetReviewLocalObserved, reviewLocalPending } from "../src/lib/scheduler-agent-pool-review-local.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { setForeignRepoLookupForTest } from "../src/lib/scheduler-foreign-repo.js";
import { startPlacement, type StartPlacementIO } from "../src/lib/scheduler-placement-start.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { autoFixture, H1 } from "./scheduler-auto-helpers.js";

const PUBLIC = "o/public", PRIVATE = "o/private";
// This machine: no Claude seat, one idle Codex seat.
const REMOTE: RemotePolicy = { mode: "balance", roles: [], poolTimeoutMin: 15, repo: PUBLIC, agents: { claude: 0, codex: 1 } };
const BORROW: BorrowEntry[] = [{ peer: "mate", projects: ["p"], maxOpen: 5, roles: ["review", "write"] }];
const MODES = ["on", "observe", "off", null] as const;

type Fixture = ReturnType<typeof autoFixture>;
let f: Fixture;
const setMode = (mode: string | null) => mode === null ? rmSync(RECOVERY_POLICY_PATH, { force: true })
  : writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { reviewLocalFirst: mode } } } }));

beforeEach(() => {
  f = autoFixture(); resetReviewLocalObserved(); setMode(null);
  setForeignRepoLookupForTest({ project: (p) => (p === "p" ? PUBLIC : null) });
});
afterEach(() => { f.close(); resetReviewLocalObserved(); setMode(null); setForeignRepoLookupForTest({ project: null, origin: null }); });

/** T1 waits for review, written by Claude; the peer has idle Codex seats and is granted only `repos`. */
function queued(repo: string, peerRepos: string[], seats = { claude: 5, codex: 5 }): void {
  f.db.query("UPDATE tasks SET stage='review', headSHA=?, pr=? WHERE id='T1'").run(H1, `https://github.com/${repo}/pull/17`);
  f.db.query("UPDATE task_workflows SET authorFamily='claude' WHERE taskId='T1'").run();
  const now = f.tickDeps.now();
  recordHello(f.db, "mate", null, { v: 1, proto: 2, boot: "b", seq: 1, paused: null,
    slots: { claude: { total: seats.claude, busy: 0 }, codex: { total: seats.codex, busy: 0 } },
    grant: { until: now + 10_000_000, repos: peerRepos, roles: ["review", "write"], ordersPerDay: 50, ordersLeftToday: 50 } }, now);
}

const io = (): StartPlacementIO => ({ policy: () => ({ remote: REMOTE, maxWorkers: 2 }), borrow: async () => BORROW,
  originRepo: async () => PUBLIC, now: () => f.tickDeps.now() });
/** A new card of the project's own repository asks for a seat, finishing work first (automatic admission). */
const newWrite = () => startPlacement(f.db, io(), { project: "p", repoDir: "/repo", fileGlobs: ["src/new.ts"], want: "auto" }, true);
const plan = () => planScheduler(autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2, now: f.tickDeps.now(), pool: { remote: REMOTE, borrow: BORROW } }));

test("[private-reserve] a queued review of a private card goes to the peer and leaves the local seat to a new write, in every mode", async () => {
  queued(PRIVATE, [PRIVATE]);
  for (const mode of MODES) {
    setMode(mode);
    expect(plan()).toMatchObject({ kind: "intent", action: "review", recipient: "peer:mate" });
    expect(await newWrite()).toMatchObject({ where: "local" }); // red before the fix under on: refused, FINISH_FIRST_WAIT
  }
  expect(reviewLocalPending()).toEqual([]); // peers only: this machine never "would have" taken it
});

test("[private-reserve] a private security card waiting for PM never holds the local seat either", async () => {
  queued(PRIVATE, [PRIVATE]);
  f.db.query("UPDATE task_workflows SET template='security' WHERE taskId='T1'").run();
  for (const mode of MODES) {
    setMode(mode);
    for (let pass = 0; pass < 2; pass++) {
      const d = plan();
      expect(d.kind === "intent" && (d.action === "ensure_session" || d.action === "review")).toBe(false); // repository / security conflict: PM's
      expect(await newWrite()).toMatchObject({ where: "local" });
    }
  }
});

test("control: a queued review of the project's own repository still takes the local seat under on, the peer's under observe / off", async () => {
  queued(PUBLIC, [PUBLIC], { claude: 0, codex: 1 }); // one idle Codex seat here, one on the peer
  setMode("on");
  expect(plan()).toMatchObject({ kind: "intent", action: "ensure_session", sessionRole: "reviewer", sessionFamily: "codex" });
  expect(await newWrite()).toMatchObject({ where: "peer", peer: "mate" }); // the review holds this machine's seat
  for (const mode of ["observe", "off", null]) {
    setMode(mode);
    expect(plan()).toMatchObject({ kind: "intent", action: "review", recipient: "peer:mate" });
    expect(await newWrite()).toMatchObject({ where: "local" }); // the review holds the peer's seat
  }
});
