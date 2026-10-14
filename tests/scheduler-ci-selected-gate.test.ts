/**
 * merge-arch-CISEL2: the ledger side of the CI selected gate (src/lib/scheduler-ci-selected-gate.ts) — effective mode is the
 * stricter of the repository variable and the recovery key; a released green merges only under on; observe bounces through the
 * existing ci_fail and leaves one observation per run / attempt / head; on registers each out-of-scope failure for repair and tells
 * PM once per 24 hours; a green without a release marker is untouched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { CiSelectedPort, CiSelectedRun } from "../src/lib/ci-selected-receipt.js";
import type { ObservedAction, RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { fullRecheck, type FullRequestPort, fullRunTitle, fullRequestId, resetFullDispatches, CI_SCOPE_RELATED } from "../src/lib/scheduler-ci-full-request.js";
import { bindCiSelectedSink, CI_SELECTED_OBSERVE, CI_SELECTED_REPAIR, CI_SELECTED_REPAIR_NOTIFIED, ciSelectedPreflight, type CiSelectedSink, effectiveSelectedMode, REPAIR_NOTIFY_MS,
  pendingRepairsIn, selectedDecision, useCiSelectedPorts, withCiSelectedGate } from "../src/lib/scheduler-ci-selected-gate.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../src/lib/ledger-store.js";
import { driveMerge, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import { mainCiDrive } from "../src/lib/scheduler-main-ci-wiring-driver.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";

const H = "a".repeat(40), MERGE = "b".repeat(40), MAIN = "c".repeat(40), M = "e".repeat(40), TREE = "f".repeat(40);
const D = (c: string) => `sha256:${c.repeat(64)}`;
const GATE = "typecheck + test + guard";
const RUN_URL = "https://github.com/o/r/actions/runs/11";
const verdict = (over: Record<string, unknown> = {}) => JSON.stringify({ version: 1, kind: "ci-selected-verdict", mode: "on", runId: 11, attempt: 1,
  head: MERGE, responsibilityDigest: D("1"), outOfScope: [{ file: "tests/x.test.ts", name: "x > flaky" }], shards: { "1": D("2") }, ...over });
const base: MergeRun = { intentId: "i", taskId: "T1", project: "p", prRef: "https://github.com/o/r/pull/7", reviewedHead: H, expectedBranch: "task/T1",
  requiredChecks: GATE, phase: "await_ci", rev: 1, mergeSha: null, reason: null, createdAt: 1, updatedAt: 1 };
const green: PrSnapshot["checks"] = [{ name: GATE, bucket: "pass", link: `${RUN_URL}/job/1` }];
const pr = (p: Partial<PrSnapshot> = {}): PrSnapshot => ({ state: "OPEN", head: H, branch: "task/T1", base: "main", draft: false, crossRepository: false,
  mergeState: "CLEAN", mergeSha: null, checks: green, ...p });

interface World { variable?: string | null | Error; art?: { present: boolean; text: string | null }; key?: RecoveryMode; attempt?: number }
function world(w: World = {}) {
  const calls: string[] = [], notes: ObservedAction[] = [], notices: string[] = [];
  const run = (): CiSelectedRun => ({ id: 11, attempt: w.attempt ?? 1, headSha: H, event: "pull_request", status: "completed", conclusion: "success", url: RUN_URL });
  const port: CiSelectedPort = {
    prRun: async () => { calls.push("prRun"); return run(); },
    runById: async () => { calls.push("run"); return run(); },
    verdict: async () => { calls.push("verdict"); return w.art ?? { present: true, text: verdict() }; },
    commitParents: async (_r, sha) => (sha === MERGE ? [MAIN, H] : [MAIN]),
    variable: async () => { calls.push("variable"); if (w.variable instanceof Error) throw w.variable; return w.variable === undefined ? "on" : w.variable; },
  };
  const policy: RecoveryPolicyPort = () => ({ mode: w.key ?? "on", manualAfterMs: null, source: "config" });
  let now = 1_000_000;
  const at = new Map<ObservedAction, number>(), fail = { observe: 0, notify: 0 }, tries = { observe: 0, notify: 0 };
  const sink: CiSelectedSink = {
    observe: async (a) => {
      tries.observe++;
      if (fail.observe > 0) { fail.observe--; throw new Error("ledger busy"); }
      if (!notes.some((n) => n.actionKey === a.actionKey && n.target === a.target)) { notes.push(a); at.set(a, now); } // the ledger's dedup key
    },
    pendingRepairs: (_p, since) => notes.filter((e) => e.data?.kind === CI_SELECTED_REPAIR && at.get(e)! >= since
      && !notes.some((n) => n.data?.kind === CI_SELECTED_REPAIR_NOTIFIED && n.data.key === e.data!.key && at.get(n)! >= at.get(e)! - REPAIR_NOTIFY_MS))
      .map((e) => ({ target: e.target, key: String(e.data!.key), file: String(e.data!.file), name: String(e.data!.name), runId: Number(e.data!.runId),
        attempt: Number(e.data!.attempt), runUrl: String(e.data!.runUrl) })),
    notify: async (_p, text) => {
      tries.notify++;
      if (fail.notify > 0) { fail.notify--; throw new Error("bridge down"); }
      notices.push(text);
    },
  };
  const ports = useCiSelectedPorts({ port, policy, sink, now: () => now });
  return { calls, notes, notices, ports, w, fail, tries, tick(ms: number) { now += ms; } };
}

function fixture(initial: MergeRun = base, snapshot = pr()) {
  let row = { ...initial };
  const calls: string[] = [];
  const ops: MergeExternal = {
    inspect: async () => { calls.push("inspect"); return snapshot; },
    freshness: async () => ({ behindBy: 0, mainHead: MAIN }),
    carryReview: async () => ({ ok: false, reason: "不沿用" }),
    updateBranch: async () => { calls.push("update"); },
    merge: async () => { calls.push("merge"); snapshot = pr({ state: "MERGED", mergeSha: M }); return M; },
    ciSelected: true, // stands in for mergeExternal
  };
  const advance = async (from: MergeRun["phase"], to: MergeRun["phase"], rev: number, receipt?: string, mergeSha?: string) => {
    expect([from, rev]).toEqual([row.phase, row.rev]);
    calls.push(`journal:${to}`);
    row = { ...row, phase: to, rev: row.rev + 1, reason: receipt ?? null, mergeSha: mergeSha ?? row.mergeSha };
    return row;
  };
  return { get row() { return row; }, calls, ops, advance, drive: () => driveMerge(row, ops, advance, () => {}) };
}

let open: Disposable | null = null;
afterEach(() => { open?.[Symbol.dispose](); open = null; resetFullDispatches(); });
const use = (w: World = {}) => { const x = world(w); open = x.ports; return x; };

describe("[验收线 2] the effective mode is the stricter of the repository variable and the key", () => {
  test("off is stricter than observe, observe stricter than on; an unset or unknown variable reads observe", () => {
    expect(effectiveSelectedMode("on", "observe")).toBe("observe");
    expect(effectiveSelectedMode("observe", "on")).toBe("observe");
    expect(effectiveSelectedMode("on", "on")).toBe("on");
    expect(effectiveSelectedMode("off", "on")).toBe("off");
    expect(effectiveSelectedMode("on", "off")).toBe("off");
    expect(effectiveSelectedMode(null, "on")).toBe("observe");
    expect(effectiveSelectedMode("ON ", "on")).toBe("on");
    expect(effectiveSelectedMode("yes", "on")).toBe("observe");
  });

  test("variable on + key observe → observe; variable observe + key on → observe (driven end to end: no merge)", async () => {
    for (const w of [{ variable: "on", key: "observe" as const }, { variable: "observe", key: "on" as const }]) {
      const x = use(w), f = fixture();
      await f.drive();
      expect(f.calls).not.toContain("merge");
      expect(x.notes.map((n) => n.data?.kind)).toEqual([CI_SELECTED_OBSERVE]);
      open![Symbol.dispose](); open = null;
    }
  });

  test("an unreadable repository variable reads off: red, nothing recorded", async () => {
    const x = use({ variable: new Error("HTTP 500") }), f = fixture();
    await f.drive();
    expect(f.calls).not.toContain("merge");
    expect(x.notes).toEqual([]);
  });
});

describe("[验收线 1] a released green: observe bounces via ci_fail and observes once, on merges, off bounces silently", () => {
  test("observe: ci_fail bounce, one observation for the same run however often it is planned", async () => {
    const x = use({ key: "observe" });
    for (let i = 0; i < 3; i++) {
      const f = fixture();
      await f.drive();
      expect(f.calls).not.toContain("merge");
      expect(f.row.phase).toBe("resolved");
      expect(f.row.reason).toMatch(/^退回 fix（ci_fail）：PR head a{40}，失败检查/);
    }
    expect(x.notes).toHaveLength(1);
    const [n] = x.notes;
    expect(n).toMatchObject({ mechanism: "ciSelectedGate", target: "T1", actionKey: `observe.11.1.${H.slice(0, 12)}` });
    expect(n!.data).toMatchObject({ kind: CI_SELECTED_OBSERVE, head: H, runId: 11, attempt: 1, runUrl: RUN_URL, wouldAllow: true,
      outOfScope: [{ file: "tests/x.test.ts", name: "x > flaky" }] });
    expect(n!.action).toContain("放行合并");
  });

  test("a new attempt of the same run is another observation", async () => {
    const x = use({ key: "observe" });
    await fixture().drive();
    x.w.attempt = 2;
    x.w.art = { present: true, text: verdict({ attempt: 2 }) };
    await fixture().drive();
    expect(x.notes.map((n) => n.actionKey)).toEqual([`observe.11.1.${H.slice(0, 12)}`, `observe.11.2.${H.slice(0, 12)}`]);
  });

  test("on: merges as before (serial and mergeDirect)", async () => {
    use();
    const f = fixture();
    await f.drive();
    expect(f.row.phase).toBe("merged");
    const d = fixture({ ...base, phase: "ready" });
    d.ops.direct = () => true;
    await d.drive();
    expect(d.row.phase).toBe("merged");
  });

  test("off: bounces, records nothing", async () => {
    const x = use({ key: "off" }), f = fixture();
    await f.drive();
    expect(f.row.phase).toBe("resolved");
    expect(f.row.reason).toMatch(/ci_fail/);
    expect(x.notes).toEqual([]);
    expect(x.notices).toEqual([]);
  });
});

describe("[验收线 3] a release marker without a matching receipt never merges", () => {
  for (const [name, w] of [
    ["receipt missing", { art: { present: true, text: null } }],
    ["head does not match", { art: { present: true, text: verdict({ head: TREE }) } }],
    ["attempt not the latest", { art: { present: true, text: verdict({ attempt: 1 }) }, attempt: 2 }],
  ] as [string, World][]) {
    test(`${name}: red even under on, nothing registered`, async () => {
      const x = use(w), f = fixture();
      await f.drive();
      expect(f.calls).not.toContain("merge");
      expect(f.row.phase).toBe("resolved");
      expect(x.notes).toEqual([]);
    });
  }

  test("an unreadable GitHub waits this tick (no merge, no bounce)", async () => {
    open = useCiSelectedPorts({ port: { ...await portOf({}), prRun: async () => { throw new Error("HTTP 502"); } } });
    const f = fixture();
    await f.drive();
    expect(f.calls).not.toContain("merge");
    expect(f.row.phase).toBe("await_ci");
  });
});

describe("[验收线 4] on registers out-of-scope failures for repair, telling PM once per file + test per 24 hours", () => {
  test("one repair fact per failure per release; one notice per 24 hours; no known-flaky entry, no node", async () => {
    const x = use();
    await fixture().drive();
    await fixture().drive(); // the same run planned again: nothing new
    const facts = () => x.notes.filter((n) => n.data?.kind === CI_SELECTED_REPAIR);
    expect(x.notes.map((n) => n.data?.kind)).toEqual([CI_SELECTED_REPAIR, CI_SELECTED_REPAIR_NOTIFIED]);
    expect(x.notes[0]!.data).toMatchObject({ file: "tests/x.test.ts", name: "x > flaky", runUrl: RUN_URL });
    expect(x.notes[1]).toMatchObject({ target: "T1", actionKey: expect.stringMatching(/^notified\.[0-9a-f]{16}\.11\.1$/) });
    expect(x.notices).toHaveLength(1);
    expect(x.notices[0]).toContain(RUN_URL);
    expect(x.notices[0]).toContain("tests/x.test.ts > x > flaky");
    // another card's release of the same flaky test within 24 hours: a new fact, no new notice, and never re-sent later
    x.tick(REPAIR_NOTIFY_MS - 1);
    await fixture({ ...base, taskId: "T2" }).drive();
    expect(facts()).toHaveLength(2);
    expect(x.notices).toHaveLength(1);
    // past 24 hours: told again
    x.tick(2);
    await fixture({ ...base, taskId: "T3" }).drive();
    expect(x.notices).toHaveLength(2);
    expect(x.notices[1]).toContain("T3");
    expect(x.notices[1]).not.toContain("T2");
    expect(x.notes.every((n) => n.mechanism === "ciSelectedGate")).toBe(true);
  });

  /** One merge-tick inspect of card `taskId` through the gh-marked external (driveMerge inspects more than once per drive). */
  const inspect = (taskId = "T1") => withCiSelectedGate(fixture().ops, { ...base, taskId }).inspect(base.prRef);

  test("a failed fact write is not deduplicated: the next inspect of the same release writes it and tells PM", async () => {
    const x = use();
    x.fail.observe = 1;
    expect((await inspect()).checks).toEqual(green); // a failed write never changes the answer
    expect(x.notes).toEqual([]);
    expect(x.notices).toEqual([]);
    await inspect(); // the same release seen again
    expect(x.notes.map((n) => n.data?.kind)).toEqual([CI_SELECTED_REPAIR, CI_SELECTED_REPAIR_NOTIFIED]);
    expect(x.notices).toHaveLength(1);
    await inspect();
    expect(x.tries.observe).toBe(3);
  });

  test("a failed notice is not marked notified: it stays pending and the next release sends it, then once only", async () => {
    const x = use();
    x.fail.notify = 1;
    await inspect();
    expect(x.tries.notify).toBe(1);
    expect(x.notices).toEqual([]);
    expect(x.notes.map((n) => n.data?.kind)).toEqual([CI_SELECTED_REPAIR]);
    // another card's release of the same test within 24 hours does not count as told: the notice goes out
    await inspect("T2");
    expect(x.notices).toHaveLength(1);
    expect(x.notices[0]).toContain("T1、T2");
    expect(x.notes.filter((n) => n.data?.kind === CI_SELECTED_REPAIR_NOTIFIED).map((n) => n.target)).toEqual(["T1", "T2"]);
    await inspect("T3");
    expect(x.notices).toHaveLength(1);
  });

  test("a merge tick re-sends a pending notice with no new release (at most every 10 minutes; plain greens unchanged)", async () => {
    const x = use();
    x.fail.notify = 1;
    await inspect();
    expect(x.notices).toEqual([]);
    x.w.art = { present: false, text: null }; // later cards are plain greens
    expect((await inspect("T5")).checks).toEqual(green);
    expect(x.notices).toEqual([]); // within the throttle window
    x.tick(10 * 60_000);
    expect((await inspect("T6")).checks).toEqual(green);
    expect(x.notices).toHaveLength(1);
    expect(x.notices[0]).toContain("tests/x.test.ts > x > flaky");
    x.tick(10 * 60_000);
    await inspect("T7");
    expect(x.notices).toHaveLength(1);
    const plain = fixture({ ...base, taskId: "T8" });
    await plain.drive();
    expect(plain.row.phase).toBe("merged");
  });
});

