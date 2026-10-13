/**
 * merge-arch-SELECT4 × S2D2: what the read map's fuse left open for a car is held while one of that car's own members is skip.
 * The real mergeTrainTick (whose `carry` runs ahead of the tick's own skip gate) and the real wiring on a fake GitHub and a real
 * ledger in a temp dir. No train is live here: the car is the one whose red verdict left the case, the notice or the run reference
 * behind, asked through the hook as stepTesting asks it. Held = no GitHub read, no variable write, no record, no notice; once the
 * member is local again the case goes on as if nothing had happened.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { planDigest, type CiPlan } from "../scripts/ci-related-plan.ts";
import type { CiIoMapFuseGh, FuseJob, FuseRun } from "../src/lib/ci-io-map-fuse.js";
import { resetFuseMemory } from "../src/lib/ci-io-map-fuse-run.js";
import { ciIoMapFuse } from "../src/lib/ci-io-map-fuse-wiring.js";
import { createTask } from "../src/lib/ledger-write.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { setForeignRepoLookupForTest } from "../src/lib/scheduler-foreign-repo.js";
import type { TrainCar, TrainState, TrainStore } from "../src/lib/scheduler-merge-train.js";
import { mergeTrainTick } from "../src/lib/scheduler-merge-train-tick.js";
import { schedulerV2SkipTask } from "../src/lib/scheduler-v2-skip.js";
import { mergedCard } from "./deploy-test-kit.js";

const REPO = "example/repo", MIN = 60_000, CI = ".github/workflows/ci.yml", F = "tests/hole.test.ts", RUN = 900, PR_RUN = 901;
const HEAD = "1".repeat(40), TRIGGER = "7".repeat(40), PR = `https://github.com/${REPO}/pull/1`;
const FAIL_LOG = [`##[group]${F}:`, "error: expect(received).toBe(expected)", "(fail) hole > case [0.40ms]", "##[endgroup]", " 1999 pass", " 1 fail",
  "##[error]Process completed with exit code 1."].map((l) => `test shard 1 of 8\tUnit tests\t2026-10-12T09:00:00.1234567Z ${l}`).join("\n");
const base: CiPlan = { version: 1, event: "pull_request", sha: "9".repeat(40), mode: "on", scope: "related", reasons: [], tests: ["tests/a.test.ts"],
  shards: [["tests/a.test.ts"]], proposed: 1, picked: 1, universe: 9,
  ioMap: { mode: "on", used: true, sha: "e".repeat(40), generatedAt: "2026-10-12T00:00:00Z", proposed: 1, picked: 1, reasons: [] }, prHead: HEAD };
/** T1's frozen read-map plan on its exact head leaves F out; the train run's own plan is full and bound to what it tested. */
const PLANS: Record<number, CiPlan> = { [PR_RUN]: base, [RUN]: { ...base, scope: "full", tests: [], shards: [], sha: "8".repeat(40), ioMap: null, prHead: TRIGGER } };

