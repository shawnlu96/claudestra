/** rename-floka-REPOMERGE1 · the train's CI_IO_MAP fuse entry (ci-io-map-fuse-run.ts) with the renamed repository's old and new name. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CiIoMapFuseGh, FuseCase } from "../src/lib/ci-io-map-fuse.js";
import { fuseLedger } from "../src/lib/ci-io-map-fuse-ledger.js";
import { ciIoMapFuseHook, resetFuseMemory, type FusePort } from "../src/lib/ci-io-map-fuse-run.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { OFFICIAL_REPO, PROPOSED_REPO } from "../src/lib/floka-repo/migrate.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { setRepoAliasForTest } from "../src/lib/repo-alias.js";
import type { TrainCar, TrainCheck, TrainState } from "../src/lib/scheduler-merge-train.js";

const OLD = OFFICIAL_REPO, NEW = PROPOSED_REPO, H1 = "a".repeat(40);
const MODES: RecoveryMode[] = ["off", "observe", "on"];
const check = (repo: string, run: number): TrainCheck => ({ name: "test", bucket: "fail", link: `https://github.com/${repo}/actions/runs/${run}/job/9` }) as TrainCheck;
const car = { id: "c1", branch: "train/x-c1", members: ["T1"] } as unknown as TrainCar;
const state = (repo: string) => ({ id: "x", project: "p", repo, members: [{ taskId: "T1", prRef: `https://github.com/${repo}/pull/1`, head: H1 }] }) as unknown as TrainState;

/** The real hook under fuse observe; ciRun records the run asked for and fails, so nothing past the entry is read. */
async function ciRunCalls(config: string, train: string, checks: TrainCheck[]): Promise<number[]> {
  const calls: number[] = [];
  const gh = { ciRun: async (_repo: string, run: number) => { calls.push(run); throw new Error("stop here"); } } as unknown as CiIoMapFuseGh;
  const port = { mode: () => "observe", projectRepo: () => config, gh, ledger: {}, now: () => 1_000, pm: async () => {}, skip: () => false } as unknown as FusePort;
  const orig = console.error;
  console.error = () => {};
  try { await ciIoMapFuseHook(port)(state(train), car, checks); } finally { console.error = orig; }
  return calls;
}

beforeEach(() => resetFuseMemory());
afterEach(() => setRepoAliasForTest({ mode: null, sink: null }));

describe("[验收线 1/4] the fuse hook reads a run GitHub links under the other name", () => {
  test("on: a new-name check link on an old-name train is read; off / observe: skipped as before", async () => {
    for (const mode of MODES) {
      setRepoAliasForTest({ mode, sink: () => {} });
      expect(await ciRunCalls(OLD, OLD, [check(OLD, 5)])).toEqual([5]);
      expect(await ciRunCalls(OLD, OLD, [check(NEW, 6)])).toEqual(mode === "on" ? [6] : []);
    }
  });
  test("on: the config moved to the new name while the train keeps the old one: still checked; off / observe: not", async () => {
    for (const mode of MODES) {
      setRepoAliasForTest({ mode, sink: () => {} });
      expect(await ciRunCalls(NEW, OLD, [check(NEW, 7)])).toEqual(mode === "on" ? [7] : []);
    }
  });
  test("a fork's or another org's run link is never read, whatever the mode", async () => {
    setRepoAliasForTest({ mode: "on", sink: () => {} });
    expect(await ciRunCalls(OLD, OLD, [check("someone/claudestra", 8), check("someone/floka", 9)])).toEqual([]);
    expect(await ciRunCalls("someone/floka", OLD, [check(OLD, 10)])).toEqual([]);
  });
});

/**
 * The real ledger and carry, the config already on the new name: three old-name pending cases and one new-name one, each read as a
 * completed green run (so each is settled at once). Returns the runs asked for (and under which name) and the cases still pending.
 */
