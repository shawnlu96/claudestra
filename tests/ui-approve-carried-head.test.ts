/** Production CLI/lease/reader wiring; all GitHub effects go through a recording fake gh, Git proof uses a real repo. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { acquireLock } from "../src/lib/file-lock.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { manualMergeGate } from "../src/lib/manual-merge-queue-pass.js";
import { RECOVERY_POLICY_PATH, recoveryPolicy } from "../src/lib/recovery-policy.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { encodeLease } from "../src/lib/scheduler-lease-env.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import { currentReviewFacts } from "../src/lib/scheduler-review.js";
import { mergeTick } from "../src/lib/scheduler-service.js";
import { uiMergeRefusal } from "../src/lib/scheduler-ui-gate.js";
import { testChildEnv } from "./test-env.js";

const PM = "agent-pm", CHANNEL = "777123456", DIGEST = "a".repeat(64), PR = "https://github.com/o/r/pull/7";
const manager = join(import.meta.dir, "../src/manager.ts");
let root: string, repo: string, origin: string, base: string, main: string, carried: string;
const git = async (...args: string[]) => {
  const r = await runBounded(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd: repo, env: testChildEnv(), timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`${args}: ${r.stderr}`);
  return r.stdout.trim();
};
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "uicar1-")); repo = join(root, "repo"); origin = join(root, "origin.git"); mkdirSync(repo);
  await git("init", "-qb", "main");
  writeFileSync(join(repo, "common"), "base\n"); await git("add", "."); await git("commit", "-qm", "base");
  await git("checkout", "-qb", "task/T");
  writeFileSync(join(repo, "feature"), "reviewed\n"); await git("add", "."); await git("commit", "-qm", "feature"); base = await git("rev-parse", "HEAD");
  await git("checkout", "-q", "main");
  writeFileSync(join(repo, "main-only"), "new main\n"); await git("add", "."); await git("commit", "-qm", "main"); main = await git("rev-parse", "HEAD");
  await git("checkout", "-q", "task/T"); await git("merge", "-q", "--no-edit", "main"); carried = await git("rev-parse", "HEAD");
  await git("clone", "--bare", "-q", repo, origin);
  await git("remote", "add", "origin", "https://github.com/o/r.git"); await git("update-ref", "refs/remotes/origin/main", main);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
let active: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(() => { active?.close(); active = undefined; rmSync(RECOVERY_POLICY_PATH, { force: true }); });

async function fixture() {
  const state = mkdtempSync(join(root, "state-")), home = join(state, "home"), temp = join(state, "tmp");
  for (const path of [home, temp, join(state, "ledger/reviews")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "", agents: { [PM]: { projectId: "p", channelId: CHANNEL } } }));
  writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: [{ id: "p", name: "p", dirs: [] }] }));
  const policy = JSON.stringify({ projects: { p: { keys: { manualMergeQueue: "on", mainCarry: "on" } } } });
  writeFileSync(join(state, "recovery-policy.json"), policy);
  mkdirSync(dirname(RECOVERY_POLICY_PATH), { recursive: true }); writeFileSync(RECOVERY_POLICY_PATH, policy);
  const db = openLedger(join(state, "ledger.sqlite"));
  setMeta(db, { actor: "owner" }, { project: "p", key: "pms", value: [PM] });
  createTask(db, { actor: "owner" }, { project: "p", id: "T", title: "screenshots", kind: "code", agent: "author" });
  setWorkflow(db, { actor: "owner" }, { taskId: "T", taskRev: getTask(db, "T")!.rev, template: "ui", templateVersion: 2,
    mode: "manual", authorFamily: "claude", fallback: "PM", reason: "pm_takeover: 人工审查和截图验收" });
  db.query("UPDATE tasks SET stage='review', round=4, headSHA=?, branch='task/T', pr=?, extra=? WHERE id='T'")
    .run(base, PR, JSON.stringify({ screenshotsDigest: DIGEST, screenshots: ["before.png", "after.png"] }));
  const leaseFile = join(state, "scheduler.pid"), maintenanceFile = join(state, "maintenance.lock");
  const singleton = (await acquireLock(leaseFile, 0))!, maintenance = (await acquireLock(maintenanceFile, 0))!;
  const env = testChildEnv({ HOME: home, TMPDIR: temp, CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(state, "run") });
  const invoke = async (scheduler: boolean, args: string[]) => {
    const identity = scheduler ? { DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "1",
      CLAUDESTRA_SCHEDULER_LEASE: encodeLease({ singleton: { path: leaseFile, token: singleton.token },
        maintenance: { path: maintenanceFile, token: maintenance.token } }) } : { DISCORD_CHANNEL_ID: CHANNEL };
    const result = await runBounded([process.execPath, "--no-env-file", "--config=/dev/null", manager, "ledger", ...args],
      { env: { ...env, ...identity }, timeoutMs: 30_000 });
    try { return JSON.parse(result.stdout.trim().split("\n").at(-1)!); }
    catch { throw new Error(`CLI ${args}: ${result.stdout} ${result.stderr}`); }
  };
  const pm = (...args: string[]) => invoke(false, args);
  const scheduler = (...args: string[]) => { expect(args[0]).toBe("ledger"); return invoke(true, args.slice(1)); };
  const report = join(state, "ledger/reviews/T.md"), findings = join(state, "findings.json");
  writeFileSync(report, `PASS ${base}\n`); writeFileSync(findings, "[]");
  expect(await pm("review", "T", "--reviewer", "reviewer", "--verdict", "pass", "--p0", "0", "--p1", "0", "--p2", "0",
    "--head", base, "--session", "rs-T", "--family", "codex", "--findings", findings, "--path", report)).toMatchObject({ ok: true });
  const events = () => listEvents(db, { project: "p", target: "T" });
  const seq = events().findLast((e) => e.kind === "review")!.seq;
  const approve = (head = carried, digest = DIGEST) => pm("ui-approve", "T", "--head", head, "--digest", digest);
  expect(await approve(base)).toMatchObject({ ok: true });
  expect(await pm("stage", "T", "--from", "review", "--to", "merge")).toMatchObject({ ok: true });
  const reader = new LedgerReader(join(state, "ledger.sqlite"));
  const config = parseSchedulerConfig({ enabled: true, projects: { p: { repoDir: repo, requiredChecks: ["check"], maxActiveWorkers: 1 } } });
  const request = () => pm("manual-merge-request", "T", "--head", getTask(db, "T")!.headSHA!, "--round", "4", "--spec-rev", "1",
    "--review-seq", String(seq), "--ui-digest", DIGEST, "--reason", "PM checked screenshots on current head");
  const claim = () => manualMergeGate(reader.get()!, null, (p, k) => recoveryPolicy(p, k, join(state, "recovery-policy.json"))).claim(scheduler, config);
  const close = () => { reader.close(); db.close(); singleton.release(); maintenance.release(); rmSync(state, { recursive: true, force: true }); };
  return { state, db, pm, scheduler, config, seq, events, approve, request, claim, reader, close };
}
type F = Awaited<ReturnType<typeof fixture>>;

/** The executable records gh argv. Fetches use a local bare origin; the canonical proof still checks the configured HTTPS origin. */
function fakeGithub(f: F, initial: string) {
  const stateFile = join(f.state, "gh-state.json"), callsFile = join(f.state, "gh-calls.jsonl"), exe = join(f.state, "gh.ts");
  writeFileSync(stateFile, JSON.stringify({ head: initial, merged: false })); writeFileSync(callsFile, "");
  writeFileSync(exe, `import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
const a=process.argv.slice(2), p=${JSON.stringify(stateFile)}, s=JSON.parse(readFileSync(p,'utf8'));
appendFileSync(${JSON.stringify(callsFile)},JSON.stringify(a)+'\\n');
let out;
if(a[0]==='repo') out={nameWithOwner:'o/r'};
else if(a[1]==='view') out={state:s.merged?'MERGED':'OPEN',headRefOid:s.head,headRefName:'task/T',baseRefName:'main',isDraft:false,
 isCrossRepository:false,mergeStateStatus:'CLEAN',mergeCommit:s.merged?{oid:'f'.repeat(40)}:null};
else if(a[1]==='checks') out=[{name:'check',bucket:'pass'}];
else if(a[1]==='update-branch') {s.head=${JSON.stringify(carried)};writeFileSync(p,JSON.stringify(s));out={};}
else if(a.includes('PUT')) {if(!a.includes('sha='+s.head)) throw Error('unpinned merge');s.merged=true;writeFileSync(p,JSON.stringify(s));out={merged:true,sha:'f'.repeat(40)};}
else if(a[0]==='api') out={behind:s.head===${JSON.stringify(base)}?1:0,main:${JSON.stringify(main)}};
else throw Error('unexpected gh '+a);
console.log(JSON.stringify(out));`);
  const command: typeof runBounded = (argv, opts) => {
    const mapped = argv[0] === "gh" ? [process.execPath, "--no-env-file", "--config=/dev/null", exe, ...argv.slice(1)]
      : argv[0] === "git" && argv[1] === "fetch" ? argv.map((a) => a === "origin" ? origin : a) : argv;
    return runBounded(mapped, { ...opts, env: testChildEnv({ HOME: join(f.state, "home"), TMPDIR: join(f.state, "tmp") }) });
  };
  const external = mergeExternal(f.config.projects.p!, command);
  const calls = () => readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map((x) => JSON.parse(x) as string[]);
  const tick = () => mergeTick(f.reader.get()!, f.config, f.scheduler, () => external, () => {}, undefined, null);
  return { calls, tick };
}
const task = (f: F) => getTask(f.db, "T")!;
const snap = (f: F) => JSON.stringify([task(f), f.events()]);
const carry = (f: F) => f.pm("main-carry", "T", "--old", base, "--new", carried, "--main", main, "--round", "4", "--spec-rev", "1",
  "--review-seq", String(f.seq), "--rev", String(task(f).rev), "--repo-dir", repo);
