/**
 * WEXT1 live-extend on a real temporary ledger: the live lent author is built only through production writers (planIntent,
 * offerLendCore, claimLend, settleIntent); the one scheduler pool link is written exactly as scheduler-pool's offer writes it.
 */
import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extendLiveWriterScope, type LiveExtendInput } from "../src/lib/ledger-writer-scope-extend.js";
import { reconcileFileScope } from "../src/lib/ledger-resource-scope.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask, deliver, moveStage, setMeta, setTask } from "../src/lib/ledger-write.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { planIntent, setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { claimLend, offerLendCore, reclaimLend } from "../src/lib/ledger-lend.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { poolLinkKey } from "../src/lib/scheduler-pool-facts.js";
import { bindSchedulerSession } from "../src/lib/scheduler-sessions.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { isWriteInvocation } from "../src/manager/write-commands.js";
import { testChildEnv } from "./test-env.js";

const peer = "mate", fp = "abcd-ef01-2345-6789", repo = "o/r", NOW = 1_000_000;
const pm = { actor: "agent-pm", now: NOW }, owner = { actor: "owner", now: NOW }, sched = { actor: "scheduler", now: NOW };
const borrow: BorrowEntry = { peer, projects: ["p"], roles: ["write"], maxOpen: 4 };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const f of cleanups.splice(0)) f(); });

/** One auto card in build, written by `peer`'s worker w1 under a held lease; fileGlobs then approved wider than the dispatch. */
function liveCard(db: Database, id: string, planned: string[], approved: string[], now = NOW, offerFp = fp): { intentId: string; orderId: string } {
  const owner = { actor: "owner", now }, pm = { actor: "agent-pm", now }, sched = { actor: "scheduler", now };
  createTask(db, owner, { project: "p", id, title: id, kind: "code", extra: { fileGlobs: planned } });
  setWorkflow(db, owner, { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "manual" });
  moveStage(db, owner, { taskId: id, from: "spec", to: "restate" });
  moveStage(db, owner, { taskId: id, from: "restate", to: "build" });
  const causalSeq = (db.query("SELECT MAX(seq) AS n FROM events WHERE project = 'p'").get() as { n: number }).n;
  const intentId = `${id}-write`;
  planIntent(db, pm, { id: intentId, taskId: id, taskRev: getTask(db, id)!.rev, workflowRev: getWorkflow(db, id)!.rev, causalSeq, node: "write",
    action: "dispatch", recipient: `peer:${peer}`, reason: "pool write", resources: planned });
  const order = offerLendCore(db, sched, { taskId: id, peer, family: "codex", repo, pr: null, spec: "spec text", borrow,
    write: { fp: offerFp, base: "main", baseSha: "b".repeat(40), report: null } });
  insertEvent(db, { ...sched, dedupKey: poolLinkKey(intentId) }, { project: "p", target: id, kind: "scheduler", text: "pool",
    data: { op: "pool_offer", id: intentId, orderId: order.orderId, peer, family: "codex", round: order.round, head: null, step: order.step } }, true);
  claimLend(db, owner, peer, { v: 1, orderId: order.orderId, worker: "w1" }, () => borrow);
  settleIntent(db, sched, { id: intentId, from: "pending", to: "submitted", receipt: "claimed" });
  setTask(db, owner, { id, rev: getTask(db, id)!.rev, patch: { extra: { fileGlobs: approved } } });
  return { intentId, orderId: order.orderId };
}

function fixture(now = NOW) {
  const dir = mkdtempSync(join(tmpdir(), "wext-")), path = join(dir, "ledger.sqlite"), registryPath = join(dir, "registry.json");
  const db = openLedger(path);
  cleanups.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(registryPath, JSON.stringify({ agents: { "agent-pm": { channelId: "1", projectId: "p" } } }));
  setMeta(db, owner, { project: "p", key: "pms", value: [pm.actor] });
  recordHello(db, peer, fp, { v: 1, proto: 3, boot: "b", seq: 1, grant: { until: now * 10, repos: [repo], roles: ["write"], ordersPerDay: 9, ordersLeftToday: 9 },
    slots: { codex: { total: 4, busy: 0 }, claude: { total: 4, busy: 0 } }, paused: null }, now);
  const card = liveCard(db, "WX", ["src/a.ts"], ["src/a.ts", "src/b/*", "tests/b.test.ts"], now);
  const input = (over: Partial<LiveExtendInput> = {}): LiveExtendInput => ({ taskId: "WX", project: "p", taskRev: getTask(db, "WX")!.rev,
    workflowRev: getWorkflow(db, "WX")!.rev, reason: "PM approved append", orderId: card.orderId, gen: 1, peer, registryPath, ...over });
  const snapshot = () => ["tasks", "task_steps", "task_workflows", "scheduler_intents", "scheduler_resources", "scheduler_sessions", "lend_orders",
    "lend_write_leases", "events"].map(t => db.query(`SELECT * FROM ${t} ORDER BY rowid`).all());
  const files = (taskId = "WX") => (db.query("SELECT resource, intentId FROM scheduler_resources WHERE taskId = ? AND resource NOT LIKE '%:%' ORDER BY resource")
    .all(taskId) as { resource: string; intentId: string }[]);
  return { db, path, registryPath, card, input, snapshot, files };
}