const envs: { close(): void }[] = [];
function setup() {
  const c = mergedCard(), clock = { t: 1_000_000 }, notices: string[] = [], pmFails = { n: 0 };
  createTask(c.db, { actor: "owner", now: 150 }, { project: "p", id: "T1", title: "T1", kind: "code" });
  const hub = { value: "on" as string | null, writes: 0, reads: [] as string[], fails: {} as Partial<Record<keyof CiIoMapFuseGh, number>> };
  const read = <T>(name: keyof CiIoMapFuseGh, v: () => T): T => {
    if ((hub.fails[name] ?? 0) > 0) { hub.fails[name]!--; throw new Error("HTTP 502: Bad Gateway"); }
    hub.reads.push(name);
    return v();
  };
  const run = (id: number): FuseRun => ({ id, attempt: 1, status: "completed", conclusion: id === RUN ? "failure" : "success", branch: id === RUN ? "train/t" : "task/T1", path: CI, event: "pull_request",
    head: id === RUN ? TRIGGER : HEAD, repo: REPO, headRepo: REPO, prs: id === RUN ? [] : [1] });
  const jobs = (id: number): FuseJob[] => [{ id: id * 10, name: `ci scope ${PLANS[id]!.scope}`, status: "completed", conclusion: "success" }];
  const gh: CiIoMapFuseGh = {
    ciRun: async (_r, id) => read("ciRun", () => run(id)),
    headRuns: async (_r, head) => read("headRuns", () => (head === HEAD ? [run(PR_RUN)] : [])),
    attemptJobs: async (_r, id) => read("attemptJobs", () => jobs(id)),
    attemptFailedLog: async () => read("attemptFailedLog", () => FAIL_LOG),
    jobLog: async (_r, job) => read("jobLog", () => {
      const p = PLANS[job / 10]!;
      return { text: `2026-10-12T09:00:01Z scope=${p.scope} plan=${planDigest(p)}`, truncated: false };
    }),
    planArtifact: async (_r, id) => read("planArtifact", () => JSON.stringify(PLANS[id], null, 1)),
    ioMapVar: async () => read("ioMapVar", () => hub.value),
    lowerIoMapVar: async () => { hub.writes++; hub.value = "observe"; },
  };
  const io = { now: () => clock.t, notifyPm: async (_task: unknown, text: string) => { if (pmFails.n-- > 0) throw new Error("bridge down"); notices.push(text); } };
  const store: TrainStore = { load: () => null, all: () => [], save: () => {}, event: () => {}, nextSeq: () => 1 };
  mkdirSync(dirname(RECOVERY_POLICY_PATH), { recursive: true });
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { ciIoMapFuse: "on" } } } }));
  setForeignRepoLookupForTest({ project: () => REPO });
  /** The red verdict of T1's car, asked as stepTesting asks it (the production wiring: policy file, project repository, skip route). */
  const red = () => {
    const s = { id: "t", project: "p", repo: REPO, members: [{ taskId: "T1", prRef: PR, head: HEAD, files: [] }] } as unknown as TrainState;
    const car = { id: "t", members: ["T1"], branch: "train/t" } as TrainCar;
    return ciIoMapFuse(c.db, gh, io)!(s, car, [{ name: "check", bucket: "fail", link: `https://github.com/${REPO}/actions/runs/${RUN}/job/1` }]);
  };
  /** Ordinary production passes after `ms`: no live train, no candidate, so all they do is take up what was left open. */
  const later = async (ms: number) => { clock.t += ms; for (let i = 0; i < 3; i++) await mergeTrainTick(c.db, ["p"], io, { gh: gh as never, store }, () => ["check"]); };
  const steps = () => (c.db.query("SELECT data FROM events ORDER BY seq").all() as { data: string }[]).map((e) => JSON.parse(e.data) as { op?: string; step: string })
    .filter((e) => e.op === "ci_io_map_fuse").map((e) => e.step);
  /** S2D2: T1's feature goes `migrating` (route skip, bound as tests/shared-ledger-v2-stage2-skip-merge.test.ts binds it), and back. */
  const modes = join(dirname(c.db.filename), "shared-ledger-modes.json");
  const toSkip = () => {
    c.db.query("INSERT OR IGNORE INTO features (id,project,title,status,createdBy,createdAt,updatedAt) VALUES ('fm','p','synthetic fm','active','owner',1,1)").run();
    c.db.query("UPDATE tasks SET featureId='fm' WHERE id='T1'").run();
    writeFileSync(modes, JSON.stringify({ features: { fm: { authorityMode: "planning", sharedPlanning: true, migrating: { batchId: "batch", kind: "execute" } } } }));
    expect(schedulerV2SkipTask(c.db, "T1")).toBe(true);
  };
  const toLocal = () => { rmSync(modes); expect(schedulerV2SkipTask(c.db, "T1")).toBe(false); };
  /** Everything the fuse did: GitHub reads, variable writes, the value, PM notices, its ledger records. */
  const effects = () => ({ reads: hub.reads.length, writes: hub.writes, value: hub.value, notices: notices.length, steps: steps() });
  envs.push(c);
  return { hub, gh, clock, notices, pmFails, red, later, steps, toSkip, toLocal, effects };
}