describe("[验收线 4] the bound sink's pending query on a real ledger", () => {
  test("a fact is pending until a notified record for its key lands within 24 hours of it; window and project respected", () => {
    const db = openLedger(join(mkdtempSync(join(tmpdir(), "cisel2-pending-")), "ledger.sqlite"));
    /** the row recordObserved appends (raw: no cards needed for a query test) */
    const note = (target: string, kind: string, key: string, run: number, at: number, project = "p") => db.query(
      "INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, 'scheduler', ?, ?, 'note', 'x', ?)").run(at, project, target, JSON.stringify(
      { kind, key, file: `tests/${key}.test.ts`, name: key, runId: run, attempt: 1, runUrl: `u${run}`, op: "recovery_observe", mechanism: "ciSelectedGate", actionKey: `${kind}.${run}` }));
    const day = REPAIR_NOTIFY_MS, t0 = 10 * day;
    note("T1", CI_SELECTED_REPAIR, "k1", 1, t0);
    note("T9", CI_SELECTED_REPAIR, "k1", 9, t0, "other");
    expect(pendingRepairsIn(db, "p", t0 - day).map((r) => [r.target, r.key, r.runUrl])).toEqual([["T1", "k1", "u1"]]);
    note("T1", CI_SELECTED_REPAIR_NOTIFIED, "k1", 1, t0 + 5);
    expect(pendingRepairsIn(db, "p", t0 - day)).toEqual([]);
    note("T2", CI_SELECTED_REPAIR, "k1", 2, t0 + day - 1); // told within the 24 hours before it: covered
    note("T3", CI_SELECTED_REPAIR, "k2", 3, t0 + day - 1);
    expect(pendingRepairsIn(db, "p", t0).map((r) => r.target)).toEqual(["T3"]);
    note("T4", CI_SELECTED_REPAIR, "k1", 4, t0 + day + 10); // the last notice is more than 24 hours older: pending again
    expect(pendingRepairsIn(db, "p", t0 + 1).map((r) => r.target)).toEqual(["T3", "T4"]);
    expect(pendingRepairsIn(db, "p", t0 + day + 5).map((r) => r.target)).toEqual(["T4"]); // older facts drop out of the window
  });
});

