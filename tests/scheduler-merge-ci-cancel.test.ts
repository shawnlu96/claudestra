/**
 * merge-arch-CICANCEL1: required CI that was only cancelled is not a ci_fail. on: one rerun through CIF1's claim, a second
 * cancel goes to the PM; observe / off: today's bounce (observe adds one note); any failed check bounces in every mode; a run of
 * another head is never re-run (CIF1 and the cancel path wait). Fake gh argv runner, real ledger and merge tick, no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { useEffCountRefreshPorts } from "../src/lib/effect-count-refresh.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { advanceMergeRun, getMergeRun } from "../src/lib/scheduler-merge.js";
import { setCiCancelModeSource } from "../src/lib/scheduler-merge-ci-cancel.js";
import { cancelClaim, cancelClaimBase, cancelManualReceipt, cancelObserveReceipt, cancelOnly, parseCancelManual, parseCancelObserve,
  redCheck } from "../src/lib/scheduler-merge-ci-cancel-judge.js";
import { ciRerunGh, rerunReceipt } from "../src/lib/scheduler-merge-ci-rerun.js";
import { green, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import type { BoundedResult } from "../src/lib/run-bounded.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import { ledgerAs, mergedCard } from "./deploy-test-kit.js";

const HEAD = "c".repeat(40), OTHER = "9".repeat(40), PR = "https://github.com/example/repo/pull/7";
const RUN = "https://github.com/example/repo/actions/runs/77";
const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/p" } } });
const at = (line: string) => `ci\tgate\t2026-10-14T15:20:03.1234567Z ${line}`;
/** What `--log-failed` gives for a cancelled run: the gate's own line, no bun test failure to parse. */
const CANCEL_LOG = [at("##[error]分片没有全部成功：cancelled"), at("##[error]Process completed with exit code 1.")].join("\n");
const TIMEOUT_LOG = [at("##[group]tests/slow.test.ts:"), at("(fail) slow > waits [6189.00ms]"), at("  ^ this test timed out after 5000ms."),
  at("##[endgroup]"), at(" 1 fail"), at("Ran 2 tests across 2 files. [9.00s]")].join("\n");

type Bucket = PrSnapshot["checks"][number]["bucket"];
interface Gh { attempt: number; status: string; conclusion: string; headSha: string; log: string; argv: string[] }
const ok = (stdout: string): BoundedResult => ({ code: 0, stdout, stderr: "", timedOut: false });
/** run 77 / PR 7 as GitHub answers them; a rerun starts a new attempt that is queued until the test says otherwise. */
const fakeGh = (gh: Gh) => async (argv: string[]): Promise<BoundedResult> => {
  const cmd = argv.slice(1).join(" ");
  gh.argv.push(cmd);
  if (cmd === "run view 77 --repo example/repo --json attempt,status,conclusion,headSha") {
    return ok(JSON.stringify({ attempt: gh.attempt, status: gh.status, conclusion: gh.conclusion, headSha: gh.headSha }));
  }
  if (cmd === "run view 77 --repo example/repo --log-failed") return ok(gh.log);
  if (cmd === `pr view ${PR} --json files`) return ok(JSON.stringify({ files: [{ path: "src/lib/x.ts" }] }));
  if (cmd === "run rerun 77 --failed --repo example/repo") return ok(void Object.assign(gh, { attempt: gh.attempt + 1, status: "queued", conclusion: "" }) ?? "");
  return { code: 1, stdout: "", stderr: `unexpected gh ${cmd}`, timedOut: false };
};
const snapOf = (gate: Bucket, shard?: Bucket, mergeState = "UNSTABLE"): PrSnapshot => ({ state: "OPEN", head: HEAD, branch: "feat/t9", base: "main",
  draft: false, crossRepository: false, mergeState, mergeSha: null,
  checks: [{ name: "ci", bucket: gate, link: `${RUN}/job/9` }, ...(shard ? [{ name: "shard 1", bucket: shard, link: `${RUN}/job/3` }] : [])] });

