import { reborrowMarker } from "../src/lib/lend-reborrow-marker.js";
/** Isolated preparation, canonical transaction, audit binding and CAS regressions. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createTask, setMeta, setTask } from "../src/lib/ledger-write.js";
import { cardMoved, getLendOrder, offerLend, reclaimLend, type LendOrder } from "../src/lib/ledger-lend.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { assertReborrowAuthority, assertReborrowCas, captureReborrowFacts, type ReborrowFacts } from "../src/lib/lend-reborrow-facts.js";
import { prepareReborrowSource, type ReborrowSource, type ReborrowSourceProbe } from "../src/lib/lend-reborrow-source.js";
import { reborrowEventDraft, reborrowKey, replayReborrow } from "../src/lib/lend-reborrow-event.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { prepareReborrowContext } from "../src/lib/lend-reborrow-context.js";
import { applyReborrow } from "../src/lib/lend-reborrow-apply.js";

const project = "p", taskId = "REBOR", peer = "mate", repo = "owner/repo", fp = "abcd-ef01-2345-6789";
const reviewed = "b".repeat(40), remote = "c".repeat(40);
const branch = "lend/REBOR-abcd", now = 100_000;
const pm = { actor: "agent-pm", now };
const borrow: BorrowEntry = { peer, projects: [project], roles: ["write"], maxOpen: 4 };
let db: Database, facts: ReborrowFacts;

function offerInput() {
  return { taskId, peer, repo, family: "codex" as const, pr: null, spec: "Preserve changes", borrow,
    write: { fp, base: "main", baseSha: reviewed, report: "Original P1 finding" } };
}

function hello() {
  recordHello(db, peer, fp, { v: 1, proto: 3, boot: "test-boot", seq: 1,
    grant: { until: now + 100_000, repos: [repo], roles: ["write"], ordersPerDay: 10, ordersLeftToday: 10 },
    slots: { codex: { total: 4, busy: 0 }, claude: { total: 4, busy: 0 } }, paused: null }, now);
}

beforeEach(() => {
  db = openLedger(":memory:");
  setMeta(db, { actor: "owner", now }, { project, key: "pms", value: [pm.actor] });
  const task = createTask(db, { actor: "owner", now: now - 100 }, { project, id: taskId, title: "Recovery", kind: "code" }).row;
  setTask(db, { actor: "owner", now }, { id: taskId, rev: task.rev, patch: { branch, headSHA: reviewed } });
  db.run("UPDATE tasks SET stage = 'build' WHERE id = ?", [taskId]);
  offerLend(db, { ...pm, now: now - 20 }, offerInput());
  reclaimLend(db, pm, { taskId, reason: "preserve checkpoint before resuming" });
  db.run("UPDATE tasks SET stage = 'fix' WHERE id = ?", [taskId]);
  hello();
  facts = captureReborrowFacts(db, taskId, peer, repo);
});
afterEach(() => closeLedger(":memory:"));

function source(): ReborrowSource {
  return { peer, fp, repo, branch, remoteHead: remote, pr: null };
}

const probe = (s = source()): ReborrowSourceProbe => ({ read: async () => structuredClone(s), isAncestor: async () => true });
const authority = () => assertReborrowAuthority(db, facts, pm.actor, borrow, fp, now);
const cas = () => db.transaction(() => assertReborrowCas(db, facts)).immediate();
const rows = () => JSON.stringify([db.query("SELECT * FROM tasks").all(), db.query("SELECT * FROM lend_write_leases").all(),
  db.query("SELECT * FROM lend_orders").all(), db.query("SELECT * FROM events").all()]);

describe("read-only recovery facts", () => {
  test("PM reclaim retains the complete ended lease and exact reclaim event", () => {
    const before = rows();
    expect(facts.lease).toEqual(getWriteLease(db, taskId)!);
    expect(facts.reclaim.data.lend).toMatchObject({ op: "reclaim", peer, cancelled: facts.previous.orderId });
    expect(facts.task.headSHA).toBe(reviewed);
    expect(facts.family).toBe("codex");
    authority();
    cas();
    expect(rows()).toBe(before);
  });

  test.each(["pooled", "claimed", "unknown"])("rejects %s even on another peer", (status) => {
    db.run("UPDATE lend_orders SET status = ?, peer = 'other'", [status]);
    const before = rows();
    expect(() => captureReborrowFacts(db, taskId, peer, repo)).toThrow("活单或未知结果");
    expect(rows()).toBe(before);
  });

  test("rejects a different peer, repository, or unexplained ended lease", () => {
    expect(() => captureReborrowFacts(db, taskId, "other", repo)).toThrow("peer / 仓库");
    expect(() => captureReborrowFacts(db, taskId, peer, "owner/other")).toThrow("peer / 仓库");
    db.run("UPDATE lend_write_leases SET reason = 'timed out'");
    expect(() => captureReborrowFacts(db, taskId, peer, repo)).toThrow("PM 收回");
  });

  test.each([
    "UPDATE tasks SET rev = rev + 1", "UPDATE tasks SET headSHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
    "UPDATE tasks SET specRev = specRev + 1", "UPDATE tasks SET round = round + 1", "UPDATE tasks SET pr = 'https://github.com/owner/repo/pull/7'",
    "UPDATE lend_write_leases SET prevAssignee = 'someone'", "UPDATE lend_orders SET reason = 'changed'",
  ])("CAS refuses drift: %s", (sql) => {
    db.run(sql);
    const before = rows();
    expect(cas).toThrow();
    expect(rows()).toBe(before);
  });

  test("CAS rejects changed materials and requires a transaction", () => {
    expect(() => assertReborrowCas(db, facts)).toThrow("写事务");
    appendEvent(db, pm, { project, target: taskId, kind: "note", text: "new checkpoint evidence" });
    expect(cas).toThrow("发生变化");
  });

  test("mutating a prepared snapshot cannot replace the ledger facts", () => {
    facts.lease.prevAssignee = "forged";
    expect(cas).toThrow("发生变化");
  });

  test("mismatched timestamp or an executor-authored reclaim is not PM evidence", () => {
    db.run("UPDATE lend_write_leases SET updatedAt = updatedAt + 1");
    expect(() => captureReborrowFacts(db, taskId, peer, repo)).toThrow("PM 收回事件");
    appendEvent(db, { actor: "agent-worker", now: now + 1 }, { project, target: taskId, kind: "note", data: facts.reclaim.data });
    expect(() => captureReborrowFacts(db, taskId, peer, repo)).toThrow("PM 收回事件");
  });

  test("current canonical fix path demonstrates both pending integration points", () => {
    const before = rows();
    expect(() => offerLend(db, pm, offerInput())).toThrow("持有写租约");
    expect(cardMoved(facts.task, { step: "fix", head: remote, specRev: facts.task.specRev, round: facts.task.round })).toBe(true);
    expect(rows()).toBe(before);
  });
});

describe("current authenticated authority", () => {
  test("does not accept an executor or different pinned identity", () => {
    expect(() => assertReborrowAuthority(db, facts, "agent-worker", borrow, fp, now)).toThrow("真实 PM");
    expect(() => assertReborrowAuthority(db, facts, pm.actor, borrow, null, now)).toThrow("认证 peer");
    expect(() => assertReborrowAuthority(db, facts, pm.actor, borrow, "ffff-ffff-ffff-ffff", now)).toThrow("认证 peer");
  });

  test("a dispatcher in the PM list still cannot authorize recovery", () => {
    db.run("INSERT INTO meta (project, key, value) VALUES (?, 'team', ?)", [project, JSON.stringify({ dispatcher: pm.actor, sinceSeq: 1, audit: true })]);
    expect(authority).toThrow("真实 PM");
  });

  test.each([null, { ...borrow, roles: [] }, { ...borrow, peer: "other" }, { ...borrow, priority: "off" as const }])("borrow must remain valid: %j", (b) => {
    expect(() => assertReborrowAuthority(db, facts, pm.actor, b ? { ...b, roles: [...b.roles] } : null, fp, now)).toThrow("borrow");
  });

  test.each([
    "UPDATE lend_peers SET fp = 'ffff-ffff-ffff-ffff'", "UPDATE lend_peers SET helloAt = 9999999", "UPDATE lend_peers SET helloAt = -9999999",
    "UPDATE lend_peers SET grant = NULL", "UPDATE lend_peers SET grant = json_set(grant, '$.until', 0)",
    "UPDATE lend_peers SET grant = json_set(grant, '$.roles', json('[]'))", "UPDATE lend_peers SET grant = json_set(grant, '$.repos', json('[]'))",
  ])("revocation or drift refuses: %s", (sql) => {
    db.run(sql);
    const before = rows();
    expect(authority).toThrow();
    expect(rows()).toBe(before);
  });
});

describe("outside-transaction source reconciliation", () => {
  test("keeps original reviewed head separate from actual remote head", async () => {
    const before = rows(), comparisons: string[] = [];
    const p = probe();
    p.isAncestor = async (_repo, from, to) => { comparisons.push(from); expect(to).toBe(remote); return true; };
    const s = await prepareReborrowSource(facts, p);
    expect(s.remoteHead).toBe(remote);
    expect(facts.task.headSHA).toBe(reviewed);
    expect(comparisons).toEqual([reviewed]);
    expect(rows()).toBe(before);
  });

  test.each([false, null])("unreconciled ancestry %j cannot lose an unpushed checkpoint", async (answer) => {
    await expect(prepareReborrowSource(facts, { ...probe(), isAncestor: async () => answer })).rejects.toThrow("未包含");
  });

  test("remote/identity drift during comparison refuses", async () => {
    const s = source(); let reads = 0;
    await expect(prepareReborrowSource(facts, { ...probe(), read: async () => {
      reads++; return { ...s, fp: reads === 1 ? fp : "ffff-ffff-ffff-ffff" };
    } })).rejects.toThrow("漂移");
  });

  test("a PR must preserve its identity and use main", async () => {
    const s = source();
    s.pr = { number: 7, url: `https://github.com/${repo}/pull/7`, repo, branch, head: remote, base: "main" };
    expect((await prepareReborrowSource(facts, probe(s))).pr?.number).toBe(7);
    s.pr.base = "temporary-base";
    await expect(prepareReborrowSource(facts, probe(s))).rejects.toThrow("main base");
    s.pr.base = "main";
    facts.task.pr = `https://github.com/${repo}/pull/8`;
    await expect(prepareReborrowSource(facts, probe(s))).rejects.toThrow("原 PR");
  });
});

/** Synthetic audit-corruption fixture only; production successors always come from the canonical writer. */
function syntheticSuccessor(s: ReborrowSource): LendOrder {
  const o = structuredClone(facts.previous);
  Object.assign(o, { orderId: `${o.orderId}-successor`, step: "fix", status: "pooled", head: s.remoteHead, pr: s.pr?.number ?? null,
    supersedes: o.orderId, createdBy: pm.actor, createdAt: now + 1, updatedAt: now + 1 });
  Object.assign(o.wire, { orderId: o.orderId, step: o.step, head: o.head, pr: o.pr });
  return o;
}

