/**
 * MAINP2 formal PM main-carry: a real temporary SQLite ledger and a real git repository (origin = a GitHub URL, origin/main a
 * local ref, no network). Proof via the canonical reviewMainCarryProof; every refusal is checked to have written nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { applyManualCarry, carriedReview, formalCarries, MAIN_CARRY_OP, mainCarryKey, manualCarryGate, MAX_CARRY_HOPS,
  runManualCarry, verifyManualCarry, type CarryOutcome, type ManualCarryRequest } from "../src/lib/review-main-carry-manual.js";
import { reviewMainCarryProof } from "../src/lib/review-main-carry-proof.js";
import { verdictKey } from "../src/lib/review-verdict.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { mainCarryCmds } from "../src/manager/ledger-main-carry-cmds.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";

const REPO = "example/proof", PR = `https://github.com/${REPO}/pull/1`;
const port = (mode: RecoveryMode | "error"): RecoveryPolicyPort => () =>
  mode === "error" ? { mode: "off", manualAfterMs: null, source: "error", diagnostic: "坏文件" } : { mode, manualAfterMs: null, source: "config" };

let root = "", work = "", db: Database, ledgerPath = "";
let oldHead = "", main1 = "", main2 = "", one = "", two = "", base = "";
let clock = 1_000_000;
const sh = async (...args: string[]) => {
  const r = await runBounded(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd: work, timeoutMs: 30_000 });
  if (r.code !== 0 || r.timedOut) throw new Error(`${args[0]}: ${r.stderr}`);
  return r.stdout.trim();
};
const file = (p: string, v: string) => writeFileSync(join(work, p), v);
const commit = async (m: string) => { await sh("add", "-A"); await sh("commit", "-qm", m); return sh("rev-parse", "HEAD"); };
const at = async (h: string) => { await sh("reset", "--hard", "-q"); await sh("checkout", "-q", "--detach", h); };
const actualMain = (h: string) => sh("update-ref", "refs/remotes/origin/main", h);
const treeCommit = (tree: string, parents: string[], m = "merge") => sh("commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", m);

let cards = 0;
/** A manual-workflow code card in merge at `head`, with this round's structured PASS by a codex reviewer (author claude). */
function card(o: { head?: string; review?: Record<string, unknown>; actor?: string; dedupKey?: string; workflow?: false | "ui";
  family?: "claude" | "codex"; pr?: string; reason?: string } = {}) {
  const id = `T${++cards}`, head = o.head ?? oldHead;
  createTask(db, { actor: "owner", now: ++clock }, { project: "p", id, title: id, kind: "code", agent: "agent-author" });
  if (o.workflow !== false) setWorkflow(db, { actor: "owner", now: ++clock }, { taskId: id, taskRev: 1, template: o.workflow === "ui" ? "ui" : "code",
    templateVersion: 2, mode: "manual", authorFamily: o.family ?? "claude", fallback: "人工",
    reason: o.reason ?? "pm_takeover: PM 手动推进合并" });
  db.query("UPDATE tasks SET stage='merge', round=1, headSHA=?, pr=?, branch=?, updatedAt=? WHERE id=?").run(head, o.pr ?? PR, `task/${id}`, ++clock, id);
  const reviewSeq = insertEvent(db, { actor: o.actor ?? "agent-rv", now: ++clock, dedupKey: o.dedupKey }, { project: "p", target: id, kind: "review", text: "",
    data: { round: 1, head, verdict: "pass", reviewer: "agent-rv", reviewerSessionId: "rs-1", reviewerFamily: "codex", path: "reviews/r.md",
      findings: [], p0: 0, p1: 0, p2: 0, ...o.review } }, !!o.dedupKey).seq;
  const t = getTask(db, id)!;
  const req = (newHead: string, over: Partial<ManualCarryRequest> = {}): ManualCarryRequest =>
    ({ taskId: id, oldHead: getTask(db, id)!.headSHA!, newHead, mainHead: main2, specRev: t.specRev, round: 1, reviewSeq,
      rev: getTask(db, id)!.rev, ...over });
  return { id, reviewSeq, req };
}
const snapshot = (id: string) => ({ task: getTask(db, id), events: listEvents(db, { project: "p", target: id }).length });
const run = (req: ManualCarryRequest, mode: RecoveryMode | "error" = "on", actor = "pm") =>
  runManualCarry(db, { actor, now: ++clock }, req, { repoDir: work, policy: port(mode) });
