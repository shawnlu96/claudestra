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
import { bindCiSelectedSink, CI_SELECTED_OBSERVE, CI_SELECTED_REPAIR, ciSelectedPreflight, type CiSelectedSink, effectiveSelectedMode, REPAIR_NOTIFY_MS,
  selectedDecision, useCiSelectedPorts, withCiSelectedGate } from "../src/lib/scheduler-ci-selected-gate.js";
import { driveMerge, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";
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
  const notified: { key: string; at: number }[] = [];
  const sink: CiSelectedSink = {
    observe: async (a) => {
      if (!notes.some((n) => n.actionKey === a.actionKey && n.target === a.target)) notes.push(a); // the ledger's dedup key
      if (a.data?.notified === true) notified.push({ key: String(a.data.key), at: now });
    },
    notifiedSince: (_p, key, since) => notified.some((n) => n.key === key && n.at >= since),
    notify: async (_p, text) => { notices.push(text); },
  };
  const ports = useCiSelectedPorts({ port, policy, sink, now: () => now });
  return { calls, notes, notices, ports, w, tick(ms: number) { now += ms; } };
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
    expect(x.notes.map((n) => n.data?.kind)).toEqual([CI_SELECTED_REPAIR]);
    expect(x.notes[0]!.data).toMatchObject({ file: "tests/x.test.ts", name: "x > flaky", runUrl: RUN_URL, notified: true });
    expect(x.notices).toHaveLength(1);
    expect(x.notices[0]).toContain(RUN_URL);
    expect(x.notices[0]).toContain("tests/x.test.ts > x > flaky");
    // another card's release of the same flaky test within 24 hours: a new fact, no new notice
    x.tick(REPAIR_NOTIFY_MS - 1);
    await fixture({ ...base, taskId: "T2" }).drive();
    expect(x.notes).toHaveLength(2);
    expect(x.notes[1]!.data).toMatchObject({ notified: false });
    expect(x.notices).toHaveLength(1);
    // past 24 hours: told again
    x.tick(2);
    await fixture({ ...base, taskId: "T3" }).drive();
    expect(x.notices).toHaveLength(2);
    expect(x.notes.every((n) => n.mechanism === "ciSelectedGate")).toBe(true);
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
    expect(x.notes.map((n) => n.data?.kind)).toEqual([CI_SELECTED_REPAIR]);
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
