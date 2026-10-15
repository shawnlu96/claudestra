import { expect, test } from "bun:test";
import { ciQueueFullStep } from "../src/lib/scheduler-ci-queue-full.js";
import { recordObserved } from "../src/lib/recovery-policy.js";
import { createTask } from "../src/lib/ledger-write.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";

const H = "a".repeat(40), H2 = "b".repeat(40), ROUND = 200_000;
const config = { enabled: true, pollMs: 1000, autoDispatch: false, projects: { p: { repoDir: ".", maxActiveWorkers: 1, requiredChecks: ["check"] } } };
type Kind = "light" | "full" | "pending" | "fail";
const pr = (i: number) => `https://github.com/o/r/pull/${i}`;
function checks(i: number, kind: Kind): PrSnapshot["checks"] {
  const light = { name: "ci scope light", bucket: "pass" as const, link: `https://github.com/o/r/actions/runs/${100 + i}/job/7` };
  if (kind === "fail") return [{ name: "check", bucket: "fail" }, light];
  if (kind === "pending") return [{ name: "check", bucket: "pending" }, { ...light, bucket: "pending" }];
  return kind === "full" ? [{ name: "check", bucket: "pass" }, light, { name: "ci scope full", bucket: "pass" }] : [{ name: "check", bucket: "pass" }, light];
}

