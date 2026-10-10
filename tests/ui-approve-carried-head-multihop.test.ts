/**
 * UICARRY2 end to end: file ledger, the production CLI / lease / reader wiring, a real git fixture, a recording fake gh. A card
 * carried twice (and three times) by review carries gets PM's merge-stage re-approval anchored on the intermediate head PM
 * re-approved, never by a bare head match; the round, the review and the request gates stay as they were.
 */
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
import { currentReviewFacts } from "../src/lib/scheduler-review.js";
import { mergeTick } from "../src/lib/scheduler-service.js";
import { uiMergeRefusal } from "../src/lib/scheduler-ui-gate.js";
import { testChildEnv } from "./test-env.js";

const PM = "agent-pm", CHANNEL = "777123457", DIGEST = "a".repeat(64), PR = "https://github.com/o/r/pull/7";
const manager = join(import.meta.dir, "../src/manager.ts");
let root: string, repo: string, origin: string, base: string;
const mains: string[] = [], heads: string[] = []; // heads[i]: the task branch after merging mains[i]
const git = async (...args: string[]) => {
  const r = await runBounded(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd: repo, env: testChildEnv(), timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`${args}: ${r.stderr}`);
  return r.stdout.trim();
};
const setMain = async (main: string) => {
  await git("update-ref", "refs/remotes/origin/main", main);
  await git("--git-dir", origin, "update-ref", "refs/heads/main", main);
};
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "uicarry2-")); repo = join(root, "repo"); origin = join(root, "origin.git"); mkdirSync(repo);
  await git("init", "-qb", "main");
  writeFileSync(join(repo, "common"), "base\n"); await git("add", "."); await git("commit", "-qm", "base");
  await git("checkout", "-qb", "task/T");
  writeFileSync(join(repo, "feature"), "reviewed\n"); await git("add", "."); await git("commit", "-qm", "feature"); base = await git("rev-parse", "HEAD");
  for (let i = 0; i < 3; i++) {
    await git("checkout", "-q", "main");
    writeFileSync(join(repo, `main-${i}`), `main ${i}\n`); await git("add", "."); await git("commit", "-qm", `main ${i}`); mains.push(await git("rev-parse", "HEAD"));
    await git("checkout", "-q", "task/T"); await git("merge", "-q", "--no-edit", "main"); heads.push(await git("rev-parse", "HEAD"));
  }
  await git("clone", "--bare", "-q", repo, origin);
  await git("remote", "add", "origin", "https://github.com/o/r.git"); await setMain(mains[0]!);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
let active: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(() => { active?.close(); active = undefined; rmSync(RECOVERY_POLICY_PATH, { force: true }); });

async function fixture(opts: { approveBeforePass?: boolean } = {}) {
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
  const approve = (head: string, digest = DIGEST) => pm("ui-approve", "T", "--head", head, "--digest", digest);
  if (opts.approveBeforePass) expect(await approve(base)).toMatchObject({ ok: true }); // PM looked before the code PASS landed
  const report = join(state, "ledger/reviews/T.md"), findings = join(state, "findings.json");
  writeFileSync(report, `PASS ${base}\n`); writeFileSync(findings, "[]");
  expect(await pm("review", "T", "--reviewer", "reviewer", "--verdict", "pass", "--p0", "0", "--p1", "0", "--p2", "0",
    "--head", base, "--session", "rs-T", "--family", "codex", "--findings", findings, "--path", report)).toMatchObject({ ok: true });
  const events = () => listEvents(db, { project: "p", target: "T" });
  const seq = events().findLast((e) => e.kind === "review")!.seq;
  if (!opts.approveBeforePass) expect(await approve(base)).toMatchObject({ ok: true });
  expect(await pm("stage", "T", "--from", "review", "--to", "merge")).toMatchObject({ ok: true });
  const reader = new LedgerReader(join(state, "ledger.sqlite"));
  const config = parseSchedulerConfig({ enabled: true, projects: { p: { repoDir: repo, requiredChecks: ["check"], maxActiveWorkers: 1 } } });
  const request = () => pm("manual-merge-request", "T", "--head", getTask(db, "T")!.headSHA!, "--round", "4", "--spec-rev", "1",
    "--review-seq", String(seq), "--ui-digest", DIGEST, "--reason", "PM re-shot screenshots on the current head");
  const claim = () => manualMergeGate(reader.get()!, null, (p, k) => recoveryPolicy(p, k, join(state, "recovery-policy.json"))).claim(scheduler, config);
  const close = () => { reader.close(); db.close(); singleton.release(); maintenance.release(); rmSync(state, { recursive: true, force: true }); };
  return { state, db, pm, scheduler, config, seq, events, approve, request, claim, reader, close };
}
type F = Awaited<ReturnType<typeof fixture>>;

