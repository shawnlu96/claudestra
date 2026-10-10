/**
 * dispatch-recovery-CIF8: a red CI whose failing test files are all on the valid known flaky list and outside the PR is re-run
 * once (on), only recorded (observe) or left alone (off); every other red bounces to fix as before. A fake gh, no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { addKnownFlaky, revokeKnownFlaky, setKnownFlakyModeSource } from "../src/lib/ci-known-flaky.js";
import { knownFlakyBase } from "../src/lib/ci-known-flaky-rerun.js";
import { bindNode } from "../src/lib/ledger-dag-write.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { parseRerunReceipt, rerunReceipt, type CiRerunGh } from "../src/lib/scheduler-merge-ci-rerun.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import { ledgerAs, mergedCard } from "./deploy-test-kit.js";

const HEAD = "c".repeat(40), RUN = "https://github.com/example/repo/actions/runs/77";
const FLAKY = "tests/scheduler-update-fail-remote-cancel.test.ts", OTHER = "tests/other.test.ts";
const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/p" } } });
const owner = { actor: "owner", now: 150 };
const BOUNCED = { run: "resolved", stage: "fix" }, WAITING = { run: "await_ci", stage: "merge" };

/** A red bun test step: one assertion failure per file. */
const logOf = (...files: string[]) => [
  ...files.flatMap((f) => [`##[group]${f}:`, "error: expect(received).toBe(expected)", "(fail) 竞态 > 断言 [0.40ms]", "##[endgroup]"]),
  " 1999 pass", ` ${files.length} fail`, "##[error]Process completed with exit code 1.",
].map((l) => `ci\tRun tests\t2026-10-10T11:02:03.1234567Z ${l}`).join("\n");

interface Over { mode?: RecoveryMode; log?: string | Error; files?: string[] | Error; rerun?: Error }
function card(over: Over = {}) {
  const c = mergedCard();
  c.db.query("UPDATE scheduler_merges SET phase='await_ci', mergeSha=NULL WHERE intentId=?").run(c.intent);
  setKnownFlakyModeSource(() => over.mode ?? "on");
  const featureId = createFeature(c.db, owner, { project: "p", slug: "rel", title: "rel" }).row.id;
  initDag(c.db, owner, { id: featureId, rev: 1, nodes: [{ key: "UPDFLAKY1", oneLine: "修时序竞态" }] });
  const add = (file = FLAKY) => addKnownFlaky(c.db, owner, { project: "p", file, featureId, node: "UPDFLAKY1", reason: "时序竞态" });
  /** The fixing node opens its card, which then reaches `stage`. */
  const fixer = (stage: string) => {
    createTask(c.db, owner, { project: "p", id: "rel-UPDFLAKY1", title: "fix", kind: "code" });
    bindNode(c.db, owner, { id: featureId, rev: getFeature(c.db, featureId)!.rev, key: "UPDFLAKY1", taskId: "rel-UPDFLAKY1" });
    c.db.query("UPDATE tasks SET stage=? WHERE id='rel-UPDFLAKY1'").run(stage);
  };
  const gh = { attempt: 1, status: "completed", conclusion: "failure", calls: [] as string[] };
  const ciRerun: CiRerunGh = {
    runAttempt: async () => ({ attempt: gh.attempt, status: gh.status, conclusion: gh.conclusion }),
    failedLog: async () => { gh.calls.push("log"); if (over.log instanceof Error) throw over.log; return over.log ?? logOf(FLAKY); },
    prFiles: async () => { gh.calls.push("files"); if (over.files instanceof Error) throw over.files; return over.files ?? ["src/lib/x.ts"]; },
    rerunFailed: async () => { gh.calls.push("rerun"); if (over.rerun) throw over.rerun; gh.attempt++; gh.status = "queued"; gh.conclusion = ""; },
  };
  const snap: PrSnapshot = { state: "OPEN", head: HEAD, branch: "feat/t9", base: "main", draft: false, crossRepository: false,
    mergeState: "UNSTABLE", mergeSha: null, checks: [{ name: "ci", bucket: "fail", link: `${RUN}/job/9` }] };
  const external = { inspect: async () => snap, freshness: async () => ({ behindBy: 0, mainHead: "e".repeat(40) }),
    carryReview: async () => ({ ok: false, reason: "不沿用" }), updateBranch: async () => {}, merge: async () => { throw new Error("不该合并"); },
    ciRerun } as MergeExternal;
  const tick = (now = 200) => schedulerMergeTick(c.db, config, ledgerAs(c.db, "scheduler", () => now), () => external);
  const state = () => ({ run: getMergeRun(c.db, c.intent)?.phase as string | undefined, stage: (c.db.query("SELECT stage FROM tasks WHERE id='T9'").get() as { stage: string }).stage });
  /** Everything written for the card, without the clock. */
  const written = () => (c.db.query("SELECT kind, text, data FROM events WHERE target='T9' ORDER BY seq").all() as { kind: string; text: string; data: string }[]);
  const events = (op: string) => written().map((e) => ({ text: e.text, ...JSON.parse(e.data) })).filter((e) => e.op === op);
  const reruns = () => gh.calls.filter((x) => x === "rerun").length;
  return { ...c, featureId, add, fixer, gh, tick, state, written, events, reruns };
}
const withCard = async (over: Over, body: (c: ReturnType<typeof card>) => Promise<void>) => {
  const c = card(over);
  try { await body(c); } finally { c.close(); }
};
afterEach(() => setKnownFlakyModeSource(null));