/** The deploy kit's auto card in `await_ci` on its reviewed head; run 77 (attempt 1) ended cancelled and the gate shows cancel. */
function card(mode: RecoveryMode, over: Partial<Gh> = {}) {
  setCiCancelModeSource(() => mode);
  const c = mergedCard();
  c.db.query("UPDATE scheduler_merges SET phase='await_ci', mergeSha=NULL WHERE intentId=?").run(c.intent);
  const gh: Gh = { attempt: 1, status: "completed", conclusion: "cancelled", headSha: HEAD, log: CANCEL_LOG, argv: [], ...over };
  let snap = snapOf("cancel");
  const merges: string[] = [];
  const external = { inspect: async () => snap, freshness: async () => ({ behindBy: 0, mainHead: "e".repeat(40) }),
    carryReview: async () => ({ ok: false, reason: "不沿用" }), updateBranch: async () => { throw new Error("不该更新分支"); },
    merge: async (_pr: string, head: string) => { merges.push(head); throw new Error("停在合并前"); }, ciRerun: ciRerunGh(fakeGh(gh) as never) } as MergeExternal;
  const tick = (now = 200) => schedulerMergeTick(c.db, config, ledgerAs(c.db, "scheduler", () => now), () => external);
  const state = () => ({ run: getMergeRun(c.db, c.intent)?.phase, stage: (c.db.query("SELECT stage FROM tasks WHERE id='T9'").get() as { stage: string }).stage,
    mode: getWorkflow(c.db, "T9")?.mode });
  const events = (kind: string, op: string) => (c.db.query(`SELECT text, data FROM events WHERE target='T9' AND kind=? AND json_extract(data,'$.op')=?
    ORDER BY seq`).all(kind, op) as { text: string; data: string }[]).map((e) => ({ text: e.text, ...JSON.parse(e.data) }));
  const reruns = () => gh.argv.filter((a) => a.startsWith("run rerun")).length;
  const notes = () => events("note", "recovery_observe").filter((e) => e.mechanism === "ciCancelRerun");
  return { ...c, gh, tick, state, events, reruns, notes, merges, setSnap: (s: PrSnapshot) => { snap = s; } };
}
type Card = ReturnType<typeof card>;
const withCard = async (mode: RecoveryMode, over: Partial<Gh>, body: (c: Card) => Promise<void>) => {
  using _count = useEffCountRefreshPorts({ mode: () => "off" }); // EFFAUTO1 reads the log once more on a bounce; not this card's subject
  const c = card(mode, over);
  try { await body(c); } finally { c.close(); }
};
afterEach(() => setCiCancelModeSource(null));

const WAITING = { run: "await_ci", stage: "merge", mode: "auto" }, BOUNCED = { run: "resolved", stage: "fix", mode: "auto" };
const TO_PM = { run: "resolved", stage: "merge", mode: "manual" };

describe("merge-arch-CICANCEL1 judgment", () => {
  test("cancel is red and never green; only cancelled = a required cancel and no failed check anywhere", () => {
    const run = { requiredChecks: "ci" };
    const c = (name: string, bucket: Bucket) => ({ name, bucket });
    expect([redCheck(c("ci", "cancel")), redCheck(c("ci", "fail")), redCheck(c("ci", "pass")), redCheck(c("ci", "pending"))]).toEqual([true, true, false, false]);
    expect(cancelOnly(run, [c("ci", "cancel"), c("shard", "cancel")])).toBe(true);
    expect(cancelOnly(run, [c("ci", "cancel"), c("shard", "fail")])).toBe(false); // a failed shard is a real failure
    expect(cancelOnly(run, [c("ci", "fail")])).toBe(false);
    expect(cancelOnly(run, [c("ci", "pass"), c("shard", "cancel")])).toBe(false); // nothing required was cancelled
    for (const checks of [[c("ci", "cancel")], [c("ci", "pass"), c("lint", "cancel")]]) expect(green(run, checks)).toBe(false); // [验收线 5]
  });

  test("receipts: the cancel claim is CIF1's claim plus a mark; manual / observe receipts round-trip; others are not theirs", () => {
    const base = rerunReceipt(HEAD, { link: RUN, checks: ["ci"], cases: [] });
    expect(cancelClaimBase(cancelClaim(base))).toBe(base);
    expect(cancelClaimBase(base)).toBeNull();
    expect(cancelClaimBase(cancelClaim(rerunReceipt(HEAD, { link: RUN, checks: ["ci"], cases: ["t > x"] })))).toBeNull(); // a timeout claim is not one
    const facts = { prHead: HEAD, link: RUN, attempt: 2 };
    expect(parseCancelManual(cancelManualReceipt(facts, "CI 连续被取消"))).toEqual({ ...facts, why: "CI 连续被取消" });
    expect(parseCancelObserve(cancelObserveReceipt(facts, "manual"))).toEqual({ ...facts, plan: "manual" });
    expect(parseCancelObserve(cancelObserveReceipt({ ...facts, attempt: 1 }, "rerun"))).toEqual({ ...facts, attempt: 1, plan: "rerun" });
  });

  test("the ledger refuses a manual receipt for another head", async () => {
    setCiCancelModeSource(() => "on");
    const c = mergedCard();
    try {
      c.db.query("UPDATE scheduler_merges SET phase='await_ci', mergeSha=NULL WHERE intentId=?").run(c.intent);
      const rev = getMergeRun(c.db, c.intent)!.rev;
      expect(() => advanceMergeRun(c.db, { actor: "scheduler", now: 200 }, { intentId: c.intent, from: "await_ci", to: "resolved", rev,
        receipt: cancelManualReceipt({ prHead: OTHER, link: RUN, attempt: 2 }, "CI 连续被取消") })).toThrow("head");
    } finally { c.close(); }
  });
});

