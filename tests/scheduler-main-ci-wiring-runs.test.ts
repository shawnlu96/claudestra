/**
 * MAINCIW2 through the real schedulerPass (tests/scheduler-main-ci-wiring-world.test.ts): under mainCiPause=on a main push run still
 * running no longer pauses claim / begin / trains / unsent runs; a confirmed failure still does; observe samples carry the run evidence.
 * Also the `scheduler-main-ci --op observe --evidence` exception (PM 补 10-14 15:53).
 */
import { describe, expect, test } from "bun:test";
import { useMainCiWorld, writePolicy, type MainCiWorld } from "./scheduler-main-ci-wiring-world.test.ts";

const world = useMainCiWorld();
const merges = (calls: string[]) => calls.filter((c) => /^(update|serial-merge|match-head):/.test(c));
const pauseMarkers = (w: MainCiWorld, id: string) => w.taskEvents(id).filter((e) => e.data.op === "merge_unsent_cancel");
const run = (w: MainCiWorld, o: { id?: number; attempt?: number; status: string; conclusion?: string | null; ageMin?: number }) =>
  ({ id: o.id ?? 5, run_attempt: o.attempt ?? 1, event: "push", head_sha: w.hub.main, status: o.status, conclusion: o.conclusion ?? null,
    created_at: new Date(w.clock.now - (o.ageMin ?? 3) * 60_000).toISOString(), check_suite_id: 50 });
const running = (w: MainCiWorld) => { w.ci.bySha.set(w.hub.main, "pending"); w.ci.workflowRuns = [run(w, { status: "in_progress" })]; };
const passes = async (w: MainCiWorld, n: number) => { const out: string[] = []; for (let i = 0; i < n; i++) out.push(...await w.pass()); return out; };
const samples = (w: MainCiWorld) => (w.db.query(`SELECT data FROM events WHERE kind='note' AND json_extract(data,'$.op')='recovery_observe'
  AND json_extract(data,'$.mechanism')='mainCiPause' ORDER BY seq`).all() as { data: string }[]).map((r) => JSON.parse(r.data) as Record<string, unknown>);

describe("[验收线 1] on: main CI still running does not pause", () => {
  test("queued / in_progress push run, required check pending: claim and begin go on, the card merges", async () => {
    const w = world();
    writePolicy({ mainCiPause: "on" });
    w.card("T1");
    running(w);
    const calls = await passes(w, 4);
    expect(merges(calls).length).toBeGreaterThan(0);
    expect(w.managerLog.some((a) => a[1] === "scheduler-merge-begin")).toBe(true);
    expect(pauseMarkers(w, "T1")).toEqual([]);
    expect(w.gate && w.notices).toEqual([]);
  });

  test("a begun ready run is not cancelled and a testing train is not voided", async () => {
    const w = world();
    writePolicy({ mainCiPause: "on" });
    w.card("T1"); w.card("T2");
    w.hub.pending = true;
    await w.pass();
    expect(w.store.load("p")?.phase).toBe("testing");
    running(w);
    await w.pass();
    expect(w.store.load("p")?.outcome).not.toBe("void");
    expect(w.events.some((e) => e.kind === "void")).toBe(false);
  });

  test("ready run of a single card: not cancelled main_ci_pause while main only runs", async () => {
    const w = world();
    writePolicy({ mainCiPause: "on" });
    w.card("T1");
    const intent = await w.begin("T1");
    running(w);
    await w.pass();
    expect(pauseMarkers(w, "T1")).toEqual([]);
    expect((w.db.query("SELECT status FROM scheduler_intents WHERE id=?").get(intent) as { status: string }).status).not.toBe("cancelled");
  });
});

describe("[验收线 2] on: a confirmed failure still pauses", () => {
  test("completed failure while the push run is still in progress: no begin, no merge, paused like before", async () => {
    const w = world();
    writePolicy({ mainCiPause: "on" });
    w.card("T1");
    w.ci.bySha.set(w.hub.main, "failure");
    w.ci.workflowRuns = [run(w, { status: "in_progress" })];
    const calls = await passes(w, 3);
    expect(merges(calls)).toEqual([]);
    expect(w.managerLog.filter((a) => a[1] === "scheduler-merge-begin")).toEqual([]);
    expect(w.frozen()).toBe(false);
  });

  test("run older than 60 minutes: main_ci_evidence_missing pauses (injected clock)", async () => {
    const w = world();
    writePolicy({ mainCiPause: "on" });
    w.card("T1");
    w.ci.bySha.set(w.hub.main, "pending");
    w.ci.workflowRuns = [run(w, { status: "in_progress", ageMin: 61 })];
    const calls = await passes(w, 3);
    expect(merges(calls)).toEqual([]);
    expect(w.managerLog.filter((a) => a[1] === "scheduler-merge-begin")).toEqual([]);
  });
});