describe("CIF8 on: failures only in valid listed files outside the PR → one rerun through CIF1's claim", () => {
  test("re-runs once, does not bounce, the event names the entry and its fixing node; the same head red again → fix, no second rerun", async () => {
    await withCard({}, async (c) => {
      const { entry } = c.add();
      await c.tick();
      expect([c.state(), c.reruns()]).toEqual([WAITING, 1]);
      expect(c.events("merge_conflict")).toEqual([]);
      const [ev, ...more] = c.events("merge_ci_rerun");
      expect(more).toEqual([]);
      expect(ev).toMatchObject({ prHead: HEAD, run: RUN, checks: ["ci"], cases: [FLAKY],
        knownFlaky: [{ file: FLAKY, featureId: c.featureId, node: "UPDFLAKY1", entrySeq: entry.seq }] });
      expect(ev.text).toContain(`已知偶发测试（${FLAKY}（${c.featureId}/UPDFLAKY1））`);
      expect(ev.text).toContain(RUN);
      expect(ev.reason).toContain("已知偶发清单");
      // Still running: wait, never a second rerun.
      c.gh.status = "in_progress";
      await c.tick();
      expect([c.state(), c.reruns()]).toEqual([WAITING, 1]);
      // The rerun ended red on the same head.
      c.gh.status = "completed";
      c.gh.conclusion = "failure";
      await c.tick();
      expect([c.state(), c.reruns()]).toEqual([BOUNCED, 1]);
      expect(c.events("merge_ci_rerun")).toHaveLength(1);
      expect(c.events("merge_conflict")).toEqual([expect.objectContaining({ cause: "ci_fail" })]);
    });
  });

  test("several listed files are one rerun", async () => {
    await withCard({ log: logOf(FLAKY, OTHER) }, async (c) => {
      c.add();
      c.add(OTHER);
      await c.tick();
      expect([c.state(), c.reruns()]).toEqual([WAITING, 1]);
      expect(c.events("merge_ci_rerun")[0].knownFlaky.map((k: { file: string }) => k.file)).toEqual([FLAKY, OTHER]);
    });
  });

  test("the number of listed files is not capped: six valid ones are still one rerun", async () => {
    const six = [0, 1, 2, 3, 4, 5].map((i) => `tests/f${i}.test.ts`);
    await withCard({ log: logOf(...six) }, async (c) => {
      for (const f of six) c.add(f);
      await c.tick();
      expect([c.state(), c.reruns()]).toEqual([WAITING, 1]);
      expect(c.events("merge_conflict")).toEqual([]);
      const [ev, ...more] = c.events("merge_ci_rerun");
      expect(more).toEqual([]);
      expect(ev.cases).toEqual(six);
      expect(ev.knownFlaky.map((k: { file: string }) => k.file)).toEqual(six);
    });
  });

  test("the fixing node's card still in progress keeps the entry valid", async () => {
    await withCard({}, async (c) => {
      c.add();
      c.fixer("review");
      await c.tick();
      expect([c.state(), c.reruns()]).toEqual([WAITING, 1]);
    });
  });

  test("the rerun call fails after the claim → fix, and the head is spent", async () => {
    await withCard({ rerun: new Error("HTTP 403") }, async (c) => {
      c.add();
      await c.tick();
      expect(c.state()).toEqual(BOUNCED);
      expect(c.events("merge_conflict")).toHaveLength(1);
    });
  });
});

