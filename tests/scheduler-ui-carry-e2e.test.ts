/**
 * UICAR2 · LIFE2 (10-07) wired as src/scheduler.ts runs it: a temp state dir (ledger, registry, projects, scheduler.json, recovery
 * policy), every write a real `src/manager.ts ledger` child (the PM's under its channel identity, the scheduler's under its identity
 * and lease), reads through the query_only LedgerReader, production mergeExternal with real git (canonical proof against a local bare
 * origin) and only gh faked. A UI card PM accepted at `reviewed`; the merge run's update-branch merges a main that only touched
 * src/lib/other.ts. Before UICAR2 the run stopped at await_ci with "UI 截图验收已失效"; with uiCarry on it writes ui_carry and merges
 * at the new head. Shapes: MQ1 manual request and an auto card. Negatives: main touched web/, src/bridge/ or the card's fileGlobs; observe.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireLock } from "../src/lib/file-lock.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { planIntent, setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { UI_APPROVED } from "../src/lib/ledger-ui-approve-verdict.js";
import { manualMergeGate } from "../src/lib/manual-merge-queue-pass.js";
import { RECOVERY_POLICY_PATH, recoveryPolicy } from "../src/lib/recovery-policy.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { encodeLease } from "../src/lib/scheduler-lease-env.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import { mergeTick } from "../src/lib/scheduler-service.js";
import { testChildEnv } from "./test-env.js";

const ID = "T", PR = "https://github.com/example/repo/pull/42", M = "b".repeat(40), DIGEST = "d".repeat(64);
const PM = "agent-pm", PM_CHANNEL = "777000222", MANAGER = resolve("src/manager.ts");
let root = "", work = "", origin = "", reviewed = "";
const heads: Record<string, { main: string; merged: string }> = {};
const sh = async (...argv: string[]) => {
  const r = await runBounded(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...argv],
    { cwd: work, timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = async (file: string, body: string) => {
  mkdirSync(join(work, file, ".."), { recursive: true });
  writeFileSync(join(work, file), body);
  await sh("add", "-A"); await sh("commit", "-qm", file);
  return sh("rev-parse", "HEAD");
};

/** reviewed = the UI change; per kind, a main commit on base touching one path and `merged` = update-branch's pure merge of it. */
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "uicar2-e2e-")); work = join(root, "work"); origin = join(root, "origin.git");
  await runBounded(["git", "init", "-q", "--bare", "-b", "main", origin], { timeoutMs: 30_000 });
  await runBounded(["git", "init", "-q", "-b", "main", work], { timeoutMs: 30_000 });
  await sh("remote", "add", "origin", "https://github.com/example/repo.git");
  await sh("remote", "set-url", "--push", "origin", origin);
  for (const f of ["README.md", "web/app.tsx", "src/bridge/b.ts", "src/lib/other.ts", "src/lib/owned.ts"]) await commit(f, "base\n");
  const base = await sh("rev-parse", "HEAD");
  await sh("checkout", "-qb", `task/${ID}`); reviewed = await commit("web/app.tsx", "ui change\n");
  for (const [kind, file] of [["lib", "src/lib/other.ts"], ["web", "web/features/lend/x.tsx"], ["bridge", "src/bridge/b.ts"], ["glob", "src/lib/owned.ts"]]) {
    await sh("checkout", "-q", "-B", `main-${kind}`, base);
    const main = await commit(file!, `main ${kind}\n`);
    await sh("checkout", "-q", "-B", `h-${kind}`, reviewed); await sh("merge", "-q", "--no-edit", main);
    heads[kind!] = { main, merged: await sh("rev-parse", "HEAD") };
  }
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); });
type Json = Record<string, unknown>;
const passing = { stdout: JSON.stringify([{ name: "check", bucket: "pass" }]), stderr: "", code: 0 };

