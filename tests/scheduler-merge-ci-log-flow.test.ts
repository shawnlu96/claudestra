import { afterEach, expect, spyOn, test } from "bun:test";
import { addKnownFlaky, setKnownFlakyModeSource } from "../src/lib/ci-known-flaky.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { recordObserved, type RecoveryMode } from "../src/lib/recovery-policy.js";
import type { BoundedResult, runBounded } from "../src/lib/run-bounded.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { ciBehindGh, ciBehindOrRerun } from "../src/lib/scheduler-merge-ci-behind.js";
import { bounceReceipt } from "../src/lib/scheduler-merge-conflict.js";
import { LOG_LIMIT, JOB_LOG_MAX, openCiLogPerJob, judgeCiLog, readPerJobLog } from "../src/lib/scheduler-merge-ci-log-read.js";
import { ciRerunGh, parseRerunReceipt } from "../src/lib/scheduler-merge-ci-rerun.js";
import { parseFailedLog } from "../src/lib/scheduler-merge-ci-rerun-log.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import { ciLogFixture, wholeLog, type FixtureJob } from "./scheduler-merge-ci-log-fixture.js";
import { ledgerAs, mergedCard } from "./deploy-test-kit.js";

const HEAD = "c".repeat(40), FIX = "e".repeat(40), BASE = "b".repeat(40);
const PR = "https://github.com/example/repo/pull/7", RUN = "https://github.com/example/repo/actions/runs/77";
const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/p" } } });
const snap: PrSnapshot = { state: "OPEN", head: HEAD, branch: "feat/t9", base: "main", draft: false, crossRepository: false,
  mergeState: "UNSTABLE", mergeSha: null, checks: [{ name: "ci", bucket: "fail", link: `${RUN}/job/9` }] };
const ok = (stdout: string, truncated = false): BoundedResult => ({ code: 0, stdout, stderr: "", timedOut: false, truncated });
interface Options { mode?: RecoveryMode; jobs?: readonly FixtureJob[]; json?: string; truncated?: boolean; main?: boolean; flaky?: boolean;
  small?: string; managerFail?: boolean }
function card(kind: "A" | "B" | "C", options: Options = {}) {
  const c = mergedCard(), jobs = options.jobs ?? ciLogFixture(kind);
  c.db.query("UPDATE scheduler_merges SET phase='await_ci', mergeSha=NULL WHERE intentId=?").run(c.intent);
  const argv: string[][] = [];
  let attempt = 1;
  const command: typeof runBounded = async (a, opts) => {
    argv.push(a);
    const cmd = a.slice(1).join(" ");
    if (cmd.includes("--json attempt,status,conclusion,headSha")) return ok(JSON.stringify({ attempt, status: "completed", conclusion: "failure", headSha: HEAD }));
    if (cmd.includes("--json jobs,attempt")) return ok(options.json ?? JSON.stringify({ attempt: 1, jobs: jobs.map((j) =>
      ({ databaseId: j.id, name: j.name, conclusion: "failure", steps: j.failedSteps.map((name) => ({ name, conclusion: "failure" })) })) }));
    if (a.includes("--job")) {
      expect(opts.maxBytes).toBe(JOB_LOG_MAX);
      return ok(jobs.find((j) => String(j.id) === a[a.indexOf("--job") + 1])!.log, options.truncated);
    }
    if (a.includes("--log-failed")) return ok(options.small ?? wholeLog(jobs).slice(0, 1024 * 1024));
    if (a.includes("--json") && a.includes("files")) return ok(JSON.stringify({ files: [{ path: "src/lib/unrelated.ts" }] }));
    if (cmd.startsWith("run rerun")) { attempt++; return ok(""); }
    if (cmd.includes("/compare/")) return ok(JSON.stringify({ base: BASE, commits: options.main ? [FIX] : [] }));
    if (cmd.includes("/commits")) return ok(JSON.stringify([FIX]));
    if (cmd.includes("/update-branch")) return ok("");
    throw new Error(`unexpected command ${cmd}`);
  };
  const ciRerun = ciRerunGh(command), external = { inspect: async () => snap,
    freshness: async () => ({ behindBy: 0, mainHead: FIX }), carryReview: async () => ({ ok: false, reason: "fixture" }),
    updateBranch: async () => {}, merge: async () => { throw new Error("not merged"); }, ciRerun, ciBehind: ciBehindGh(command) } as MergeExternal;
  if (options.flaky) {
    const ctx = { actor: "owner", now: 150 }, featureId = createFeature(c.db, ctx, { project: "p", slug: "flaky", title: "flaky" }).row.id;
    initDag(c.db, ctx, { id: featureId, rev: 1, nodes: [{ key: "FIX", oneLine: "repair" }] });
    addKnownFlaky(c.db, ctx, { project: "p", file: "tests/anonymous-failure.test.ts", featureId, node: "FIX", reason: "fixture" });
  }
  setKnownFlakyModeSource(() => "on");
  const open = () => openCiLogPerJob(c.db, () => ({ mode: options.mode ?? "on", manualAfterMs: null, source: "config" }),
    options.managerFail ? async () => ({ ok: false, error: "fixture write failed" }) : undefined);
  const tick = async () => { open(); await schedulerMergeTick(c.db, config, ledgerAs(c.db, "scheduler"), () => external); };
  const state = () => getMergeRun(c.db, c.intent)!;
  const notes = () => (c.db.query("SELECT text,data FROM events WHERE target='T9' AND json_extract(data,'$.mechanism')='ciLogPerJob' ORDER BY seq")
    .all() as { text: string; data: string }[]).map((r) => ({ text: r.text, ...JSON.parse(r.data) }));
  const reruns = () => argv.filter((a) => a[2] === "rerun");
  const updates = () => argv.filter((a) => a.join(" ").includes("/update-branch"));
  return { ...c, jobs, command, ciRerun, external, argv, open, tick, state, notes, reruns, updates };
}
afterEach(() => { openCiLogPerJob(null); setKnownFlakyModeSource(null); });