async function assertReapproved(f: F, reviewCarrySeqs: number[]) {
  const result = await f.approve();
  expect(result).toMatchObject({ ok: true, event: { kind: "decision", data: { op: "ui_approved", head: carried, specRev: 1, round: 4,
    screenshotsDigest: DIGEST, carriedFrom: base, reviewCarrySeqs } } });
  expect(task(f)).toMatchObject({ stage: "merge", round: 4, headSHA: carried });
  expect(f.events().filter((e) => e.kind === "review")).toHaveLength(1);
  expect(uiMergeRefusal(f.db, task(f), Date.now())).toBeNull();
}
async function finish(f: F, gh: ReturnType<typeof fakeGithub>) {
  expect(await f.request()).toMatchObject({ ok: true, state: "queued" });
  expect(await f.claim()).toEqual({ claimed: ["T"], failed: [] });
  await gh.tick(); await gh.tick();
  const merged = f.db.query("SELECT phase, reviewedHead FROM scheduler_merges ORDER BY updatedAt DESC LIMIT 1").get();
  expect(merged).toMatchObject({ phase: "merged", reviewedHead: carried });
  const put = gh.calls().filter((a) => a.includes("PUT"));
  expect(put).toHaveLength(1); expect(put[0]).toContain(`sha=${carried}`);
}

