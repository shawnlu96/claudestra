/**
 * merge-arch-CIRERUN1: a red CI whose failing test files are all outside the PR (not on the known flaky list) gets the head's
 * one shared automatic rerun; files in the PR, an unreadable log, a red typecheck / guard step, a cancel, or a head already
 * re-run by any mechanism keep the bounce. Switch ciOutOfDiffRerun: on by default, off = CIF8 alone. Fake gh, no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { addKnownFlaky, setKnownFlakyModeSource } from "../src/lib/ci-known-flaky.js";
import { knownFlakyBase } from "../src/lib/ci-known-flaky-rerun.js";
import { outOfDiffMode, setOutOfDiffModeSource } from "../src/lib/ci-out-of-diff-rerun.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import type { CiBehindGh } from "../src/lib/scheduler-merge-ci-behind.js";
import { parseRerunReceipt, RERUN_SETTLE_MS, rerunReceipt, TRAIN_RERUN_OP, type CiRerunGh } from "../src/lib/scheduler-merge-ci-rerun.js";
import { parseFailedLog } from "../src/lib/scheduler-merge-ci-rerun-log.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import { ledgerAs, mergedCard } from "./deploy-test-kit.js";

const HEAD = "c".repeat(40), NEW = "a".repeat(40), BASE = "b".repeat(40), FIX = "f".repeat(40);
const RUN = "https://github.com/example/repo/actions/runs/77";
const UNLISTED = "tests/http-peer.test.ts", LISTED = "tests/scheduler-update-fail-remote-cancel.test.ts";
const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/p" } } });
const owner = { actor: "owner", now: 150 };
const BOUNCED = { run: "resolved", stage: "fix" }, WAITING = { run: "await_ci", stage: "merge" }, UPDATING = { run: "updating", stage: "merge" };

const line = (step: string) => (l: string) => `ci\t${step}\t2026-10-16T11:02:03.1234567Z ${l}`;
/** A red bun test step: one assertion failure (not a timeout, so CIF1 alone bounces) per file. */
const logOf = (...files: string[]) => [
  ...files.flatMap((f) => [`##[group]${f}:`, "error: expect(received).toBe(expected)", "(fail) 计时 > 断言 [0.40ms]", "##[endgroup]"]),
  " 1999 pass", ` ${files.length} fail`, "##[error]Process completed with exit code 1.",
].map(line("Unit tests")).join("\n");
const TSC_RED = [["src/lib/x.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
  "##[error]Process completed with exit code 2."].map(line("Typecheck (tsc --noEmit)")).join("\n"), logOf(UNLISTED)].join("\n");
const GUARD_RED = [logOf(UNLISTED), ["✗ size: src/lib/x.ts 812 > 800 lines", "##[error]Process completed with exit code 1."]
  .map(line("Guard (ratchets)")).join("\n")].join("\n");

interface Over { ood?: RecoveryMode | null; kf?: RecoveryMode; log?: string; files?: string[] | Error; conclusion?: string;
  /** main changed the failing file since the merge-base (CIF2 would merge main in) */ behind?: boolean;
  /** GitHub keeps showing attempt 1 after the rerun call */ stuck?: boolean }