function insertSuccessorFixture(o: LendOrder): void {
  const row = db.query("SELECT * FROM lend_orders WHERE orderId = ?").get(facts.previous.orderId) as Record<string, string | number | null>;
  Object.assign(row, { orderId: o.orderId, step: o.step, status: o.status, head: o.head, supersedes: o.supersedes, wire: JSON.stringify(o.wire),
    createdBy: o.createdBy, createdAt: o.createdAt, updatedAt: o.updatedAt });
  const keys = Object.keys(row);
  db.run(`INSERT INTO lend_orders (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`, Object.values(row));
}

describe("successor audit binding contract", () => {
  test("canonical orderFor accepts verified recovery without overwriting the reviewed basis", async () => {
    const recovery = await prepareReborrowContext(facts, probe());
    const order = applyReborrow(db, pm, recovery, offerInput(), fp);
    expect(order).toMatchObject({ head: remote, step: "fix", base: "main", supersedes: facts.previous.orderId });
    expect(order.wire.inputs.join("\n")).toContain("Original P1 finding");
    expect(getWriteLease(db, taskId)?.state).toBe("held");
    expect(db.query("SELECT headSHA FROM tasks WHERE id = ?").get(taskId)).toEqual({ headSHA: reviewed });
    expect(replayReborrow(db, facts, recovery.source)?.orderId).toBe(order.orderId);
  });

  test.each(["missing", "wrong-head", "wrong-reclaim", "marker"])("read-side basis refuses %s audit corruption", (bad) => {
    const s = source(), order = syntheticSuccessor(s);
    order.wire.acceptance = bad === "marker" ? [] : [reborrowMarker({ orderId: facts.previous.orderId, gen: facts.previous.leaseGen, reclaimSeq: facts.reclaim.seq })];
    insertSuccessorFixture(order);
    if (bad !== "missing") {
      const draft = structuredClone(reborrowEventDraft(facts, s, order));
      if (bad === "wrong-head") draft.data.lend.ledgerHead = "corrupt";
      if (bad === "wrong-reclaim") draft.data.lend.reclaim.seq = -1;
      appendEvent(db, { ...pm, dedupKey: reborrowKey(taskId, facts.reclaim.seq) }, draft);
    }
    expect(getLendOrder(db, order.orderId)?.reborrowBasis).toBeNull();
    expect(cardMoved(facts.task, getLendOrder(db, order.orderId)!)).toBe(true);
  });

  test("an event append failure rolls back the canonical order and lease", async () => {
    const recovery = await prepareReborrowContext(facts, probe()), before = rows();
    db.run(`CREATE TRIGGER fail_reborrow BEFORE INSERT ON events WHEN json_extract(NEW.data, '$.lend.op') = 'write_reborrow'
      BEGIN SELECT RAISE(ABORT, 'audit failure'); END`);
    expect(() => applyReborrow(db, pm, recovery, offerInput(), fp)).toThrow("audit failure");
    expect(rows()).toBe(before);
    expect(getWriteLease(db, taskId)?.state).toBe("ended");
  });

  test("same request replays after consuming the last slot and after ending", async () => {
    const recovery = await prepareReborrowContext(facts, probe()), input = { ...offerInput(), borrow: { ...borrow, maxOpen: 1 } };
    const order = applyReborrow(db, pm, recovery, input, fp), after = rows();
    expect(applyReborrow(db, pm, recovery, input, fp).orderId).toBe(order.orderId);
    expect(rows()).toBe(after);
    db.run("UPDATE lend_orders SET status = 'done' WHERE orderId = ?", [order.orderId]);
    expect(applyReborrow(db, pm, recovery, input, fp).status).toBe("done");
  });

  test("JSON cannot impersonate an externally verified recovery capability", async () => {
    const recovery = await prepareReborrowContext(facts, probe()), before = rows();
    expect(() => applyReborrow(db, pm, structuredClone(recovery), offerInput(), fp)).toThrow("未经本次");
    expect(rows()).toBe(before);
  });

  test("draft preserves full lease and reclaim evidence without writing anything", () => {
    const before = rows(), s = source(), o = syntheticSuccessor(s), draft = reborrowEventDraft(facts, s, o);
    expect(draft.data.lend.previousLease).toEqual(facts.lease);
    expect(draft.data.lend.reclaim).toEqual(facts.reclaim);
    expect(draft.data.lend).toMatchObject({ ledgerHead: reviewed, head: remote, previousOrderId: facts.previous.orderId, family: "codex" });
    expect(rows()).toBe(before);
    o.family = "claude";
    expect(() => reborrowEventDraft(facts, s, o)).toThrow("未绑定");
  });

  test("duplicate and ended requests resolve the same successor; changed requests refuse", () => {
    const s = source(), o = syntheticSuccessor(s);
    expect(replayReborrow(db, facts, s)).toBeNull();
    insertSuccessorFixture(o);
    appendEvent(db, { ...pm, dedupKey: reborrowKey(taskId, facts.reclaim.seq) }, reborrowEventDraft(facts, s, o));
    expect(replayReborrow(db, facts, s)?.orderId).toBe(o.orderId);
    db.run("UPDATE lend_orders SET status = 'done' WHERE orderId = ?", [o.orderId]);
    expect(replayReborrow(db, facts, s)?.status).toBe("done");
    s.fp = "ffff-ffff-ffff-ffff";
    expect(() => replayReborrow(db, facts, s)).toThrow("不同的接续请求");
  });

  test("a rollback discards the synthetic successor and its canonical audit event", () => {
    const before = rows(), s = source(), o = syntheticSuccessor(s);
    expect(() => db.transaction(() => {
      assertReborrowCas(db, facts);
      insertSuccessorFixture(o);
      appendEvent(db, { ...pm, dedupKey: reborrowKey(taskId, facts.reclaim.seq) }, reborrowEventDraft(facts, s, o));
      throw new Error("rollback probe");
    }).immediate()).toThrow("rollback probe");
    expect(getLendOrder(db, o.orderId)).toBeNull();
    expect(replayReborrow(db, facts, s)).toBeNull();
    expect(rows()).toBe(before);
  });
});
