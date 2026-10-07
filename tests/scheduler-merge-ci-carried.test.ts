/**
 * Red CI on the carried head (after the scheduler's own update-branch): a shard (not a required check) red while the required gate
 * has not reported yet must keep the run waiting, not unknown; once the gate is red, the CIF1 rule decides (timeouts in untouched
 * tests → one rerun per head, anything else → back to fix). In-process ledger, fake gh argv runner; the production-wiring case is
 * tests/scheduler-merge-ci-carried-e2e.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import { ciRerunGh, rerunReceipt } from "../src/lib/scheduler-merge-ci-rerun.js";
import { ciBehindGh } from "../src/lib/scheduler-merge-ci-behind.js";
import { ciRed } from "../src/lib/scheduler-merge-ci-carried.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import type { BoundedResult } from "../src/lib/run-bounded.js";
import { getMeta } from "../src/lib/ledger-store.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import { ledgerAs, mergedCard } from "./deploy-test-kit.js";

const HEAD = "c".repeat(40), NEW = "a".repeat(40), FIX = "f".repeat(40), PR = "https://github.com/example/repo/pull/7";
const RUN = "https://github.com/example/repo/actions/runs/77";
const SLOW = "tests/scheduler-placement-start-reservations.test.ts";
const SHARD = "test shard 1 of 4";
const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/p" } } });

const at = (line: string) => `${SHARD}\tUnit tests\t2026-10-07T07:20:03.1234567Z ${line}`;
const ciLog = (body: string[], fails = 1) => [
  at("##[group]tests/a.test.ts:"), at("(pass) fine [1.00ms]"), at("##[endgroup]"),
  ...body, at(""), at(" 1999 pass"), at(` ${fails} fail`), at("Ran 2000 tests across 300 files. [90.00s]"),
  at("##[error]Process completed with exit code 1."),
].join("\n");
const TIMEOUT_ONLY = ciLog([at(`##[group]${SLOW}:`), at("(fail) production livePlacementIO observes formal starts [5638.00ms]"),
  at("  ^ this test timed out after 5000ms."), at("##[endgroup]")]);
const ASSERTED = ciLog([at(`##[group]${SLOW}:`), at("error: expect(received).toBe(expected)"),
  at("(fail) production livePlacementIO observes formal starts [0.40ms]"), at("##[endgroup]")]);

interface Gh { attempt: number; status: string; conclusion: string; log: string | Error; files: string[]; argv: string[][] }
const ok = (stdout: string): BoundedResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const no = (stderr: string): BoundedResult => ({ code: 1, stdout: "", stderr, timedOut: false });
/** Answers gh argv like the real CLI would for run 77 / PR 7; the compare says the carried head is up to date with main. */
const fakeGh = (gh: Gh) => async (argv: string[]): Promise<BoundedResult> => {
  gh.argv.push(argv);
  const cmd = argv.slice(1).join(" ");
  if (cmd === "run view 77 --repo example/repo --json attempt,status,conclusion") {
    return ok(JSON.stringify({ attempt: gh.attempt, status: gh.status, conclusion: gh.conclusion }));
  }
  if (cmd === "run view 77 --repo example/repo --log-failed") return gh.log instanceof Error ? no(gh.log.message) : ok(gh.log);
  if (cmd === `pr view ${PR} --json files`) return ok(JSON.stringify({ files: gh.files.map((path) => ({ path })) }));
  if (cmd === "run rerun 77 --failed --repo example/repo") {
    Object.assign(gh, { attempt: gh.attempt + 1, status: "queued", conclusion: "" });
    return ok("");
  }
  if (/^api repos\/example\/repo\/compare\/[a-f0-9]{40}\.\.\.main --jq /.test(cmd)) return ok(JSON.stringify({ base: FIX, commits: [] }));
  return no(`unexpected gh ${cmd}`);
};

type Bucket = PrSnapshot["checks"][number]["bucket"];
/** The sharded workflow on `head`: one shard and the required gate `ci`, both jobs of run 77; null = gate not reported yet. */
const snapOf = (head: string, shard: Bucket, gate: Bucket | null, mergeState = "UNSTABLE"): PrSnapshot => ({ state: "OPEN", head,
  branch: "feat/t9", base: "main", draft: false, crossRepository: false, mergeState, mergeSha: null,
  checks: [{ name: SHARD, bucket: shard, link: `${RUN}/job/1` }, ...(gate ? [{ name: "ci", bucket: gate, link: `${RUN}/job/5` }] : [])] });