describe("[验收线 1] only cancelled on the reviewed head, attempt 1", () => {
  test("off: back to fix as before (ci_fail), no rerun, no note", async () => {
    await withCard("off", {}, async (c) => {
      await c.tick();
      expect(c.state()).toEqual(BOUNCED);
      expect(c.events("scheduler", "merge_conflict")).toEqual([expect.objectContaining({ cause: "ci_fail" })]);
      expect([c.reruns(), c.notes()]).toEqual([0, []]);
    });
  });

  test("observe: the same bounce, plus one note naming card, head, run, attempt and the rerun on would send", async () => {
    await withCard("observe", {}, async (c) => {
      await c.tick();
      expect(c.state()).toEqual(BOUNCED);
      expect(c.events("scheduler", "merge_conflict")).toEqual([expect.objectContaining({ cause: "ci_fail" })]);
      expect(c.reruns()).toBe(0);
      expect(c.notes()).toEqual([expect.objectContaining({ prHead: HEAD, run: RUN, attempt: 1, plan: "rerun", intentId: c.intent })]);
      expect(c.notes()[0].text).toContain("CI 被取消，重跑一次");
    });
  });

  test("on: one rerun through CIF1's claim, no bounce, no unknown; ticks while GitHub catches up never send a second", async () => {
    await withCard("on", {}, async (c) => {
      await c.tick();
      expect(c.state()).toEqual(WAITING);
      expect(c.reruns()).toBe(1);
      expect(c.events("scheduler", "merge_conflict")).toEqual([]);
      const [claim, ...more] = c.events("scheduler", "merge_ci_rerun");
      expect(more).toEqual([]);
      expect(claim).toMatchObject({ prHead: HEAD, run: RUN, checks: ["ci"], cancelled: true, reason: "CI 被取消，重跑一次" });
      expect(claim.text).toContain("CI 被取消，重跑一次");
      Object.assign(c.gh, { attempt: 1, status: "completed", conclusion: "cancelled" }); // GitHub still shows the old attempt
      await c.tick(300);
      c.gh.attempt = 2;
      c.gh.status = "in_progress";
      await c.tick(400);
      expect([c.state(), c.reruns()]).toEqual([WAITING, 1]);
      c.setSnap(snapOf("pass", undefined, "CLEAN")); // the rerun went green: the gate goes on to merge (the fake merge stops it there)
      Object.assign(c.gh, { status: "completed", conclusion: "success" });
      await c.tick(500);
      expect(c.merges).toEqual([HEAD]);
    });
  });

  test("on, after this merge run already merged main in (CIF2, the 10-14 shape): still one rerun, not bounced", async () => {
    await withCard("on", {}, async (c) => {
      c.db.query(`INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (150,'scheduler','p','T9','scheduler','behind',?)`)
        .run(JSON.stringify({ op: "merge_ci_behind", intentId: c.intent, prHead: OTHER }));
      await c.tick();
      expect([c.state(), c.reruns(), c.events("scheduler", "merge_conflict")]).toEqual([WAITING, 1, []]);
    });
  });
});