/** Six merge cards T1..T6 in mergeFirst order (no entry events → id order), each with its own PR and light run 10i. */
function fixture(kinds: Kind[], mode: "on" | "observe" = "on") {
  const db = openLedger(":memory:"), heads = kinds.map(() => H), reads = kinds.map(() => 0), commands: string[] = [], actions: string[] = [];
  kinds.forEach((_, n) => {
    createTask(db, { actor: "owner", now: n + 1 }, { project: "p", id: `T${n + 1}`, title: "card", kind: "code" });
    db.query("UPDATE tasks SET stage='merge', headSHA=?, pr=?, branch='task/T' WHERE id=?").run(H, pr(n + 1), `T${n + 1}`);
  });
  let now = 1_000_000;
  const snapshot = (n: number): PrSnapshot => ({ state: "OPEN", head: heads[n]!, base: "main", branch: "task/T", draft: false, crossRepository: false,
    mergeState: "CLEAN", mergeSha: null, checks: checks(n + 1, kinds[n]!) });
  const io = {
    manager: async (...args: string[]) => (actions.push(args[args.indexOf("--action") + 1]!), { ok: true, ...recordObserved(db, { project: "p", target: args[2]!, mechanism: "ciQueueFull" as never,
      actionKey: args[args.indexOf("--action-key") + 1]!, action: args[args.indexOf("--action") + 1]!, data: JSON.parse(args[args.indexOf("--data") + 1]!) }, now) }),
    external: () => ({ inspect: async (ref: string) => { const n = Number(ref.split("/").pop()) - 1; reads[n]!++; return snapshot(n); },
      freshness: async () => ({ behindBy: 0, mainHead: H }), carryReview: async () => ({ ok: false, reason: "no" }),
      updateBranch: async () => {}, merge: async () => H }) satisfies MergeExternal,
    command: async (args: string[]) => { commands.push(args[3]!); return { code: 0, stdout: "", stderr: "", timedOut: false }; },
    active: () => {}, policy: () => ({ mode, source: "config" as const, manualAfterMs: null }), now: () => now,
  };
  return {
    db, reads, commands, actions, kinds, tick: async () => { expect(await ciQueueFullStep(db, config, io)).toEqual([]); },
    advance: (ms: number) => { now += ms; },
    move: (n: number, kind: Kind) => { heads[n - 1] = H2; kinds[n - 1] = kind; db.query("UPDATE tasks SET headSHA=? WHERE id=?").run(H2, `T${n}`); },
    hold: (n: number, phase = "await_ci") => {
      db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
        VALUES ('slot','T${n}','p','merge','merge',1,1,1,?,1,'submitted','merge',1,1)`).run(H);
      db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p','merge:p',?,'slot',1)").run(`T${n}`);
      db.query(`INSERT INTO scheduler_merges (intentId,taskId,project,prRef,expectedBranch,reviewedHead,requiredChecks,phase,createdAt,updatedAt)
        VALUES ('slot',?,'p',?,'task/T',?,'check',?,1,1)`).run(`T${n}`, pr(n), H, phase);
    },
  };
}

test("[验收线 1] cards already judged stop starving later light-only cards: both rerun within two passes", async () => {
  const f = fixture(["full", "full", "full", "full", "light", "light"]);
  try {
    await f.tick(); f.advance(ROUND); await f.tick();
    expect(f.commands.sort()).toEqual(["105", "106"]);
    expect(f.reads.slice(0, 4)).toEqual([1, 1, 1, 1]); // judged in pass one, not inspected in pass two
    // A rerun inside RETRY_MS is not read again either.
    f.advance(ROUND); await f.tick();
    expect(f.reads).toEqual([1, 1, 1, 1, 1, 1]); expect(f.commands.length).toBe(2);
  } finally { closeLedger(":memory:"); }
});

test("[验收线 2] the slot holder waiting on CI is read first even sixth in mergeFirst", async () => {
  const f = fixture(["light", "light", "light", "light", "light", "light"]);
  try {
    f.hold(6);
    await f.tick();
    expect(f.commands[0]).toBe("106"); expect(f.commands.length).toBe(4);
    expect(f.reads).toEqual([1, 1, 1, 0, 0, 1]);
  } finally { closeLedger(":memory:"); }
});

test("a slot holder not waiting on CI keeps its mergeFirst place", async () => {
  const f = fixture(["light", "light", "light", "light", "light", "light"]);
  try { f.hold(6, "merging"); await f.tick(); expect(f.commands).toEqual(["101", "102", "103", "104"]); } finally { closeLedger(":memory:"); }
});

test("[验收线 3] a judged card is read again on a new head, and after ten minutes at the same head", async () => {
  const f = fixture(["full", "full", "full", "full", "light", "light"]);
  try {
    await f.tick();
    f.move(1, "light"); f.advance(ROUND); await f.tick();
    expect(f.reads.slice(0, 4)).toEqual([2, 1, 1, 1]);
    expect(f.commands.sort()).toEqual(["101", "105", "106"]);
    f.advance(600_000 - ROUND - 1); await f.tick(); expect(f.reads.slice(1, 4)).toEqual([1, 1, 1]);
    f.advance(1); await f.tick(); expect(f.reads.slice(1, 4)).toEqual([2, 2, 2]);
  } finally { closeLedger(":memory:"); }
});

test("pending checks are never judged: re-read after sixty seconds", async () => {
  const f = fixture(["pending", "full"]);
  try {
    await f.tick(); f.advance(60_001); await f.tick();
    expect(f.reads).toEqual([2, 1]); expect(f.commands).toEqual([]);
    f.kinds[0] = "light"; f.advance(60_001); await f.tick();
    expect(f.commands).toEqual(["101"]);
  } finally { closeLedger(":memory:"); }
});

test("[验收线 4] observe keeps the sixty-second re-read: same head going from red to green is observed on the next pass", async () => {
  const f = fixture(["fail"], "observe");
  try {
    await f.tick(); f.kinds[0] = "light"; f.advance(ROUND); await f.tick();
    expect(f.reads).toEqual([2]); expect(f.commands).toEqual([]);
    expect(f.actions).toContain("本会重跑 101");
  } finally { closeLedger(":memory:"); }
});

test("[验收线 4] observe neither caches judged cards nor moves the slot holder ahead", async () => {
  const f = fixture(["full", "full", "full", "full", "light", "light"], "observe");
  try {
    f.hold(6);
    await f.tick(); expect(f.reads).toEqual([1, 1, 1, 1, 0, 0]);
    f.advance(ROUND); await f.tick(); expect(f.reads).toEqual([2, 2, 2, 2, 0, 0]);
    expect(f.commands).toEqual([]);
  } finally { closeLedger(":memory:"); }
});