describe("[验收线 4] observe samples keep the run evidence per attempt", () => {
  test("same SHA, attempt 1 then attempt 2 both red: two samples, each with its own run id / attempt; reason unchanged", async () => {
    const w = world();
    writePolicy({ mainCiPause: "observe" });
    w.card("T1");
    w.ci.bySha.set(w.hub.main, "failure");
    w.ci.workflowRuns = [run(w, { id: 9, attempt: 1, status: "completed", conclusion: "failure" })];
    w.hub.pending = true;
    await w.pass();
    w.ci.workflowRuns = [run(w, { id: 9, attempt: 2, status: "completed", conclusion: "failure" })];
    await w.pass();
    const s = samples(w);
    expect(s).toHaveLength(2);
    expect(s.map((x) => x.evidence)).toEqual([1, 2].map((attempt) => ({ rule: "run", newReason: "main_unhealthy",
      runs: [{ id: 9, attempt, status: "completed", conclusion: "failure" }] })));
    expect(s.every((x) => String(x.reason).startsWith("main_unhealthy："))).toBe(true);
    expect(s.map((x) => x.state)).toEqual(["red", "red"]);
  });

  test("observe while main only runs: the original pause sample, with what on would do (main_ci_pending)", async () => {
    const w = world();
    writePolicy({ mainCiPause: "observe" });
    w.card("T1");
    running(w);
    w.hub.pending = true;
    await w.pass();
    expect(samples(w).map((x) => [x.state, String(x.reason).split("：")[0], x.evidence])).toEqual([["unknown", "main_unhealthy",
      { rule: "run", newReason: "main_ci_pending", runs: [{ id: 5, attempt: 1, status: "in_progress", conclusion: null }] }]]);
  });
});

describe("scheduler-main-ci --op observe --evidence (PM 补 10-14 15:53 exception)", () => {
  const SHA = "d".repeat(40);
  const observe = (w: MainCiWorld, ...extra: string[]) =>
    w.ledger("scheduler", ["scheduler-main-ci", "p", "--op", "observe", "--sha", SHA, "--state", "unknown", "--reason", "main_unhealthy：x", ...extra]);
  const ev = (attempt: number) => JSON.stringify({ rule: "run", newReason: "main_ci_pending", runs: [{ id: 3, attempt, status: "queued", conclusion: null }] });

  test("without --evidence: output, data and actionKey as before", async () => {
    const w = world();
    expect(await observe(w)).toEqual({ ok: true, project: "p", recorded: true });
    expect(samples(w)).toEqual([{ mainSha: SHA, state: "unknown", reason: "main_unhealthy：x", op: "recovery_observe", mechanism: "mainCiPause",
      actionKey: `main-ci:${SHA}:unknown` }]);
    expect(await observe(w)).toEqual({ ok: true, project: "p", recorded: false });
  });

  test("invalid evidence is refused whole, nothing written", async () => {
    const w = world();
    for (const bad of ["{", JSON.stringify({ rule: "run", newReason: "main_ci_pending", runs: [{ id: -1, attempt: 1, status: "queued", conclusion: null }] })]) {
      expect(await observe(w, "--evidence", bad)).toMatchObject({ ok: false, code: "invalid" });
    }
    expect(samples(w)).toEqual([]);
  });

  test("same SHA, two attempts: one sample each, evidence stored structured", async () => {
    const w = world();
    expect(await observe(w, "--evidence", ev(1))).toMatchObject({ recorded: true });
    expect(await observe(w, "--evidence", ev(2))).toMatchObject({ recorded: true });
    expect(await observe(w, "--evidence", ev(2))).toMatchObject({ recorded: false });
    expect(samples(w).map((s) => [s.actionKey, s.reason, (s.evidence as { runs: { attempt: number }[] }).runs[0]!.attempt])).toEqual([
      [`main-ci:${SHA}:unknown:main_ci_pending:3@1`, "main_unhealthy：x", 1], [`main-ci:${SHA}:unknown:main_ci_pending:3@2`, "main_unhealthy：x", 2]]);
  });
});