/** Out-of-band corruption: the append-only triggers are what a real writer cannot bypass. */
const tamper = (f: ReturnType<typeof fixture>, sql: string) => {
  f.db.run("DROP TRIGGER IF EXISTS events_no_update");
  f.db.run("DROP TRIGGER IF EXISTS events_no_delete");
  f.db.run(sql);
};

const refuses = (f: ReturnType<typeof fixture>, run: () => unknown, message?: string) => {
  const before = f.snapshot();
  expect(run).toThrow(message);
  expect(f.snapshot()).toEqual(before);
};

test("preview is read-only; apply appends under the real intent, audits bindings and is replayable as a duplicate", () => {
  const f = fixture(), before = f.snapshot(), lastSeq = (f.db.query("SELECT MAX(seq) AS n FROM events").get() as { n: number }).n;
  const dry = extendLiveWriterScope(f.db, pm, f.input());
  expect(dry).toMatchObject({ ok: true, dryRun: true, executable: true, old: ["src/a.ts"], added: ["src/b/*", "tests/b.test.ts"], retained: [],
    intent: { id: f.card.intentId, status: "submitted" }, order: { orderId: f.card.orderId, peer, worker: "w1", gen: 1, step: "write" },
    lease: { peer, fp, branch: "lend/WX-abcd" }, auditSeq: null });
  expect(f.snapshot()).toEqual(before);
  const done = extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true });
  expect(done).toMatchObject({ ok: true, dryRun: false, duplicate: false, held: ["src/a.ts", "src/b/*", "tests/b.test.ts"] });
  expect(f.files()).toEqual(["src/a.ts", "src/b/*", "tests/b.test.ts"].map(resource => ({ resource, intentId: f.card.intentId })));
  const audit = f.db.query("SELECT actor, kind, text, data FROM events WHERE seq = ?").get(done.auditSeq as number) as { actor: string; kind: string; data: string };
  expect(audit).toMatchObject({ actor: pm.actor, kind: "decision", text: "PM approved append" });
  expect(JSON.parse(audit.data)).toMatchObject({ op: "scheduler_file_scope_extend", intentId: f.card.intentId, orderId: f.card.orderId, gen: 1,
    worker: "w1", fp, branch: "lend/WX-abcd", old: ["src/a.ts"], added: ["src/b/*", "tests/b.test.ts"] });
  // No scheduler dispatch / claim / order / session record is invented; lease, stage, intent and order are untouched.
  expect(f.db.query("SELECT COUNT(*) AS n FROM events WHERE kind IN ('scheduler','note') AND seq > ?").get(lastSeq)).toEqual({ n: 0 });
  expect(f.db.query("SELECT state, peer FROM lend_write_leases").get()).toEqual({ state: "held", peer });
  expect(f.db.query("SELECT status, leaseGen FROM lend_orders").get()).toEqual({ status: "claimed", leaseGen: 1 });
  expect(getTask(f.db, "WX")!.stage).toBe("build");
  const once = f.snapshot();
  expect(extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true })).toMatchObject({ duplicate: true, auditSeq: done.auditSeq, added: [] });
  expect(extendLiveWriterScope(f.db, pm, f.input())).toMatchObject({ dryRun: true, executable: true, duplicate: true, auditSeq: done.auditSeq });
  expect(f.snapshot()).toEqual(once);
  refuses(f, () => extendLiveWriterScope(f.db, pm, { ...f.input(), reason: "other words", apply: true }), "没有可追加");
});

test("narrowed fileGlobs never remove a claim; retained claims are reported", () => {
  const f = fixture();
  setTask(f.db, owner, { id: "WX", rev: getTask(f.db, "WX")!.rev, patch: { extra: { fileGlobs: ["src/b/*"] } } });
  expect(extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true })).toMatchObject({ added: ["src/b/*"], retained: ["src/a.ts"], held: ["src/a.ts", "src/b/*"] });
});

test.each<[string, (f: ReturnType<typeof fixture>) => unknown]>([
  ["foreign actor", f => extendLiveWriterScope(f.db, { actor: "agent-outsider", now: NOW }, { ...f.input(), apply: true })],
  ["scheduler", f => extendLiveWriterScope(f.db, sched, { ...f.input(), apply: true })],
  ["project", f => extendLiveWriterScope(f.db, pm, { ...f.input(), project: "q", apply: true })],
  ["task rev", f => extendLiveWriterScope(f.db, pm, { ...f.input(), taskRev: f.input().taskRev - 1, apply: true })],
  ["workflow rev", f => extendLiveWriterScope(f.db, pm, { ...f.input(), workflowRev: f.input().workflowRev + 1, apply: true })],
  ["gen", f => extendLiveWriterScope(f.db, pm, { ...f.input(), gen: 2, apply: true })],
  ["peer", f => extendLiveWriterScope(f.db, pm, { ...f.input(), peer: "other", apply: true })],
  ["order", f => extendLiveWriterScope(f.db, pm, { ...f.input(), orderId: "lend:WX:s1:r0:a9", apply: true })],
])("identity / CAS: %s refuses with zero writes", (_, run) => {
  const f = fixture();
  refuses(f, () => run(f));
});

