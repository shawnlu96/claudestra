import { afterEach, expect, test } from "bun:test";
import { autoFixture, H1 } from "./scheduler-auto-helpers.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { holdWriteLease } from "../src/lib/ledger-lend-lease.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { lendAuthorBasis, lendAuthorFence, proveLendAuthorRetire } from "../src/lib/lend-author-retire-proof.js";
import { LEND_AUTHOR_CLI_PORTS } from "../src/lib/lend-author-retire-cmds.js";
import { retireLendAuthor } from "../src/lib/lend-author-retire-write.js";

const fixtures: ReturnType<typeof autoFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });

function fixture() {
  const f = autoFixture(); fixtures.push(f);
  f.db.run("UPDATE tasks SET stage='fix', headSHA=?, branch='lend/T1-abcd', agent='remote@mate' WHERE id='T1'", [H1]);
  f.db.run(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
    VALUES ('old','T1','p','fix','ensure_session',1,1,1,1,?,2,'done','seed',1,1)`, [H1]);
  f.db.run(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES ('T1','author','remote@mate','peer-s','claude','peer','active','old',1,1)`);
  f.db.run(`INSERT INTO lend_orders (orderId,taskId,project,peer,family,step,specRev,round,head,repo,wire,text,sha256,status,worker,
    leaseGen,leaseMs,createdBy,createdAt,updatedAt,branch) VALUES ('O','T1','p','mate','claude','fix',1,0,?,'example/repo','{}','','',
    'cancelled','remote',1,1000,'pm',1,1,'lend/T1-abcd')`, [H1]);
  holdWriteLease(f.db, getTask(f.db, "T1")!, { peer: "mate", fp: "abcd-ef01-2345-6789", branch: "lend/T1-abcd", repo: "example/repo" }, 1);
  f.db.run("UPDATE lend_write_leases SET state='ended' WHERE taskId='T1'");
  const fence = () => lendAuthorFence(getTask(f.db, "T1")!, getSchedulerSession(f.db, "T1", "author")!);
  const sample = () => ({ ...fence(), basis: lendAuthorBasis(f.db, "T1"), heads: [{ repo: "example/repo", branch: "lend/T1-abcd", head: H1 }] });
  return { ...f, fence, sample };
}

test("ended lease: on retires only the matching peer author, preserving reviewer and other extra", () => {
  const f = fixture();
  f.db.run("UPDATE tasks SET extra=? WHERE id='T1'", [JSON.stringify({ placement: "peer:mate", keep: 7 })]);
  const result = retireLendAuthor(f.db, { actor: "scheduler" }, f.sample(), { ...LEND_AUTHOR_CLI_PORTS, policy: () => ({ mode: "on", manualAfterMs: null, source: "default" }) });
  expect(result.ok).toBe(true);
  expect(getSchedulerSession(f.db, "T1", "author")?.state).toBe("retired");
  expect(getTask(f.db, "T1")).toMatchObject({ agent: null, headSHA: H1, extra: { keep: 7 } });
  expect(listEvents(f.db, { target: "T1" }).filter(e => e.data.op === "lend_author_retire")).toHaveLength(1);
});

test.each(["pooled", "claimed", "unknown"])("%s write order blocks retirement even with ended lease", status => {
  const f = fixture(); f.db.run("UPDATE lend_orders SET status=? WHERE orderId='O'", [status]);
  expect(proveLendAuthorRetire(f.db, f.sample())).toMatchObject({ ok: false, reason: expect.stringContaining(status) });
  expect(retireLendAuthor(f.db, { actor: "scheduler" }, f.sample(),
    { ...LEND_AUTHOR_CLI_PORTS, policy: () => ({ mode: "on", manualAfterMs: null, source: "default" }) })).toMatchObject({ ok: false });
  expect(getSchedulerSession(f.db, "T1", "author")?.state).toBe("active");
});

test("held lease, revision drift, wrong binding and unreadable/different remote head fail closed", () => {
  const f = fixture(), s = f.sample();
  for (const patch of [{ rev: s.rev + 1 }, { specRev: s.specRev + 1 }, { head: "2".repeat(40) }, { sessionId: "other" },
    { heads: [] }, { heads: [{ repo: "example/repo", branch: "lend/T1-abcd", head: "2".repeat(40) }] }]) {
    expect(proveLendAuthorRetire(f.db, { ...s, ...patch }).ok).toBe(false);
  }
  f.db.run("UPDATE lend_write_leases SET state='held' WHERE taskId='T1'");
  expect(proveLendAuthorRetire(f.db, f.sample())).toMatchObject({ ok: false, reason: expect.stringContaining("held") });
});

test("worker@peer correspondence is mandatory", () => {
  const f = fixture(); f.db.run("UPDATE lend_orders SET worker='another' WHERE orderId='O'");
  expect(proveLendAuthorRetire(f.db, f.sample())).toMatchObject({ ok: false, reason: expect.stringContaining("worker@peer") });
});

test("non scheduler / non PM cannot retire, and rejection leaves lease and binding unchanged", () => {
  const f = fixture();
  expect(() => retireLendAuthor(f.db, { actor: "intruder" }, f.sample(), LEND_AUTHOR_CLI_PORTS)).toThrow("PM");
  expect(getSchedulerSession(f.db, "T1", "author")?.state).toBe("active");
  expect(f.db.query("SELECT state FROM lend_write_leases WHERE taskId='T1'").get()).toEqual({ state: "ended" });
});


test("lease/order generation drift invalidates the remote sample", () => {
  const f = fixture(), old = f.sample();
  f.db.run("UPDATE lend_orders SET leaseGen=leaseGen+1 WHERE orderId='O'");
  expect(proveLendAuthorRetire(f.db, old)).toMatchObject({ ok: false, reason: expect.stringContaining("lease/order") });
});

test("the registered CLI command rejects a non scheduler / non PM actor", async () => {
  const f = fixture(), s = f.sample();
  expect(await f.cli("intruder", "scheduler-lend-author-retire", "T1", "--rev", String(s.rev), "--spec-rev", String(s.specRev),
    "--head", s.head!, "--session", s.sessionId, "--basis", s.basis, "--heads", JSON.stringify(s.heads))).toMatchObject({ ok: false, code: "forbidden" });
  expect(getSchedulerSession(f.db, "T1", "author")?.state).toBe("active");
});
