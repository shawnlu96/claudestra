/** CVREBOR1 CONV reborrow fixture shared by tests/lend-reborrow-conv*.test.ts: real scheduler CONV end over an isolated CLI lab. */
import { expect } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { instanceKeySync, keyFingerprint } from "../src/lib/instance-key.js";
import { getLendOrder, listLendOrders } from "../src/lib/ledger-lend.js";
import { getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { getIntent, getWorkflow } from "../src/lib/ledger-scheduler.js";
import { planIntent, setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { setRemoteConvergenceContext } from "../src/lib/fix-strategy-remote-context.js";
import type { ConvergenceLifecycle } from "../src/lib/fix-strategy-lifecycle.js";
import { writeLab, writeResources } from "./lend-write-fixture.js";

type Family = "codex" | "claude";
export let resources: ReturnType<typeof writeResources>, lab: ReturnType<typeof writeLab>;
export let db: ReturnType<typeof openLedger>, dbPath: string, fp: string, endSeq: number, reviewed: string, branch: string, oldId: string;
export let intentId: string, origin: Family = "codex";
export const target = (): Family => origin === "codex" ? "claude" : "codex";
const manager = join(import.meta.dir, "../src/manager.ts");
const P1 = { findingId: "keep-auth", family: "security", severity: "P1", probe: "[验收线 1] auth bypass reproduces" };

export function parse(r: { stdout: Buffer; stderr: Buffer }) {
  const line = r.stdout.toString().trim().split("\n").at(-1);
  if (!line) throw new Error(r.stderr.toString());
  return JSON.parse(line) as Record<string, any>;
}
export const argv = (...args: string[]) => [process.execPath, "--no-env-file", manager, "ledger", ...args];
export const cli = (...args: string[]) => parse(Bun.spawnSync(argv(...args), { cwd: lab.root, env: lab.env, stdout: "pipe", stderr: "pipe" }));
export const peer = (ep: string, body: object) => cli(`lend-${ep}`, "--", "mate", JSON.stringify({ v: 1, ...body }));
export const base = () => ["lend-offer", "T1", "--peer", "mate", "--repo", "o/r", "--reborrow"];
export const conv = (...extra: string[]) => cli(...base(), "--conv-end", String(endSeq), ...extra);
export const orders = () => listLendOrders(db, "T1");
export const snapshot = () => JSON.stringify([getTask(db, "T1"), orders(), getWriteLease(db, "T1"), listEvents(db, { target: "T1" }),
  db.query("SELECT * FROM scheduler_intents ORDER BY id").all()]);
export const claim = (id: string) => peer("claim", { orderId: id, worker: "writer" });
export function deliver(id: string, head: string, family: Family, gen = 1) {
  return peer("write", { orderId: id, gen, branch, pr: 7, session: { id: `session-${id}`, family },
    deliver: { v: 1, orderId: id, head, evidence: branch, summary: "Delivered", selfCheck: "All acceptance lines checked" } });
}
export function hello(slots = { codex: 4, claude: 4 }, until = Date.now() + 3600_000) {
  expect(peer("hello", { proto: 3, boot: "fixture-boot", seq: Date.now(), paused: null,
    slots: { codex: { total: slots.codex, busy: 0 }, claude: { total: slots.claude, busy: 0 } },
    grant: { until, roles: ["write"], repos: ["o/r"], ordersPerDay: 50, ordersLeftToday: 50 } })).toMatchObject({ ok: true });
}
function fakeGh() {
  const bin = join(lab.root, "bin"); mkdirSync(bin);
  const file = join(bin, "gh");
  writeFileSync(file, `#!${process.execPath}\nconst a=process.argv.slice(2);\n` +
    `if(a[0]==='pr'&&a[1]==='list') console.log(JSON.stringify([{number:7,url:'https://github.com/o/r/pull/7',` +
    `headRefName:${JSON.stringify(branch)},headRefOid:${JSON.stringify(lab.git(lab.seed, "rev-parse", "HEAD"))},baseRefName:'main',isCrossRepository:false}]));\n` +
    `else process.exit(1);\n` +
    // Drift probe: the first source read appends a real ledger event, i.e. the card changes while preparation is outside the lock.
    `const fs=require('node:fs');const flag=${JSON.stringify(join(lab.root, "drift-flag"))};\n` +
    `if(fs.existsSync(flag)){fs.rmSync(flag);const {Database}=require('bun:sqlite');const d=new Database(${JSON.stringify(dbPath)});\n` +
    `d.run("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (?,'owner','p','T1','note','drift','{}')",[Date.now()]);d.close();}\n` +
    // Material drift probe: the frozen CONV material file is rewritten after preparation hashed it, before the canonical CAS.
    `const mflag=${JSON.stringify(join(lab.root, "material-flag"))};\n` +
    `if(fs.existsSync(mflag)){fs.appendFileSync(fs.readFileSync(mflag,'utf8'),'\\nedited');fs.rmSync(mflag);}\n`);
  chmodSync(file, 0o755); lab.env.PATH = `${bin}:${lab.env.PATH}`;
}
function review(round: number, head: string) {
  const path = join(lab.root, `review-${round}.md`); writeFileSync(path, `round ${round}: P1 keep-auth still open`);
  db.run("INSERT INTO events (ts,actor,project,target,kind,data) VALUES (?, 'reviewer','p','T1','review',?)", [Date.now(), JSON.stringify({
    round, verdict: "changes", path, head, reviewer: "reviewer", reviewerSessionId: `review-session-${round}`, reviewerFamily: target(),
    p0: 0, p1: 1, p2: 0, findings: [P1] })]);
}
/** Synthetic storage damage / forgery: lift the append-only triggers for this one edit only, then restore them verbatim. */
export function tamper(sql: string, params: unknown[] = []) {
  const triggers = db.query("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'events'").all() as { name: string; sql: string }[];
  for (const t of triggers) db.run(`DROP TRIGGER ${t.name}`);
  try { db.run(sql, params as any[]); } finally { for (const t of triggers) db.run(t.sql); }
}
export const ctx = (actor: string) => ({ actor, now: Date.now() });
/** Materials land in the lab temp dir; no local lifecycle effect is reachable (maxWorkers 0, no borrow peers). */
const lifecycleIn = (root: string): ConvergenceLifecycle => ({
  active: () => {}, registryPath: "", slotLockPath: "", materialRoot: root, worktreeRoot: root,
  registry: () => [], readReport: async (p: string) => `report ${p}`, diffSummary: async (_s: string, a: string | null, b: string) => `diff ${a}..${b}`,
  open: async (_s: string, dir: string) => ({ dir }), authorTree: async () => { throw new Error("no local tree in this fixture"); },
  agents: async () => [], manager: async () => { throw new Error("no local lifecycle effects in this fixture"); },
}) as unknown as ConvergenceLifecycle;

/** Real scheduler convergence until the lease is formally ended, then the PM settles the intent through settleIntent. */
export async function convEnd(settle = true) {
  const notices: string[] = [], lifecycle = lifecycleIn(lab.root);
  setRemoteConvergenceContext(db, { lifecycle, remote: null, borrow: [], source: lab.seed, spec: "spec", maxWorkers: 0,
    notify: async (t) => { notices.push(t); }, remoteHead: async () => ({ ok: true, head: getTask(db, "T1")!.headSHA! }) });
  const task = getTask(db, "T1")!, snap = autoSnapshot(db, task, { registry: [], maxWorkers: 2 }), next = planScheduler(snap);
  if (next.kind !== "intent" || next.action !== "fix_swap") throw new Error(JSON.stringify(next));
  const causalSeq = (db.query("SELECT MAX(seq) AS s FROM events WHERE project = 'p'").get() as { s: number }).s;
  intentId = planIntent(db, ctx("scheduler"), { ...next, recipient: next.recipient ?? undefined, taskId: "T1", taskRev: task.rev,
    workflowRev: getWorkflow(db, "T1")!.rev, causalSeq }).intent.id;
  expect(await fixSwapStep(db, ctx("scheduler"), intentId, lifecycle)).toMatchObject({ step: "waiting" });
  expect(getLendOrder(db, oldId)?.status).toBe("cancelled");
  const o = getLendOrder(db, oldId)!;
  expect(peer("write", { orderId: oldId, gen: 1, cancelAck: { clean: true }, report: "stopped cleanly",
    session: { id: "old-peer-session", family: origin }, verdict: { v: 1, orderId: oldId, head: o.head, verdict: "pass",
      p0: 0, p1: 0, p2: 0, findings: [], reportPath: "cancel.md" } })).toMatchObject({ ok: true });
  expect(await fixSwapStep(db, ctx("scheduler"), intentId, lifecycle)).toMatchObject({ step: "waiting" });
  expect(getWriteLease(db, "T1")?.state).toBe("ended");
  endSeq = listEvents(db, { target: "T1" }).findLast((e) => e.data.op === "fix_strategy_reclaim")!.seq;
  if (settle) settleIntent(db, ctx("owner"), { id: intentId, from: getIntent(db, intentId)!.status, to: "cancelled", receipt: "PM 核对后结清 CONV 换家族意图" });
}

export async function setup(family: Family) {
  origin = family;
  resources = writeResources(); lab = writeLab(resources);
  const state = lab.env.CLAUDESTRA_STATE_DIR, keyDir = join(lab.root, "peer-key"); mkdirSync(keyDir);
  const key = instanceKeySync(keyDir)!; fp = keyFingerprint(key.publicKey);
  const configs = {
    "peers.json": { httpPeers: [{ name: "mate", fp, publicKey: key.publicKey, addedAt: "" }], pendingInvites: [] },
    "registry.json": { socket: "", agents: { "agent-task-one": { runtime: "claude-code", sessionId: "s-one", cwd: lab.seed } } },
    "projects.json": { projects: [{ id: "p", name: "p", dirs: [lab.seed], createdAt: "" }] },
    "lend.json": { version: 2, enabled: true, lend: [], borrow: [{ peer: "mate", fp, projects: ["p"], roles: ["write"], maxOpen: 4 }] },
  };
  for (const [name, value] of Object.entries(configs)) writeFileSync(join(state, name), JSON.stringify(value));
  dbPath = join(state, "ledger.sqlite"); db = openLedger(dbPath);
  const spec = join(lab.root, "spec.md"); writeFileSync(spec, "Keep the auth boundary; preserve every original acceptance.");
  createTask(db, { actor: "owner" }, { project: "p", id: "T1", title: "Conv recovery", kind: "code", spec, extra: { fileGlobs: ["src/x.ts"] } });
  setWorkflow(db, ctx("owner"), { taskId: "T1", taskRev: getTask(db, "T1")!.rev, template: "code", templateVersion: 2, mode: "manual",
    authorFamily: family, fallback: "只报错不修", reasonCode: "pm_hold", reason: "fixture lends the early rounds by hand" });
  db.run("UPDATE tasks SET stage = 'build', round = 0 WHERE id = 'T1'");
  hello();
  const offered = cli("lend-offer", "T1", "--peer", "mate", "--repo", "o/r", "--family", family); expect(offered.ok).toBe(true);
  branch = offered.branch;
  expect(claim(offered.orderId).ok).toBe(true);
  lab.git(lab.seed, "checkout", "-B", branch);
  const h1 = lab.commit(lab.seed, "r1.txt"); lab.git(lab.seed, "push", "-q", lab.bare, branch);
  expect(deliver(offered.orderId, h1, family).ok).toBe(true);
  review(1, h1);
  db.run("UPDATE tasks SET stage = 'fix', round = 1 WHERE id = 'T1'");
  let head = h1;
  for (const round of [2, 3, 4]) {
    const fix = cli("lend-offer", "T1", "--peer", "mate", "--repo", "o/r", "--family", family); expect(fix.ok).toBe(true);
    expect(claim(fix.orderId).ok).toBe(true);
    head = lab.commit(lab.seed, `r${round}.txt`); lab.git(lab.seed, "push", "-q", lab.bare, branch);
    expect(deliver(fix.orderId, head, family).ok).toBe(true);
    review(round, head);
    db.run("UPDATE tasks SET stage = 'fix', round = ? WHERE id = 'T1'", [round]);
  }
  reviewed = head;
  const fix = cli("lend-offer", "T1", "--peer", "mate", "--repo", "o/r", "--family", family); expect(fix.ok).toBe(true);
  oldId = fix.orderId; expect(claim(oldId).ok).toBe(true);
  db.run("UPDATE task_workflows SET mode = 'auto' WHERE taskId = 'T1'");
  fakeGh();
}