test.each([
  ["expired lease", "UPDATE lend_orders SET leaseUntil = 5"],
  ["order unknown", "UPDATE lend_orders SET status = 'unknown'"],
  ["lease ended", "UPDATE lend_write_leases SET state = 'ended'"],
  ["lease on another peer", "UPDATE lend_write_leases SET peer = 'other'"],
  ["fingerprint changed", "UPDATE lend_peers SET fp = 'ffff-0000-0000-0000'"],
  ["intent done", "UPDATE scheduler_intents SET status = 'done'"],
  ["intent cancelled", "UPDATE scheduler_intents SET status = 'cancelled'"],
  ["intent unknown", "UPDATE scheduler_intents SET status = 'unknown'"],
  ["workflow manual", "UPDATE task_workflows SET mode = 'manual'"],
  ["stage review", "UPDATE tasks SET stage = 'review'"],
  ["author replaced", "UPDATE task_steps SET executor = 'w2@mate'"],
  ["second writer step", "INSERT INTO task_steps (taskId, step, round, executor, executorKind, state, verified, claims, createdAt, updatedAt) " +
    "VALUES ('WX', 'fix', 0, 'agent-local', 'agent', 'assigned', '{}', '{}', 1, 1)"],
  ["claim note lost", "DELETE FROM events WHERE kind = 'note' AND json_extract(data, '$.lend.op') = 'claim'"],
  ["pool link lost", "DELETE FROM events WHERE json_extract(data, '$.op') = 'pool_offer'"],
  ["old claim lost", "DELETE FROM scheduler_resources WHERE resource = 'src/a.ts'"],
  ["old claim acquired elsewhere", "UPDATE scheduler_resources SET taskId = 'gone' WHERE resource = 'src/a.ts'"],
])("lost lease / binding / claim: %s refuses with zero writes", (_, sql) => {
  const f = fixture();
  f.db.run("PRAGMA foreign_keys = OFF");
  tamper(f, sql);
  refuses(f, () => extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true }));
  expect(extendLiveWriterScope(f.db, pm, f.input())).toMatchObject({ executable: false });
});

test("a local author session or live registry author on the card is an unknown writer", () => {
  const f = fixture();
  const causalSeq = (f.db.query("SELECT MAX(seq) AS n FROM events WHERE project = 'p'").get() as { n: number }).n;
  f.db.run("UPDATE scheduler_intents SET status = 'done' WHERE id = ?", [f.card.intentId]);
  planIntent(f.db, pm, { id: "ens", taskId: "WX", taskRev: getTask(f.db, "WX")!.rev, workflowRev: getWorkflow(f.db, "WX")!.rev, causalSeq,
    node: "write", action: "ensure_session", reason: "local" });
  settleIntent(f.db, pm, { id: "ens", from: "pending", to: "submitted" });
  writeFileSync(f.registryPath, JSON.stringify({ agents: { "agent-local": { channelId: "8", sessionId: "s-local", status: "dead", runtime: "codex" } } }));
  bindSchedulerSession(f.db, pm, { taskId: "WX", role: "author", intentId: "ens", agent: "agent-local", sessionId: "s-local", family: "codex",
    transport: "tmux", registryPath: f.registryPath });
  settleIntent(f.db, pm, { id: "ens", from: "submitted", to: "done" });
  f.db.run("UPDATE scheduler_intents SET status = 'submitted' WHERE id = ?", [f.card.intentId]);
  refuses(f, () => extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true }), "作者 session");
  f.db.run("DELETE FROM scheduler_sessions");
  writeFileSync(f.registryPath, JSON.stringify({ agents: { "agent-x": { channelId: "9", task: "WX", status: "active" } } }));
  refuses(f, () => extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true }), "registry");
});

test("cross-card glob overlap, special resources and same-card intent resources refuse", () => {
  const f = fixture();
  createTask(f.db, owner, { project: "p", id: "OT", title: "other", kind: "code" });
  setWorkflow(f.db, owner, { taskId: "OT", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "manual" });
  const seq = (f.db.query("SELECT MAX(seq) AS n FROM events WHERE project = 'p'").get() as { n: number }).n;
  planIntent(f.db, pm, { id: "ot", taskId: "OT", taskRev: 1, workflowRev: 1, causalSeq: seq, node: "write", action: "dispatch", reason: "x", resources: ["src/b/c.ts"] });
  refuses(f, () => extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true }), "冲突");
  expect(extendLiveWriterScope(f.db, pm, f.input()).conflicts).toEqual([{ resource: "src/b/*", held: "src/b/c.ts", taskId: "OT" }]);
  f.db.run("DELETE FROM scheduler_resources WHERE taskId = 'OT'");
  f.db.run("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', 'tests/*', 'WX', ?, 1, 'intent')", [f.card.intentId]);
  refuses(f, () => extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true }), "冲突");
  f.db.run("DELETE FROM scheduler_resources WHERE resource = 'tests/*'");
  setTask(f.db, owner, { id: "WX", rev: getTask(f.db, "WX")!.rev, patch: { extra: { fileGlobs: ["src/a.ts", "merge:p"] } } });
  refuses(f, () => extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true }), "fileGlobs");
});