/** Refused (by status or by LedgerError) and nothing written. */
async function zeroWrite(id: string, go: () => Promise<CarryOutcome>, why: RegExp) {
  const before = snapshot(id);
  let r: CarryOutcome | null = null, reason = "";
  try { r = await go(); } catch (e) { reason = (e as Error).message; }
  if (r) {
    expect({ status: r.status }).toEqual({ status: r.status === "off" ? "off" : "refused" });
    reason = (r as { reason: string }).reason;
  }
  expect(reason).toMatch(why);
  expect(snapshot(id)).toEqual(before);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mainp2-")); work = join(root, "repo"); mkdirSync(work);
  ledgerPath = join(root, "ledger.sqlite"); db = openLedger(ledgerPath);
  db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'pms', '[\"pm\",\"agent-dispatch\"]') ON CONFLICT (project, key) DO UPDATE SET value = excluded.value").run();
  db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'team', '{\"dispatcher\":\"agent-dispatch\",\"sinceSeq\":0}') ON CONFLICT (project, key) DO UPDATE SET value = excluded.value").run();
  await sh("init", "-q", "-b", "main");
  await sh("remote", "add", "origin", `https://github.com/${REPO}.git`);
  file("shared", "original\n"); base = await commit("base");
  await sh("checkout", "-qb", "feature"); file("feature", "reviewed\n"); oldHead = await commit("reviewed");
  await at(base); file("main1", "m1\n"); main1 = await commit("main one"); file("main2", "m2\n"); main2 = await commit("main two");
  await actualMain(main2);
  await at(oldHead); await sh("merge", "-q", "--no-edit", main1); one = await sh("rev-parse", "HEAD");
  await sh("merge", "-q", "--no-edit", main2); two = await sh("rev-parse", "HEAD");
});
afterAll(() => { closeLedger(ledgerPath); if (root) rmSync(root, { recursive: true, force: true }); });

describe("MAINP2 formal PM carry: policy modes", () => {
  test("default observe reports plan + full chain, writes nothing; off refuses; unreadable policy is off", async () => {
    const c = card();
    const before = snapshot(c.id);
    const r = await run(c.req(two), "observe");
    expect(r).toMatchObject({ status: "observe", plan: { from: oldHead, to: two, mainHead: main2, mainParent: main2, hops: 2, sourceReviewSeq: c.reviewSeq,
      sourceKind: "cli", chain: [{ head: one, previousHead: oldHead, mainParent: main1 }, { head: two, previousHead: one, mainParent: main2 }] } });
    expect(snapshot(c.id)).toEqual(before);
    await zeroWrite(c.id, () => run(c.req(two), "off"), /off/);
    await zeroWrite(c.id, () => run(c.req(two), "error"), /off.*坏文件/);
  });
  test("0 hops (new = reviewed head) never makes a carry", async () => {
    const c = card();
    const before = snapshot(c.id);
    expect(await run(c.req(oldHead))).toMatchObject({ status: "noop" });
    expect(snapshot(c.id)).toEqual(before);
  });
});