describe("UICAR1 production carried-head screenshot reacceptance", () => {
  test("LIFE2: MQ1 update-branch carries PASS, UI drift cancels request, merge ui-approve requeues same round and pins new head", async () => {
    const f = active = await fixture(), gh = fakeGithub(f, base);
    expect(await f.request()).toMatchObject({ ok: true, state: "queued" }); expect(await f.claim()).toEqual({ claimed: ["T"], failed: [] });
    const intent = (f.db.query("SELECT id FROM scheduler_intents WHERE action='merge'").get() as { id: string }).id;
    await gh.tick(); expect(getMergeRun(f.db, intent)!.phase).toBe("updating");
    await gh.tick(); expect(getMergeRun(f.db, intent)!.phase).toBe("await_ci");
    const c = f.events().find((e) => e.data.op === "review_carry")!;
    expect(c).toMatchObject({ actor: "scheduler", data: { from: base, to: carried, round: 4 } });
    expect(currentReviewFacts(task(f), f.events())).toMatchObject({ kind: "facts", facts: { head: base } });
    await gh.tick();
    expect((f.db.query("SELECT receipt FROM scheduler_intents WHERE id=?").get(intent) as { receipt: string }).receipt).toContain("人工合并请求已失效：UI 验收");
    expect(f.db.query("SELECT status FROM scheduler_intents WHERE id=?").get(intent)).toMatchObject({ status: "cancelled" });
    expect((await f.request()).ok).toBe(false);
    await assertReapproved(f, [c.seq]); await finish(f, gh);
    expect(gh.calls().filter((a) => a.includes("update-branch"))).toHaveLength(1);
  }, 60_000);
  test("PM MAINP2: formal main-carry then merge ui-approve preserves PASS and merges at the carried head", async () => {
    const f = active = await fixture();
    expect(await carry(f)).toMatchObject({ ok: true, status: "carried" });
    expect(currentReviewFacts(task(f), f.events(), (a) => a === PM)).toMatchObject({ kind: "facts", facts: { head: base } });
    await assertReapproved(f, []); await finish(f, fakeGithub(f, carried));
  }, 60_000);
});