test("two competing applications: interleaved previews, then exactly one card gets the overlapping glob", () => {
  const f = fixture();
  const other = liveCard(f.db, "WY", ["lib/y.ts"], ["lib/y.ts", "src/b/x.ts"]);
  const y = (apply = false): LiveExtendInput => ({ taskId: "WY", project: "p", taskRev: getTask(f.db, "WY")!.rev, workflowRev: getWorkflow(f.db, "WY")!.rev,
    reason: "PM approved", orderId: other.orderId, gen: 1, peer, registryPath: f.registryPath, apply });
  expect(extendLiveWriterScope(f.db, pm, f.input()).executable).toBe(true);
  expect(extendLiveWriterScope(f.db, pm, y()).executable).toBe(true);
  expect(extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true }).duplicate).toBe(false);
  refuses(f, () => extendLiveWriterScope(f.db, pm, y(true)), "冲突");
  expect(f.files("WY")).toEqual([{ resource: "lib/y.ts", intentId: other.intentId }]);
});

test("same-card race over two connections: one append, the other only a duplicate receipt", () => {
  const f = fixture();
  const second = new (f.db.constructor as typeof Database)(f.path);
  cleanups.unshift(() => second.close());
  const a = extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true });
  const b = extendLiveWriterScope(second, pm, { ...f.input(), apply: true });
  expect([a.duplicate, b.duplicate]).toEqual([false, true]);
  expect(b.auditSeq).toBe(a.auditSeq);
  expect(f.db.query("SELECT COUNT(*) AS n FROM events WHERE json_extract(data, '$.op') = 'scheduler_file_scope_extend'").get()).toEqual({ n: 1 });
});

test.each([
  ["forged old", "UPDATE events SET data = json_set(data, '$.old', json('[]')) WHERE json_extract(data, '$.op') = 'scheduler_file_scope_extend'"],
  ["forged gen", "UPDATE events SET data = json_set(data, '$.gen', 7) WHERE json_extract(data, '$.op') = 'scheduler_file_scope_extend'"],
  ["executor actor", "UPDATE events SET actor = 'w1@mate' WHERE json_extract(data, '$.op') = 'scheduler_file_scope_extend'"],
  ["audit lost", "DELETE FROM events WHERE json_extract(data, '$.op') = 'scheduler_file_scope_extend'"],
  ["audit repeated", "INSERT INTO events (ts, actor, project, target, kind, text, data) SELECT ts, actor, project, target, kind, text, data FROM events " +
    "WHERE json_extract(data, '$.op') = 'scheduler_file_scope_extend'"],
])("corrupt extension audit fails closed: %s", (_, sql) => {
  const f = fixture();
  extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true });
  setTask(f.db, owner, { id: "WX", rev: getTask(f.db, "WX")!.rev, patch: { extra: { fileGlobs: ["src/a.ts", "src/b/*", "tests/b.test.ts", "docs/x.md"] } } });
  tamper(f, sql);
  refuses(f, () => extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true }));
});

test("after the writer finishes, the default paused reconciliation replays the extension as real provenance", () => {
  const f = fixture();
  extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true });
  reclaimLend(f.db, pm, { taskId: "WX", reason: "PM takes it back" });
  settleIntent(f.db, pm, { id: f.card.intentId, from: "submitted", to: "cancelled" });
  setWorkflow(f.db, pm, { taskId: "WX", taskRev: getTask(f.db, "WX")!.rev, workflowRev: getWorkflow(f.db, "WX")!.rev, template: "code", templateVersion: 2,
    mode: "manual", authorFamily: getWorkflow(f.db, "WX")!.authorFamily, fallback: "manual", reason: "PM pause" });
  const paused = { taskId: "WX", project: "p", taskRev: getTask(f.db, "WX")!.rev, workflowRev: getWorkflow(f.db, "WX")!.rev, reason: "narrow", registryPath: f.registryPath };
  setTask(f.db, owner, { id: "WX", rev: getTask(f.db, "WX")!.rev, patch: { extra: { fileGlobs: ["src/b/*"] } } });
  const dry = reconcileFileScope(f.db, pm, { ...paused, taskRev: getTask(f.db, "WX")!.rev });
  expect(dry).toMatchObject({ old: ["src/a.ts", "src/b/*", "tests/b.test.ts"], remove: ["src/a.ts", "tests/b.test.ts"], anchors: { "src/b/*": f.card.intentId } });
  expect(dry.reasons.filter(r => /扩范围|来源|失锁/.test(r))).toEqual([]);
  // Forged extension audits are not provenance for the paused path either.
  tamper(f, "UPDATE events SET data = json_set(data, '$.claimSeq', 1) WHERE json_extract(data, '$.op') = 'scheduler_file_scope_extend'");
  expect(reconcileFileScope(f.db, pm, { ...paused, taskRev: getTask(f.db, "WX")!.rev }).reasons).toContain("扩范围审计的出借单 / 领单来源不可核");
});