describe("[验收线 5] no release marker: merge gate behaves exactly as before", () => {
  test("plain green merges, plain red bounces, with or without the gate", async () => {
    const x = use({ art: { present: false, text: null } });
    const f = fixture();
    await f.drive();
    expect(f.row.phase).toBe("merged");
    const r = fixture(base, pr({ checks: [{ name: GATE, bucket: "fail", link: `${RUN_URL}/job/1` }] }));
    await r.drive();
    expect(r.row.phase).toBe("resolved");
    expect(x.calls.filter((c) => c === "variable")).toEqual([]); // a red snapshot is never read; no marker never asks the variable
    expect(x.notes).toEqual([]);
  });

  test("without a port (a test process with nothing injected) the external is the very same object", () => {
    const ops = fixture().ops;
    expect(withCiSelectedGate(ops, base)).toBe(ops);
  });

  test("an injected external (not the gh-backed mergeExternal) is never read, even with a port", async () => {
    const x = use();
    const f = fixture();
    delete f.ops.ciSelected;
    expect(withCiSelectedGate(f.ops, base)).toBe(f.ops);
    await f.drive();
    expect(f.row.phase).toBe("merged");
    expect(x.calls).toEqual([]);
  });

  test("the gh-backed mergeExternal carries the mark through every wrapper it is assembled with", () => {
    const e = mergeExternal({ repoDir: "/nonexistent", requiredChecks: [GATE] } as unknown as Parameters<typeof mergeExternal>[0]);
    expect(e.ciSelected).toBe(true);
  });

  test("selectedDecision: plain without a marker", () => {
    expect(selectedDecision({ marked: false, receipt: null }, "on")).toEqual({ kind: "plain" });
  });
});