function card(over: Over = {}) {
  const c = mergedCard();
  c.db.query("UPDATE scheduler_merges SET phase='await_ci', mergeSha=NULL WHERE intentId=?").run(c.intent);
  setKnownFlakyModeSource(() => over.kf ?? "off");
  if (over.ood !== null) setOutOfDiffModeSource(() => over.ood ?? "on");
  let snap: PrSnapshot = { state: "OPEN", head: HEAD, branch: "feat/t9", base: "main", draft: false, crossRepository: false,
    mergeState: "UNSTABLE", mergeSha: null, checks: [{ name: "ci", bucket: "fail", link: `${RUN}/job/9` }] };
  const gh = { attempt: 1, status: "completed", conclusion: over.conclusion ?? "failure", calls: [] as string[] };
  const ciRerun: CiRerunGh = {
    runAttempt: async () => { gh.calls.push("attempt"); return { attempt: gh.attempt, status: gh.status, conclusion: gh.conclusion, headSha: HEAD }; },
    failedLog: async () => over.log ?? logOf(UNLISTED),
    prFiles: async () => { if (over.files instanceof Error) throw over.files; return over.files ?? ["src/lib/x.ts"]; },
    rerunFailed: async () => {
      gh.calls.push("rerun");
      if (!over.stuck) [gh.attempt, gh.status, gh.conclusion] = [gh.attempt + 1, "queued", ""];
    },
  };
  const ciBehind: CiBehindGh = {
    mainSince: async () => ({ mergeBase: BASE, mainHead: FIX, commits: over.behind ? [FIX] : [] }),
    fileCommits: async () => [FIX],
    updateBranch: async () => { gh.calls.push("update"); snap = { ...snap, head: NEW, checks: [{ name: "ci", bucket: "pending", link: `${RUN}/job/9` }] }; },
  };
  const external = { inspect: async () => snap, freshness: async () => ({ behindBy: 0, mainHead: FIX }),
    carryReview: async () => ({ ok: false, reason: "不沿用" }), updateBranch: async () => { throw new Error("不该走 gh pr update-branch"); },
    merge: async () => { throw new Error("不该合并"); }, ciRerun, ciBehind } as MergeExternal;
  const tick = (now = 200) => schedulerMergeTick(c.db, config, ledgerAs(c.db, "scheduler", () => now), () => external);
  const state = () => ({ run: getMergeRun(c.db, c.intent)?.phase as string | undefined, stage: (c.db.query("SELECT stage FROM tasks WHERE id='T9'").get() as { stage: string }).stage });
  const written = () => (c.db.query("SELECT kind, text, data FROM events WHERE target='T9' ORDER BY seq").all() as { kind: string; text: string; data: string }[]);
  const events = (op: string) => written().map((e) => ({ text: e.text, ...JSON.parse(e.data) })).filter((e) => e.op === op);
  const count = (call: string) => gh.calls.filter((x) => x === call).length;
  /** The rerun ended: red (`failure`) or green. */
  const finish = (conclusion: string) => { [gh.status, gh.conclusion] = ["completed", conclusion]; };
  return { ...c, gh, tick, state, written, events, count, finish, setSnap: (s: Partial<PrSnapshot>) => { snap = { ...snap, ...s }; } };
}
type Card = ReturnType<typeof card>;
const withCard = async (over: Over, body: (c: Card) => Promise<void>) => {
  const c = card(over);
  try { await body(c); } finally { c.close(); }
};
afterEach(() => { setKnownFlakyModeSource(null); setOutOfDiffModeSource(null); });

const insertEvent = (c: Card, kind: string, actor: string, data: Record<string, unknown>) =>
  c.db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (150,?,'p','T9',?,'',?)").run(actor, kind, JSON.stringify(data));

describe("[验收线 1] an unlisted red outside the PR is re-run once; anything else bounces", () => {
  test("on: one rerun through CIF1's claim, no bounce, the event says out-of-diff and names the file", async () => {
    await withCard({}, async (c) => {
      await c.tick();
      expect([c.state(), c.count("rerun")]).toEqual([WAITING, 1]);
      expect(c.events("merge_conflict")).toEqual([]);
      const [ev, ...more] = c.events("merge_ci_rerun");
      expect(more).toEqual([]);
      expect(ev).toMatchObject({ prHead: HEAD, run: RUN, checks: ["ci"], cases: [UNLISTED], outOfDiff: true });
      expect(ev.knownFlaky).toBeUndefined();
      expect(ev.text).toContain(`本卡没碰的测试（${UNLISTED}）`);
      expect(ev.reason).toContain("不在本 PR 改动里");
    });
  });

  test("off (before this card): the same red bounces to fix, no rerun", async () => {
    await withCard({ ood: "off" }, async (c) => {
      await c.tick();
      expect([c.state(), c.count("rerun"), c.events("merge_ci_rerun")]).toEqual([BOUNCED, 0, []]);
    });
  });

  const bounced = (name: string, over: Over) => test(name, async () => withCard(over, async (c) => {
    await c.tick();
    expect([c.state(), c.count("rerun"), c.events("merge_ci_rerun")]).toEqual([BOUNCED, 0, []]);
    expect(c.events("merge_conflict")).toEqual([expect.objectContaining({ cause: "ci_fail", checks: [{ name: "ci", link: RUN }] })]);
  }));
  bounced("the failing file is in the PR", { files: ["src/lib/x.ts", UNLISTED] });
  bounced("one of several failing files is in the PR", { files: [UNLISTED], log: logOf("tests/other.test.ts", UNLISTED) });
  bounced("the PR files cannot be read (or the list may be cut)", { files: new Error("改动文件 ≥ 100 个，列表可能不全") });
  bounced("the log does not parse", { log: line("Unit tests")("something else went wrong") });
  bounced("the typecheck step is red too", { log: TSC_RED });
  bounced("the guard step is red too", { log: GUARD_RED });
  bounced("the run was cancelled, not failed", { conclusion: "cancelled" });

  test("a red typecheck or guard step leaves no failure list at all: the rerun layers are never reached", () => {
    expect(parseFailedLog(logOf(UNLISTED))).toEqual([expect.objectContaining({ file: UNLISTED, timedOut: false })]);
    expect([parseFailedLog(TSC_RED), parseFailedLog(GUARD_RED)]).toEqual([null, null]);
  });
});

