import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ciQueueFullStep } from "../src/lib/scheduler-ci-queue-full.js";
import { recordObserved, type RecoveryMode } from "../src/lib/recovery-policy.js";
import { createTask } from "../src/lib/ledger-write.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";

const H = "a".repeat(40), PR = "https://github.com/o/r/pull/1";
const config = { enabled: true, pollMs: 1000, autoDispatch: false, projects: { p: { repoDir: ".", maxActiveWorkers: 1, requiredChecks: ["check"] } } };
function fixture(mode: RecoveryMode = "on", count = 1) {
  const db = openLedger(":memory:");
  for (let i = 1; i <= count; i++) {
    createTask(db, { actor: "owner", now: i }, { project: "p", id: `T${i}`, title: "card", kind: "code" });
    db.query("UPDATE tasks SET stage='merge', headSHA=?, pr=?, branch='task/T' WHERE id=?").run(H, PR, `T${i}`);
  }
  let now = 1_000_000, reads = 0, commands: string[][] = [];
  let snapshot: PrSnapshot = { state: "OPEN", head: H, base: "main", branch: "task/T", draft: false, crossRepository: false,
    mergeState: "CLEAN", mergeSha: null, checks: [{ name: "check", bucket: "pass" },
      { name: "ci scope light", bucket: "pass", link: "https://github.com/o/r/actions/runs/42/job/7" }] };
  const io = {
    manager: async (...args: string[]) => {
      const data = JSON.parse(args[args.indexOf("--data") + 1]!);
      return { ok: true, ...recordObserved(db, { project: "p", target: args[2]!, mechanism: "ciQueueFull" as never,
        actionKey: args[args.indexOf("--action-key") + 1]!, action: args[args.indexOf("--action") + 1]!, data }, now) };
    },
    external: () => ({ inspect: async () => { reads++; return snapshot; }, freshness: async () => ({ behindBy: 0, mainHead: H }),
      carryReview: async () => ({ ok: false, reason: "no" }), updateBranch: async () => {}, merge: async () => H }) satisfies MergeExternal,
    command: async (args: string[]) => { commands.push(args); return { code: 0, stdout: "", stderr: "", timedOut: false }; },
    active: () => {}, policy: () => ({ mode, source: "config" as const, manualAfterMs: null }), now: () => now,
  };
  return { db, io, tick: () => ciQueueFullStep(db, config, io), get reads() { return reads; }, commands,
    get snapshot() { return snapshot; }, set snapshot(p: PrSnapshot) { snapshot = p; }, advance: (ms: number) => { now += ms; } };
}

test("on reruns all jobs once, persists before effect, survives restart, retries once after ten minutes then notes PM", async () => {
  const f = fixture();
  try {
    expect(await f.tick()).toEqual([]);
    expect(f.commands).toEqual([["gh", "run", "rerun", "42", "--repo", "o/r"]]);
    expect(f.db.query("SELECT COUNT(*) AS n FROM events WHERE kind='note'").get()).toEqual({ n: 1 });
    await f.tick(); expect(f.reads).toBe(1); expect(f.commands.length).toBe(1);
    // A new SQLite connection has no process-local read throttle; durable records alone prevent the effect.
    const copy = Database.deserialize(f.db.serialize());
    await ciQueueFullStep(copy, config, f.io); copy.close();
    expect(f.commands.length).toBe(1);
    f.advance(600_001); await f.tick(); expect(f.commands.length).toBe(2);
    f.advance(600_001); await f.tick(); expect(f.commands.length).toBe(2);
    expect(f.db.query("SELECT text FROM events WHERE kind='note' ORDER BY seq DESC LIMIT 1").get()).toMatchObject({ text: expect.stringContaining("全量补跑没起来") });
    f.advance(600_001); await f.tick(); expect(f.commands.length).toBe(2);
  } finally { closeLedger(":memory:"); }
});

test("pending, red, full marker, moved head, non-merge and skipped tasks issue no rerun", async () => {
  for (const kind of ["pending", "red", "full", "moved", "stage", "skip"] as const) {
    const f = fixture();
    try {
      if (kind === "pending" || kind === "red") f.snapshot = { ...f.snapshot, checks: f.snapshot.checks.map((c) => ({ ...c, bucket: kind === "red" ? "fail" : "pending" })) };
      if (kind === "full") f.snapshot = { ...f.snapshot, checks: [...f.snapshot.checks, { name: "ci scope full", bucket: "pending" }] };
      if (kind === "moved") f.snapshot = { ...f.snapshot, head: "b".repeat(40) };
      if (kind === "stage") f.db.query("UPDATE tasks SET stage='review'").run();
      if (kind === "skip") Object.assign(f.io, { pace: { skipTask: () => true, yieldNow: () => false, cursor: {} } });
      await f.tick(); expect(f.commands).toEqual([]);
      if (kind === "skip" || kind === "stage") expect(f.reads).toBe(0);
    } finally { closeLedger(":memory:"); }
  }
});

test("off never reads, observe records once per head but never reruns", async () => {
  for (const mode of ["off", "observe"] as const) {
    const f = fixture(mode);
    try {
      await f.tick(); f.advance(60_001); await f.tick(); expect(f.commands).toEqual([]);
      expect(f.reads).toBe(mode === "off" ? 0 : 2);
      expect(f.db.query("SELECT COUNT(*) AS n FROM events WHERE kind='note'").get()).toEqual({ n: mode === "off" ? 0 : 2 });
    } finally { closeLedger(":memory:"); }
  }
});

test("reads at most four cards per pass, including manual cards without a workflow", async () => {
  const f = fixture("on", 5);
  try { await f.tick(); expect(f.reads).toBe(4); } finally { closeLedger(":memory:"); }
});