describe("ci-full re-check: a released full run counts only under on", () => {
  const subject = { repo: "o/r", pr: 7, head: H, base: MAIN, merge: MERGE, tree: TREE };
  const fullPort = (): FullRequestPort => ({
    subject: async () => subject,
    runs: async () => [{ id: 11, title: fullRunTitle(fullRequestId(subject)), status: "completed", conclusion: "success", createdAt: new Date(0).toISOString() }],
    dispatch: async () => {},
  });
  const prRelated = pr({ checks: [...green, { name: CI_SCOPE_RELATED, bucket: "pass" }] });
  test("on passes; observe / off fail as run_failed; observe records once", async () => {
    const x = use();
    expect(await fullRecheck(base, prRelated, fullPort())).toBeNull();
    open![Symbol.dispose]();
    const y = use({ key: "observe" });
    expect(await fullRecheck(base, prRelated, fullPort())).toMatch(/run_failed.*run 11 CI 按责任选集放行/);
    expect(await fullRecheck(base, prRelated, fullPort())).toMatch(/run_failed/);
    expect(y.notes).toHaveLength(1);
    open![Symbol.dispose]();
    use({ key: "off" });
    expect(await fullRecheck(base, prRelated, fullPort())).toMatch(/run_failed/);
    expect(x.notes.map((n) => n.data?.kind)).toEqual([CI_SELECTED_REPAIR, CI_SELECTED_REPAIR_NOTIFIED]);
  });
});