describe("[验收线 2] one shared rerun per head: across mechanisms, restarts and repeated ticks", () => {
  test("the head was already re-run by CIF1 / CIF8 → bounce, no second rerun", async () => {
    await withCard({}, async (c) => {
      insertEvent(c, "scheduler", "scheduler", { op: "merge_ci_rerun", intentId: "m0", prHead: HEAD, run: "https://github.com/example/repo/actions/runs/70" });
      await c.tick();
      expect([c.state(), c.count("rerun")]).toEqual([BOUNCED, 0]);
    });
  });

  test("a merge train re-ran this head → bounce, no second rerun", async () => {
    await withCard({}, async (c) => {
      insertEvent(c, "note", "scheduler", { op: TRAIN_RERUN_OP, prHead: HEAD, run: "https://github.com/example/repo/actions/runs/71" });
      await c.tick();
      expect([c.state(), c.count("rerun")]).toEqual([BOUNCED, 0]);
    });
  });

  test("listed file with CIF8 on: CIF8's one rerun, not one more of this layer's", async () => {
    await withCard({ kf: "on", log: logOf(LISTED) }, async (c) => {
      const featureId = createFeature(c.db, owner, { project: "p", slug: "rel", title: "rel" }).row.id;
      initDag(c.db, owner, { id: featureId, rev: 1, nodes: [{ key: "UPDFLAKY1", oneLine: "修时序竞态" }] });
      addKnownFlaky(c.db, owner, { project: "p", file: LISTED, featureId, node: "UPDFLAKY1", reason: "时序竞态" });
      await c.tick();
      await c.tick();
      expect([c.state(), c.count("rerun")]).toEqual([WAITING, 1]);
      const [ev, ...more] = c.events("merge_ci_rerun");
      expect(more).toEqual([]);
      expect(ev.knownFlaky).toEqual([expect.objectContaining({ file: LISTED })]);
      expect(ev.outOfDiff).toBeUndefined();
    });
  });

  test("repeated ticks and a restart (reason cache lost) while GitHub still shows attempt 1 → still one rerun; past the settle → fix", async () => {
    await withCard({ stuck: true }, async (c) => {
      await c.tick();
      await c.tick(300);
      expect([c.state(), c.count("rerun")]).toEqual([WAITING, 1]);
      c.db.query("UPDATE scheduler_merges SET reason=NULL WHERE intentId=?").run(c.intent); // a restart's fresh driver
      await c.tick(400);
      expect([c.state(), c.count("rerun"), c.events("merge_ci_rerun").length]).toEqual([WAITING, 1, 1]);
      await c.tick(200 + RERUN_SETTLE_MS + 1);
      expect([c.state(), c.count("rerun")]).toEqual([BOUNCED, 1]);
      expect(c.events("merge_ci_rerun_stale")).toHaveLength(1);
    });
  });

  test("the rerun ends red → back to fix the way it always did, no second rerun", async () => {
    await withCard({}, async (c) => {
      await c.tick();
      c.finish("failure");
      await c.tick();
      await c.tick();
      expect([c.state(), c.count("rerun"), c.events("merge_ci_rerun").length]).toEqual([BOUNCED, 1, 1]);
      expect(c.events("merge_conflict")).toEqual([expect.objectContaining({ cause: "ci_fail", prHead: HEAD })]);
    });
  });

  test("the rerun ends green → the card is not bounced; the gate waits for the PR checks like any green", async () => {
    await withCard({}, async (c) => {
      await c.tick();
      c.finish("success");
      await c.tick();
      expect([c.state(), c.count("rerun"), c.events("merge_conflict")]).toEqual([WAITING, 1, []]);
      c.setSnap({ checks: [{ name: "ci", bucket: "pending", link: `${RUN}/job/9` }] });
      await c.tick();
      expect([c.state(), c.events("merge_conflict")]).toEqual([WAITING, []]);
    });
  });

  test("main changed the failing file: still red after the rerun → CIF2 merges main in, the same end as off", async () => {
    const end = async (ood: RecoveryMode) => {
      const c = card({ ood, behind: true });
      try {
        await c.tick();
        if (ood === "on") {
          expect([c.state(), c.count("rerun"), c.count("update")]).toEqual([WAITING, 1, 0]);
          c.finish("failure");
          await c.tick();
        }
        return { state: c.state(), reruns: c.count("rerun"), updates: c.count("update"), behind: c.events("merge_ci_behind").length,
          bounces: c.events("merge_conflict").length };
      } finally { c.close(); }
    };
    expect(await end("off")).toEqual({ state: UPDATING, reruns: 0, updates: 1, behind: 1, bounces: 0 });
    expect(await end("on")).toEqual({ state: UPDATING, reruns: 1, updates: 1, behind: 1, bounces: 0 });
  });

  test("this run already merged main in for a red CI (CIF2) → the new red bounces, no rerun", async () => {
    await withCard({}, async (c) => {
      insertEvent(c, "scheduler", "scheduler", { op: "merge_ci_behind", intentId: c.intent, prHead: "d".repeat(40) });
      await c.tick();
      expect([c.state(), c.count("rerun")]).toEqual([BOUNCED, 0]);
    });
  });
});