describe("MAINP2 formal PM carry: on writes one transaction", () => {
  test("1 and 2 hops: head/rev move via setTask, one decision with source PASS, chain and kind; the PASS keeps covering the head", async () => {
    const c = card();
    const rev = getTask(db, c.id)!.rev;
    const r = await run(c.req(one));
    expect(r).toMatchObject({ status: "carried", duplicate: false, plan: { hops: 1, from: oldHead, to: one, mainParent: main1 } });
    expect(getTask(db, c.id)).toMatchObject({ headSHA: one, rev: rev + 1 });
    const evs = listEvents(db, { project: "p", target: c.id });
    const carry = evs.at(-1)!, move = evs.at(-2)!;
    expect(carry).toMatchObject({ actor: "pm", kind: "decision", dedupKey: mainCarryKey(c.id, oldHead, one),
      data: { op: MAIN_CARRY_OP, carrySource: "pm", from: oldHead, to: one, mainHead: main2, sourceReviewSeq: c.reviewSeq, sourceKind: "cli", round: 1 } });
    expect(move).toMatchObject({ kind: "task", actor: "pm", seq: carry.seq - 1, data: { patch: { headSHA: one } } });
    // no review / submit / order / retire / scheduler event is manufactured: only the task-set and the decision are new
    expect(evs.filter((e) => e.seq > c.reviewSeq).map((e) => e.kind)).toEqual(["task", "decision"]);
    // a second formal carry continues the chain from the carried head: still the same PASS
    const r2 = await run(c.req(two));
    expect(r2).toMatchObject({ status: "carried", plan: { hops: 1, from: one, to: two, sourceReviewSeq: c.reviewSeq } });
    const read = carriedReview(getTask(db, c.id)!, listEvents(db, { project: "p", target: c.id }));
    expect(read).toMatchObject({ kind: "facts", base: oldHead, facts: { eventSeq: c.reviewSeq, verdict: "pass" } });
    expect((read as unknown as { carries: unknown[] }).carries).toHaveLength(2);
  });
  test("replay and two concurrent runs: exactly one carry; a different new head after it is a zero-write conflict", async () => {
    const c = card();
    const req = c.req(two);
    const [a, b] = await Promise.all([run(req), run(req)]);
    expect([a, b].map((x) => x.status), JSON.stringify([a, b])).toEqual(["carried", "carried"]);
    expect([a, b].map((x) => (x as { duplicate: boolean }).duplicate).sort()).toEqual([false, true]);
    expect(listEvents(db, { project: "p", target: c.id }).filter((e) => e.data.op === MAIN_CARRY_OP)).toHaveLength(1);
    expect(await run(req)).toMatchObject({ status: "carried", duplicate: true });
    await zeroWrite(c.id, () => run({ ...req, newHead: one }), /rev|head/);
  });
  test("applyManualCarry alone re-reads the policy and every gate inside its transaction", async () => {
    const c = card();
    const proof = await reviewMainCarryProof({ repoDir: work, repository: REPO, base: "main", mainHead: main2, oldHead, newHead: two });
    if (!proof.ok) throw new Error(proof.reason);
    const req = c.req(two);
    expect(() => applyManualCarry(db, { actor: "pm", now: ++clock }, req, proof, { policy: port("observe") })).toThrow(/observe/);
    db.query("UPDATE tasks SET rev = rev + 1 WHERE id = ?").run(c.id); // a write landed while git ran
    const before = snapshot(c.id);
    expect(() => applyManualCarry(db, { actor: "pm", now: ++clock }, req, proof, { policy: port("on") })).toThrow(/rev/);
    expect(snapshot(c.id)).toEqual(before);
    expect(() => applyManualCarry(db, { actor: "pm", now: ++clock }, { ...c.req(two), mainHead: main1 }, proof, { policy: port("on") })).toThrow(/main/);
  });
});