async function setup(o: { shape: "manual" | "auto"; kind: string; uiCarry: "on" | "observe" }) {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const { main, merged } = heads[o.kind]!;
  await sh("push", "-q", "-f", "origin", `${main}:refs/heads/main`); // GitHub's main when update-branch runs
  const dir = mkdtempSync(join(root, "state-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const reader = new LedgerReader(path);
  cleanup.push(() => { reader.close(); closeLedger(path); rmSync(dir, { recursive: true, force: true }); errors.mockRestore(); });
  writeFileSync(join(dir, "registry.json"), JSON.stringify({ socket: "", agents: { [PM]: { channelId: PM_CHANNEL, projectId: "p" } } }));
  writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects: [{ id: "p", name: "p", dirs: [], createdAt: "2026-10-07T00:00:00Z" }] }));
  const policyPath = join(dir, "recovery-policy.json"), cfg = { enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: work } } };
  const policy = JSON.stringify({ projects: { p: { keys: { uiCarry: o.uiCarry, manualMergeQueue: "on" } } } });
  writeFileSync(policyPath, policy);
  writeFileSync(RECOVERY_POLICY_PATH, policy); // the in-process pass (claim gate / drift) reads the test process's own copy
  cleanup.push(() => rmSync(RECOVERY_POLICY_PATH, { force: true }));
  writeFileSync(join(dir, "scheduler.json"), JSON.stringify(cfg));
  const config = parseSchedulerConfig(cfg);

  const singletonPath = join(dir, "singleton.lock"), maintenancePath = join(dir, "maintenance.lock");
  const singleton = (await acquireLock(singletonPath, 0))!, maintenance = (await acquireLock(maintenancePath, 0))!;
  cleanup.push(() => { singleton.release(); maintenance.release(); });
  const home = join(dir, "home"), runtime = join(dir, "runtime");
  for (const d of [home, runtime]) mkdirSync(d);
  // The child's TMPDIR is the common ancestor of its state / runtime / HOME: wherever the outer temp root is, the child's
  // test-guard sees them under its temp dir and keeps them (a redirect would hide the parent's ledger and registry).
  const base = { HOME: home, TMPDIR: dir, CLAUDESTRA_STATE_DIR: dir, CLAUDESTRA_RUNTIME_DIR: runtime };
  const spawn = async (env: Record<string, string>, args: string[]): Promise<Json> => {
    const p = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", MANAGER, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(err).not.toContain("[test-guard]"); // the child's effective state / runtime dirs are the parent's
    try { return JSON.parse(out.trim().split("\n").at(-1) ?? ""); } catch { return { ok: false, code: "child", error: `${out}\n${err}`.trim() }; }
  };
  const children: string[] = [];
  /** The scheduler service's manager: `manager.ts ledger …` with its identity and lease. */
  const scheduler = (...args: string[]) => (children.push(args[1]!), spawn(testChildEnv({ ...base, DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "1",
    CLAUDESTRA_SCHEDULER_LEASE: encodeLease({ singleton: { path: singletonPath, token: singleton.token },
      maintenance: { path: maintenancePath, token: maintenance.token } }) }), args));
  const pm = (...args: string[]) => spawn(testChildEnv({ ...base, DISCORD_CHANNEL_ID: PM_CHANNEL }), ["ledger", ...args]);

  // The card: UI, in review at `reviewed`, screenshots digest and its own file scope (src/lib/owned.ts).
  setMeta(db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM] });
  const spec = join(dir, "T.md");
  writeFileSync(spec, "规格：界面改动\n验收：截图");
  createTask(db, { actor: "owner", now: 2 }, { project: "p", id: ID, title: "ui", kind: "code", agent: "agent-author", spec } as never);
  setWorkflow(db, { actor: "owner", now: 3 }, { taskId: ID, taskRev: getTask(db, ID)!.rev, template: "ui", templateVersion: 2, mode: o.shape,
    authorFamily: "claude", fallback: "人工", ...(o.shape === "manual" ? { reason: "PM 接管，人工审查后合并" } : {}) });
  db.query("UPDATE tasks SET stage='review', round=1, headSHA=?, pr=?, branch=?, extra=?, rev=rev+1 WHERE id=?")
    .run(reviewed, PR, `task/${ID}`, JSON.stringify({ screenshotsDigest: DIGEST, fileGlobs: ["src/lib/owned.ts"] }), ID);
  const reviewSeq = o.shape === "manual" ? await manualReviewed(db, dir, pm) : autoReviewed(db);
  const seq = () => (db.query("SELECT MAX(seq) AS seq FROM events WHERE project='p'").get() as { seq: number }).seq;
  const revs = () => ({ task: getTask(db, ID)!.rev, wf: (db.query("SELECT rev FROM task_workflows WHERE taskId=?").get(ID) as { rev: number }).rev });

  // Fake gh at this tick: behind until update-branch merges main in; CI green; the merge pinned to the expected head.
  const gh = { head: reviewed, merged: false, calls: [] as string[] };
  const command: typeof runBounded = async (argv, opts) => {
    const ok = (stdout: unknown) => ({ code: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "", timedOut: false });
    if (argv[0] === "git") return runBounded(argv[1] === "fetch" ? argv.map((a) => (a === "origin" ? origin : a)) : argv, opts);
    const a = argv.slice(1).join(" ");
    gh.calls.push(a);
    if (a.startsWith("repo view")) return ok({ nameWithOwner: "example/repo" });
    if (a.startsWith("pr view")) return ok({ state: gh.merged ? "MERGED" : "OPEN", headRefOid: gh.head, headRefName: `task/${ID}`, baseRefName: "main",
      isDraft: false, isCrossRepository: false, mergeStateStatus: gh.merged ? "UNKNOWN" : "CLEAN", mergeCommit: gh.merged ? { oid: M } : null });
    if (a.startsWith("pr checks")) return { timedOut: false, ...passing };
    if (a.startsWith("api repos/example/repo/compare/")) return ok({ behind: gh.head === reviewed ? 1 : 0, main });
    if (a === `pr update-branch ${PR}`) { gh.head = merged; return ok(""); }
    if (a === `api -X PUT repos/example/repo/pulls/42/merge -f sha=${gh.head} -f merge_method=merge`) { gh.merged = true; return ok({ merged: true, sha: M }); }
    return { code: 1, stdout: "", stderr: `unexpected gh ${a}`, timedOut: false };
  };

  /** Into the merge queue the way each shape does: PM's manual request claimed by the gate, or the planner's merge intent. */
  const enqueue = async (): Promise<string> => {
    const ro = reader.get()!;
    if (o.shape === "auto") {
      const r = await scheduler("ledger", "scheduler-plan", ID, "--id", "a1", "--rev", String(revs().task), "--workflow-rev", String(revs().wf),
        "--seq", String(seq()), "--node", "merge_deploy", "--action", "merge", "--reason", "merge", "--resources", "merge:p");
      expect(r).toMatchObject({ ok: true });
      return "a1";
    }
    const req = await pm("manual-merge-request", ID, "--head", reviewed, "--spec-rev", "1", "--round", "1", "--review-seq", String(reviewSeq),
      "--ui-digest", DIGEST, "--reason", "PM 验收截图后排队合并");
    expect(req).toMatchObject({ ok: true, state: "queued" });
    expect(await manualMergeGate(ro, null, (p, k) => recoveryPolicy(p, k, policyPath)).claim(scheduler, config)).toEqual({ claimed: [ID], failed: [] });
    return (ro.query("SELECT id FROM scheduler_intents WHERE action='merge' AND status IN ('pending','submitted')").get() as { id: string }).id;
  };
  const drive = async (intent: string) => {
    for (let i = 0; i < 6 && !["merged", "unknown", "resolved", "await_review"].includes(getMergeRun(db, intent)?.phase ?? ""); i++) {
      const ro = reader.get()!;
      expect(() => ro.run("UPDATE meta SET value = value")).toThrow(/readonly/);
      await mergeTick(ro, config, scheduler, (p) => mergeExternal(p, command), () => {});
    }
    return getMergeRun(db, intent)!;
  };
  const events = () => listEvents(db, { project: "p", target: ID });
  const sent = () => gh.calls.filter((c) => c.includes("update-branch") || c.includes("/merge "));
  return { db, merged, enqueue, drive, events, sent, children };
}