test("[验收线 5] incomplete job conclusions preserve the whole-log bounce instead of recovering a partial run", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const conclusion of ["timed_out", "cancelled", "action_required"]) {
      const jobs = ciLogFixture("C");
      jobs.push({ id: 10, name: "interrupted shard", failedSteps: [],
        log: "interrupted shard\tUnit tests\t##[error]Job did not complete" });
      expect(parseFailedLog(wholeLog(jobs))).toBeNull();
      const json = JSON.stringify({ attempt: 1, jobs: jobs.map((j) => ({ databaseId: j.id, name: j.name,
        conclusion: j.id === 10 ? conclusion : "failure", steps: j.failedSteps.map((name) => ({ name, conclusion: "failure" })) })) });
      let legacy: string | null = null;
      for (const mode of ["off", "on", "observe"] as const) await withCard("C", { jobs, json, mode }, async (c) => {
        await c.tick();
        expect(c.state().phase).toBe("resolved");
        expect(c.reruns()).toHaveLength(0);
        expect(c.updates()).toHaveLength(0);
        expect(c.argv.some((a) => a.includes("--job"))).toBe(false);
        if (mode === "off") legacy = c.state().reason;
        else expect(c.state().reason).toBe(legacy);
        if (mode === "observe") expect(c.notes().map((n) => n.wouldKind)).toEqual(["bounce", "bounce"]);
      });
      expect(errors.mock.calls.flat().join("\n")).toContain("读 CI 失败：失败日志太长，可能被截断");
    }
  } finally { errors.mockRestore(); }
});

async function withCard(kind: "A" | "B" | "C", options: Options, body: (c: ReturnType<typeof card>) => Promise<void>): Promise<void> {
  const c = card(kind, options);
  try { await body(c); } finally { c.close(); }
}

test("[验收线 2] on C reruns exactly once with the timed-out case", async () => {
  await withCard("C", {}, async (c) => {
    await c.tick();
    expect(c.reruns()).toEqual([["gh", "run", "rerun", "77", "--failed", "--repo", "example/repo"]]);
    expect(c.state().phase).toBe("await_ci");
    expect(parseRerunReceipt(c.state().reason!.replace(/^等 CI 重跑开始：/, ""))?.cases).toEqual(["tests/anonymous-failure.test.ts > anonymous failure 0"]);
  });
});
test("[验收线 2] on A skips the UNKNOWN STEP gate and hands assertions to CIF8; B keeps Guard red", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const kind of ["A", "B"] as const) await withCard(kind, {}, async (c) => {
      await c.tick();
      expect(c.state().phase).toBe("resolved");
      expect(c.reruns()).toHaveLength(0);
      expect(errors.mock.calls.flat().join("\n")).toContain(kind === "A" ? "有非超时失败：anonymous failure 0" : "失败日志解析不出 bun test 的失败用例");
    });
    await withCard("A", { flaky: true }, async (c) => {
      await c.tick();
      expect(c.reruns()).toHaveLength(1);
      expect(c.state().phase).toBe("await_ci");
    });
  } finally { errors.mockRestore(); }
});
test("[验收线 2] CIF2 updates main once and reuses each CIF1 job download", async () => {
  const jobs = ciLogFixture("B").filter((j) => j.id !== 1);
  await withCard("B", { jobs, main: true }, async (c) => {
    await c.tick();
    expect(c.state().phase).toBe("updating");
    expect(c.updates()).toHaveLength(1);
    expect(c.reruns()).toHaveLength(0);
    expect(c.argv.filter((a) => a.includes("--job"))).toHaveLength(jobs.length);
    expect(c.argv.filter((a) => a.includes("jobs,attempt"))).toHaveLength(1);
  });
});