describe("MAINP2 formal PM carry: zero-write refusals", () => {
  test("role: only real PM / master / owner; executor, dispatcher and the scheduler identity are refused", async () => {
    const c = card();
    for (const actor of ["agent-author", "agent-rv", "agent-dispatch", "scheduler", "stranger"]) await zeroWrite(c.id, () => run(c.req(two), "on", actor), /PM|调度/);
    expect((await run(c.req(two), "observe", "owner")).status).toBe("observe");
    expect((await run(c.req(two), "observe", "master")).status).toBe("observe");
  });
  test("CAS / spec / round / review seq / head drift", async () => {
    const c = card();
    await zeroWrite(c.id, () => run(c.req(two, { rev: 99 })), /rev/);
    await zeroWrite(c.id, () => run(c.req(two, { oldHead: one })), /原 head/);
    await zeroWrite(c.id, () => run(c.req(two, { specRev: 77 })), /规格/);
    await zeroWrite(c.id, () => run(c.req(two, { round: 2 })), /轮次/);
    await zeroWrite(c.id, () => run(c.req(two, { reviewSeq: c.reviewSeq - 1 })), /审查结论是/);
    await zeroWrite(c.id, () => run(c.req("A".repeat(40))), /SHA/);
  });
  test("review: P1, changes, same family without exemption, no author family, unauthorised CLI source, pool claim without receipt", async () => {
    const p1 = card({ review: { verdict: "pass", p1: 1, findings: [{ findingId: "f1", family: "x", severity: "P1", probe: "src/a.ts:1" }] } });
    await zeroWrite(p1.id, () => run(p1.req(two)), /P0\/P1/);
    // "changes" with no findings is arbitrated to pass (review-arbiter.ts); one standing P2 keeps it "changes"
    const changes = card({ review: { verdict: "changes", p2: 1, findings: [{ findingId: "f2", family: "x", severity: "P2", probe: "src/a.ts:2" }] } });
    await zeroWrite(changes.id, () => run(changes.req(two)), /不是 pass/);
    const same = card({ family: "codex" });
    await zeroWrite(same.id, () => run(same.req(two)), /同家族/);
    const legacy = card({ workflow: false });
    await zeroWrite(legacy.id, () => run(legacy.req(two)), /家族证据/);
    const forged = card({ actor: "agent-author" });
    await zeroWrite(forged.id, () => run(forged.req(two)), /PM 代记/);
    const pool = card({ review: { reviewer: "peer:x", reviewerSessionId: "lend:o1" }, actor: "pm" });
    await zeroWrite(pool.id, () => run(pool.req(two)), /出借池/);
    const pmRecorded = card({ actor: "pm" });
    expect(await run(pmRecorded.req(two), "observe")).toMatchObject({ status: "observe", plan: { sourceKind: "cli" } });
  });
  test("source kind is read from the event: a real MCP verdict is mcp; a CLI row with via=mcp but no ticket key stays cli", async () => {
    const mcp = card({ review: { via: "mcp", orderId: "ord-1" }, dedupKey: verdictKey({ orderId: "ord-1", head: oldHead }) });
    expect(await run(mcp.req(two), "observe")).toMatchObject({ plan: { sourceKind: "mcp" } });
    const fake = card({ review: { via: "mcp", orderId: "ord-2" } });
    expect(await run(fake.req(two), "observe")).toMatchObject({ plan: { sourceKind: "cli" } });
  });
  test("merge gates: owner hold, frozen queue, merge journal unknown / engine run, slot holder, UI evidence missing", async () => {
    const frozen = card();
    db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'queueFrozen', ?) ON CONFLICT (project, key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ frozen: true, reason: "x", since: 1 }));
    try { await zeroWrite(frozen.id, () => run(frozen.req(two)), /冻结/); }
    finally { db.query("DELETE FROM meta WHERE project='p' AND key='queueFrozen'").run(); }
    for (const phase of ["unknown", "await_ci"]) {
      const c = card();
      db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
        VALUES (?,?,'p','merge_deploy','merge',1,1,1,1,?,2,'submitted','merge',1,1)`).run(`m-${c.id}`, c.id, oldHead);
      db.query(`INSERT INTO scheduler_merges (intentId,taskId,project,prRef,expectedBranch,reviewedHead,requiredChecks,phase,createdAt,updatedAt)
        VALUES (?,?,'p',?,?,?,'ci',?,1,1)`).run(`m-${c.id}`, c.id, PR, `task/${c.id}`, oldHead, phase);
      await zeroWrite(c.id, () => run(c.req(two)), phase === "unknown" ? /不明/ : /引擎/);
    }
    const slot = card();
    db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
      VALUES (?,?,'p','merge_deploy','merge',1,1,1,1,?,2,'submitted','merge',1,1)`).run(`s-${slot.id}`, slot.id, oldHead);
    db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p','merge:p',?,?,1)").run(slot.id, `s-${slot.id}`);
    try { await zeroWrite(slot.id, () => run(slot.req(two)), /合并槽/); }
    finally { db.query("DELETE FROM scheduler_resources WHERE taskId=?").run(slot.id); }
    const held = card({ reason: "owner_hold: owner 要先看" });
    await zeroWrite(held.id, () => run(held.req(two)), /owner hold/);
    const ui = card({ workflow: "ui" });
    await zeroWrite(ui.id, () => run(ui.req(two)), /UI/);
  });
  test("a forged carry decision (no paired head move under its key) breaks the chain instead of laundering a head", async () => {
    const c = card();
    db.query("UPDATE tasks SET headSHA=? WHERE id=?").run(two, c.id);
    insertEvent(db, { actor: "pm", now: ++clock }, { project: "p", target: c.id, kind: "decision", text: "",
      data: { op: MAIN_CARRY_OP, from: oldHead, to: two, round: 1, specRev: getTask(db, c.id)!.specRev, sourceReviewSeq: c.reviewSeq } }, false);
    const t = getTask(db, c.id)!, evs = listEvents(db, { project: "p", target: c.id });
    expect(formalCarries(t, evs)).toBeNull();
    expect(carriedReview(t, evs)).toMatchObject({ kind: "refused" });
    expect(() => manualCarryGate(db, "pm", { ...c.req(two), oldHead: two, newHead: two }, ++clock)).toThrow(/沿用链/);
  });
});

