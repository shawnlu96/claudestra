import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { autoFixture, H1 } from "./scheduler-auto-helpers.js";
import { createTask } from "../src/lib/ledger-write.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { holdWriteLease } from "../src/lib/ledger-lend-lease.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { prepareLendAuthor } from "../src/lib/lend-author-retire-tick.js";
import { RECOVERY_POLICY_PATH, type RecoveryMode } from "../src/lib/recovery-policy.js";
import type { LocalAuthorEnv } from "../src/lib/scheduler-local-author.js";
import type { ReadLendHead } from "../src/lib/lend-author-retire-read.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function fixture(mode: RecoveryMode) {
  const f = autoFixture(); cleanup.push(f.close);
  const previous = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH) : undefined;
  cleanup.push(() => previous ? writeFileSync(RECOVERY_POLICY_PATH, previous) : unlinkSync(RECOVERY_POLICY_PATH));
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { lendAuthorRebuild: mode } } } }));
  f.db.run("INSERT INTO meta(project,key,value) VALUES ('p','team',?)", [JSON.stringify({ dispatcher: "dispatch", sinceSeq: 1 })]);
  f.db.run("UPDATE meta SET value='[\"pm\",\"dispatch\"]' WHERE project='p' AND key='pms'");
  const add = (id: string, lease: "held" | "ended", order: string) => {
    if (id !== "T1") {
      createTask(f.db, { actor: "owner" }, { project: "p", id, title: id, kind: "code" });
      setWorkflow(f.db, { actor: "owner" }, { taskId: id, taskRev: 1, template: "code", templateVersion: 2,
        mode: "auto", authorFamily: "claude", fallback: "只报错不修" });
    }
    f.db.run("UPDATE tasks SET stage='fix', headSHA=?, branch=?, agent='remote@mate' WHERE id=?", [H1, `lend/${id}-abcd`, id]);
    f.db.run(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
      VALUES (?,?,'p','fix','ensure_session',1,1,1,1,?,2,'done','seed',1,1)`, [`old-${id}`, id, H1]);
    f.db.run(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
      VALUES (?,'author','remote@mate',?,'claude','peer','active',?,1,1)`, [id, `peer-${id}`, `old-${id}`]);
    f.db.run(`INSERT INTO lend_orders(orderId,taskId,project,peer,family,step,specRev,round,head,repo,wire,text,sha256,status,worker,
      leaseGen,leaseMs,createdBy,createdAt,updatedAt,branch) VALUES (?,?,'p','mate','claude','fix',1,0,?,'example/repo','{}','','',
      ?,'remote',1,1000,'pm',1,1,?)`, [`O-${id}`, id, H1, order, `lend/${id}-abcd`]);
    holdWriteLease(f.db, getTask(f.db, id)!, { peer: "mate", fp: "abcd-ef01-2345-6789", repo: "example/repo", branch: `lend/${id}-abcd` }, 1);
    f.db.run("UPDATE lend_write_leases SET state=? WHERE taskId=?", [lease, id]);
  };
  const children: string[] = [];
  const env: LocalAuthorEnv = { db: f.reader.get()!, registryRow: () => undefined, worktreeRoot: f.dir,
    active: () => {}, git: async () => ({ code: 0, out: "" }), create: async () => ({ ok: false }),
    ledger: (...args) => { children.push(args[2]!); return f.cli("scheduler", ...args.slice(1)); } };
  const blocked = (id: string) => listEvents(f.db, { target: id }).filter(e => e.data.op === "lend_author_blocked");
  return { ...f, add, env, children, blocked };
}

test.each(["observe", "on"] as const)("%s: a held write lease is not a retirement candidate; ended+unproven is throttled", async mode => {
  const f = fixture(mode); f.add("T1", "held", "claimed"); f.add("T2", "ended", "unknown");
  let reads = 0, now = 1_000_000;
  const deps = { now: () => now, readHead: (async () => { reads++; return { ok: true, head: H1 }; }) as ReadLendHead };
  for (let n = 0; n < 3; n++) {
    for (const id of ["T1", "T2"]) await prepareLendAuthor(f.env, getTask(f.db, id)!, deps);
    now += 60_000;
  }
  expect(f.children.filter(id => id === "T1")).toHaveLength(0);
  expect(f.blocked("T1")).toHaveLength(0);
  expect(f.children.filter(id => id === "T2")).toHaveLength(1);
  expect(f.blocked("T2")).toHaveLength(1);
  expect(reads).toBe(0);
  expect(getSchedulerSession(f.db, "T1", "author")?.state).toBe("active");
});

test.each([["dispatch", 0], ["owner", 1]] as const)("on: lend-reclaim by %s reads remote %d times", async (actor, expected) => {
  const f = fixture("on"); f.add("T1", "held", "claimed");
  let reads = 0;
  const lend = { borrow: async () => [], notifyPm: async () => {}, result: { remoteHead: (async () => { reads++; return { ok: true, head: H1 }; }) as ReadLendHead,
    reportDir: () => "unused", writeReport: () => {}, sign: () => ({ key: "unused", sig: "unused" }) } };
  expect(await f.cliWith({ lend }, actor, "lend-reclaim", "T1", "--reason", "test")).toMatchObject({ ok: true });
  expect(reads).toBe(expected);
  expect(f.db.query("SELECT state FROM lend_write_leases").get()).toEqual({ state: "ended" });
  expect(getSchedulerSession(f.db, "T1", "author")?.state).toBe(actor === "dispatch" ? "active" : "retired");
  if (actor === "dispatch") expect(f.blocked("T1")[0]?.text).toContain("身份不符");
});

test("lend-reclaim by a non-manager is refused before any remote read", async () => {
  const f = fixture("on"); f.add("T1", "held", "claimed");
  let reads = 0;
  const lend = { borrow: async () => [], notifyPm: async () => {}, result: { remoteHead: (async () => { reads++; return { ok: true, head: H1 }; }) as ReadLendHead,
    reportDir: () => "unused", writeReport: () => {}, sign: () => ({ key: "unused", sig: "unused" }) } };
  expect(await f.cliWith({ lend }, "intruder", "lend-reclaim", "T1", "--reason", "test")).toMatchObject({ ok: false, error: expect.stringContaining("收回写代码") });
  expect(reads).toBe(0);
  expect(f.db.query("SELECT state FROM lend_write_leases").get()).toEqual({ state: "held" });
});