const negatives: [string, (f: F) => void, string?][] = [
  ["head unchanged from PM approval", (f) => f.db.query("UPDATE tasks SET headSHA=?").run(base)],
  ["author merged main without a carry", (f) => f.db.query("DELETE FROM events WHERE json_extract(data,'$.op')='review_main_carry'").run()],
  ["non-scheduler review_carry", (f) => f.db.query(`UPDATE events SET kind='scheduler', actor='author', data=json_set(data,'$.op','review_carry')
    WHERE json_extract(data,'$.op')='review_main_carry'`).run()],
  ["forged PM actor", (f) => f.db.query("UPDATE events SET actor='author' WHERE json_extract(data,'$.op')='review_main_carry'").run()],
  ["approval only in prior round", (f) => f.db.query("UPDATE events SET data=json_set(data,'$.round',3) WHERE json_extract(data,'$.op')='ui_approved'").run()],
  ["approval only in prior spec", (f) => f.db.query("UPDATE events SET data=json_set(data,'$.specRev',0) WHERE json_extract(data,'$.op')='ui_approved'").run()],
  ["latest PM verdict rejected", (f) => f.db.query("UPDATE events SET data=json_set(data,'$.op','ui_rejected') WHERE json_extract(data,'$.op')='ui_approved'").run()],
  ["no PM approval", (f) => f.db.query("DELETE FROM events WHERE json_extract(data,'$.op')='ui_approved'").run()],
  ["digest changed", (f) => f.db.query("UPDATE tasks SET extra=json_set(extra,'$.screenshotsDigest',?)").run("b".repeat(64))],
  ["wrong requested head", () => {}, "head"], ["wrong requested digest", () => {}, "digest"],
  ["ownerVisual", (f) => { insertEvent(f.db, { actor: PM }, { project: "p", target: "T", kind: "task", text: "owner gate",
    data: { op: "set", patch: { extra: { ownerVisual: true } } } }, false); }],
  ["deliver after carry", (f) => { insertEvent(f.db, { actor: "author" }, { project: "p", target: "T", kind: "deliver", text: "new code", data: {} }, false); }],
  ["reject in merge", () => {}, "reject"],
  ["PM approved a different version from review", (f) => f.db.query("UPDATE events SET data=json_set(data,'$.head',?) WHERE json_extract(data,'$.op')='ui_approved'").run(main)],
];
describe("UICAR1 conflicts are read only", () => {
  test.each(negatives)("%s", async (...args) => {
    const [, mutate, arg] = args;
    const f = active = await fixture(); expect(await carry(f)).toMatchObject({ ok: true, status: "carried" });
    // Deliberate journal corruption on this private DB, to verify the reader fails closed.
    f.db.run("DROP TRIGGER events_no_update"); f.db.run("DROP TRIGGER events_no_delete");
    mutate(f); const before = snap(f);
    const r = arg === "reject" ? await f.pm("ui-reject", "T", "--text", "redo") : await f.approve(arg === "head" ? base : carried, arg === "digest" ? "b".repeat(64) : DIGEST);
    expect(r).toMatchObject({ ok: false, code: "conflict" }); expect(snap(f)).toBe(before);
  }, 60_000);
});