describe("CIF8 on: every doubt bounces to fix as it does today", () => {
  const bounced = async (over: Over, prepare: (c: ReturnType<typeof card>) => void) => withCard(over, async (c) => {
    prepare(c);
    await c.tick();
    expect([c.state(), c.reruns()]).toEqual([BOUNCED, 0]);
    expect([c.events("merge_ci_rerun"), c.events("merge_ci_known_flaky_observe")]).toEqual([[], []]);
    expect(c.events("merge_conflict")).toEqual([expect.objectContaining({ cause: "ci_fail", checks: [{ name: "ci", link: RUN }] })]);
  });

  test("nothing registered", () => bounced({}, () => {}));
  test("the fixing node is verified", () => bounced({}, (c) => { c.add(); c.fixer("verified"); }));
  test("the fixing node is done", () => bounced({}, (c) => { c.add(); c.fixer("done"); }));
  test("the fixing node was cancelled", () => bounced({}, (c) => { c.add(); c.fixer("cancelled"); }));
  test("the entry was revoked", () => bounced({}, (c) => {
    c.add();
    revokeKnownFlaky(c.db, owner, { project: "p", file: FLAKY, reason: "修好了" });
  }));
  test("this merge run already merged main in for a red CI (CIF2)", () => bounced({}, (c) => {
    c.add();
    c.db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (150,'scheduler','p','T9','scheduler','',?)")
      .run(JSON.stringify({ op: "merge_ci_behind", intentId: c.intent, prHead: "d".repeat(40) }));
  }));
  test("the failing file is in the PR's own changes", () => bounced({ files: ["src/lib/x.ts", FLAKY] }, (c) => { c.add(); }));
  test("a failure outside the list next to a listed one", () => bounced({ log: logOf(FLAKY, OTHER) }, (c) => { c.add(); }));
  test("the log cannot be fetched", () => bounced({ log: new Error("gh run view 失败") }, (c) => { c.add(); }));
  test("the log cannot be parsed", () => bounced({ log: "ci\tRun tests\tsomething else went wrong" }, (c) => { c.add(); }));
  test("the PR files cannot be read", () => bounced({ files: new Error("gh pr view 失败") }, (c) => { c.add(); }));
});

describe("CIF8 observe / off", () => {
  const run = async (mode: RecoveryMode, listed: boolean) => {
    const c = card({ mode });
    try {
      if (listed) c.add();
      await c.tick();
      return { state: c.state(), reruns: c.reruns(), written: c.written(), observed: c.events("merge_ci_known_flaky_observe"),
        run: getMergeRun(c.db, c.intent)!, featureId: c.featureId };
    } finally { c.close(); }
  };

  test("observe: bounced exactly like off, plus one event saying what on would do", async () => {
    const [off, observe] = [await run("off", true), await run("observe", true)];
    expect([off.state, off.reruns, off.observed]).toEqual([BOUNCED, 0, []]);
    expect([observe.state, observe.reruns]).toEqual([BOUNCED, 0]);
    expect(observe.observed).toHaveLength(1);
    expect(observe.observed[0].text).toContain(`on 时会按已知偶发重跑：${FLAKY}（${observe.featureId}/UPDFLAKY1）`);
    expect(observe.observed[0]).toMatchObject({ prHead: HEAD, run: RUN, files: [FLAKY] });
    // Without that one event, everything written for the card and the run itself are the same.
    const rest = observe.written.filter((e) => JSON.parse(e.data).op !== "merge_ci_known_flaky_observe");
    const plain = (rows: typeof rest) => rows.map((e) => e.kind + e.text + e.data.replaceAll(observe.featureId, off.featureId));
    expect(plain(rest)).toEqual(plain(off.written));
    expect({ ...observe.run, rev: 0, updatedAt: 0 }).toEqual({ ...off.run, rev: 0, updatedAt: 0 });
    expect(observe.run.rev).toBe(off.run.rev);
  });

  test("observe with no valid entry, and off with one, write nothing of their own", async () => {
    const [bare, off] = [await run("observe", false), await run("off", true)];
    expect([bare.state, bare.observed, bare.reruns]).toEqual([BOUNCED, [], 0]);
    expect(bare.written.map((e) => e.kind + e.text)).toEqual(off.written.map((e) => e.kind + e.text));
  });
});

describe("CIF8 claim receipt", () => {
  const base = rerunReceipt(HEAD, { link: RUN, checks: ["ci"], cases: [] });
  test("a known flaky claim reads as CIF1's claim; anything that is not exactly the suffix is left alone", () => {
    const claim = `${base}，已知偶发 ${JSON.stringify([FLAKY])}`;
    expect(knownFlakyBase(claim)).toBe(base);
    expect(parseRerunReceipt(knownFlakyBase(claim))).toEqual({ prHead: HEAD, link: RUN, checks: ["ci"], cases: [] });
    expect(parseRerunReceipt(claim)).toBeNull(); // to CIF2's layer it is not a rerun claim
    const timeouts = rerunReceipt(HEAD, { link: RUN, checks: ["ci"], cases: [`a.test.ts > x，已知偶发 [y`] });
    expect(knownFlakyBase(timeouts)).toBe(timeouts);
    const six = `${base}，已知偶发 ${JSON.stringify([0, 1, 2, 3, 4, 5].map((i) => `tests/f${i}.test.ts`))}`;
    expect(knownFlakyBase(six)).toBe(base);
    for (const bad of ["[]", '["../x.test.ts"]', '["src/x.ts"]', `["${FLAKY}","${FLAKY}"]`, "[1]"]) {
      expect(knownFlakyBase(`${base}，已知偶发 ${bad}`)).toBe(`${base}，已知偶发 ${bad}`);
      expect(parseRerunReceipt(`${base}，已知偶发 ${bad}`)).toBeNull();
    }
  });
});
