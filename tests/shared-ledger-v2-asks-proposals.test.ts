import { afterEach, expect, test } from "bun:test";
import { fixture } from "./shared-ledger-v2-asks-fixture.test.js";
import { readProposals, readAskAudit, proposalDigest } from "../src/shared-ledger/asks/index.js";
import { v2ObjectDigest, type V2Proposal } from "../src/lib/shared-ledger-contract-v2.js";

const fixtures: ReturnType<typeof fixture>[] = [];
const setup = () => { const f = fixture(); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.db.close(); });

test("one pending scope proposal per feature, with proposal/base/expiry bound", () => {
  const f = setup(), result = f.propose(), p = result.proposal!, b = result.ask.bind!;
  expect(b.proposalDigest).toBe(p.proposalDigest);
  expect(b.baseVersion).toBe(p.baseVersion); expect(b.expiresAt).toBe(p.expiresAt);
  expect(result.authorizationDigest).toBe(v2ObjectDigest(b));
  expect(() => f.propose()).toThrow("pending_proposal");
  expect(f.transaction(ctx => readProposals(ctx))).toEqual([p]);
  expect(f.db.query("SELECT * FROM v2_asks").all()).toHaveLength(1);
});
test("owner decision signs and applies graph atomically", () => {
  const f = setup(), result = f.propose();
  const done = f.apply(f.decide(result));
  expect(done.proposal!.state).toBe("approved"); expect(done.ask.decision).toBe("approved");
  expect(done.ask.answeredBy).toBe("person"); expect(f.graph().version).toBe(2);
  expect(f.transaction<unknown[]>(ctx => readAskAudit(ctx, result.proposal!.id))).toHaveLength(2);
  expect(() => f.apply(f.decide(result))).toThrow("conflict");
});
test("separate ask approval does not install graph until dag.decide rechecks", () => {
  const f = setup(), result = f.propose();
  f.apply(f.command("ask.answer", { askId: result.ask.id, bindDigest: result.authorizationDigest }));
  expect(f.graph().version).toBe(1);
  f.apply(f.decide(result)); expect(f.graph().version).toBe(2);
});
for (const drift of ["base", "featureRev", "taskRev", "graph", "expiry"]) {
  test(`approval rejects ${drift} drift without overwriting graph`, () => {
    const f = setup(), result = f.propose();
    f.apply(f.command("ask.answer", { askId: result.ask.id, bindDigest: result.authorizationDigest }));
    if (drift === "base") f.seed("feature", { ...f.f, currentVersion: 2 });
    if (drift === "featureRev") f.seed("feature", { ...f.f, rev: 2 });
    if (drift === "taskRev") f.mutateTask({ rev: 2 });
    if (drift === "graph") f.seed("dag", { ...f.graph(), nodes: [{ ...f.graph().nodes[0], oneLine: "changed" }] });
    if (drift === "expiry") f.setNow(result.ask.expiresAt);
    const before = f.graph(), auditBefore = f.db.query("SELECT * FROM v2_ask_audit").all();
    const command = f.decide(result);
    if (drift === "featureRev") Object.assign(command.payload, { expectedRev: 2 });
    expect(() => f.apply(command)).toThrow(drift === "expiry" ? "authorization_expired" : "conflict");
    expect(f.graph()).toEqual(before);
    expect(f.transaction<V2Proposal[]>(ctx => readProposals(ctx))[0].state).toBe("pending");
    expect(f.db.query("SELECT * FROM v2_ask_audit").all()).toEqual(auditBefore);
  });
}
test("all cards including unbound cards participate in rev snapshot", () => {
  const f = setup(), second = { ...f.t, id: "task-two", rev: 1 };
  f.ports.readTasks = ctx => [f.ports.readTask(ctx, "task"), second];
  const result = f.propose(); second.rev = 2;
  expect(() => f.apply(f.decide(result))).toThrow("conflict"); expect(f.graph().version).toBe(1);
});
test("member and service cannot decide scope proposals", () => {
  const f = setup(), result = f.propose();
  f.setPerson("member"); expect(() => f.apply(f.decide(result))).toThrow("forbidden");
  f.setPerson("person"); f.setService(); expect(() => f.apply(f.decide(result))).toThrow("forbidden");
  expect(f.graph().version).toBe(1);
});
for (const close of ["reject", "cancel", "expire"]) {
  test(`${close} releases pending proposal without graph changes`, () => {
    const f = setup(), result = f.propose();
    if (close === "reject") f.apply(f.decide(result, "rejected"));
    else {
      if (close === "expire") f.setNow(result.ask.expiresAt);
      f.apply(f.command(close === "expire" ? "ask.expire" : "ask.cancel", {
        askId: result.ask.id, bindDigest: result.authorizationDigest,
      }));
    }
    expect(f.transaction<V2Proposal[]>(ctx => readProposals(ctx))[0].state).toBe(close === "reject" ? "rejected" : close === "cancel" ? "void" : "expired");
    expect(f.graph().version).toBe(1);
    f.setNow(2001); expect(f.propose().proposal!.state).toBe("pending");
  });
}
test("ask rejection also releases pending and cannot later become approved", () => {
  const f = setup(), result = f.propose();
  f.apply(f.command("ask.answer", { askId: result.ask.id, bindDigest: result.authorizationDigest,
    answer: { kind: "option", optionId: "reject" }, decision: "rejected" }));
  expect(() => f.apply(f.decide(result))).toThrow("conflict");
  expect(f.propose().proposal!.state).toBe("pending");
});
test("scope approval cannot reinterpret a reject option as approval", () => {
  const f = setup(), result = f.propose();
  expect(() => f.apply(f.command("ask.answer", { askId: result.ask.id, bindDigest: result.authorizationDigest,
    answer: { kind: "option", optionId: "reject" }, decision: "approved" }))).toThrow("authorization_mismatch");
  expect(f.getAsk(result.ask.id).state).toBe("open");
});
test("revoked approval cannot apply and member cannot revoke it", () => {
  const f = setup(), result = f.propose();
  const signed = f.apply(f.command("ask.answer", { askId: result.ask.id, bindDigest: result.authorizationDigest })).ask;
  const cancel = f.command("ask.cancel", { askId: signed.id, expectedRev: signed.rev, bindDigest: result.authorizationDigest });
  f.setPerson("member"); expect(() => f.apply(cancel)).toThrow("forbidden");
  f.setPerson("person"); f.apply(cancel);
  expect(() => f.apply(f.decide(result))).toThrow("conflict"); expect(f.graph().version).toBe(1);
});
test("proposal summary or base content cannot reuse an old digest", () => {
  const f = setup();
  const c = f.command("dag.propose", { baseDigest: v2ObjectDigest(f.graph()) });
  if (c.type !== "dag.propose") throw Error("fixture");
  c.payload.proposalDigest = proposalDigest(c.payload); c.payload.reasonText = "changed meaning";
  expect(() => f.apply(c)).toThrow("authorization_mismatch");
  c.payload.proposalDigest = proposalDigest(c.payload); c.payload.baseDigest = "f".repeat(64);
  expect(() => f.apply(c)).toThrow("authorization_mismatch");
});
test("foreign ask or mismatched proposal digest cannot authorize scope change", () => {
  const f = setup(), result = f.propose(), other = f.create();
  for (const patch of [{ askId: other.ask.id }, { proposalDigest: "f".repeat(64) }, { baseVersion: 2 }]) {
    const c = f.decide(result); Object.assign(c.payload, patch);
    expect(() => f.apply(c)).toThrow("authorization_mismatch");
  }
  expect(f.graph().version).toBe(1);
});
test("graph/event/receipt errors roll back graph, signature, proposal and audits together", () => {
  for (const failure of ["graph", "event", "receipt"]) {
    const f = setup(), result = f.propose(), before = f.graph();
    const audit = f.db.query("SELECT * FROM v2_ask_audit").all();
    if (failure === "graph") f.failGraph();
    if (failure === "event") f.failEvent();
    expect(() => f.apply(f.decide(result), () => { if (failure === "receipt") throw Error("receipt failed"); })).toThrow();
    expect(f.graph()).toEqual(before); expect(f.getAsk(result.ask.id).state).toBe("open");
    expect(f.transaction<V2Proposal[]>(ctx => readProposals(ctx))[0].state).toBe("pending");
    expect(f.db.query("SELECT * FROM v2_ask_audit").all()).toEqual(audit);
  }
});