test("real CLI: explicit --live-extend previews, applies, replays; flags never leak into the default paused mode", async () => {
  const f = fixture(Date.now()), state = join(f.path, ".."), home = join(state, "home");
  writeFileSync(join(state, "registry.json"), JSON.stringify({ agents: { "agent-pm": { channelId: "111", projectId: "p" }, "agent-q": { channelId: "222", projectId: "q" } } }));
  writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: ["p", "q"].map(id => ({ id, name: id, dirs: [state] })) }));
  const base = () => ["--project", "p", "--rev", String(f.input().taskRev), "--workflow-rev", String(f.input().workflowRev), "--reason", "PM approved append"];
  const live = () => ["--live-extend", "--order", f.card.orderId, "--gen", "1", "--peer", peer];
  const cli = async (flags: string[], channel = "111") => {
    const proc = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", join(import.meta.dir, "../src/manager.ts"), "ledger",
      "scheduler-file-scope", "WX", ...flags], { cwd: state, stdout: "pipe", stderr: "pipe", env: testChildEnv({ HOME: home, CODEX_HOME: join(home, ".codex"),
      CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(state, "runtime"), DISCORD_CHANNEL_ID: channel }) });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const last = out.trim().split("\n").at(-1);
    if (!last) throw new Error(err);
    return JSON.parse(last);
  };
  expect(isWriteInvocation("ledger", ["scheduler-file-scope", "WX", ...live()])).toBe(false);
  expect(isWriteInvocation("ledger", ["scheduler-file-scope", "WX", ...live(), "--apply"])).toBe(true);
  const before = f.snapshot();
  for (const flags of [[...base(), ...live()], [...base(), ...live(), "--dry-run"]]) {
    expect(await cli(flags)).toMatchObject({ ok: true, mode: "live-extend", dryRun: true, executable: true, added: ["src/b/*", "tests/b.test.ts"] });
  }
  for (const [flags, channel] of [[[...base(), "--order", f.card.orderId, "--apply"], "111"], [[...base(), "--live-extend", "--order", f.card.orderId,
    "--peer", peer, "--apply"], "111"], [[...base(), ...live(), "--apply"], "222"], [[...base(), ...live(), "--apply", "--dry-run"], "111"]] as const) {
    expect(await cli([...flags], channel)).toMatchObject({ ok: false });
  }
  expect(f.snapshot()).toEqual(before);
  const applied = await cli([...base(), ...live(), "--apply"]);
  expect(applied).toMatchObject({ ok: true, dryRun: false, duplicate: false, old: ["src/a.ts"], added: ["src/b/*", "tests/b.test.ts"],
    held: ["src/a.ts", "src/b/*", "tests/b.test.ts"], intent: { id: f.card.intentId }, order: { orderId: f.card.orderId, gen: 1 } });
  expect(typeof applied.auditSeq).toBe("number");
  expect(f.files().map(r => r.resource)).toEqual(applied.held);
  const once = f.snapshot();
  expect(await cli([...base(), ...live(), "--apply"])).toMatchObject({ ok: true, duplicate: true, auditSeq: applied.auditSeq });
  expect(f.snapshot()).toEqual(once);
});

const extendAudit = "json_extract(data, '$.op') = 'scheduler_file_scope_extend'";
const widen = (f: ReturnType<typeof fixture>) => setTask(f.db, owner, { id: "WX", rev: getTask(f.db, "WX")!.rev,
  patch: { extra: { fileGlobs: ["src/a.ts", "src/b/*", "tests/b.test.ts", "docs/x.md"] } } });

test.each([
  ["approved scope removed", "json_remove(data, '$.fileGlobs')"],
  ["approved scope widened", "json_set(data, '$.fileGlobs', json('[\"docs/x.md\",\"src/a.ts\",\"src/b/*\",\"tests/b.test.ts\"]'))"],
  ["fingerprint", "json_set(data, '$.fp', 'abcd-0000-0000-0000')"],
  ["branch", "json_set(data, '$.branch', 'lend/WX-ffff')"],
  ["CAS / stage removed", "json_remove(data, '$.taskRev', '$.workflowRev', '$.specRev', '$.round', '$.stage')"],
  ["task rev", "json_set(data, '$.taskRev', 3)"],
  ["stage", "json_set(data, '$.stage', 'fix')"],
  ["worker", "json_set(data, '$.worker', 'w9')"],
])("corrupt audit binding fails closed for the next extension and the paused replay: %s", (_, expression) => {
  const f = fixture();
  extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true });
  tamper(f, `UPDATE events SET data = ${expression} WHERE ${extendAudit}`);
  widen(f);
  refuses(f, () => extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true }));
  expect(extendLiveWriterScope(f.db, pm, f.input()).reasons.some(r => r.startsWith("扩范围审计"))).toBe(true);
});

test("a corrupt audit never yields a duplicate receipt", () => {
  const f = fixture();
  extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true });
  tamper(f, `UPDATE events SET data = json_set(data, '$.fp', 'different') WHERE ${extendAudit}`);
  refuses(f, () => extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true }));
  expect(extendLiveWriterScope(f.db, pm, f.input())).toMatchObject({ executable: false, duplicate: false });
});

