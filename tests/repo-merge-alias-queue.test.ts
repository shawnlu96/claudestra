/** rename-floka-REPOMERGE1 · [验收线 3] the unified merge queue reads the renamed repository's old and new name as one queue. */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { OFFICIAL_REPO, PROPOSED_REPO } from "../src/lib/floka-repo/migrate.js";
import { mergeQueueFacts } from "../src/lib/merge-queue-facts.js";
import { pickMergeQueueOwner } from "../src/lib/merge-queue-owner.js";
import { RECOVERY_POLICY_PATH, type RecoveryMode } from "../src/lib/recovery-policy.js";
import { setRepoAliasForTest } from "../src/lib/repo-alias.js";
import { SCHEDULER_CONFIG_PATH } from "../src/lib/scheduler-config.js";
import { setForeignRepoLookupForTest } from "../src/lib/scheduler-foreign-repo.js";
import { resetSchedulerLeaseForTest } from "../src/lib/scheduler-lease-env.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.js";

const OLD = OFFICIAL_REPO, NEW = PROPOSED_REPO;
let w: ReclaimWorld;
afterEach(() => {
  resetSchedulerLeaseForTest(); w?.close();
  rmSync(RECOVERY_POLICY_PATH, { force: true }); rmSync(SCHEDULER_CONFIG_PATH, { force: true });
  setForeignRepoLookupForTest({ project: null, origin: null });
  setRepoAliasForTest({ mode: null, sink: null });
});

/** Project p on the old name; A's PR under the new name (made first), B's under the old one, both in merge with a passing review. */
function world() {
  mkdirSync(dirname(RECOVERY_POLICY_PATH), { recursive: true });
  w = reclaimWorld({ store: "memory", live: true });
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { mergeQueueOwner: "on", manualMergeQueue: "on", mergeDirect: "off" } } } }));
  setForeignRepoLookupForTest({ project: () => OLD, origin: () => null });
  w.config.projects.p!.remote!.repo = OLD;
  w.config.projects.p!.remote!.roles = ["review", "write"];
  for (const [id, repo] of [["A", NEW], ["B", OLD]] as const) {
    const c = w.card(id);
    w.db.query("UPDATE tasks SET pr = ? WHERE id = ?").run(`https://github.com/${repo}/pull/${c.prRef.split("/").pop()}`, id);
    insertEvent(w.db, { actor: "scheduler" }, { project: "p", target: id, kind: "stage", data: { from: "review", to: "merge", head: c.head, round: 1 } }, false);
  }
  writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify(w.config));
}

test("[验收线 3] on: one queue across both names (the earlier new-name card first); off / observe: as before, only the old name", () => {
  world();
  for (const mode of ["off", "observe", "on"] as RecoveryMode[]) {
    setRepoAliasForTest({ mode, sink: () => {} });
    const facts = mergeQueueFacts(w.db, "p", Date.now(), { repo: () => OLD });
    expect(facts.map((e) => [e.taskId, e.repository, e.reason?.code ?? null])).toEqual(mode === "on"
      ? [["A", NEW, null], ["B", NEW, null]]
      : [["A", NEW, "foreign_repo"], ["B", OLD, null]]);
    expect(pickMergeQueueOwner(w.db, "p", Date.now()).entry?.taskId ?? null).toBe(mode === "on" ? "A" : "B");
  }
});

test("[验收线 4] another org's floka stays out of the queue with repoAlias on", () => {
  world();
  setRepoAliasForTest({ mode: "on", sink: () => {} });
  w.db.query("UPDATE tasks SET pr = ? WHERE id = 'A'").run("https://github.com/someone/floka/pull/1");
  const facts = mergeQueueFacts(w.db, "p", Date.now(), { repo: () => OLD });
  expect(facts.map((e) => [e.taskId, e.reason?.code ?? null])).toEqual([["A", "foreign_repo"], ["B", null]]);
  expect(pickMergeQueueOwner(w.db, "p", Date.now()).entry?.taskId ?? null).toBe("B");
});