describe("[验收线 2] cancelled again after the rerun", () => {
  test("on: the rerun is cancelled too → the PM gets the card (CI 连续被取消), never fix, never a second rerun", async () => {
    await withCard("on", {}, async (c) => {
      await c.tick();
      Object.assign(c.gh, { status: "completed", conclusion: "cancelled" }); // attempt 2 cancelled as well
      await c.tick(300);
      expect(c.state()).toEqual(TO_PM);
      expect(c.reruns()).toBe(1);
      expect(c.events("scheduler", "merge_conflict")).toEqual([]);
      expect(c.events("scheduler", "fallback_manual")).toEqual([expect.objectContaining({ reason: expect.stringContaining("CI 连续被取消") })]);
    });
  });

  test("on: a run someone already re-ran (attempt 2) that is only cancelled → the PM at once, no rerun", async () => {
    await withCard("on", { attempt: 2 }, async (c) => {
      await c.tick();
      expect([c.state(), c.reruns()]).toEqual([TO_PM, 0]);
      expect(c.events("scheduler", "fallback_manual")[0].reason).toContain("CI 连续被取消");
    });
  });

  test("on: the head's one rerun was already spent on another run → the ledger ends the run for the PM, not fix", async () => {
    await withCard("on", {}, async (c) => {
      c.db.query(`INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (150,'scheduler','p','T9','scheduler','rerun',?)`)
        .run(JSON.stringify({ op: "merge_ci_rerun", intentId: "older", prHead: HEAD, run: "https://github.com/example/repo/actions/runs/70" }));
      await c.tick();
      expect(c.state()).toMatchObject({ run: "resolved", stage: "merge" });
      expect([c.reruns(), c.events("scheduler", "merge_conflict")]).toEqual([0, []]);
      expect(getMergeRun(c.db, c.intent)?.reason).toContain("本 head 已自动重跑过");
    });
  });

  test("observe: attempt 2 bounces as before, the note says on would hand it to the PM", async () => {
    await withCard("observe", { attempt: 2 }, async (c) => {
      await c.tick();
      expect(c.state()).toEqual(BOUNCED);
      expect(c.notes()).toEqual([expect.objectContaining({ attempt: 2, plan: "manual" })]);
    });
  });
});

describe("[验收线 3] a failed check next to the cancel", () => {
  for (const mode of ["off", "observe", "on"] as const) {
    test(`${mode}: ci_fail as before, no rerun, no note`, async () => {
      await withCard(mode, { conclusion: "failure" }, async (c) => {
        c.setSnap(snapOf("cancel", "fail"));
        await c.tick();
        expect(c.state()).toEqual(BOUNCED);
        expect(c.events("scheduler", "merge_conflict")).toEqual([expect.objectContaining({ cause: "ci_fail" })]);
        expect([c.reruns(), c.notes()]).toEqual([0, []]);
      });
    });
  }
});

describe("[验收线 4] the check links a run of another head", () => {
  test("CIF1: an untouched timeout on a run of another head is not re-run; the gate waits, then re-runs once it is this head's", async () => {
    await withCard("off", { conclusion: "failure", log: TIMEOUT_LOG, headSha: OTHER }, async (c) => {
      c.setSnap(snapOf("fail"));
      await c.tick();
      expect([c.state(), c.reruns(), c.events("scheduler", "merge_ci_rerun")]).toEqual([WAITING, 0, []]);
      c.gh.headSha = HEAD;
      await c.tick(300);
      expect([c.state(), c.reruns()]).toEqual([WAITING, 1]);
    });
  });

  for (const mode of ["off", "observe", "on"] as const) {
    test(`${mode}: only cancelled on a run of another head → wait, no rerun, no bounce, no note`, async () => {
      await withCard(mode, { headSha: OTHER }, async (c) => {
        await c.tick();
        expect([c.state(), c.reruns(), c.notes(), c.events("scheduler", "merge_conflict")]).toEqual([WAITING, 0, [], []]);
      });
    });
  }
});

describe("[验收线 5] a cancelled check never lets the card merge", () => {
  for (const mode of ["off", "observe", "on"] as const) {
    test(`${mode}: CLEAN with the required check cancelled → no merge`, async () => {
      await withCard(mode, {}, async (c) => {
        c.setSnap(snapOf("cancel", undefined, "CLEAN"));
        await c.tick();
        expect(c.merges).toEqual([]);
        expect(c.state().run).not.toBe("merged");
      });
    });
  }
});
