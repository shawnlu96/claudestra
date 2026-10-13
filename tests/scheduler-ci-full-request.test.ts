/**
 * merge-arch-SELECT1: the serial / manual merge full re-check (src/lib/scheduler-ci-full-request.ts) — when it is needed, the
 * dedupe of dispatches, bounded waits and classified failures, the gh port's argv, and the driver's await_ci call site.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CI_SCOPE_FULL, CI_SCOPE_RELATED, decideFull, DISPATCH_VISIBLE_MS, FULL_WAIT_MS, fullRecheck, type FullRequestPort, fullRequestId, fullRunTitle,
  type FullRunFact, type FullSubject, fullBoundMerge, ghFullRequestPort, needsFullRecheck, resetFullDispatches, withCiFullRequest,
} from "../src/lib/scheduler-ci-full-request.js";
import { driveMerge, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";

const H = "a".repeat(40), H2 = "c".repeat(40), MAIN = "d".repeat(40), MERGE = "e".repeat(40), TREE = "f".repeat(40), MERGED = "b".repeat(40);
const run0: MergeRun = { intentId: "i", taskId: "T1", project: "p", prRef: "https://github.com/o/r/pull/7", reviewedHead: H, expectedBranch: "task/T1",
  requiredChecks: "typecheck + test + guard", phase: "await_ci", rev: 1, mergeSha: null, reason: null, createdAt: 1, updatedAt: 1 };
const gate = { name: "typecheck + test + guard", bucket: "pass" as const };
const related: PrSnapshot["checks"] = [gate, { name: CI_SCOPE_RELATED, bucket: "pass" }];
const fullScope: PrSnapshot["checks"] = [gate, { name: CI_SCOPE_FULL, bucket: "pass" }];
const pr = (p: Partial<PrSnapshot> = {}): PrSnapshot => ({ state: "OPEN", head: H, branch: "task/T1", base: "main", draft: false, crossRepository: false,
  mergeState: "CLEAN", mergeSha: null, checks: related, ...p });
const subj = (head = H, base = MAIN): FullSubject => ({ repo: "o/r", pr: 7, head, base, merge: MERGE, tree: TREE });
const fact = (id: string, over: Partial<FullRunFact> = {}): FullRunFact =>
  ({ id: 1, title: fullRunTitle(id), status: "in_progress", conclusion: null, createdAt: new Date(1_000).toISOString(), ...over });

function fakePort(subject: () => FullSubject | "wait" = () => subj()) {
  const calls: string[] = [], runs: FullRunFact[] = [];
  const port: FullRequestPort = {
    subject: async () => { calls.push("subject"); return subject(); },
    runs: async () => { calls.push("runs"); return runs; },
    dispatch: async (_s, id) => { calls.push(`dispatch:${id}`); },
  };
  return { port, calls, runs };
}
beforeEach(() => resetFullDispatches());

describe("[验收线 3] related green never merges alone; the serial full re-check is bound, deduped and bounded", () => {
  test("a passed `ci scope full` lets the PR's own green stand; related, an empty or pending scope needs the re-check; no scope check = pre-SELECT1 full run", () => {
    expect(needsFullRecheck(fullScope)).toBe(false);
    expect(needsFullRecheck(related)).toBe(true);
    expect(needsFullRecheck([gate, { name: "ci scope ", bucket: "skipping" }])).toBe(true);
    expect(needsFullRecheck([gate])).toBe(false);
    expect(needsFullRecheck([gate, { name: CI_SCOPE_FULL, bucket: "pending" }])).toBe(true);
  });

  test("the request id binds repo, PR, head, base, merge commit and tree; any drift is another request", () => {
    const id = fullRequestId(subj());
    expect(id).toMatch(/^cifull-[0-9a-f]{24}$/);
    expect(fullRequestId({ ...subj(), repo: "O/R" })).toBe(id);
    for (const over of [{ head: H2 }, { base: H2 }, { merge: H2 }, { tree: H2 }, { pr: 8 }]) expect(fullRequestId({ ...subj(), ...over })).not.toBe(id);
  });

  test("decideFull: dispatch once, wait for the run, pass on success, classify every failure", () => {
    const id = "cifull-x";
    expect(decideFull({ id, runs: [], now: 0 })).toEqual({ kind: "dispatch", id });
    expect(decideFull({ id, runs: [], dispatchedAt: 0, now: DISPATCH_VISIBLE_MS })).toMatchObject({ kind: "wait" });
    expect(decideFull({ id, runs: [], dispatchedAt: 0, now: DISPATCH_VISIBLE_MS + 1 })).toMatchObject({ kind: "fail", cls: "dispatch_lost" });
    expect(decideFull({ id, runs: [fact("other")], now: 0 })).toEqual({ kind: "dispatch", id });
    expect(decideFull({ id, runs: [fact(id)], dispatchedAt: 0, now: FULL_WAIT_MS })).toMatchObject({ kind: "wait" });
    expect(decideFull({ id, runs: [fact(id)], dispatchedAt: 0, now: FULL_WAIT_MS + 1 })).toMatchObject({ kind: "fail", cls: "timeout" });
    expect(decideFull({ id, runs: [fact(id)], now: 1_000 + FULL_WAIT_MS + 1 })).toMatchObject({ kind: "fail", cls: "timeout" }); // restart: run's own age
    expect(decideFull({ id, runs: [fact(id, { status: "completed", conclusion: "success" })], now: 0 })).toEqual({ kind: "pass", runId: 1 });
    expect(decideFull({ id, runs: [fact(id, { status: "completed", conclusion: "failure" })], now: 0 })).toMatchObject({ kind: "fail", cls: "run_failed" });
    const older = fact(id, { id: 1, status: "completed", conclusion: "failure", createdAt: new Date(1).toISOString() });
    expect(decideFull({ id, runs: [older, fact(id, { id: 2, status: "completed", conclusion: "success", createdAt: new Date(2).toISOString() })], now: 0 }))
      .toEqual({ kind: "pass", runId: 2 });
  });

  test("a related PR: the first tick dispatches, repeated ticks never dispatch again, success lets the merge go on", async () => {
    const f = fakePort(), id = fullRequestId(subj());
    expect(await fullRecheck(run0, pr(), f.port, 0)).toBe("wait");
    expect(await fullRecheck(run0, pr(), f.port, 1_000)).toBe("wait");
    expect(await fullRecheck(run0, pr(), f.port, 2_000)).toBe("wait");
    expect(f.calls.filter((c) => c.startsWith("dispatch"))).toEqual([`dispatch:${id}`]);
    f.runs.push(fact(id));
    expect(await fullRecheck(run0, pr(), f.port, 3_000)).toBe("wait");
    f.runs[0] = fact(id, { status: "completed", conclusion: "success" });
    expect(await fullRecheck(run0, pr(), f.port, 4_000)).toBeNull();
    expect(f.calls.filter((c) => c.startsWith("dispatch"))).toHaveLength(1);
  });

  test("a moved base is a new request (one more dispatch); a head the driver has not caught up with only waits", async () => {
    let s = subj();
    const f = fakePort(() => s);
    await fullRecheck(run0, pr(), f.port, 0);
    s = subj(H, H2);
    await fullRecheck(run0, pr(), f.port, 1);
    expect(f.calls.filter((c) => c.startsWith("dispatch"))).toEqual([`dispatch:${fullRequestId(subj())}`, `dispatch:${fullRequestId(subj(H, H2))}`]);
    s = subj(H2);
    expect(await fullRecheck(run0, pr(), f.port, 2)).toBe("wait");
    expect(await fullRecheck(run0, pr({ head: H2 }), fakePort().port, 3)).toBe("wait");
    expect(f.calls.filter((c) => c.startsWith("dispatch"))).toHaveLength(2);
  });

  test("failures carry their class and the PM owner; a failed dispatch call is not re-sent by the next tick", async () => {
    const f = fakePort(), id = fullRequestId(subj());
    f.runs.push(fact(id, { status: "completed", conclusion: "cancelled" }));
    expect(await fullRecheck(run0, pr(), f.port, 0)).toMatch(/^串行 full 补验失败（run_failed，责任人 PM）/);
    const g = fakePort();
    g.port.dispatch = async () => { throw new Error("HTTP 403"); };
    expect(await fullRecheck(run0, pr(), g.port, 0)).toMatch(/dispatch_failed.*HTTP 403/);
    expect(await fullRecheck(run0, pr(), g.port, 1)).toBe("wait");
    expect(await fullRecheck(run0, pr(), g.port, DISPATCH_VISIBLE_MS + 2)).toMatch(/dispatch_lost/);
    expect(await fullRecheck(run0, pr(), fakePort(() => ({ ...subj(), tree: "nope" })).port, 0)).toMatch(/subject_invalid/);
  });

  test("main moving while the runs were read: the pass does not count, the next tick requests the new base", async () => {
    let s = subj();
    const f = fakePort(() => s), id = fullRequestId(subj());
    f.runs.push(fact(id, { status: "completed", conclusion: "success" }));
    f.port.runs = async () => { f.calls.push("runs"); s = subj(H, H2); return f.runs; };
    expect(await fullRecheck(run0, pr(), f.port, 0)).toBe("wait");
    expect(await fullRecheck(run0, pr(), f.port, 1)).toBe("wait");
    expect(f.calls.filter((c) => c.startsWith("dispatch"))).toEqual([`dispatch:${fullRequestId(subj(H, H2))}`]);
  });

  test("the merge call re-reads the passed binding right before sending; drift throws and nothing is sent", async () => {
    let s = subj();
    const f = fakePort(() => s), sent: string[] = [];
    f.runs.push(fact(fullRequestId(subj()), { status: "completed", conclusion: "success" }));
    const send = async () => { sent.push("merge"); return MERGED; };
    expect(await fullRecheck(run0, pr(), f.port, 0)).toBeNull();
    s = subj(H, H2);
    await expect(fullBoundMerge(run0.prRef, H, f.port, send)).rejects.toThrow(/binding_drift.*合并未发出/);
    expect(sent).toEqual([]);
    s = subj();
    expect(await fullRecheck(run0, pr(), f.port, 1)).toBeNull();
    expect(await fullBoundMerge(run0.prRef, H, f.port, send)).toBe(MERGED);
    expect(await fullBoundMerge(run0.prRef, H, fakePort(() => "wait").port, send)).toBe(MERGED); // no pass on record: not a re-checked merge
    expect(sent).toEqual(["merge", "merge"]);
  });

  test("an expired pass is refused, never downgraded to a plain merge: nothing is sent even against a moved base", async () => {
    let s = subj();
    const f = fakePort(() => s), sent: string[] = [];
    f.runs.push(fact(fullRequestId(subj()), { status: "completed", conclusion: "success" }));
    const send = async () => { sent.push("merge"); return MERGED; };
    const late = Date.now() + 6 * 60_000; // pass.at is stamped by the real clock a few ms after this, so a +1ms margin races it
    expect(await fullRecheck(run0, pr(), f.port, 0)).toBeNull();
    s = subj(H, H2);
    await expect(fullBoundMerge(run0.prRef, H, f.port, send, late)).rejects.toThrow(/pass_expired.*合并未发出/);
    s = subj();
    expect(await fullRecheck(run0, pr(), f.port, 1)).toBeNull();
    await expect(fullBoundMerge(run0.prRef, H, f.port, send, late)).rejects.toThrow(/pass_expired/); // same base, still stale
    expect(sent).toEqual([]);
    expect(await fullRecheck(run0, pr(), f.port, 2)).toBeNull();
    expect(await fullBoundMerge(run0.prRef, H, f.port, send)).toBe(MERGED); // a fresh pass of the same binding merges
    expect(sent).toEqual(["merge"]);
  });

  test("a test merge GitHub never computes is bounded from the first tick that needed the re-check, then goes to PM", async () => {
    const w = fakePort(() => "wait");
    expect(await fullRecheck(run0, pr(), w.port, 0)).toBe("wait");
    expect(await fullRecheck(run0, pr(), w.port, FULL_WAIT_MS)).toBe("wait");
    expect(await fullRecheck(run0, pr(), w.port, FULL_WAIT_MS + 1)).toMatch(/^串行 full 补验失败（subject_timeout，责任人 PM）/);
    expect(await fullRecheck(run0, pr(), w.port, FULL_WAIT_MS * 100)).toBe("wait"); // a fresh clock after PM got it
  });

  test("a full-scope PR and GitHub still computing the test merge never touch the run list", async () => {
    const f = fakePort();
    expect(await fullRecheck(run0, pr({ checks: fullScope }), f.port, 0)).toBeNull();
    expect(f.calls).toEqual([]);
    const w = fakePort(() => "wait");
    expect(await fullRecheck(run0, pr(), w.port, 0)).toBe("wait");
    expect(w.calls).toEqual(["subject"]);
  });
});

describe("[验收线 3] the gh port: protected argv, exact binding", () => {
  function gh(answers: Record<string, string>) {
    const argv: string[][] = [];
    const fn = async (...a: string[]) => { argv.push(a); const k = Object.keys(answers).find((x) => a.join(" ").includes(x)); return k ? answers[k]! : ""; };
    return { fn, argv };
  }
  const ok = { "pulls/7": JSON.stringify({ head: H, merge: MERGE }), [`commits/${MERGE}`]: JSON.stringify({ tree: TREE, parents: [MAIN, H] }), "commits/main": MAIN };

  test("subject: the test merge must sit on the current main tip and the reviewed head", async () => {
    expect(await ghFullRequestPort(gh(ok).fn).subject(run0.prRef, H)).toEqual(subj());
    expect(await ghFullRequestPort(gh({ ...ok, "commits/main": H2 }).fn).subject(run0.prRef, H)).toBe("wait");
    expect(await ghFullRequestPort(gh({ ...ok, "pulls/7": JSON.stringify({ head: H, merge: null }) }).fn).subject(run0.prRef, H)).toBe("wait");
    expect(await ghFullRequestPort(gh(ok).fn).subject(run0.prRef, H2)).toBe("wait");
  });

  test("dispatch is the same workflow on main with the bound inputs; runs list only workflow_dispatch runs of ci.yml", async () => {
    const g = gh({ "run list": JSON.stringify([{ databaseId: 5, displayTitle: "ci full x", status: "completed", conclusion: "success", createdAt: "t" }]) });
    const port = ghFullRequestPort(g.fn), id = fullRequestId(subj());
    await port.dispatch(subj(), id);
    expect(g.argv[0]).toEqual(["workflow", "run", "ci.yml", "-R", "o/r", "--ref", "main", "-f", `request_id=${id}`, "-f", "pr=7", "-f", `head=${H}`,
      "-f", `base=${MAIN}`, "-f", `merge=${MERGE}`, "-f", `tree=${TREE}`]);
    expect(await port.runs("o/r")).toEqual([{ id: 5, title: "ci full x", status: "completed", conclusion: "success", createdAt: "t" }]);
    expect(g.argv[1]).toEqual(expect.arrayContaining(["--workflow", "ci.yml", "--event", "workflow_dispatch"]));
  });

  test("the workflow names its dispatch run and its scope check exactly as this module reads them", () => {
    const ci = Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8")) as
      { "run-name": string; on: { workflow_dispatch: { inputs: Record<string, unknown> } }; jobs: { scope: { name: string } } };
    expect(ci["run-name"]).toStartWith("${{ inputs.request_id && format('ci full {0}', inputs.request_id) ||");
    expect(fullRunTitle("cifull-1")).toBe("ci full cifull-1");
    expect(Object.keys(ci.on.workflow_dispatch.inputs)).toEqual(["request_id", "pr", "head", "base", "merge", "tree"]);
    expect(ci.jobs.scope.name).toBe("ci scope ${{ needs.plan.outputs.scope }}");
    expect([CI_SCOPE_FULL, CI_SCOPE_RELATED]).toEqual(["ci scope full", "ci scope related"]);
  });
});

describe("[验收线 4] the serial driver's await_ci asks the re-check right before the merge claim, and only there", () => {
  function fixture(full: MergeExternal["fullRecheck"], snap = pr()) {
    let row: MergeRun = { ...run0 };
    const calls: string[] = [];
    const ops: MergeExternal = {
      inspect: async () => snap, freshness: async () => ({ behindBy: 0, mainHead: MAIN }), carryReview: async () => ({ ok: false, reason: "x" }),
      updateBranch: async () => { calls.push("update"); },
      merge: async () => { calls.push("merge"); snap = pr({ state: "MERGED", mergeSha: MERGED }); return MERGED; },
      ...(full ? { fullRecheck: async (r, p) => { calls.push("full"); return full(r, p); } } : {}),
    };
    const advance = async (_f: MergeRun["phase"], to: MergeRun["phase"], _r: number, receipt?: string) => {
      calls.push(`journal:${to}`);
      row = { ...row, phase: to, rev: row.rev + 1, reason: receipt ?? null };
      return row;
    };
    return { get row() { return row; }, calls, ops, advance };
  }

  test("wait keeps await_ci with no merge; pass merges; a classified failure goes to PM as unknown", async () => {
    const w = fixture(async () => "wait");
    await driveMerge(w.row, w.ops, w.advance);
    expect(w.row.phase).toBe("await_ci");
    expect(w.calls).toEqual(["full"]);
    const p = fixture(async () => null);
    await driveMerge(p.row, p.ops, p.advance);
    expect(p.row.phase).toBe("merged");
    expect(p.calls.indexOf("full")).toBeLessThan(p.calls.indexOf("journal:merging"));
    const f = fixture(async () => "串行 full 补验失败（timeout，责任人 PM）：x");
    await driveMerge(f.row, f.ops, f.advance);
    expect(f.row).toMatchObject({ phase: "unknown", reason: "串行 full 补验失败（timeout，责任人 PM）：x" });
    expect(f.calls).not.toContain("merge");
  });

  test("real driveMerge: main moving between the pass and the merge call never merges the untested base", async () => {
    let s = subj(), reads = 0;
    const f = fakePort(() => (++reads > 2 ? (s = subj(H, H2)) : s));
    f.runs.push(fact(fullRequestId(subj()), { status: "completed", conclusion: "success" }));
    const x = fixture(async (r, p) => fullRecheck(r, p, f.port, 0));
    const merge = x.ops.merge;
    x.ops.merge = (p, h) => fullBoundMerge(p, h, f.port, () => merge(p, h));
    await driveMerge(x.row, x.ops, x.advance);
    expect(x.row.phase).toBe("unknown");
    expect(x.row.reason).toMatch(/binding_drift/);
    expect(x.calls).not.toContain("merge");
  });

  test("a train-cleared member skips it (the train ran full); an external without the hook merges as before", async () => {
    const t = fixture(async () => "wait");
    t.ops.train = async () => "cleared";
    await driveMerge(t.row, t.ops, t.advance);
    expect(t.row.phase).toBe("merged");
    expect(t.calls).not.toContain("full");
    const plain = fixture(undefined);
    await driveMerge(plain.row, plain.ops, plain.advance);
    expect(plain.row.phase).toBe("merged");
  });

  test("a red or pending gate never reaches the re-check", async () => {
    const r = fixture(async () => null, pr({ checks: [{ ...gate, bucket: "pending" }], mergeState: "UNSTABLE" }));
    await driveMerge(r.row, r.ops, r.advance);
    expect(r.calls).not.toContain("full");
  });

  test("withCiFullRequest only adds the hook on the same external object; the live factory wraps every serial / manual merge", () => {
    const merge = async () => MERGED;
    const ext = { inspect: async () => pr(), merge } as unknown as MergeExternal;
    expect(withCiFullRequest(ext, async () => "")).toBe(ext);
    expect(typeof ext.fullRecheck).toBe("function");
    expect(ext.merge).not.toBe(merge); // the merge call goes through fullBoundMerge
    const src = readFileSync(join(import.meta.dir, "..", "src", "lib", "scheduler-merge-external.ts"), "utf8");
    expect(src).toContain("return withMainCi(withCiFullRequest(withSchedulerV2Merge(withMergeTrain({");
  });

  test("the module imports only src/lib and system modules", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "lib", "scheduler-ci-full-request.ts"), "utf8");
    for (const m of src.matchAll(/^import [^;]*? from "([^"]+)";/gm)) expect(m[1]!).toMatch(/^(node:[\w/]+|\.\/[\w-]+\.js)$/);
  });
});