test("a registry author named by the card or pending restart is an unknown writer, whatever its display title", () => {
  const f = fixture();
  setTask(f.db, owner, { id: "WX", rev: getTask(f.db, "WX")!.rev, patch: { agent: "agent-local" } });
  writeFileSync(f.registryPath, JSON.stringify({ agents: { "agent-local": { channelId: "9", task: "writing this card", status: "active", sessionId: "local-session" } } }));
  refuses(f, () => extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true }), "registry");
  writeFileSync(f.registryPath, JSON.stringify({ agents: { "agent-local": { channelId: "9", task: "writing this card", status: "stopped", acpRestartPending: true } } }));
  refuses(f, () => extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true }), "registry");
  writeFileSync(f.registryPath, JSON.stringify({ agents: { "agent-x": { channelId: "9", task: "WX", status: "stopped", acpRestartPending: true } } }));
  refuses(f, () => extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true }), "registry");
  // A named author that really stopped (no pending restart) is not a writer.
  writeFileSync(f.registryPath, JSON.stringify({ agents: { "agent-local": { channelId: "9", task: "writing this card", status: "stopped" } } }));
  expect(extendLiveWriterScope(f.db, pm, { ...f.input(), taskRev: getTask(f.db, "WX")!.rev, apply: true })).toMatchObject({ duplicate: false });
});

test("a missing current peer fingerprint refuses", () => {
  const f = fixture();
  tamper(f, "UPDATE lend_peers SET fp = NULL");
  refuses(f, () => extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true }), "指纹缺失");
});

test("a foreign glob over a kept (old) claim refuses, on a first append and on a duplicate retry", () => {
  const f = fixture();
  liveCard(f.db, "WY", ["lib/y.ts"], ["lib/y.ts"]);
  setTask(f.db, owner, { id: "WX", rev: getTask(f.db, "WX")!.rev, patch: { extra: { fileGlobs: ["src/a.ts", "docs/x.md"] } } });
  f.db.run("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', 'src/*', 'WY', 'WY-write', 1, 'card')");
  refuses(f, () => extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true }), "冲突");
  expect(extendLiveWriterScope(f.db, pm, f.input()).conflicts).toEqual([{ resource: "src/a.ts", held: "src/*", taskId: "WY" }]);
  f.db.run("DELETE FROM scheduler_resources WHERE resource = 'src/*'");
  expect(extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true })).toMatchObject({ duplicate: false, added: ["docs/x.md"] });
  f.db.run("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', 'src/*', 'WY', 'WY-write', 1, 'card')");
  refuses(f, () => extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true }), "冲突");
  expect(extendLiveWriterScope(f.db, pm, f.input())).toMatchObject({ executable: false, duplicate: false });
});

test("an altered historical workflow CAS is replayed against the card's workflow history and refused", () => {
  const f = fixture();
  expect(f.input().workflowRev).toBe(2); // setWorkflow = 1, claimAuthorFamily (claude → codex) = 2
  extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true });
  tamper(f, `UPDATE events SET data = json_set(data, '$.workflowRev', 1) WHERE ${extendAudit}`);
  widen(f);
  refuses(f, () => extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true }), "workflow rev");
});