const CARRY = { ok: true, reason: "净 diff 一致", mainParent: FIX, mainHead: FIX, diffHash: "9".repeat(64) };

/** The deploy kit's card, put back to `updating` on its reviewed head: the scheduler has just sent its own update-branch. */
function card(over: Partial<Gh> = {}) {
  const c = mergedCard();
  c.db.query("UPDATE scheduler_merges SET phase='updating', mergeSha=NULL, reason=NULL WHERE intentId=?").run(c.intent);
  const gh: Gh = { attempt: 1, status: "in_progress", conclusion: "", log: TIMEOUT_ONLY, files: ["src/lib/x.ts", "tests/x.test.ts"], argv: [], ...over };
  let snap = snapOf(NEW, "fail", null);
  const merges: string[] = [];
  const external = { inspect: async () => snap, freshness: async () => ({ behindBy: 0, mainHead: FIX }),
    carryReview: async (_pr: string, previousHead: string, head: string) => ({ ...CARRY, chain: [{ previousHead, head, mainParent: FIX }] }),
    updateBranch: async () => { throw new Error("不该再 update-branch"); }, merge: async (_pr: string, head: string) => { merges.push(head); throw new Error("停在合并前"); },
    ciRerun: ciRerunGh(fakeGh(gh) as never), ciBehind: ciBehindGh(fakeGh(gh) as never) } as MergeExternal;
  const tick = (now = 200) => schedulerMergeTick(c.db, config, ledgerAs(c.db, "scheduler", () => now), () => external);
  const state = () => ({ run: getMergeRun(c.db, c.intent)?.phase as string | undefined, frozen: getMeta(c.db, "p").queueFrozen.frozen,
    stage: (c.db.query("SELECT stage FROM tasks WHERE id='T9'").get() as { stage: string }).stage });
  const events = (op: string) => (c.db.query(`SELECT data FROM events WHERE target='T9' AND kind='scheduler' AND json_extract(data,'$.op')=?
    ORDER BY seq`).all(op) as { data: string }[]).map((e) => JSON.parse(e.data));
  const reruns = () => gh.argv.filter((a) => a[1] === "run" && a[2] === "rerun").length;
  /** GitHub finished run 77: the gate went red after the shard. */
  const gateRed = () => { Object.assign(gh, { status: "completed", conclusion: "failure" }); snap = snapOf(NEW, "fail", "fail"); };
  return { ...c, gh, tick, state, events, reruns, gateRed, merges, setSnap: (s: PrSnapshot) => { snap = s; } };
}
const withCard = async (over: Partial<Gh>, body: (c: ReturnType<typeof card>) => Promise<void>) => {
  const c = card(over);
  try { await body(c); } finally { c.close(); }
};
const WAITING = { run: "await_ci", frozen: false, stage: "merge" }, BOUNCED = { run: "resolved", frozen: false, stage: "fix" };

describe("i28-CIF3 ciRed", () => {
  test("required red / red only outside required checks while one has not reported / anything else", () => {
    const run = { requiredChecks: "ci,web" };
    const c = (name: string, bucket: Bucket) => ({ name, bucket });
    expect(ciRed(run, [c("shard", "fail"), c("ci", "cancel")])).toBe("required");
    expect(ciRed(run, [c("shard", "fail"), c("ci", "pending"), c("web", "pass")])).toBe("unsettled");
    expect(ciRed(run, [c("shard", "cancel"), c("web", "pass")])).toBe("unsettled"); // ci not reported yet
    expect(ciRed(run, [c("shard", "fail"), c("ci", "pass"), c("web", "pass")])).toBeNull(); // every required check settled
    expect(ciRed(run, [c("shard", "fail"), c("ci", "skipping"), c("web", "pass")])).toBeNull();
    expect(ciRed(run, [c("shard", "pending"), c("ci", "pending")])).toBeNull();
  });
});