/** PR775 / LIFE2 shape: the PM records the cross-family PASS and the screenshot acceptance with the ledger CLI, then requests the merge. */
async function manualReviewed(db: ReturnType<typeof openLedger>, dir: string, pm: (...a: string[]) => Promise<Json>): Promise<number> {
  expect(await pm("ui-approve", ID, "--head", reviewed, "--digest", DIGEST)).toMatchObject({ ok: true });
  const findings = join(dir, "findings.json"), report = join(dir, "ledger", "reviews", "T.md");
  mkdirSync(join(dir, "ledger", "reviews"), { recursive: true });
  writeFileSync(findings, "[]");
  writeFileSync(report, `# 审查 T\n\nhead ${reviewed}\n\nPASS\n`);
  expect(await pm("review", ID, "--reviewer", "agent-review", "--verdict", "pass", "--p0", "0", "--p1", "0", "--p2", "0", "--head", reviewed,
    "--session", "rs-T", "--family", "codex", "--findings", findings, "--path", report, "--to", "merge")).toMatchObject({ ok: true });
  return listEvents(db, { project: "p", target: ID }).findLast((e) => e.kind === "review")!.seq;
}

/** Auto card: the scheduler's own review dispatch, the reviewer session, PM's bound acceptance, review → merge. */
function autoReviewed(db: ReturnType<typeof openLedger>): number {
  const add = (actor: string, kind: string, data: unknown) => db.prepare(
    "INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (100,?,'p',?,?,'',?)").run(actor, ID, kind, JSON.stringify(data));
  const seq = () => (db.query("SELECT MAX(seq) AS seq FROM events WHERE project='p'").get() as { seq: number }).seq;
  const wf = (db.query("SELECT rev FROM task_workflows WHERE taskId=?").get(ID) as { rev: number }).rev;
  add("owner", "stage", { from: "build", to: "review", round: 1 });
  planIntent(db, { actor: "scheduler" }, { id: "rv", taskId: ID, taskRev: getTask(db, ID)!.rev, workflowRev: wf, causalSeq: seq(),
    node: "adversarial_review", action: "review", reason: "review", recipient: "agent-review" });
  settleIntent(db, { actor: "scheduler" }, { id: "rv", from: "pending", to: "submitted", receipt: "ack" });
  add("agent-review", "review", { round: 1, head: reviewed, verdict: "pass", reviewer: "agent-review", reviewerSessionId: "rs",
    reviewerFamily: "codex", path: `reviews/${ID}-r1/report.md`, findings: [], p0: 0, p1: 0, p2: 0 });
  const review = seq();
  settleIntent(db, { actor: "scheduler" }, { id: "rv", from: "submitted", to: "done", receipt: "review event recorded" });
  db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES (?,'reviewer','agent-review','rs','codex','acp','active','rv',100,100)`).run(ID);
  add(PM, "decision", { op: UI_APPROVED, head: reviewed, specRev: 1, round: 1, screenshotsDigest: DIGEST });
  db.query("UPDATE tasks SET stage='merge' WHERE id=?").run(ID);
  add("owner", "stage", { from: "review", to: "merge", round: 1, specRev: 1 });
  return review;
}

const MERGE = (head: string) => `api -X PUT repos/example/repo/pulls/42/merge -f sha=${head} -f merge_method=merge`;

describe("UICAR2 旧红新绿：LIFE2 形态，main 段只改 src/lib 下无关文件", () => {
  for (const shape of ["manual", "auto"] as const) {
    test(`${shape === "manual" ? "MQ1 人工请求" : "auto 卡"}：uiCarry on → 写 ui_carry，CI 绿后按新 head 钉 head 合并，PM 不用再验收`, async () => {
      const s = await setup({ shape, kind: "lib", uiCarry: "on" });
      const run = await s.drive(await s.enqueue());
      expect(run).toMatchObject({ phase: "merged", reviewedHead: s.merged, mergeSha: M });
      expect(s.sent()).toEqual([`pr update-branch ${PR}`, MERGE(s.merged)]);
      const all = s.events(), carry = all.find((e) => e.data.op === "review_carry")!, ui = all.filter((e) => e.data.op === "ui_carry");
      expect(ui).toHaveLength(1);
      expect(ui[0]).toMatchObject({ actor: "scheduler", seq: carry.seq + 2, data: { from: reviewed, to: s.merged, touched: [], changed: ["src/lib/other.ts"],
        digest: DIGEST, mainParent: heads.lib!.main, carrySeq: carry.seq } });
      expect(all.filter((e) => e.kind === "decision" && e.data.op === UI_APPROVED)).toHaveLength(1); // PM accepted once, at the reviewed head
      expect(getTask(s.db, ID)!.headSHA).toBe(s.merged);
    }, 180_000);
  }
});

describe("UICAR2 反例：main 段碰了界面 / 本卡文件，或开关是 observe → 不写 ui_carry，照旧不合并（走 UICAR1）", () => {
  for (const [kind, why] of [["web", /web\/features\/lend\/x\.tsx/], ["bridge", /src\/bridge\/b\.ts/], ["glob", /src\/lib\/owned\.ts/]] as const) {
    for (const shape of ["manual", "auto"] as const) {
      test(`${shape} · main 改了 ${kind}`, async () => {
        const s = await setup({ shape, kind, uiCarry: "on" });
        const run = await s.drive(await s.enqueue());
        expect(run.phase).not.toBe("merged");
        expect(s.sent()).toEqual([`pr update-branch ${PR}`]);
        const all = s.events();
        expect(all.some((e) => e.data.op === "ui_carry")).toBe(false);
        expect(String(all.findLast((e) => e.data.op === "merge_phase" && e.data.to === "await_ci")?.data.note)).toMatch(why);
        expect(JSON.stringify(all.filter((e) => e.data.op === "merge_phase").map((e) => e.data.receipt))).toMatch(/UI 截图验收已失效|UI 验收：缺同 head/);
      }, 180_000);
    }
  }

  test("auto · observe：只记一条『本可沿用』观察（带触碰清单），不写 ui_carry，照旧不合并", async () => {
    const s = await setup({ shape: "auto", kind: "lib", uiCarry: "observe" });
    const run = await s.drive(await s.enqueue());
    expect(run.phase).not.toBe("merged");
    expect(s.sent()).toEqual([`pr update-branch ${PR}`]);
    const all = s.events();
    expect(all.some((e) => e.data.op === "ui_carry")).toBe(false);
    expect(all.filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "uiCarry"))
      .toMatchObject([{ actor: "scheduler", data: { changed: ["src/lib/other.ts"], touched: [] } }]);
  }, 180_000);
});