describe("PM preflight reads the same port and mode", () => {
  test("no marker adds nothing; on accepts with a line; observe / missing receipt refuse", async () => {
    const policy = (mode: RecoveryMode): RecoveryPolicyPort => () => ({ mode, manualAfterMs: null, source: "config" });
    const input = { repo: "o/r", head: H, project: "p" };
    expect(await ciSelectedPreflight(input, await portOf({ art: { present: false, text: null } }), policy("on"))).toEqual({ ok: true, line: null });
    expect(await ciSelectedPreflight(input, await portOf({}), policy("on"))).toMatchObject({ ok: true, line: expect.stringContaining(RUN_URL) });
    expect(await ciSelectedPreflight(input, await portOf({}), policy("observe"))).toMatchObject({ ok: false, reason: expect.stringContaining("有效档 observe") });
    expect(await ciSelectedPreflight(input, await portOf({ art: { present: true, text: null } }), policy("on"))).toMatchObject({ ok: false });
  });
});

/** A bare port for the preflight (it takes the port as an argument). */
async function portOf(w: World): Promise<CiSelectedPort> {
  return {
    prRun: async () => ({ id: 11, attempt: 1, headSha: H, event: "pull_request", status: "completed", conclusion: "success", url: RUN_URL }),
    runById: async () => { throw new Error("unused"); },
    verdict: async () => w.art ?? { present: true, text: verdict() },
    commitParents: async (_r, sha) => (sha === MERGE ? [MAIN, H] : [MAIN]),
    variable: async () => "on",
  };
}