/** gh fake: each update-branch takes the next [head, main] hop; compare reports behind while a hop is left. Merges are pinned PUTs. */
function fakeGithub(f: F, initial: string, hops: [string, string][], main: string) {
  const stateFile = join(f.state, "gh-state.json"), callsFile = join(f.state, "gh-calls.jsonl"), exe = join(f.state, "gh.ts");
  writeFileSync(stateFile, JSON.stringify({ head: initial, merged: false, hops, main })); writeFileSync(callsFile, "");
  writeFileSync(exe, `import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
const a=process.argv.slice(2), p=${JSON.stringify(stateFile)}, s=JSON.parse(readFileSync(p,'utf8'));
appendFileSync(${JSON.stringify(callsFile)},JSON.stringify(a)+'\\n');
let out;
if(a[0]==='repo') out={nameWithOwner:'o/r'};
else if(a[1]==='view') out={state:s.merged?'MERGED':'OPEN',headRefOid:s.head,headRefName:'task/T',baseRefName:'main',isDraft:false,
 isCrossRepository:false,mergeStateStatus:'CLEAN',mergeCommit:s.merged?{oid:'f'.repeat(40)}:null};
else if(a[1]==='checks') out=[{name:'check',bucket:'pass'}];
else if(a[1]==='update-branch') {const [h,m]=s.hops.shift();s.head=h;s.main=m;writeFileSync(p,JSON.stringify(s));out={};}
else if(a.includes('PUT')) {if(!a.includes('sha='+s.head)) throw Error('unpinned merge');s.merged=true;writeFileSync(p,JSON.stringify(s));out={merged:true,sha:'f'.repeat(40)};}
else if(a[0]==='api') out={behind:s.hops.length?1:0,main:s.hops.length?s.hops[0][1]:s.main};
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
const snap = (f: F) => JSON.stringify([task(f), f.events(), f.db.query("SELECT * FROM scheduler_intents").all()]);
const approvals = (f: F) => f.events().filter((e) => e.data.op === "ui_approved");
/** Formal PM main-carry of one pure-main hop (review-main-carry-manual.ts), proven in the real repo. */
async function carry(f: F, i: number) {
  await setMain(mains[i]!);
  return f.pm("main-carry", "T", "--old", i ? heads[i - 1]! : base, "--new", heads[i]!, "--main", mains[i]!, "--round", "4", "--spec-rev", "1",
    "--review-seq", String(f.seq), "--rev", String(task(f).rev), "--repo-dir", repo);
}
const carrySeq = (f: F, to: string) => f.events().find((e) => (e.data.op === "review_main_carry" || e.data.op === "review_carry") && e.data.to === to)!.seq;
async function finish(f: F, head: string, gh: { calls: () => string[][]; tick: () => Promise<unknown> }) {
  expect(await f.request()).toMatchObject({ ok: true, state: "queued" });
  expect(await f.claim()).toEqual({ claimed: ["T"], failed: [] });
  await gh.tick(); await gh.tick();
  expect(f.db.query("SELECT phase, reviewedHead FROM scheduler_merges ORDER BY updatedAt DESC LIMIT 1").get()).toMatchObject({ phase: "merged", reviewedHead: head });
  const put = gh.calls().filter((a) => a.includes("PUT"));
  expect(put).toHaveLength(1); expect(put[0]).toContain(`sha=${head}`);
}

describe("UICARRY2 intermediate PM re-approval anchors a later carry", () => {
  test("S2W shape via the scheduler's update-branch: hop 1 → PM re-approves → hop 2 → re-approval anchored on hop 1's head, merge at hop 2", async () => {
    const f = active = await fixture();
    await setMain(mains[0]!);
    const gh = fakeGithub(f, base, [[heads[0]!, mains[0]!], [heads[1]!, mains[1]!]], mains[1]!);
    const hop = async (i: number) => {
      await setMain(mains[i]!);
      expect(await f.request()).toMatchObject({ ok: true, state: "queued" }); expect(await f.claim()).toEqual({ claimed: ["T"], failed: [] });
      await gh.tick(); await gh.tick(); await gh.tick(); // updating → await_ci (review_carry) → UI drift cancels the request
      expect(f.events().findLast((e) => e.data.op === "review_carry")).toMatchObject({ actor: "scheduler", data: { from: i ? heads[i - 1] : base, to: heads[i], round: 4 } });
      expect(task(f).headSHA).toBe(heads[i]!);
      expect(gh.calls().filter((a) => a.includes("PUT"))).toHaveLength(0);
    };
    await hop(0);
    expect(await f.approve(heads[0]!)).toMatchObject({ ok: true, event: { data: { carriedFrom: base, reviewCarrySeqs: [carrySeq(f, heads[0]!)] } } });
    await hop(1);
    // The pre-UICARRY2 rule: the review still reads its original head, PM's newest approval is on hop 1's head → refused.
    expect(currentReviewFacts(task(f), f.events())).toMatchObject({ kind: "facts", facts: { head: base } });
    const anchor = approvals(f).at(-1)!;
    expect(anchor.data.head).toBe(heads[0]!);
    const r = await f.approve(heads[1]!);
    expect(r).toMatchObject({ ok: true, event: { kind: "decision", data: { op: "ui_approved", head: heads[1], round: 4, specRev: 1, screenshotsDigest: DIGEST,
      carriedFrom: heads[0], anchorSeq: anchor.seq, sourceReviewSeq: f.seq, prefixCarrySeqs: [carrySeq(f, heads[0]!)], reviewCarrySeqs: [carrySeq(f, heads[1]!)] } } });
    expect(task(f)).toMatchObject({ stage: "merge", round: 4, headSHA: heads[1] });
    expect(f.events().filter((e) => e.kind === "review")).toHaveLength(1);
    expect(uiMergeRefusal(f.db, task(f), Date.now())).toBeNull();
    await finish(f, heads[1]!, gh);
    expect(gh.calls().filter((a) => a.includes("update-branch"))).toHaveLength(2);
  }, 120_000);

  for (const approveBeforePass of [false, true]) {
    test(`formal PM main-carry, three hops, each re-approved${approveBeforePass ? " (initial approval before the code PASS)" : ""}`, async () => {
      const f = active = await fixture({ approveBeforePass });
      let from = base;
      for (let i = 0; i < 3; i++) {
        expect(await carry(f, i)).toMatchObject({ ok: true, status: "carried" });
        const prev = approvals(f).at(-1)!, r = await f.approve(heads[i]!);
        expect(r).toMatchObject({ ok: true, event: { data: { head: heads[i], carriedFrom: from, reviewCarrySeqs: [] } } });
        if (i) expect(r.event.data).toMatchObject({ anchorSeq: prev.seq, prefixCarrySeqs: heads.slice(0, i).map((h) => carrySeq(f, h)) });
        else expect(r.event.data.anchorSeq).toBeUndefined();
        from = heads[i]!;
      }
      expect(task(f)).toMatchObject({ round: 4, headSHA: heads[2] });
      expect(f.events().filter((e) => e.kind === "review")).toHaveLength(1);
      await finish(f, heads[2]!, fakeGithub(f, heads[2]!, [], mains[2]!));
    }, 120_000);
  }
});


/**
 * Card at heads[2] after three formal carries, PM's approvals on base, heads[0], heads[1]; the newest (heads[1]) anchors the next one.
 * Each mutation must leave the ledger and the queue untouched and the request refused.
 */
const negatives: [string, (f: F) => void, string?][] = [
  ["anchor's anchorSeq forged", (f) => setApproval(f, 1, "$.anchorSeq", 1)],
  ["anchor's prefix seqs forged", (f) => setApproval(f, 1, "$.prefixCarrySeqs", "json('[]')")],
  ["anchor's suffix seqs forged", (f) => setApproval(f, 1, "$.reviewCarrySeqs", "json('[1]')")],
  ["anchor's source review forged", (f) => setApproval(f, 1, "$.sourceReviewSeq", 1)],
  ["anchor claims the review head as carriedFrom", (f) => setApproval(f, 1, "$.carriedFrom", `'${base}'`)],
  ["anchor's carriedFrom off the chain", (f) => setApproval(f, 1, "$.carriedFrom", `'${"9".repeat(40)}'`)],
  ["anchor without carriedFrom", (f) => f.db.query(`UPDATE events SET data=json_remove(data,'$.carriedFrom') WHERE seq=?`).run(approvals(f)[2]!.seq)],
  ["first re-approval's predecessor by a forged actor", (f) => f.db.query("UPDATE events SET actor='author' WHERE seq=?").run(approvals(f)[0]!.seq)],
  ["intermediate re-approval by a forged actor", (f) => f.db.query("UPDATE events SET actor='author' WHERE seq=?").run(approvals(f)[1]!.seq)],
  ["anchor's own round forged", (f) => setApproval(f, 1, "$.round", 3)],
  ["anchor approval written after the card left its head", (f) => { insertEvent(f.db, { actor: PM }, { project: "p", target: "T", kind: "decision",
    text: "forged", data: { ...approvals(f)[2]!.data } }, false); }],
  ["head that only appears as a carry `to`, never approved there", (f) => f.db.query("UPDATE events SET data=json_set(data,'$.head',?) WHERE seq=?")
    .run(heads[1], approvals(f)[1]!.seq)],
  ["broken chain: a formal carry deleted", (f) => f.db.query("DELETE FROM events WHERE seq=?").run(carrySeq(f, heads[1]!))],
  ["formal carry lost its paired head move", (f) => f.db.query("DELETE FROM events WHERE seq=?").run(carrySeq(f, heads[1]!) - 1)],
  ["formal carry by a forged actor", (f) => f.db.query("UPDATE events SET actor='author' WHERE seq=?").run(carrySeq(f, heads[1]!))],
  ["formal carry from another source review", (f) => f.db.query("UPDATE events SET data=json_set(data,'$.sourceReviewSeq',1) WHERE seq=?").run(carrySeq(f, heads[1]!))],
  ["formal carry from another round", (f) => f.db.query("UPDATE events SET data=json_set(data,'$.round',3) WHERE seq=?").run(carrySeq(f, heads[1]!))],
  ["code delivered after the review", (f) => { insertEvent(f.db, { actor: "author" }, { project: "p", target: "T", kind: "deliver", text: "new code", data: {} }, false); }],
  ["latest PM verdict rejected", (f) => { insertEvent(f.db, { actor: PM }, { project: "p", target: "T", kind: "decision", text: "no",
    data: { op: "ui_rejected", head: heads[2], specRev: 1, round: 4, screenshotsDigest: DIGEST, note: "redo" } }, false); }],
  ["ownerVisual", (f) => { insertEvent(f.db, { actor: PM }, { project: "p", target: "T", kind: "task", text: "owner gate",
    data: { op: "set", patch: { extra: { ownerVisual: true } } } }, false); f.db.query("UPDATE tasks SET extra=json_set(extra,'$.ownerVisual',json('true'))").run(); }],
  ["digest changed", (f) => f.db.query("UPDATE tasks SET extra=json_set(extra,'$.screenshotsDigest',?)").run("b".repeat(64))],
  ["round moved", (f) => f.db.query("UPDATE tasks SET round=5").run()],
  ["spec moved", (f) => f.db.query("UPDATE tasks SET specRev=2").run()],
  ["anchor's predecessor approval belongs to another card", (f) => f.db.query("UPDATE events SET target='U' WHERE seq=?").run(approvals(f)[1]!.seq)],
  ["wrong requested head", () => {}, "head"], ["wrong requested digest", () => {}, "digest"],
];
function setApproval(f: F, k: number, path: string, value: number | string) {
  f.db.run(`UPDATE events SET data=json_set(data,'${path}',${value}) WHERE seq=${approvals(f)[k + 1]!.seq}`);
}
describe("UICARRY2 refusals write nothing and send no merge", () => {
  test.each(negatives)("%s", async (...args) => {
    const [, mutate, arg] = args;
    const f = active = await fixture();
    for (let i = 0; i < 3; i++) {
      expect(await carry(f, i)).toMatchObject({ ok: true, status: "carried" });
      if (i < 2) expect(await f.approve(heads[i]!)).toMatchObject({ ok: true });
    }
    // Deliberate journal corruption on this private DB, to verify the reader fails closed.
    f.db.run("DROP TRIGGER events_no_update"); f.db.run("DROP TRIGGER events_no_delete");
    mutate(f); const before = snap(f);
    const r = await f.approve(arg === "head" ? heads[1]! : heads[2]!, arg === "digest" ? "b".repeat(64) : DIGEST);
    expect(r).toMatchObject({ ok: false }); expect(["conflict", "forbidden", "invalid", "not_found"]).toContain(r.code);
    expect(snap(f)).toBe(before);
    expect((await f.request()).ok).toBe(false); expect(snap(f)).toBe(before);
  }, 120_000);

  test("the control: the same card unmutated is accepted", async () => {
    const f = active = await fixture();
    for (let i = 0; i < 3; i++) {
      expect(await carry(f, i)).toMatchObject({ ok: true, status: "carried" });
      expect(await f.approve(heads[i]!)).toMatchObject({ ok: true });
    }
  }, 120_000);

  test("state drift after the request (new screenshots) stops the merge before send", async () => {
    const f = active = await fixture();
    for (let i = 0; i < 2; i++) {
      expect(await carry(f, i)).toMatchObject({ ok: true, status: "carried" });
      expect(await f.approve(heads[i]!)).toMatchObject({ ok: true });
    }
    const gh = fakeGithub(f, heads[1]!, [], mains[1]!);
    expect(await f.request()).toMatchObject({ ok: true, state: "queued" });
    f.db.query("UPDATE tasks SET extra=json_set(extra,'$.screenshotsDigest',?)").run("c".repeat(64));
    await f.claim(); await gh.tick(); await gh.tick(); await gh.tick();
    expect(gh.calls().filter((a) => a.includes("PUT"))).toHaveLength(0);
    expect(f.db.query("SELECT phase FROM scheduler_merges WHERE phase='merged'").all()).toHaveLength(0);
  }, 120_000);
});