describe("i28-CIF3 red CI on the head the scheduler's own update-branch produced", () => {
  test("shard red before the gate → carried and waiting, never unknown; gate red on a timeout outside the PR → one rerun, keep waiting", async () => {
    await withCard({}, async (c) => {
      await c.tick();
      expect(c.state()).toEqual(WAITING);
      expect(getMergeRun(c.db, c.intent)?.reviewedHead).toBe(NEW);
      expect(c.events("review_carry")).toEqual([expect.objectContaining({ from: HEAD, to: NEW })]);
      await c.tick(); // still only the shard: the gate has not run
      expect([c.state(), c.reruns()]).toEqual([WAITING, 0]);
      c.gateRed();
      await c.tick(300);
      expect([c.state(), c.reruns()]).toEqual([WAITING, 1]);
      expect(c.events("merge_ci_rerun")).toEqual([expect.objectContaining({ prHead: NEW, run: RUN, checks: ["ci"] })]);
      expect(getMergeRun(c.db, c.intent)?.reason).toContain(`PR head ${NEW}`);
      c.setSnap(snapOf(NEW, "pending", "pending")); // attempt 2 running
      await c.tick(400);
      expect([c.state(), c.reruns()]).toEqual([WAITING, 1]);
      Object.assign(c.gh, { status: "completed", conclusion: "success" });
      c.setSnap(snapOf(NEW, "pass", "pass", "CLEAN"));
      await c.tick(500);
      expect(c.merges).toEqual([NEW]); // merged pinned to the carried head (the fake stops there)
      expect(c.events("merge_conflict")).toEqual([]);
    });
  });

  test("the gate already red on first sight of the new head → carried, then the CIF1 rerun, not unknown", async () => {
    await withCard({ status: "completed", conclusion: "failure" }, async (c) => {
      c.setSnap(snapOf(NEW, "fail", "fail"));
      await c.tick();
      expect([c.state(), c.reruns()]).toEqual([WAITING, 1]);
      expect(c.events("review_carry")).toHaveLength(1);
    });
  });

  test("assertion failure, failing file in the PR, unreadable log → back to fix, no rerun, queue not frozen", async () => {
    for (const over of [{ log: ASSERTED }, { files: [SLOW] }, { log: new Error("HTTP 404") }, { log: "garbage" }] as Partial<Gh>[]) {
      await withCard(over, async (c) => {
        await c.tick();
        expect(c.state()).toEqual(WAITING);
        c.gateRed();
        await c.tick(300);
        expect([JSON.stringify(over), c.state(), c.reruns()]).toEqual([JSON.stringify(over), BOUNCED, 0]);
        expect(c.events("merge_conflict")).toEqual([expect.objectContaining({ cause: "ci_fail", prHead: NEW, checks: [{ name: "ci", link: RUN }] })]);
      });
    }
  });

  test("still red after the rerun → back to fix, never a second rerun", async () => {
    await withCard({}, async (c) => {
      await c.tick();
      c.gateRed();
      await c.tick(300);
      expect(c.reruns()).toBe(1);
      Object.assign(c.gh, { status: "completed", conclusion: "failure" }); // attempt 2 ended red
      c.setSnap(snapOf(NEW, "fail", "fail"));
      await c.tick(400);
      expect([c.state(), c.reruns()]).toEqual([BOUNCED, 1]);
      expect(c.events("merge_ci_rerun")).toHaveLength(1);
    });
  });

  test("the pre-carry head was re-run already → the carried head gets one rerun at most, not more", async () => {
    await withCard({}, async (c) => {
      c.db.prepare("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (150,'scheduler','p','T9','scheduler','',?)")
        .run(JSON.stringify({ op: "merge_ci_rerun", intentId: c.intent, prHead: HEAD, run: "https://github.com/example/repo/actions/runs/70" }));
      await c.tick();
      c.gateRed();
      await c.tick(300);
      expect(c.reruns()).toBe(1);
      Object.assign(c.gh, { status: "completed", conclusion: "failure" });
      c.setSnap(snapOf(NEW, "fail", "fail"));
      await c.tick(400);
      expect([c.state(), c.reruns()]).toEqual([BOUNCED, 1]);
      expect(rerunReceipt(NEW, { link: RUN, checks: ["ci"], cases: [] })).toContain(NEW);
    });
  });

  test("main moved meanwhile (BEHIND) with only the shard red → waits for the gate, not unknown, no update-branch", async () => {
    await withCard({}, async (c) => {
      await c.tick();
      c.setSnap(snapOf(NEW, "fail", "pending", "BEHIND"));
      await c.tick();
      expect([c.state(), c.reruns()]).toEqual([WAITING, 0]);
    });
  });

  test("unchanged: red only outside the required checks with the gate green → unknown as before", async () => {
    await withCard({}, async (c) => {
      await c.tick();
      c.setSnap(snapOf(NEW, "fail", "pass"));
      await c.tick();
      expect(c.state()).toMatchObject({ run: "unknown", frozen: true });
      expect(c.reruns()).toBe(0);
    });
  });
});