describe("write sink binding (scheduler-service.ts mergeTick)", () => {
  test("bound: the observation and the repair go out through the leased manager; unbound: nothing written, nothing thrown", async () => {
    const args: string[][] = [];
    const manager = async (...a: string[]) => { args.push(a); return { ok: true }; };
    open = useCiSelectedPorts({ port: await portOf({}), policy: () => ({ mode: "observe", manualAfterMs: null, source: "config" }) });
    {
      using _sink = bindCiSelectedSink(manager, () => {});
      await fixture().drive();
    }
    expect(args).toHaveLength(1);
    expect(args[0]!.slice(0, 7)).toEqual(["ledger", "scheduler-recovery-observe", "T1", "--mechanism", "ciSelectedGate", "--action-key", `observe.11.1.${H.slice(0, 12)}`]);
    expect(JSON.parse(args[0]![args[0]!.length - 1]!)).toMatchObject({ kind: CI_SELECTED_OBSERVE, runId: 11 });
    // the tick ended: the sink is gone, a later drive only logs
    const later = fixture({ ...base, taskId: "T9" });
    await later.drive();
    expect(later.row.phase).toBe("resolved");
    expect(args).toHaveLength(1);
  });

  test("a lost lease while writing still stops the pass", async () => {
    open = useCiSelectedPorts({ port: await portOf({}), policy: () => ({ mode: "observe", manualAfterMs: null, source: "config" }) });
    using _sink = bindCiSelectedSink(async () => ({ ok: true }), () => { throw new SchedulerStopped("lease lost"); });
    const f = fixture();
    await expect(driveMerge(f.row, f.ops, f.advance, () => {})).rejects.toThrow(/lease lost/);
  });
});

