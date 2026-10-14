import { expect, test } from "bun:test";
import { join } from "node:path";
import { getTask } from "../src/lib/ledger-store.js";
import { schedulerPass } from "../src/lib/scheduler-pass.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { ledgerAs, mergedCard } from "./deploy-test-kit.js";

for (const mode of ["observe", "on"] as const) {
  test(`${mode} queue reads precede merge-begin; PR mutations follow its durable journal`, async () => {
    const f = mergedCard();
    try {
      f.db.query("UPDATE scheduler_intents SET status='done' WHERE id=?").run(f.intent);
      f.db.query(`INSERT INTO scheduler_intents
        (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
        SELECT 'queue-order',taskId,project,node,action,causalSeq,99,taskRev,specRev,head,templateVersion,'pending',reason,createdAt,updatedAt
        FROM scheduler_intents WHERE id=?`).run(f.intent);
      f.db.query("UPDATE scheduler_resources SET intentId='queue-order' WHERE intentId=?").run(f.intent);
      const task = getTask(f.db, "T9")!, log: string[] = [], ledger = ledgerAs(f.db, "scheduler");
      let merged = false;
      const pr = (): PrSnapshot => ({ state: merged ? "MERGED" : "OPEN", head: task.headSHA!, branch: task.branch!, base: "main", draft: false,
        crossRepository: false, mergeState: "CLEAN", mergeSha: merged ? "d".repeat(40) : null,
        checks: [{ name: "ci", bucket: "pass" }, { name: "ci scope full", bucket: "pass" }] });
      const mutation = (name: string) => {
        expect(f.db.query("SELECT 1 FROM scheduler_merges WHERE intentId='queue-order'").get()).not.toBeNull();
        expect(log).toContain("scheduler-merge-begin"); log.push(name);
      };
      const io: MergeExternal = { direct: () => true, inspect: async () => { log.push("inspect"); return pr(); },
        freshness: async () => { log.push("freshness"); return { behindBy: 0, mainHead: "e".repeat(40) }; },
        carryReview: async () => ({ ok: false, reason: "unused" }), updateBranch: async () => mutation("updateBranch"),
        merge: async () => { mutation("merge"); merged = true; return "d".repeat(40); } };
      const result = await schedulerPass(f.db, { enabled: true, autoDispatch: false, pollMs: 1000,
        projects: { p: { repoDir: f.dir, maxActiveWorkers: 1, requiredChecks: ["ci"], mergeTrain: "off" } } }, {
        assertOwner: () => {}, manager: async (...args) => { const r = await ledger(...args); log.push(args[1]!); return r; },
        external: () => io, recoveryPolicy: (_project, key) => ({ mode: key === "ciQueueFull" ? mode : "off", source: "config", manualAfterMs: null }),
        maintenance: { path: join(f.dir, "maintenance"), marker: join(f.dir, "marker"), request: join(f.dir, "request") },
        trainTick: async () => {}, peerPr: async () => ({ failed: [] }), retire: async () => [], lifecycle: async () => [],
      });
      expect(result.failed).toEqual([]);
      const begin = log.indexOf("scheduler-merge-begin");
      expect(begin).toBeGreaterThan(0); expect(log[0]).toBe("inspect");
      expect(log.slice(0, begin).every((op) => ["inspect", "freshness", "scheduler-settle"].includes(op))).toBe(true);
      expect(log).toContain("merge"); expect(log.indexOf("merge")).toBeGreaterThan(begin);
    } finally { f.close(); }
  });
}
