/** Production reader + manager write path, exercised through pass/auto-tick with isolated, inert external ports. */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OWNER_PRINCIPAL_ID } from "../src/lib/devices.js";
import { answerAsk, openAsk } from "../src/lib/ledger-asks.js";
import { getEventByDedup, getTask, listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { addDep } from "../src/lib/ledger-deps-write.js";
import { createTask, moveStage, recordVerify } from "../src/lib/ledger-write.js";
import { manualResumeReason, manualResumeVerdict } from "../src/lib/manual-resume.js";
import { recoveryArgs, recoveryFence } from "../src/lib/scheduler-recovery-ports.js";
import { roundCapText } from "../src/lib/review-converge-notice.js";
import { appendEvent } from "../src/lib/ledger-write.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { informKey, setModelOutcomeReader, snapshotKey } from "../src/lib/scheduler-model-wiring.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { STATE_DIR } from "../src/lib/paths.js";
import { testChildEnv } from "./test-env.js";
import { H1 } from "./scheduler-auto-helpers.js";
import { readonlyFixture, type ReadonlyFixture } from "./scheduler-readonly-fixture.js";

const CYBER = "This request has been flagged for possible cybersecurity risk";
if (!process.env.SCHRO1_CHILD) {
  test("isolated scheduler production integration suite", async () => {
    const root = mkdtempSync(join(tmpdir(), "schro1-prod-"));
    for (const dir of ["home", "state", "runtime", "tmp"]) mkdirSync(join(root, dir));
    try {
      const r = await runBounded([process.execPath, "--no-env-file", "test", import.meta.path], { timeoutMs: 300_000,
        env: testChildEnv({ SCHRO1_CHILD: "1", HOME: join(root, "home"), CLAUDESTRA_STATE_DIR: join(root, "state"),
          CLAUDESTRA_RUNTIME_DIR: join(root, "runtime"), TMPDIR: join(root, "tmp"), CODEX_HOME: join(root, "home", "codex") }) });
      expect(r.timedOut).toBe(false);
      if (r.code !== 0) throw new Error(`isolated suite exit=${r.code}\n${r.stdout}\n${r.stderr}`);
      expect(r.stderr).toMatch(/0 fail/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 310_000);
} else {
let f: ReadonlyFixture;
const restores: (() => void)[] = [];
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); setModelOutcomeReader(); f?.close(); });
const events = (op?: string) => listEvents(f.db(), { project: "p", target: "T1" }).filter((e) => !op || e.data.op === op);
const reviews = () => f.prepare.intents().filter((i) => i.action === "review");
const policy = (modelOutcome: string, mainCarry = "on") => writeFileSync(join(f.root, "recovery-policy.json"),
  JSON.stringify({ projects: { p: { keys: { modelOutcome, mainCarry } } } }));

async function reviewReady(mode = "on", head = H1) {
  f = await readonlyFixture({ stateDir: STATE_DIR });
  policy(mode);
  // The genuine CFG function reads the same private file as the manager children, without rebinding global STATE_DIR.
  const read = join(f.root, "policy-reader.ts");
  writeFileSync(read, `import { recoveryPolicy as read } from ${JSON.stringify(resolve("src/lib/recovery-policy.ts"))};\n` +
    `export const recoveryPolicy = (p, k) => read(p, k, ${JSON.stringify(join(f.root, "recovery-policy.json"))});\n`);
  setModelOutcomeReader(read);
  const step = async () => { const r = await f.pass(); expect(r).toEqual({ ran: true, failed: [] }); };
  await step(); await step();
  expect(await f.prepare.cli("agent-task-one", "stage", "T1", "--from", "spec", "--to", "restate", "--text", "scope")).toMatchObject({ ok: true });
  expect(await f.prepare.cli("pm", "restate-approve", "T1")).toMatchObject({ ok: true });
  await step(); await step();
  expect(await f.prepare.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", head)).toMatchObject({ ok: true });
  await step();
  return step;
}

function approve() {
  const at = Date.now(), ask = openAsk(f.prepare.db, { project: "p", source: "reply", kind: "decide", title: "Refusal rule", askKey: "policy-refusal-rule" }, at - 1);
  answerAsk(f.prepare.db, ask.id, { choices: ["[button:policy_refusal_rule_go]"], labels: ["approved"], text: "", principal: OWNER_PRINCIPAL_ID,
    owner: true, via: "web_card", at, final: true });
}

function refuse() {
  const worker = f.deps.worker;
  f.deps.worker = (ref) => {
    const w = worker(ref);
    return "manual" in w ? w : { ...w, observe: async () => ({ state: "result", outcome: "failed", failure: { kind: "error", message: CYBER } }) };
  };
}

test("pass freezes review before dispatch; refusal outcome, epoch and inform use real CLI exactly once and dedupe", async () => {
  const step = await reviewReady();
  await step();
  const review = reviews().at(-1)!;
  const snap = getEventByDedup(f.db(), snapshotKey(review.id));
  expect(snap).toMatchObject({ actor: "scheduler", data: { op: "review_material_snapshot", intentId: review.id } });
  const snapshotCall = f.calls.find((c) => c.args[1] === "scheduler-review-snapshot")!;
  expect(snapshotCall.args.slice(2, 5)).toEqual([review.id, "--round", "1"]);
  expect(JSON.parse(snapshotCall.args[6]).order).toContain("T1");
  expect(f.prepare.sent.at(-1)?.text).toContain("T1");
  approve(); refuse();
  const r = await f.tick();
  expect(r.failed).toEqual([]);
  expect(r.cards[0]).toMatchObject({ step: "refusal_epoch" });
  expect(events("reviewer_swap")).toHaveLength(1);
  expect(events("model_refusal_retry").length + events("model_refusal_exempt").length).toBe(1);
  expect(getEventByDedup(f.db(), informKey("T1", "cyber_policy"))).toMatchObject({ actor: "scheduler", data: { op: "refusal_owner_inform" } });
  expect(getSchedulerSession(f.db(), "T1", "reviewer")).toMatchObject({ state: "retired", sessionId: "s-rv" });
  const selected = f.calls.filter((c) => ["scheduler-review-snapshot", "scheduler-model-outcome", "scheduler-refusal-epoch", "scheduler-model-inform"].includes(c.args[1]));
  expect(selected.map((c) => c.args[1])).toEqual(["scheduler-review-snapshot", "scheduler-model-outcome", "scheduler-refusal-epoch", "scheduler-model-inform"]);
  expect(selected.every((c) => c.code === 0 && c.result.ok === true && !c.stderr)).toBe(true);
  const outcome = selected[1].args;
  expect(outcome[2]).toBe(review.id);
  expect(JSON.parse(outcome[4])).toMatchObject({ review: { sessionId: "s-rv" }, failed: { agent: "agent-rv-t1", family: "codex" } });
  const epoch = events("reviewer_swap")[0];
  expect(selected[2].args.slice(2, 5)).toEqual(["T1", "--plan-seq", String((epoch.data.refusal as { planSeq: number }).planSeq)]);
  await f.withMaintenance(() => f.manager(...selected[3].args));
  expect(events("refusal_owner_inform")).toHaveLength(1);
  expect(f.calls.at(-1)?.result).toMatchObject({ ok: true, duplicate: true });
  expect(f.diagnostics.every((line) => line.trim() === "[memory-auto] project repository unavailable; using declared scope")).toBe(true);
}, 60_000);

test("fault injection: a real direct reader write makes pass validation red; restoring manager makes it green", async () => {
  await reviewReady();
  const manager = f.deps.manager, before = events(), task = getTask(f.db(), "T1");
  f.deps.manager = async (...args) => {
    if (args[1] === "scheduler-review-snapshot") appendEvent(f.db(), { actor: "scheduler" }, { project: "p", target: "T1", kind: "note", text: "injected" });
    return manager(...args);
  };
  const errors: string[] = [], log = spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
  restores.push(() => log.mockRestore());
  await f.pass();
  expect(errors.join("\n")).toMatch(/readonly/);
  expect(events("review_material_snapshot")).toEqual([]);
  expect(events().some((e) => e.text === "injected")).toBe(false);
  expect(getTask(f.db(), "T1")).toEqual(task);
  expect(events().length).toBeGreaterThanOrEqual(before.length); // The formal unavailable diagnostic is still journalled.
  expect(getWorkflow(f.db(), "T1")?.mode).toBe("auto");
  expect(() => expect(events("review_material_snapshot")).toHaveLength(1)).toThrow();
  f.deps.manager = manager;
  // The failed snapshot cannot retroactively authorize the already-sent ticket; restore the port on a fresh run.
  f.close();
  await reviewReady();
  const green = await f.pass();
  expect(green.failed).toEqual([]);
  expect(events("review_material_snapshot")).toHaveLength(1);
}, 60_000);

for (const mode of ["observe", "off"] as const) test(`${mode}: refusal never opens an epoch or expands authority`, async () => {
  const step = await reviewReady(mode); await step(); approve(); refuse();
  const r = await f.tick();
  expect(r.failed).toEqual([]);
  expect(r.cards[0]).toMatchObject({ step: "manual" });
  expect(events("reviewer_swap")).toEqual([]);
  expect(f.calls.filter((c) => c.args[1] === "scheduler-refusal-epoch")).toEqual([]);
  const observed = events().filter((e) => e.data.mode === "observe" && String(e.data.op).startsWith("model_"));
  expect(observed).toHaveLength(mode === "observe" ? 1 : 0);
}, 60_000);

test("snapshot input drift is rejected in the CLI writer, reported, and cannot authorize refusal epoch", async () => {
  await reviewReady();
  f.beforeChild((args) => { if (args[1] === "scheduler-review-snapshot") f.prepare.db.query("UPDATE tasks SET headSHA=?, rev=rev+1 WHERE id='T1'").run("2".repeat(40)); });
  const errors: string[] = [], log = spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
  restores.push(() => log.mockRestore());
  await f.pass();
  expect(f.calls.find((c) => c.args[1] === "scheduler-review-snapshot")?.result).toMatchObject({ ok: false });
  expect(events("review_material_snapshot")).toEqual([]);
  expect(events("reviewer_swap")).toEqual([]);
  expect(errors.join("\n") + f.diagnostics.join("\n")).toMatch(/变|head|快照/);
}, 60_000);

test("pass stops on actual child lease refusal, without sending an order or swallowing diagnostics", async () => {
  f = await readonlyFixture({ stateDir: STATE_DIR });
  f.childEnv({ CLAUDESTRA_SCHEDULER_LEASE: "" });
  await expect(f.pass()).rejects.toBeInstanceOf(SchedulerStopped);
  expect(f.prepare.sent).toEqual([]);
  expect(f.calls.at(-1)?.result).toMatchObject({ ok: false, code: "lease-lost" });
  expect(f.diagnostics.join("\n")).toMatch(/租约/);
});

test("real CLI permission failure is reported by pass and commits no plan, session or order", async () => {
  f = await readonlyFixture({ stateDir: STATE_DIR });
  const before = events(), task = getTask(f.db(), "T1");
  f.childEnv({ CLAUDESTRA_SCHEDULER_SERVICE: undefined, CLAUDESTRA_SCHEDULER_LEASE: undefined, DISCORD_CHANNEL_ID: "unknown-channel" });
  const r = await f.pass();
  expect(r.ran).toBe(true);
  expect(r.failed).toEqual([]); // The existing planner represents a rejected write as a replan, not a pass exception.
  expect((await f.tick()).cards[0]).toMatchObject({ step: "replan", detail: expect.stringContaining("计划没写进台账") });
  expect(f.calls.every((c) => c.result.ok === false)).toBe(true);
  expect(f.diagnostics.join("\n")).toMatch(/unknown-channel|身份|频道/);
  expect(events()).toEqual(before);
  expect(getTask(f.db(), "T1")).toEqual(task);
  expect(f.prepare.intents()).toEqual([]);
  expect(getSchedulerSession(f.db(), "T1", "author")).toBeNull();
  expect(f.prepare.sent).toEqual([]);
});

async function mainHistory() {
  const root = mkdtempSync(join(tmpdir(), "schro1-git-")), work = join(root, "work"), origin = join(root, "origin.git");
  restores.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(work);
  const env = testChildEnv({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_TERMINAL_PROMPT: "0" });
  const git = async (...args: string[]) => {
    const r = await runBounded(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd: work, env, timeoutMs: 10_000 });
    if (r.code !== 0 || r.timedOut) throw new Error(`local git ${args[0]}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = async (file: string) => { writeFileSync(join(work, file), file + "\n"); await git("add", file); await git("commit", "-qm", file); return git("rev-parse", "HEAD"); };
  await git("init", "-q", "--bare", "-b", "main", origin);
  await git("init", "-q", "-b", "main");
  await git("remote", "add", "origin", "https://github.com/example/schro1.git");
  await commit("base"); await git("checkout", "-qb", "feature");
  const reviewed = await commit("feature");
  await git("checkout", "-q", "main"); const main1 = await commit("main1"), main2 = await commit("main2");
  await git("checkout", "-q", "feature"); await git("merge", "-q", "--no-edit", main1); const one = await git("rev-parse", "HEAD");
  await git("merge", "-q", "--no-edit", main2); const two = await git("rev-parse", "HEAD");
  await git("push", "-q", origin, "main", "feature");
  const command: typeof runBounded = (argv, opts) => {
    if (argv[0] !== "git") throw new Error(`unexpected external tool ${argv[0]}`);
    return runBounded(argv.includes("fetch") ? argv.map((a) => a === "origin" ? origin : a) : argv, { ...opts, env });
  };
  return { work, reviewed, main1, main2, one, two, command };
}

for (const drift of [false, true]) test(`MAINP2 pass: two real main merges ${drift ? "policy drifts before CLI commit and carry fails closed" : "carry through CLI with complete audit"}`, async () => {
  const git = await mainHistory(), step = await reviewReady("on", git.reviewed);
  await step();
  expect(await f.prepare.review("pass", git.reviewed, [])).toMatchObject({ ok: true });
  f.prepare.db.query("UPDATE tasks SET pr=?, branch=? WHERE id='T1'").run("https://github.com/example/schro1/pull/1", "task/T1");
  let moved = false, merges = 0;
  const actual = mergeExternal({ maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: git.work }, git.command, () => 16);
  const external = { ...actual,
    inspect: async () => ({ state: "OPEN" as const, head: moved ? git.two : git.reviewed, branch: "task/T1", base: "main", draft: false,
      crossRepository: false, mergeState: "CLEAN", mergeSha: null, checks: [{ name: "ci", bucket: "pending" as const }] }),
    freshness: async () => ({ behindBy: moved ? 0 : 2, mainHead: git.main2 }),
    updateBranch: async () => { moved = true; }, merge: async () => { merges++; throw new Error("pending CI must never merge"); },
  };
  f.beforeChild((args) => { if (drift && args[1] === "scheduler-merge-step" && args.includes("--new-head")) policy("on", "observe"); });
  let mergeId = "";
  for (let i = 0; i < 10; i++) {
    // MCRY5: writer-side policy drift ends in this run's formal unknown; the pass itself completes, never a fake success.
    const r = await f.pass({ external: () => external });
    if (!drift) expect(r.failed).toEqual([]);
    mergeId = f.prepare.intents().find((intent) => intent.action === "merge")?.id ?? "";
    if (mergeId && ["await_ci", "unknown"].includes(getMergeRun(f.db(), mergeId)?.phase ?? "")) break;
  }
  const carry = events("review_carry"), run = getMergeRun(f.db(), mergeId);
  if (drift) {
    expect(run).toMatchObject({ phase: "unknown", reviewedHead: git.reviewed, mergeSha: null });
    expect(run?.reason).toMatch(/mainCarry.*on/);
    expect(merges).toBe(0);
    expect(carry).toEqual([]);
    expect(getTask(f.db(), "T1")?.headSHA).toBe(git.reviewed);
    expect(f.calls.find((c) => c.args.includes("--new-head"))?.result).toMatchObject({ ok: false });
    expect(f.diagnostics.join("\n")).toMatch(/mainCarry.*on/);
  } else {
    expect(run).toMatchObject({ phase: "await_ci", reviewedHead: git.two });
    expect(carry).toHaveLength(1);
    expect(carry[0]).toMatchObject({ actor: "scheduler", data: { from: git.reviewed, to: git.two, hops: 2, mainCarry: "on",
      mainHead: git.main2, sourceReviewSeq: events().findLast((e) => e.kind === "review")!.seq,
      chain: [{ previousHead: git.reviewed, head: git.one, mainParent: git.main1 }, { previousHead: git.one, head: git.two, mainParent: git.main2 }] } });
    expect(events("merge_phase").find((e) => e.data.carrySeq === carry[0].seq)).toMatchObject({ seq: carry[0].seq + 1, data: { to: "await_ci" } });
    expect(getTask(f.db(), "T1")?.headSHA).toBe(git.two);
    const write = f.calls.filter((c) => c.args.includes("--new-head"));
    expect(write).toHaveLength(1);
    expect(write[0]).toMatchObject({ code: 0, result: { ok: true } });
    expect(write[0].args.slice(-2)).toEqual(["--new-head", git.two]);
  }
}, 90_000);

async function manualDependent(id: string) {
  addDep(f.prepare.db, f.prepare.at("owner"), { from: "T0", to: id, kind: "blocks", when: "T0 上线后" });
  const task = getTask(f.db(), id)!, w = getWorkflow(f.db(), id)!;
  expect(await f.prepare.cli("pm", "workflow-set", id, "--rev", String(task.rev), "--workflow-rev", String(w.rev),
    "--template", w.template, "--version", "2", "--mode", "manual", "--author-family", "claude", "--fallback", "only inform",
    "--reason-code", "deps_not_live", "--reason", "wait T0")).toMatchObject({ ok: true });
}

async function manualCard(mode: "on" | "observe" | "off") {
  f = await readonlyFixture({ stateDir: STATE_DIR });
  writeFileSync(join(f.root, "recovery-policy.json"), JSON.stringify({ projects: { p: { keys: { manualStall: mode } } } }));
  createTask(f.prepare.db, f.prepare.at("owner"), { project: "p", id: "T0", title: "dependency", kind: "code" });
  await manualDependent("T1");
  for (const [from, to] of [["spec", "restate"], ["restate", "build"], ["build", "review"], ["review", "merge"], ["merge", "live"]] as const) {
    moveStage(f.prepare.db, f.prepare.at("owner"), { taskId: "T0", from, to });
  }
  recordVerify(f.prepare.db, f.prepare.at("owner"), { taskId: "T0", result: "pass", data: { checks: [{ id: "pr-merged", status: "pass" }] } });
  const task = f.prepare.task(), workflow = getWorkflow(f.db(), "T1")!, verdict = manualResumeVerdict(f.db(), task, workflow);
  expect(verdict.ok).toBe(true);
  if (!verdict.ok) throw new Error(verdict.why);
  return { args: [...recoveryArgs(recoveryFence(f.db(), task)), "--mode", mode, "--reason", manualResumeReason(verdict.facts), "--max-workers", "2"] };
}

for (const mode of ["on", "observe", "off"] as const) test(`MAN2 ${mode}: actual pass and CLI preserve recovery, observe key and notification timing`, async () => {
  const { args } = await manualCard(mode), before = events();
  expect(await f.pass()).toEqual({ ran: true, failed: [] });
  const writes = f.calls.filter((c) => c.args[1] === "scheduler-manual-resume");
  expect(writes).toHaveLength(mode === "off" ? 0 : 1);
  if (mode !== "off") expect(writes[0]).toMatchObject({ args: ["ledger", "scheduler-manual-resume", ...args], result: { ok: true }, code: 0 });
  if (mode === "on") {
    expect(getWorkflow(f.db(), "T1")?.mode).toBe("auto");
    expect(events("workflow_resume")).toHaveLength(1);
    expect(events("workflow_resume")[0].text).toBe(`交回自动（规格第 1 版）：${args[args.indexOf("--reason") + 1]}`);
    expect(f.prepare.notices.filter((n) => n.startsWith("[manual 自动恢复]"))).toHaveLength(1);
  } else {
    expect(getWorkflow(f.db(), "T1")?.mode).toBe("manual");
    expect(f.prepare.notices).toEqual([]);
    expect(events("recovery_observe")).toHaveLength(mode === "observe" ? 1 : 0);
    if (mode === "off") expect(events()).toEqual(before);
    await f.pass();
    expect(events("recovery_observe")).toHaveLength(mode === "observe" ? 1 : 0);
  }
}, 30_000);

test("MAN2 CLI rereads mode/fingerprint and all task/workflow fences; refusals preserve exact state", async () => {
  const { args } = await manualCard("on"), before = events(), task = f.prepare.task(), wf = getWorkflow(f.db(), "T1");
  const call = (a: string[]) => f.withMaintenance(() => f.manager("ledger", "scheduler-manual-resume", ...a));
  const changed = (flag: string, value: string) => args.map((a, i) => args[i - 1] === flag ? value : a);
  for (const [flag, value] of [["--rev", String(task.rev + 1)], ["--workflow-rev", String(wf!.rev + 1)], ["--head", H1], ["--round", "1"],
    ["--spec-rev", "2"], ["--reason", "forged fingerprint"], ["--mode", "observe"], ["--max-workers", "65"]]) {
    expect(await call(changed(flag, value))).toMatchObject({ ok: false });
    expect(events()).toEqual(before);
    expect(f.prepare.task()).toEqual(task);
    expect(getWorkflow(f.db(), "T1")).toEqual(wf);
  }
  f.beforeChild((a) => {
    if (a[1] === "scheduler-manual-resume") writeFileSync(join(f.root, "recovery-policy.json"), JSON.stringify({ projects: { p: { keys: { manualStall: "off" } } } }));
  });
  const refused = await f.pass();
  expect(refused.failed).toEqual([]);
  expect(events()).toEqual(before);
  expect(getWorkflow(f.db(), "T1")).toEqual(wf);
  expect(f.prepare.notices).toEqual([]);
  expect(f.calls.at(-1)?.result).toMatchObject({ ok: false, code: "forbidden" });
}, 30_000);

for (const mode of ["on", "observe"] as const) for (const limit of [20, 32]) {
  test(`MAN2 ${mode}: legal agents ${limit}+${limit} works through the real pass and CLI`, async () => {
    await manualCard(mode);
    writeFileSync(join(f.root, "scheduler.json"), JSON.stringify({ enabled: true, autoDispatch: true,
      projects: { p: { agents: { claude: limit, codex: limit }, requiredChecks: ["ci"], repoDir: f.root } } }));
    expect(await f.pass()).toEqual({ ran: true, failed: [] });
    const writes = f.calls.filter((c) => c.args[1] === "scheduler-manual-resume");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ code: 0, result: { ok: true } });
    expect(writes[0].args.slice(-2)).toEqual(["--max-workers", String(limit * 2)]);
    expect(getWorkflow(f.db(), "T1")?.mode).toBe(mode === "on" ? "auto" : "manual");
    expect(events(mode === "on" ? "workflow_resume" : "recovery_observe")).toHaveLength(1);
  }, 30_000);
}

for (const mode of ["on", "observe"] as const) test(`MAN2 ${mode}: one fenced refusal does not starve the next manual card`, async () => {
  await manualCard(mode);
  createTask(f.prepare.db, f.prepare.at("owner"), { project: "p", id: "T2", title: "next", kind: "code", agent: "agent-task-one" });
  setWorkflow(f.prepare.db, f.prepare.at("owner"), { taskId: "T2", taskRev: 1, template: "code", templateVersion: 2,
    mode: "auto", authorFamily: "claude", fallback: "only inform" });
  await manualDependent("T2");
  const before = events(), log = spyOn(console, "error").mockImplementation(() => {});
  restores.push(() => log.mockRestore());
  f.beforeChild((a) => {
    if (a[1] === "scheduler-manual-resume" && a[2] === "T1") f.prepare.db.query("UPDATE tasks SET rev=rev+1 WHERE id='T1'").run();
  });
  expect(await f.pass()).toEqual({ ran: true, failed: [] });
  expect(f.calls.filter((c) => c.args[1] === "scheduler-manual-resume").map((c) => [c.args[2], c.result.ok, c.result.code]))
    .toEqual([["T1", false, "conflict"], ["T2", true, undefined]]);
  expect(events()).toEqual(before);
  expect(getWorkflow(f.db(), "T1")?.mode).toBe("manual");
  expect(getWorkflow(f.db(), "T2")?.mode).toBe(mode === "on" ? "auto" : "manual");
  expect(listEvents(f.db(), { project: "p", target: "T2" }).filter((e) => e.data.op === (mode === "on" ? "workflow_resume" : "recovery_observe")))
    .toHaveLength(1);
  expect(log.mock.calls.flat().join("\n")).toMatch(/T1.*conflict/);
  expect(f.prepare.notices.filter((n) => n.startsWith("[manual 自动恢复]"))).toHaveLength(mode === "on" ? 1 : 0);
}, 30_000);

test("MAN2 real SQLite write failure remains reported rather than classified as a card refusal", async () => {
  await manualCard("on");
  const before = events(), wf = getWorkflow(f.db(), "T1");
  f.prepare.db.exec("CREATE TRIGGER fail_resume BEFORE UPDATE ON task_workflows WHEN NEW.taskId='T1' BEGIN SELECT RAISE(ABORT, 'storage write failed'); END");
  expect((await f.pass()).failed).toEqual([{ taskId: "manual-resume", error: "scheduler-manual-resume [invalid]: storage write failed" }]);
  expect(f.calls.find((c) => c.args[1] === "scheduler-manual-resume")?.result).toMatchObject({ ok: false, code: "invalid" });
  expect(f.diagnostics.join("\n")).toMatch(/storage write failed/);
  expect(events()).toEqual(before);
  expect(getWorkflow(f.db(), "T1")).toEqual(wf);
  expect(f.prepare.notices).toEqual([]);
}, 30_000);

for (const mode of ["on", "observe"] as const) test(`MAN2 ${mode}: actual lease loss stops the pass with zero recovery writes`, async () => {
  await manualCard(mode);
  const before = events(), wf = getWorkflow(f.db(), "T1");
  f.childEnv({ CLAUDESTRA_SCHEDULER_LEASE: "" });
  await expect(f.pass()).rejects.toBeInstanceOf(SchedulerStopped);
  expect(f.calls.at(-1)?.result).toMatchObject({ ok: false, code: "lease-lost" });
  expect(events()).toEqual(before);
  expect(getWorkflow(f.db(), "T1")).toEqual(wf);
  expect(f.prepare.notices).toEqual([]);
}, 30_000);

async function recoveryReview(cap: boolean) {
  const step = await reviewReady(); await step();
  const round = cap ? 8 : 1, report = join(f.root, "recovery-review.md");
  writeFileSync(report, "# Findings\ncleanup: deferred improvement\n");
  const rows = [{ findingId: "persistent", family: "logic", severity: cap ? "P1" : "P0", basis: "regression", probe: "[回归] src/a.ts" },
    { findingId: "cleanup", family: "cleanup", severity: "P1", probe: "src/other.ts" }];
  f.prepare.db.query("UPDATE tasks SET round=?, rev=rev+1 WHERE id='T1'").run(round);
  f.prepare.db.query("UPDATE scheduler_intents SET status='done' WHERE action='review'").run();
  if (cap) {
    insertEvent(f.prepare.db, f.prepare.at("owner"), { project: "p", target: "T1", kind: "stage", text: "",
      data: { from: "fix", to: "review", round } }, false);
    // Dispatch and acknowledgement for this round come from the genuine read-only pass, not manufactured source proof.
    expect(await f.pass()).toEqual({ ran: true, failed: [] });
    f.prepare.db.query("UPDATE scheduler_intents SET status='done' WHERE action='review'").run();
  }
  // Writer preparation supplies the completed findings; execution validates the planner and formal dispatch/source gates.
  const review = insertEvent(f.prepare.db, f.prepare.at("agent-rv-t1"), { project: "p", target: "T1", kind: "review", text: "",
    data: { round, head: H1, verdict: cap ? "changes" : "block", reviewer: "agent-rv-t1", reviewerSessionId: "s-rv", reviewerFamily: "codex",
      path: report, findings: rows, p0: cap ? 0 : 1, p1: cap ? 2 : 1, p2: 0 } }, false);
  return { args: [...recoveryArgs(recoveryFence(f.db(), f.prepare.task())), "--review-seq", String(review.seq)], review };
}

for (const cap of [true, false]) test(`real review ${cap ? "cap" : "block"}: CLI persists demotion before notification, preserves event text/key and dedupes`, async () => {
  const { args, review } = await recoveryReview(cap);
  const command = cap ? "scheduler-review-hold" : "scheduler-review-downgrade";
  const before = events();
  for (const [flag, value] of [["--rev", "999"], ["--workflow-rev", "999"], ["--head", "2".repeat(40)], ["--round", "99"], ["--spec-rev", "99"],
    ["--review-seq", String(review.seq - 1)]]) {
    const invalid = args.map((a, i) => args[i - 1] === flag ? value : a);
    expect(await f.withMaintenance(() => f.manager("ledger", command, ...invalid, ...(cap ? ["--action", "prepare"] : []))))
      .toMatchObject({ ok: false });
    expect(events()).toEqual(before);
  }
  const notify = f.deps.notifyPm;
  const seenAtNotify: number[] = [];
  f.deps.notifyPm = async (task, text) => { seenAtNotify.push(events("review_downgrade").length); await notify(task, text); };
  expect(await f.pass()).toEqual({ ran: true, failed: [] });
  expect(seenAtNotify.length).toBeGreaterThan(0);
  expect(seenAtNotify.every((n) => n === 1)).toBe(true);
  expect(events("review_downgrade")).toHaveLength(1);
  expect(events("review_downgrade")[0].data).toMatchObject({ round: cap ? 8 : 1, head: H1, findingIds: ["cleanup"] });
  const writes = f.calls.filter((c) => c.args[1] === command && c.result.ok === true);
  expect(writes).toHaveLength(cap ? 2 : 1);
  if (cap) {
    const held = events("review_round_hold")[0];
    expect(held).toMatchObject({ actor: "scheduler", dedupKey: `scheduler:review-cap:T1:${review.seq}`, data: { round: 8, reviewSeq: review.seq, informed: true } });
    expect(held.text).toBe(roundCapText(f.prepare.task(), events()));
    expect(f.prepare.notices.filter((n) => n.includes("上限 8 轮"))).toHaveLength(1);
  } else expect(getWorkflow(f.db(), "T1")?.mode).toBe("manual");
  await f.pass();
  expect(events("review_downgrade")).toHaveLength(1);
  if (cap) expect(events("review_round_hold")).toHaveLength(1);
}, 60_000);
}