describe("[验收线 1] production wiring: the scheduler's own mergeExternal (no injected external) runs the receipt check", () => {
  const policyCfg = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: [GATE], repoDir: "/tmp/project" } } }).projects.p!;
  /** gh faked at the command boundary only: repo view, pr view, pr checks, compare, the merge API. */
  function ghWorld() {
    const calls: string[][] = [];
    let merged = false;
    const ok = (v: unknown) => ({ code: 0, stdout: JSON.stringify(v), stderr: "", timedOut: false });
    const command = (async (argv: string[]) => {
      calls.push(argv);
      if (argv[1] === "repo") return ok({ nameWithOwner: "o/r" });
      if (argv[1] === "pr" && argv[2] === "view") return ok({ state: merged ? "MERGED" : "OPEN", headRefOid: H, headRefName: "task/T1", baseRefName: "main",
        isDraft: false, isCrossRepository: false, mergeStateStatus: "CLEAN", mergeCommit: merged ? { oid: M } : null });
      if (argv[1] === "pr" && argv[2] === "checks") return ok(green);
      if (argv[1] === "api" && argv.includes("-X")) { merged = true; return ok({ merged: true, sha: M }); }
      if (argv[1] === "api" && String(argv[2]).includes("/compare/")) return ok({ behind: 0, main: MAIN });
      throw new Error(`unexpected ${argv.join(" ")}`);
    }) as unknown as Parameters<typeof mergeExternal>[1];
    return { calls, command, sent: () => calls.some((a) => a.includes("-X")) };
  }
  const drive = async (ext: MergeExternal) => {
    let row = { ...base };
    const advance = async (_f: MergeRun["phase"], to: MergeRun["phase"], _r: number, receipt?: string, mergeSha?: string) =>
      (row = { ...row, phase: to, rev: row.rev + 1, reason: receipt ?? null, mergeSha: mergeSha ?? row.mergeSha });
    await mainCiDrive(row, ext, advance, () => {});
    return row;
  };

  test("observe: the marked mergeExternal reads the receipt, bounces via ci_fail, never sends the merge", async () => {
    const x = use({ key: "observe" }), g = ghWorld();
    const row = await drive(mergeExternal(policyCfg, g.command));
    expect(x.calls).toContain("verdict");
    expect(row.phase).toBe("resolved");
    expect(row.reason).toMatch(/ci_fail/);
    expect(g.sent()).toBe(false);
    expect(x.notes.map((n) => n.data?.kind)).toEqual([CI_SELECTED_OBSERVE]);
  });

  test("on: the same wiring merges", async () => {
    const x = use(), g = ghWorld();
    const row = await drive(mergeExternal(policyCfg, g.command));
    expect(x.calls).toContain("verdict");
    expect(row.phase).toBe("merged");
    expect(g.sent()).toBe(true);
  });

  test("the same external without the mark (an injected one) is not read: it merges as before", async () => {
    const x = use({ key: "observe" }), g = ghWorld();
    const { ciSelected: _mark, ...unmarked } = mergeExternal(policyCfg, g.command);
    const row = await drive(unmarked);
    expect(x.calls).toEqual([]);
    expect(row.phase).toBe("merged");
  });
});
