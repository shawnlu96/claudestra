/** PR full-check suites attached to main must not replace or duplicate evidence for main's own content. */
import { expect, test } from "bun:test";
import { fullRecheck, resetFullDispatches, type FullRequestPort } from "../src/lib/scheduler-ci-full-request.js";
import { useMainCiWorld, writePolicy, type MainCiWorld } from "./scheduler-main-ci-wiring-world.test.ts";

const world = useMainCiWorld();
function addSuite(w: MainCiWorld, title = "ci full cifull-" + "a".repeat(24)) {
  w.ci.extraMainRuns.push({ id: 2, name: "check", head_sha: w.hub.main, status: "completed", conclusion: "success",
    app: { slug: "github-actions" }, check_suite: { id: 202 } });
  const run: Record<string, unknown> = { id: 42, event: "workflow_dispatch", path: ".github/workflows/ci.yml", display_title: title,
    head_sha: w.hub.main, head_branch: "main", check_suite_id: 202, repository: { full_name: w.repo } };
  w.ci.workflowRuns.push(run);
  return run;
}

for (const mode of ["on", "observe"] as const) {
  test(`[验收线 3] ${mode}: full dispatch adds a distinct suite at main, but a green main still permits merging`, async () => {
    resetFullDispatches();
    const w = world();
    writePolicy({ mainCiPause: mode });
    const c = w.card("C"), subject = { repo: w.repo, pr: 1, head: c.head, base: w.hub.main, merge: w.newSha(), tree: w.newSha() };
    w.ci.extraPrChecks = [{ name: "ci scope related", bucket: "pass" }];
    let dispatched = 0, title = "";
    const port: FullRequestPort = {
      subject: async () => subject,
      runs: async () => dispatched ? [{ id: 42, title, status: "completed", conclusion: "success", createdAt: new Date().toISOString() }] : [],
      dispatch: async (_s, id) => {
        dispatched++; title = `ci full ${id}`;
        addSuite(w, title);
      },
    };
    w.ci.fullRecheck = (run, pr) => fullRecheck(run, pr, port, w.clock.now);
    const intent = await w.begin("C");
    await w.step(intent, "ready", "await_ci");
    const calls: string[] = [];
    for (let i = 0; i < 5; i++) calls.push(...await w.pass());
    expect(dispatched).toBe(1);
    expect(calls.filter((s) => s === "serial-merge:C")).toHaveLength(1);
    expect(w.frozen()).toBe(false);
    expect(w.taskEvents("C").filter((e) => e.data.op === "merge_unsent_cancel")).toEqual([]);
    expect(w.notices).toEqual([]);
    expect(w.db.query("SELECT 1 FROM events WHERE json_extract(data,'$.mechanism')='mainCiPause'").get()).toBeNull();
  });
}

test("[验收线 4] PM revoke after initial go: fullRecheck is not called, next pass cancels", async () => {
  const w = world();
  writePolicy({ mainCiPause: "on" });
  const c = w.card("C");
  w.ci.defaultCi = "failure";
  await w.ledger("agent-pm", ["main-ci-repair", "C", "--head", c.head, "--main", w.hub.main, "--reason", "修 main"]);
  const intent = await w.begin("C");
  await w.step(intent, "ready", "await_ci");
  let revoked = false, invoked = 0, dispatched = 0;
  w.ci.extraPrChecks = [{ name: "ci scope related", bucket: "pass" }];
  const subject = { repo: w.repo, pr: 1, head: c.head, base: w.hub.main, merge: w.newSha(), tree: w.newSha() };
  const port: FullRequestPort = { subject: async () => subject, runs: async () => [], dispatch: async () => { dispatched++; } };
  w.ci.fullRecheck = (run, pr) => { invoked++; return fullRecheck(run, pr, port, w.clock.now); };
  w.ci.onInspect = async () => {
    if (revoked) return;
    revoked = true;
    await w.ledger("agent-pm", ["main-ci-repair", "C", "--revoke", "--reason", "换人修"]);
  };
  await w.pass();
  expect(revoked).toBe(true);
  expect(invoked).toBe(0);
  expect(dispatched).toBe(0);
  expect(w.phase("C")).toBe("await_ci");
  await w.pass();
  expect(w.db.query("SELECT status FROM scheduler_intents WHERE id=?").get(intent)).toEqual({ status: "cancelled" });
  expect(w.frozen()).toBe(false);
});

for (const conclusion of ["success", "failure", "cancelled"]) {
  test(`[验收线 3] non-push ${conclusion} suite cannot affect green push health`, async () => {
    const w = world();
    writePolicy({ mainCiPause: "on" });
    w.card("C");
    addSuite(w); w.ci.extraMainRuns[0]!.conclusion = conclusion;
    await w.pass();
    expect(w.gate!.reads.get("p")!.health.state).toBe("green");
    expect(w.frozen()).toBe(false);
  });
}
for (const source of ["push", "missing-event", "missing-suite", "third-party", "contradictory"]) {
  test(`[验收线 3] ${source}: unknown or relevant duplicate evidence remains ambiguous`, async () => {
    const w = world();
    writePolicy({ mainCiPause: "on" });
    w.card("C");
    const run = addSuite(w);
    if (source === "push") run.event = "push";
    if (source === "missing-event") delete run.event;
    if (source === "missing-suite") delete run.check_suite_id;
    if (source === "third-party") w.ci.extraMainRuns[0]!.app = { slug: "other-app" };
    if (source === "contradictory") w.ci.workflowRuns.push({ ...run, event: "push" });
    await w.pass();
    const health = w.gate!.reads.get("p")!.health;
    expect(health.state).toBe("unknown");
    expect(health.reasons).toContainEqual({ code: "ambiguous_check", check: "check" });
    expect(w.managerLog.filter((a) => a[1] === "scheduler-merge-begin")).toEqual([]);
  });
}
test("[验收线 3] push failure is still red while a non-push suite is green", async () => {
  const w = world();
  writePolicy({ mainCiPause: "on" }); w.card("C");
  w.ci.defaultCi = "failure"; addSuite(w);
  await w.pass();
  expect(w.gate!.reads.get("p")!.health.state).toBe("red");
});
test("[验收线 5] Actions provenance read failure records readFailureSince and never green", async () => {
  const w = world();
  writePolicy({ mainCiPause: "on" }); w.card("C");
  w.ci.actionsFail = true;
  await w.pass();
  const read = w.gate!.reads.get("p")!;
  expect(read.health).toMatchObject({ state: "unknown", reasons: [{ code: "read_error", phase: "checks" }] });
  expect(read.state.readFailureSince).toBe(w.clock.now);
  expect(w.managerLog.filter((a) => a[1] === "scheduler-merge-begin")).toEqual([]);
});

test("[验收线 3] an isolated non-push check cannot stand in for missing main push evidence", async () => {
  const w = world();
  writePolicy({ mainCiPause: "on" }); w.card("C");
  w.ci.defaultCi = "missing"; addSuite(w);
  await w.pass();
  expect(w.gate!.reads.get("p")!.health.reasons).toContainEqual({ code: "missing_check", check: "check" });
});