describe("MAINP2 formal PM carry: the canonical proof decides (real git)", () => {
  test("extra commit, evil merge, off-main parent, main / repository drift and missing objects fail closed with zero writes", async () => {
    await at(two); file("feature", "reviewed\nsmuggled\n"); const extra = await commit("extra functional commit");
    await at(oldHead); await sh("merge", "-q", "--no-commit", "--no-ff", main2); file("feature", "reviewed\nevil\n"); await sh("add", "-A");
    const evil = await treeCommit(await sh("write-tree"), [oldHead, main2]);
    await at(base); file("side", "s\n"); const side = await commit("side only");
    const offMain = await treeCommit(await sh("rev-parse", `${two}^{tree}`), [oldHead, side]);
    const c = card();
    await zeroWrite(c.id, () => run(c.req(extra)), /双亲|合并/);
    await zeroWrite(c.id, () => run(c.req(evil)), /净 diff/);
    await zeroWrite(c.id, () => run(c.req(offMain)), /main/);
    await zeroWrite(c.id, () => run(c.req(two, { mainHead: main1 })), /漂移/);
    await zeroWrite(c.id, () => run(c.req("e".repeat(40))), /证明读取失败|父链/);
    const other = card({ pr: "https://github.com/example/other/pull/9" });
    await zeroWrite(other.id, () => run(other.req(two)), /仓库/);
  });
  test(`bounded chain: ${MAX_CARRY_HOPS} hops carry, 17 refuse`, async () => {
    const mainTree = await sh("rev-parse", `${main2}^{tree}`), featureTree = await sh("rev-parse", `${two}^{tree}`);
    let main = main2, head = two;
    const heads: string[] = [];
    for (let i = 3; i <= 17; i++) {
      main = await treeCommit(mainTree, [main], `main ${i}`);
      head = await treeCommit(featureTree, [head, main], `merge ${i}`); heads.push(head);
    }
    await actualMain(main);
    try {
      const c = card();
      await zeroWrite(c.id, () => run(c.req(head, { mainHead: main })), /链长/);
      expect(await run(c.req(heads.at(-2)!, { mainHead: main }))).toMatchObject({ status: "carried", plan: { hops: 16 } });
    } finally { await actualMain(main2); }
  });
  test("MAINPG1 replay: diff.submodule=log short-prefix gitlink collision refuses; the pure-main chain carries", async () => {
    const [reviewedLink, swapped] = ["1", "2"].map((tail) => `c0ffee0${"0".repeat(32)}${tail}`);
    await at(oldHead);
    await sh("update-index", "--add", "--cacheinfo", `160000,${reviewedLink},module`);
    await sh("commit", "-qm", "reviewed missing gitlink"); const reviewed = await sh("rev-parse", "HEAD");
    await sh("merge", "-q", "--no-edit", main1); const pure1 = await sh("rev-parse", "HEAD");
    await sh("merge", "-q", "--no-edit", main2); const pure2 = await sh("rev-parse", "HEAD");
    await at(pure2); await sh("update-index", "--cacheinfo", `160000,${swapped},module`);
    const evil = await treeCommit(await sh("write-tree"), [reviewed, main2]);
    await sh("config", "diff.submodule", "log");
    try {
      const shown = await Promise.all([reviewed, evil].map((h) => sh("diff", "--no-color", `${main2}...${h}`)));
      expect(shown[0]).toBe(shown[1]);
      const c = card({ head: reviewed });
      await zeroWrite(c.id, () => run(c.req(evil)), /净 diff/);
      expect(await run(c.req(pure2))).toMatchObject({ status: "carried", plan: { hops: 2, from: reviewed, to: pure2 } });
    } finally { await sh("config", "--unset", "diff.submodule"); }
  });
});