test("an author session is the claimed worker only with a done ensure_session and its real peer bind after the claim", () => {
  const f = fixture();
  f.db.run(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
    VALUES ('WX', 'author', 'peer:mate', 'obsolete-worker-session', 'codex', 'peer', 'retiring', ?, 1, 1)`, [f.card.intentId]);
  refuses(f, () => extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true }), "作者 session");
  f.db.run("DELETE FROM scheduler_sessions");
  // The real peer bind: an ensure_session intent of this card, bound by the production writer after the claim, then settled done.
  f.db.run("UPDATE scheduler_intents SET status = 'done' WHERE id = ?", [f.card.intentId]);
  const causalSeq = (f.db.query("SELECT MAX(seq) AS n FROM events WHERE project = 'p'").get() as { n: number }).n;
  planIntent(f.db, pm, { id: "ens", taskId: "WX", taskRev: getTask(f.db, "WX")!.rev, workflowRev: getWorkflow(f.db, "WX")!.rev, causalSeq,
    node: "write", action: "ensure_session", reason: "peer session" });
  settleIntent(f.db, pm, { id: "ens", from: "pending", to: "submitted" });
  bindSchedulerSession(f.db, pm, { taskId: "WX", role: "author", intentId: "ens", agent: `w1@${peer}`, sessionId: "peer-w1", family: "codex",
    transport: "peer", registryPath: f.registryPath });
  settleIntent(f.db, pm, { id: "ens", from: "submitted", to: "done" });
  f.db.run("UPDATE scheduler_intents SET status = 'submitted' WHERE id = ?", [f.card.intentId]);
  expect(extendLiveWriterScope(f.db, pm, f.input())).toMatchObject({ executable: true, reasons: [] });
  for (const sql of ["UPDATE scheduler_sessions SET state = 'retiring'", "UPDATE scheduler_sessions SET agent = 'w2@mate'",
    "UPDATE scheduler_sessions SET sessionId = 'other'", "UPDATE scheduler_intents SET status = 'cancelled' WHERE id = 'ens'"]) {
    f.db.run("SAVEPOINT probe");
    f.db.run(sql);
    refuses(f, () => extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true }), "作者 session");
    f.db.run("ROLLBACK TO probe");
    f.db.run("RELEASE probe");
  }
  tamper(f, "DELETE FROM events WHERE json_extract(data, '$.op') = 'session_bind'");
  refuses(f, () => extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true }), "绑定记录");
});

function rollover(peer2 = "next", fp2 = "dcba-4321-5678-9000") {
  const f = fixture();
  extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true });
  reclaimLend(f.db, pm, { taskId: "WX", reason: "PM ends former author" });
  settleIntent(f.db, pm, { id: f.card.intentId, from: "submitted", to: "cancelled" });
  const borrow2 = { ...borrow, peer: peer2 };
  recordHello(f.db, peer2, fp2, { v: 1, proto: 3, boot: "b", seq: 2, grant: { until: NOW * 10, repos: [repo], roles: ["write"], ordersPerDay: 9, ordersLeftToday: 9 },
    slots: { codex: { total: 4, busy: 0 }, claude: { total: 4, busy: 0 } }, paused: null }, NOW);
  const causalSeq = (f.db.query("SELECT MAX(seq) AS n FROM events WHERE project = 'p'").get() as { n: number }).n;
  planIntent(f.db, pm, { id: "replacement", taskId: "WX", taskRev: getTask(f.db, "WX")!.rev, workflowRev: getWorkflow(f.db, "WX")!.rev, causalSeq,
    node: "write", action: "dispatch", recipient: `peer:${peer2}`, reason: "new author after reclaim", resources: f.files().map(r => r.resource) });
  const order = offerLendCore(f.db, sched, { taskId: "WX", peer: peer2, family: "codex", repo, pr: null, spec: "spec text", borrow: borrow2,
    write: { fp: fp2, base: "main", baseSha: "b".repeat(40), report: null } });
  insertEvent(f.db, { ...sched, dedupKey: poolLinkKey("replacement") }, { project: "p", target: "WX", kind: "scheduler", text: "pool",
    data: { op: "pool_offer", id: "replacement", orderId: order.orderId, peer: peer2, family: "codex", round: order.round, head: null, step: order.step } }, true);
  claimLend(f.db, owner, peer2, { v: 1, orderId: order.orderId, worker: "w2" }, () => borrow2);
  settleIntent(f.db, sched, { id: "replacement", from: "pending", to: "submitted", receipt: "claimed" });
  return { f, order, peer2, fp2 };
}

test("a legitimate reclaim + re-lend keeps past extension provenance for the new author and the paused narrowing", () => {
  const { f, order, peer2, fp2 } = rollover();
  widen(f);
  const next = extendLiveWriterScope(f.db, pm, { ...f.input({ orderId: order.orderId, peer: peer2 }), apply: true });
  expect(next).toMatchObject({ duplicate: false, added: ["docs/x.md"], held: ["docs/x.md", "src/a.ts", "src/b/*", "tests/b.test.ts"],
    lease: { peer: peer2, fp: fp2, branch: "lend/WX-dcba" } });
  reclaimLend(f.db, pm, { taskId: "WX", reason: "PM ends replacement" });
  settleIntent(f.db, pm, { id: "replacement", from: "submitted", to: "cancelled" });
  setWorkflow(f.db, pm, { taskId: "WX", taskRev: getTask(f.db, "WX")!.rev, workflowRev: getWorkflow(f.db, "WX")!.rev,
    template: "code", templateVersion: 2, mode: "manual", authorFamily: "codex", fallback: "manual", reason: "pause for reconciliation" });
  setTask(f.db, owner, { id: "WX", rev: getTask(f.db, "WX")!.rev, patch: { extra: { fileGlobs: ["src/a.ts"] } } });
  const paused = reconcileFileScope(f.db, pm, { taskId: "WX", project: "p", taskRev: getTask(f.db, "WX")!.rev,
    workflowRev: getWorkflow(f.db, "WX")!.rev, reason: "narrow after finished", registryPath: f.registryPath, apply: true });
  expect(paused).toMatchObject({ remove: ["docs/x.md", "src/b/*", "tests/b.test.ts"], reasons: [] });
  expect(f.files().map(r => r.resource)).toEqual(["src/a.ts"]);
});

test("historical fingerprint tail corruption after real rollover refuses with zero writes", () => {
  const { f, order, peer2 } = rollover();
  widen(f);
  tamper(f, `UPDATE events SET data = json_set(data, '$.fp', 'abcd-0000-0000-0000') WHERE ${extendAudit}`);
  const input = f.input({ orderId: order.orderId, peer: peer2 }), before = f.snapshot();
  expect(extendLiveWriterScope(f.db, pm, input).executable).toBe(false);
  expect(f.snapshot()).toEqual(before);
  refuses(f, () => extendLiveWriterScope(f.db, pm, { ...input, apply: true }));
});

for (const [label, expression] of [
  ["missing legacy evidence", "json_remove(data, '$.lend.fp')"],
  ["damaged full fingerprint", "json_set(data, '$.lend.fp', 'abcd-0000-0000-0000')"],
  ["malformed fingerprint", "json_set(data, '$.lend.fp', 7)"],
]) test(`original offer ${label} after rollover refuses with zero writes`, () => {
  const { f, order, peer2 } = rollover();
  widen(f);
  tamper(f, `UPDATE events SET data = ${expression} WHERE json_extract(data, '$.lend.orderId') = '${f.card.orderId}'
    AND json_extract(data, '$.lend.op') = 'offer'`);
  const input = f.input({ orderId: order.orderId, peer: peer2 }), before = f.snapshot();
  expect(extendLiveWriterScope(f.db, pm, input).executable).toBe(false);
  expect(f.snapshot()).toEqual(before);
  refuses(f, () => extendLiveWriterScope(f.db, pm, { ...input, apply: true }));
});

test("a legacy offer without immutable fingerprint fails closed even before rollover", () => {
  const f = fixture();
  tamper(f, "UPDATE events SET data = json_remove(data, '$.lend.fp') WHERE json_extract(data, '$.lend.op') = 'offer'");
  const before = f.snapshot();
  expect(extendLiveWriterScope(f.db, pm, f.input()).executable).toBe(false);
  expect(f.snapshot()).toEqual(before);
  refuses(f, () => extendLiveWriterScope(f.db, pm, { ...f.input(), apply: true }), "原租期完整指纹证据缺失");
});

test("same peer and branch prefix rollover uses original offer identity rather than the overwritten lease", () => {
  const { f, order, peer2, fp2 } = rollover(peer, "abcd-0000-1111-2222");
  widen(f);
  expect(extendLiveWriterScope(f.db, pm, { ...f.input({ orderId: order.orderId, peer: peer2 }), apply: true }))
    .toMatchObject({ added: ["docs/x.md"], lease: { peer: peer2, fp: fp2, branch: "lend/WX-abcd" } });
});

test("formal offer persists the full lease identity in append-only evidence", () => {
  const f = fixture();
  const offer = f.db.query("SELECT data FROM events WHERE json_extract(data, '$.lend.op') = 'offer'").get() as { data: string };
  expect(JSON.parse(offer.data).lend).toMatchObject({ orderId: f.card.orderId, peer, fp, branch: "lend/WX-abcd", step: "write" });
  refuses(f, () => f.db.run("UPDATE events SET data = '{}' WHERE json_extract(data, '$.lend.op') = 'offer'"));
});

for (const mode of ["missing", "duplicate"]) test(`original offer ${mode} is zero-write after rollover`, () => {
  const { f, order, peer2 } = rollover();
  widen(f);
  const where = `json_extract(data, '$.lend.orderId') = '${f.card.orderId}' AND json_extract(data, '$.lend.op') = 'offer'`;
  tamper(f, mode === "missing" ? `DELETE FROM events WHERE ${where}` :
    `INSERT INTO events (ts, actor, project, target, kind, text, data) SELECT ts, actor, project, target, kind, text, data FROM events WHERE ${where}`);
  const input = f.input({ orderId: order.orderId, peer: peer2 }), before = f.snapshot();
  expect(extendLiveWriterScope(f.db, pm, input).executable).toBe(false);
  expect(f.snapshot()).toEqual(before);
  refuses(f, () => extendLiveWriterScope(f.db, pm, { ...input, apply: true }));
});

test("review offer without write input remains valid and records no write fingerprint", () => {
  const f = fixture();
  reclaimLend(f.db, pm, { taskId: "WX", reason: "finish author" });
  settleIntent(f.db, pm, { id: f.card.intentId, from: "submitted", to: "cancelled" });
  deliver(f.db, owner, { taskId: "WX", moveFrom: "build", headSHA: "c".repeat(40), evidence: "synthetic result" });
  const review = offerLendCore(f.db, sched, { taskId: "WX", peer, family: "codex", repo, pr: null, spec: "spec text",
    borrow: { ...borrow, roles: ["review"] } });
  const offers = f.db.query("SELECT data FROM events WHERE json_extract(data, '$.lend.orderId') = ? AND json_extract(data, '$.lend.op') = 'offer'")
    .all(review.orderId) as { data: string }[];
  expect(offers).toHaveLength(1);
  expect(JSON.parse(offers[0]!.data).lend).toEqual({ orderId: review.orderId, peer, op: "offer", step: "review",
    specSha256: createHash("sha256").update("spec text", "utf8").digest("hex") });
});

test("formal producer normalizes its full fingerprint from the same write input", () => {
  const f = fixture();
  const card = liveCard(f.db, "UP", ["src/u.ts"], ["src/u.ts"], NOW, fp.toUpperCase());
  const offer = f.db.query("SELECT data FROM events WHERE json_extract(data, '$.lend.orderId') = ? AND json_extract(data, '$.lend.op') = 'offer'")
    .get(card.orderId) as { data: string };
  expect(JSON.parse(offer.data).lend.fp).toBe(fp);
  expect(f.db.query("SELECT fp FROM lend_write_leases WHERE taskId = 'UP'").get()).toEqual({ fp });
});

test("formal producer rejects invalid write fingerprint without an offer or lease", () => {
  const f = fixture();
  createTask(f.db, owner, { project: "p", id: "BAD", title: "bad fingerprint", kind: "code" });
  moveStage(f.db, owner, { taskId: "BAD", from: "spec", to: "restate" });
  moveStage(f.db, owner, { taskId: "BAD", from: "restate", to: "build" });
  refuses(f, () => offerLendCore(f.db, sched, { taskId: "BAD", peer, family: "codex", repo, pr: null, spec: "spec text", borrow,
    write: { fp: "invalid", base: "main", baseSha: "b".repeat(40), report: null } }));
});