describe("[验收线 4] the switch: default on, off = CIF8 alone, observe records once", () => {
  const run = async (ood: RecoveryMode, kf: RecoveryMode = "off") => {
    const c = card({ ood, kf });
    try {
      await c.tick();
      return { state: c.state(), reruns: c.count("rerun"), attempts: c.count("attempt"), written: c.written(), run: getMergeRun(c.db, c.intent)! };
    } finally { c.close(); }
  };
  const plain = (rows: { kind: string; text: string; data: string }[]) => rows.map((e) => e.kind + e.text + e.data);

  test("off: no claim, no extra run read, the same bounce as observe without its one sample", async () => {
    const [off, observe] = [await run("off"), await run("observe")];
    expect([off.state, off.reruns, off.attempts]).toEqual([BOUNCED, 0, 1]);
    expect([observe.state, observe.reruns]).toEqual([BOUNCED, 0]);
    const samples = observe.written.filter((e) => JSON.parse(e.data).op === "recovery_observe");
    expect(samples).toHaveLength(1);
    expect(JSON.parse(samples[0]!.data)).toMatchObject({ mechanism: "ciOutOfDiffRerun", prHead: HEAD, run: RUN, files: [UNLISTED] });
    expect(plain(observe.written.filter((e) => JSON.parse(e.data).op !== "recovery_observe"))).toEqual(plain(off.written));
    expect({ ...observe.run, rev: 0, updatedAt: 0 }).toEqual({ ...off.run, rev: 0, updatedAt: 0 });
  });

  test("off with CIF8 observe on an unlisted file: written word for word as with the layer absent (CIF8 observe alone)", async () => {
    const off = await run("off", "observe");
    expect([off.state, off.reruns]).toEqual([BOUNCED, 0]);
    expect(off.written.some((e) => /recovery_observe|merge_ci_known_flaky_observe|merge_ci_rerun"/.test(e.data))).toBe(false);
  });

  test("no policy file: the new key is on by default, and the gate notes that once with the rollback command", async () => {
    await withCard({ ood: null }, async (c) => {
      expect(outOfDiffMode("p")).toBe("on");
      await c.tick();
      expect([c.state(), c.count("rerun")]).toEqual([WAITING, 1]);
      const notes = c.db.query("SELECT text FROM events WHERE kind='note' AND json_extract(data,'$.op')='recovery_default_on'").all() as { text: string }[];
      expect(notes).toEqual([{ text: expect.stringContaining("off --key ciOutOfDiffRerun") }]);
    });
  });

  test("the claim reads as CIF1's claim; to CIF2's layer it is not a rerun claim", () => {
    const base = rerunReceipt(HEAD, { link: RUN, checks: ["ci"], cases: [] });
    const claim = `${base}，范围外 ${JSON.stringify([UNLISTED])}`;
    expect(knownFlakyBase(claim)).toBe(base);
    expect(parseRerunReceipt(claim)).toBeNull();
    for (const bad of ["[]", '["src/x.ts"]', `["${UNLISTED}","${UNLISTED}"]`]) expect(knownFlakyBase(`${base}，范围外 ${bad}`)).toBe(`${base}，范围外 ${bad}`);
  });
});