async function carryTwice(config: string): Promise<{ calls: string[]; open: number[] }> {
  const db = openLedger(":memory:"), ledger = fuseLedger(db, () => 1_000), calls: string[] = [];
  const pending = (repo: string, runId: number): FuseCase => ({ project: "p", repo, train: "x", car: "c1", branch: "train/x", runId, members: [], attempt: 1 });
  for (const c of [pending(OLD, 1), pending(OLD, 2), pending(OLD, 3), pending(NEW, 4)]) ledger.pend(c);
  const gh = {
    ciRun: async (repo: string, id: number, attempt = 1) => {
      calls.push(`${repo}#${id}`);
      return { id, attempt, status: "completed", conclusion: "success", branch: "train/x", head: H1, path: ".github/workflows/ci.yml", event: "pull_request", repo, headRepo: repo, prs: [] };
    },
  } as unknown as CiIoMapFuseGh;
  const port = { mode: () => "on", projectRepo: () => config, gh, ledger, now: () => 1_000, pm: async () => {}, skip: () => false } as unknown as FusePort;
  const orig = console.log;
  console.log = () => {};
  try { const hook = ciIoMapFuseHook(port); await hook.carry("p"); await hook.carry("p"); } finally { console.log = orig; }
  try { return { calls, open: ledger.openCases("p", 0).map((c) => c.runId) }; } finally { closeLedger(":memory:"); }
}

describe("[fuse-carry] old-name cases left open before the config moved to the new name", () => {
  test("on: every case is read under the configured name, closed under its own name, and none keeps the carry slots", async () => {
    setRepoAliasForTest({ mode: "on", sink: () => {} });
    expect(await carryTwice(NEW)).toEqual({ calls: [`${NEW}#1`, `${NEW}#2`, `${NEW}#3`, `${NEW}#4`], open: [] });
  });
  test("off / observe: the old-name cases stay out of the new-name carry, as before", async () => {
    for (const mode of ["off", "observe"] as const) {
      setRepoAliasForTest({ mode, sink: () => {} });
      resetFuseMemory();
      expect(await carryTwice(NEW)).toEqual({ calls: [`${NEW}#4`], open: [1, 2, 3] });
    }
  });
});

describe("[fuse-carry] a write an earlier pass sent for an old-name case, settled after the config moved to the new name", () => {
  test("on: GitHub is read under the configured name; pending, try, closed and done all keep the case's own name", async () => {
    setRepoAliasForTest({ mode: "on", sink: () => {} });
    const db = openLedger(":memory:"), ledger = fuseLedger(db, () => 1_000), reads: string[] = [], writes: string[] = [];
    const c: FuseCase = { project: "p", repo: OLD, train: "x", car: "c1", branch: "train/x", runId: 1, members: [], attempt: 1 };
    const e = { repo: OLD, project: "p", train: "x", car: "c1", members: [], run: { id: 1, attempt: 1, head: H1, tested: H1, planDigest: "d".repeat(64) }, files: ["tests/a.test.ts"], omissions: [] };
    ledger.pend(c);
    ledger.tryWrite(c, "k1", e); // the process stopped after the write, before the done record
    const gh = { ioMapVar: async (repo: string) => { reads.push(repo); return "observe"; }, lowerIoMapVar: async (repo: string) => { writes.push(repo); } } as unknown as CiIoMapFuseGh;
    const port = { mode: () => "on", projectRepo: () => NEW, gh, ledger, now: () => 1_000, pm: async () => {}, skip: () => false } as unknown as FusePort;
    const orig = console.log;
    console.log = () => {};
    try { await ciIoMapFuseHook(port).carry("p"); } finally { console.log = orig; }
    try {
      const steps = (db.query("SELECT data FROM events WHERE project = 'p' ORDER BY seq").all() as { data: string }[]).map((r) => JSON.parse(r.data) as { step: string; case?: unknown });
      const ids = (step: string) => steps.filter((s) => s.step === step).map((s) => (typeof s.case === "string" ? s.case : null));
      expect({ reads, writes }).toEqual({ reads: [NEW], writes: [] });
      expect([ids("try"), ids("done"), ids("closed")]).toEqual([[`${OLD}#1#1`], [`${OLD}#1#1`], [`${OLD}#1#1`]]);
      expect([ledger.openCases("p", 0), ledger.unsettled(c)]).toEqual([[], null]);
    } finally { closeLedger(":memory:"); }
  });
});