beforeEach(() => resetFuseMemory());
afterEach(() => { setForeignRepoLookupForTest({ project: null }); rmSync(RECOVERY_POLICY_PATH, { force: true }); for (const e of envs.splice(0)) e.close(); });

test("control: with the member local, the passes that follow lower CI_IO_MAP for the case a failed read left open", async () => {
  const env = setup();
  env.hub.fails.planArtifact = 1;
  await env.red();
  expect([env.hub.writes, env.steps()]).toEqual([0, ["pending"]]);
  await env.later(11 * MIN);
  expect([env.hub.writes, env.hub.value, env.notices.length, env.steps()]).toEqual([1, "observe", 1, ["pending", "try", "done", "sent", "closed"]]);
});

test("an open case of a car whose member turned skip is held, and lowers once the member is local again", async () => {
  const env = setup();
  env.hub.fails.planArtifact = 1;
  await env.red();
  env.toSkip();
  const before = env.effects();
  await env.later(11 * MIN); await env.later(11 * MIN);
  expect(env.effects()).toEqual(before);
  env.toLocal();
  await env.later(0); // being held was no try: it is due at once
  expect(env.effects()).toMatchObject({ writes: 1, value: "observe", notices: 1, steps: ["pending", "try", "done", "sent", "closed"] });
  expect(env.notices[0]).toContain("已从 on 退回 observe");
});

test("a notice owed for a car whose member turned skip is not sent, then sent exactly once when the member is local again", async () => {
  const env = setup();
  env.pmFails.n = 1;
  await env.red();
  expect(env.effects()).toMatchObject({ writes: 1, value: "observe", notices: 0, steps: ["pending", "try", "done", "closed"] });
  env.toSkip();
  const before = env.effects();
  await env.later(2 * MIN); await env.later(11 * MIN);
  expect(env.effects()).toEqual(before);
  env.toLocal();
  await env.later(0); await env.later(11 * MIN);
  expect(env.effects()).toMatchObject({ writes: 1, notices: 1, steps: [...before.steps, "sent"] });
});

test("a kept run reference of a car whose member turned skip is not read back until the member is local again", async () => {
  const env = setup();
  env.hub.fails.ciRun = 1;
  await env.red();
  expect(env.effects()).toMatchObject({ reads: 0, writes: 0, steps: ["ref"] });
  env.toSkip();
  const before = env.effects();
  await env.later(11 * MIN); await env.later(11 * MIN);
  expect(env.effects()).toEqual(before);
  env.toLocal();
  await env.later(0);
  expect(env.effects()).toMatchObject({ writes: 1, value: "observe", notices: 1 });
  expect(env.steps().filter((s) => s === "refdone" || s === "done")).toEqual(["refdone", "done"]);
});

test("a member that is skip at the red verdict, or turns skip between the last read and the write: nothing is written or sent, the case is kept", async () => {
  const env = setup();
  env.toSkip();
  await env.red(); // the tick's own gate would not have stepped this train; asked anyway, only the run is kept
  expect(env.effects()).toEqual({ reads: 0, writes: 0, value: "on", notices: 0, steps: ["ref"] });
  env.toLocal();
  const read = env.gh.ioMapVar;
  env.gh.ioMapVar = async (r) => { const v = await read(r); env.toSkip(); return v; };
  await env.later(0); // the reference is read back; the member turns skip right before the write
  expect(env.effects()).toMatchObject({ writes: 0, value: "on", notices: 0, steps: ["ref", "pending", "refdone"] });
  env.gh.ioMapVar = read;
  env.toLocal();
  await env.later(0);
  expect(env.effects()).toMatchObject({ writes: 1, value: "observe", notices: 1 });
});