test("[验收线 3] observe preserves both legacy bounces, notes each layer once and never claims reruns", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const [kind, options, would] of [
      ["A", {}, "flaky"], ["B", {}, "bounce"], ["C", {}, "rerun"], ["A", { flaky: true }, "flaky"],
      ["B", { jobs: ciLogFixture("B").filter((j) => j.id !== 1), main: true }, "flaky"],
    ] as const) await withCard(kind, { ...options, mode: "observe" }, async (c) => {
      await c.tick();
      expect(c.state().phase).toBe("resolved");
      expect(c.reruns()).toHaveLength(0);
      expect(c.updates()).toHaveLength(0);
      const notes = c.notes();
      expect(notes).toHaveLength(2);
      expect(notes[0]).toMatchObject({ actionKey: "cif1:77", wouldKind: would, runId: "77", attempt: 1 });
      if (kind === "C") expect(notes[0].cases).toEqual(["tests/anonymous-failure.test.ts > anonymous failure 0"]);
      if (options.main) expect(notes[1].wouldKind).toBe("behind");
      if (kind === "A") expect(notes[0].gateSkipped).toBe(true);
      expect(errors.mock.calls.flat().join("\n")).toContain("读 CI 失败：失败日志太长，可能被截断");
      expect(errors.mock.calls.flat().join("\n")).toContain("读 CI / main 失败：失败日志太长，可能被截断");
      expect(c.db.query("SELECT count(*) AS n FROM events WHERE json_extract(data,'$.op') IN ('merge_ci_rerun','merge_ci_behind','merge_ci_known_flaky_observe')").get()).toEqual({ n: 0 });
      // Ask the same two readers next pass without changing card state; durable observe dedup owns repetition.
      const run = c.state();
      c.open();
      await ciBehindOrRerun({ ...run, phase: "await_ci", reason: null }, snap, c.external, async () => run,
        [{ name: "ci", link: `${RUN}/job/9` }], bounceReceipt);
      expect(c.notes()).toHaveLength(2);
    });
  } finally { errors.mockRestore(); }
});
test("[验收线 3] an observation write failure still bounces", async () => {
  await withCard("C", { mode: "observe", managerFail: true }, async (c) => {
    await c.tick();
    expect(c.state().phase).toBe("resolved");
    expect(c.reruns()).toHaveLength(0);
    expect(c.notes()).toEqual([]);
  });
});
test("[验收线 4] off never lists or downloads failed jobs", async () => {
  await withCard("C", { mode: "off" }, async (c) => {
    await c.tick();
    expect(c.state().phase).toBe("resolved");
    expect(c.argv.some((a) => a.includes("--job") || a.includes("jobs,attempt"))).toBe(false);
    expect(c.notes()).toEqual([]);
  });
});
test("[验收线 5] invalid JSON, changed attempts, no failed jobs, full buffers and excessive kept output all bounce", async () => {
  const big = { id: 1, name: "large", failedSteps: ["Unit tests"], log: `error: ${"x".repeat(LOG_LIMIT)}` };
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const [options, why] of [
      [{ json: "bad" }, "JSON"], [{ json: '{"attempt":2,"jobs":[]}' }, "attempt 与读取时不一致"],
      [{ json: '{"attempt":1,"jobs":[]}' }, "失败 job 列表为空"], [{ truncated: true }, "失败 job shard 7 的日志超过 8 MiB"],
      [{ jobs: [big] }, "按 job 截取后仍超过 900 KiB"],
    ] as const) await withCard("C", options, async (c) => {
      errors.mockClear();
      await c.tick();
      expect(c.state().phase).toBe("resolved");
      expect(c.reruns()).toHaveLength(0);
      expect(c.updates()).toHaveLength(0);
      expect(errors.mock.calls.flat().join("\n")).toContain(why);
    });
  } finally { errors.mockRestore(); }
});
test("[验收线 5] UNKNOWN STEP gate with extra failed steps or no verdict is never skipped", async () => {
  for (const missingVerdict of [false, true]) {
    const jobs = ciLogFixture("A"), gate = jobs[1]!;
    if (missingVerdict) gate.log = gate.log.replace("##[error]分片没有全部成功：failure", "no verdict");
    else gate.failedSteps.push("other");
    await withCard("A", { jobs }, async (c) => {
      c.open();
      const read = await readPerJobLog(c.command, "example/repo", "77", 1);
      expect(read.gateSkipped).toBe(false);
      await c.tick();
      expect(c.state().phase).toBe("resolved");
      expect(c.reruns()).toHaveLength(0);
    });
  }
});
test("[验收线 6] small logs never enter per-job recovery in any mode", async () => {
  const small = "##[group]tests/x.test.ts:\n(fail) slow\n^ this test timed out after 5000ms.\n##[endgroup]\n 1 fail";
  for (const mode of ["off", "observe", "on"] as const) await withCard("C", { mode, small }, async (c) => {
    await c.tick();
    expect(c.reruns()).toHaveLength(1);
    expect(c.argv.some((a) => a.includes("--job") || a.includes("jobs,attempt"))).toBe(false);
    expect(c.notes()).toEqual([]);
  });
});
test("[验收线 3] lost pass lease propagates instead of bouncing", async () => {
  await withCard("C", { mode: "observe" }, async (c) => {
    openCiLogPerJob(c.db, () => ({ mode: "observe", source: "config", manualAfterMs: null }), async () => { throw new SchedulerStopped("lost"); },
      () => { throw new SchedulerStopped("lost"); });
    await expect(judgeCiLog(c.state(), "example/repo", "77", 1, c.ciRerun, "cif1", async () => "result",
      () => ({ wouldKind: "bounce", why: "fixture" }))).rejects.toBeInstanceOf(SchedulerStopped);
    await expect(ciBehindOrRerun(c.state(), snap, c.external, async () => c.state(),
      [{ name: "ci", link: `${RUN}/job/9` }], bounceReceipt)).rejects.toBeInstanceOf(SchedulerStopped);
  });
});
test("[验收线 3] guarded manager observation carries the same data and durable dedup", async () => {
  await withCard("C", { mode: "observe" }, async (c) => {
    const writes: string[][] = [];
    openCiLogPerJob(c.db, () => ({ mode: "observe", source: "config", manualAfterMs: null }), async (...args) => {
      writes.push(args);
      recordObserved(c.db, { project: "p", mechanism: "ciLogPerJob", target: args[2]!, actionKey: args[6]!, action: args[8]!,
        data: JSON.parse(args[10]!) }, Date.now());
      return { ok: true };
    });
    await expect(judgeCiLog(c.state(), "example/repo", "77", 1, c.ciRerun, "cif1", async () => "yes",
      () => ({ wouldKind: "rerun", why: "timeout", cases: ["x"] }))).rejects.toThrow("失败日志太长");
    expect(writes[0]?.slice(0, 4)).toEqual(["ledger", "scheduler-recovery-observe", "T9", "--mechanism"]);
    expect(c.notes()).toHaveLength(1);
  });
});
test("[验收线 8] a new pass clears downloads while on logs each run only once", async () => {
  const logs = spyOn(console, "log").mockImplementation(() => {});
  try {
    await withCard("C", {}, async (c) => {
      const ask = () => judgeCiLog(c.state(), "example/repo", "77", 1, c.ciRerun, "cif1", async () => "classified",
        () => ({ wouldKind: "rerun", why: "timeout" }));
      c.open();
      await ask(); await ask();
      expect(c.argv.filter((a) => a.includes("--job"))).toHaveLength(c.jobs.length);
      c.open();
      await ask();
      expect(c.argv.filter((a) => a.includes("--job"))).toHaveLength(c.jobs.length * 2);
      expect(logs.mock.calls).toHaveLength(1);
    });
  } finally { logs.mockRestore(); }
});
test("[验收线 6] a prior pass's expired ownership callback does not alter ordinary gh read-error bounces", async () => {
  await withCard("C", {}, async (c) => {
    c.ciRerun.failedLog = async () => { throw new Error("HTTP 404"); };
    openCiLogPerJob(c.db, () => ({ mode: "observe", source: "config", manualAfterMs: null }), undefined,
      () => { throw new SchedulerStopped("previous pass ended"); });
    await schedulerMergeTick(c.db, config, ledgerAs(c.db, "scheduler"), () => c.external);
    expect(c.state().phase).toBe("resolved");
    expect(c.reruns()).toHaveLength(0);
    expect(c.notes()).toHaveLength(0);
  });
});