describe("MAINP2 CLI and post-merge verify", () => {
  const deps = (actor: string) => ({ db, actor, projectIds: ["p"], autoProjects: () => [], autoDispatch: () => false,
    loadRegistry: async () => ({} as Registry), saveRegistry: async () => {}, now: () => ++clock });
  const args = (c: ReturnType<typeof card>, newHead: string) => {
    const r = c.req(newHead);
    return ["main-carry", c.id, "--old", r.oldHead, "--new", newHead, "--main", r.mainHead, "--spec-rev", String(r.specRev), "--round", "1",
      "--review-seq", String(r.reviewSeq), "--rev", String(r.rev), "--repo-dir", work];
  };
  test("the registered command reads the real policy file (default observe); scheduler identity cannot run it; on carries", async () => {
    const c = card();
    expect(await runLedger(args(c, two), deps("scheduler"))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await runLedger(args(c, two), deps("agent-author"))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await runLedger(args(c, two), deps("pm"))).toMatchObject({ ok: true, status: "observe" });
    expect(getTask(db, c.id)!.headSHA).toBe(oldHead);
    const dir = mkdtempSync(join(tmpdir(), "mainp2-policy-")), path = join(dir, "recovery-policy.json");
    writeFileSync(path, JSON.stringify({ projects: { p: { keys: { mainCarry: "on" } } } }));
    expect(path).not.toBe(RECOVERY_POLICY_PATH);
    const cmd = mainCarryCmds({ policyPath: path })["main-carry"]!;
    const { LedgerCli } = await import("../src/manager/ledger-context.js");
    const { parseLedgerArgs } = await import("../src/manager/ledger-identity.js");
    const parsed = parseLedgerArgs(args(c, two), cmd.valued, cmd.bools);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(await cmd.run(new LedgerCli(deps("pm"), parsed))).toMatchObject({ ok: true, status: "carried" });
    writeFileSync(path, JSON.stringify({ projects: { p: { keys: { mainCarry: "off" } } } }));
    const c2 = card();
    const p2 = parseLedgerArgs(args(c2, two), cmd.valued, cmd.bools);
    if ("error" in p2) throw new Error(p2.error);
    expect(await cmd.run(new LedgerCli(deps("pm"), p2))).toMatchObject({ ok: false, status: "off" });
    expect(getTask(db, c2.id)!.headSHA).toBe(oldHead);
    rmSync(dir, { recursive: true, force: true });
  });
  test("verify: the recorded chain ends at the merged head, every hop's parents hold, the head is on fetched main", async () => {
    const c = card();
    expect(await run(c.req(two))).toMatchObject({ status: "carried" });
    const git = async (a: string[]) => { const r = await runBounded(["git", ...a], { cwd: work, timeoutMs: 30_000 }); return { code: r.code ?? -1, stdout: r.stdout }; };
    expect(await verifyManualCarry(db, c.id, two, git)).toMatchObject({ ok: false, problems: [expect.stringContaining("origin/main")] });
    const merged = await treeCommit(await sh("rev-parse", `${two}^{tree}`), [main2, two], "merge PR");
    await actualMain(merged);
    try {
      expect(await verifyManualCarry(db, c.id, two, git)).toEqual({ ok: true, carries: 1, problems: [] });
      const wrong = await verifyManualCarry(db, c.id, one, git);
      expect(wrong.ok).toBe(false);
      expect(wrong.problems.join()).toContain("台账 head");
      const r = await runLedger(["main-carry-verify", c.id, "--merged-head", two, "--repo-dir", work], deps("pm"));
      expect(r).toMatchObject({ ok: true, carries: 1 });
    } finally { await actualMain(main2); }
  });
});
