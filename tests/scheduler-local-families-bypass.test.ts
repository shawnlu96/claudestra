import { expect, test } from "bun:test";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { placeFor, type PlacementFacts } from "../src/lib/scheduler-placement.js";
import { reviewPlacement } from "../src/lib/scheduler-placement-plan.js";
import { startPlacement } from "../src/lib/scheduler-placement-start.js";
import type { PlannerSnapshot } from "../src/lib/scheduler-plan.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";

function project(restricted: boolean, mode: "off" | "balance", roles: string[], runtime = "codex") {
  return parseSchedulerConfig({ enabled: true, projects: { a: { repoDir: "/repo", maxActiveWorkers: 2,
    requiredChecks: ["ci"], localAuthorRuntime: runtime, remote: { mode, roles, localPriority: "balance",
      ...(restricted ? { localFamilies: ["codex"] } : {}) } } } }).projects.a;
}
const snapshot = (remote: PlacementFacts["remote"]) => ({ pool: { remote }, workflow: { authorFamily: "codex" } }) as PlannerSnapshot;

test("mode-off-bypass: parsed restriction blocks Claude review in both entry paths; omission stays local", () => {
  for (const restricted of [true, false]) {
    const remote = project(restricted, "off", ["review"]).remote!;
    const facts = { remote } as PlacementFacts;
    expect(placeFor(facts, "review", "claude")).toEqual(restricted ? { kind: "wait", reason: "本机不接 claude" }
      : { kind: "local", reason: "scheduler.json remote.mode = off，只用本机" });
    expect(reviewPlacement(snapshot(remote), 0)).toEqual(restricted ? { wait: "本机不接 claude" } : null);
    expect(placeFor(facts, "write", "claude").kind).toBe("local");
  }
});

test("review-role-bypass: parsed roles=[] cannot create a forbidden local reviewer; omission stays local", () => {
  for (const restricted of [true, false]) {
    const remote = project(restricted, "balance", []).remote!;
    expect(reviewPlacement(snapshot(remote), 0)).toEqual(restricted ? { wait: "本机不接 claude" } : null);
  }
});

test("start-fallback-bypass: borrow failure refuses forbidden local Claude writer; omission keeps fallback", async () => {
  const path = tempLedgerPath("local-family-fallback-");
  const db = openLedger(path);
  try {
    for (const restricted of [true, false]) {
      const p = project(restricted, "balance", ["review"], "claude");
      const result = await startPlacement(db, { policy: () => ({ remote: p.remote!, maxWorkers: p.maxActiveWorkers }),
        borrow: async () => { throw new Error("borrow unavailable"); }, originRepo: async () => "o/r", now: () => 1000 },
      { project: "a", repoDir: p.repoDir, fileGlobs: [], want: "auto" });
      expect(result).toEqual(restricted ? { where: "refused", reason: "本机不接 claude" }
        : { where: "local", reason: "读借入名单 / 仓库地址失败，放本机：borrow unavailable" });
    }
  } finally { closeLedger(path); }
});
