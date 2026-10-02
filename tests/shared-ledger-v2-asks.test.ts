import { afterEach, describe, expect, test } from "bun:test";
import { fixture } from "./shared-ledger-v2-asks-fixture.test.js";
import { readAskAudit, readAsks, authorizationDigest, askBindDigest, type AskCommand } from "../src/shared-ledger/asks/index.js";
import { V2_DTO_FIXTURES } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { v2ObjectDigest } from "../src/lib/shared-ledger-contract-v2.js";

const fixtures: ReturnType<typeof fixture>[] = [];
const setup = () => { const f = fixture(); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.db.close(); });

describe("central business asks", () => {
  test("bind, separate hashes, expiry, signer and immutable audit round-trip", () => {
    const f = setup(), ask = f.create().ask;
    expect(ask.bind).toEqual(f.bind);
    expect(askBindDigest(ask)).toBe(authorizationDigest(f.bind));
    expect(ask.source).toBe("business");
    const signed = f.apply(f.answer(ask)).ask;
    expect(signed.answeredBy).toBe("person");
    expect(signed.answeredAt).toBe(2000);
    expect(f.apply(f.check(signed)).authorizationDigest).toBe(authorizationDigest(f.bind));
    const history = f.transaction<unknown[]>(ctx => readAskAudit(ctx, ask.id));
    expect(history).toHaveLength(2);
    expect(() => f.db.exec("DELETE FROM v2_ask_audit")).toThrow("immutable ask audit");
    expect(f.transaction(ctx => readAsks(ctx))).toEqual([signed]);
  });
  for (const kind of ["permission", "terminal", "model_permission", "auq", "chat", "question"]) {
    test(`rejects local interaction kind ${kind} at command boundary`, () => {
      const f = setup(), c = f.command("ask.create");
      (c.payload as { kind: string }).kind = kind;
      expect(() => f.apply(c)).toThrow("invalid_field");
      expect(f.db.query("SELECT * FROM v2_asks").all()).toHaveLength(0);
    });
  }
  for (const kind of ["decide", "owner_action", "accept"]) {
    test(`business ${kind} carries null bind and validates answers`, () => {
      const f = setup(), ask = f.apply(f.command("ask.create", { kind, bind: null })).ask;
      expect(() => f.apply(f.command("ask.answer", { askId: ask.id, bindDigest: v2ObjectDigest(null) }))).toThrow("invalid_field");
      expect(f.apply(f.answer(ask, "acknowledged")).ask.state).toBe("answered");
    });
  }
  test("member and service representing owner cannot sign", () => {
    const f = setup(), ask = f.create().ask;
    f.setPerson("member"); expect(() => f.apply(f.answer(ask))).toThrow("forbidden");
    f.setPerson("person"); f.setService(); expect(() => f.apply(f.answer(ask))).toThrow("forbidden");
    expect(f.getAsk(ask.id).state).toBe("open");
  });
  test("stale CAS, wrong bind and invalid answers leave no audit changes", () => {
    const f = setup(), ask = f.create().ask;
    for (const [patch, code] of [[{ expectedRev: 2 }, "conflict"], [{ bindDigest: "f".repeat(64) }, "authorization_mismatch"],
      [{ answer: { kind: "option", optionId: "unknown" } }, "invalid_field"]] as const) {
      const c = f.answer(ask); Object.assign(c.payload, patch);
      expect(() => f.apply(c)).toThrow(code);
    }
    expect(f.getAsk(ask.id).rev).toBe(1);
    expect(f.transaction<unknown[]>(ctx => readAskAudit(ctx, ask.id))).toHaveLength(1);
  });
  test("expiry at the exact deadline blocks signing and use, then records expiry", () => {
    const f = setup(), ask = f.create().ask, signed = f.apply(f.answer(ask)).ask;
    f.setNow(ask.expiresAt);
    expect(() => f.apply(f.check(signed))).toThrow("authorization_expired");
    const expired = f.apply(f.command("ask.expire", { askId: ask.id, expectedRev: 2, bindDigest: v2ObjectDigest(ask.bind) })).ask;
    expect(expired.state).toBe("expired"); expect(expired.answeredBy).toBeNull();
    const other = setup(), open = other.create().ask; other.setNow(open.expiresAt);
    expect(() => other.apply(other.answer(open))).toThrow("authorization_expired");
  });
  test("early expiry fails and owner revocation invalidates approved authorization", () => {
    const f = setup(), ask = f.create().ask, signed = f.apply(f.answer(ask)).ask;
    expect(() => f.apply(f.command("ask.expire", { askId: ask.id, expectedRev: 2, bindDigest: v2ObjectDigest(ask.bind) }))).toThrow("conflict");
    const cancel = f.command("ask.cancel", { askId: ask.id, expectedRev: 2, bindDigest: v2ObjectDigest(ask.bind) });
    f.setPerson("member"); expect(() => f.apply(cancel)).toThrow("forbidden");
    f.setPerson("person"); expect(f.apply(cancel).ask.state).toBe("cancelled");
    expect(() => f.apply(f.check(signed))).toThrow("authorization_mismatch");
    expect(f.transaction<unknown[]>(ctx => readAskAudit(ctx, ask.id))).toHaveLength(3);
  });
  for (const field of ["originalDigest", "sharedDigest", "actionDigest", "redactionVersion", "actions"]) {
    test(`old approval cannot authorize altered ${field}`, () => {
      const f = setup(), ask = f.apply(f.answer(f.create().ask)).ask, c = f.check(ask);
      const bind = (c.payload as { bind: Record<string, unknown> }).bind;
      bind[field] = field === "redactionVersion" ? 2 : field === "actions" ? ["release"] : "f".repeat(64);
      expect(() => f.apply(c)).toThrow("authorization_mismatch");
    });
  }
  test("distinct original and shared content hashes are preserved without conflation", () => {
    const f = setup(), sharedDigest = "c".repeat(64);
    f.mutateTask({ spec: { ...f.t.spec, sharedDigest } });
    const ask = f.apply(f.command("ask.create", { bind: { ...f.bind, sharedDigest } })).ask;
    expect(ask.bind!.originalDigest).not.toBe(ask.bind!.sharedDigest);
    expect(f.apply(f.check(f.apply(f.answer(ask)).ask)).authorizationDigest).toBe(v2ObjectDigest(ask.bind));
  });
  test("current task, workflow, content and owner membership are rechecked before use", () => {
    for (const drift of ["rev", "spec", "workflow", "owner"]) {
      const f = setup(), ask = f.apply(f.answer(f.create().ask)).ask;
      if (drift === "rev") f.mutateTask({ rev: 2 });
      if (drift === "spec") f.mutateTask({ spec: { ...f.t.spec, sharedDigest: "f".repeat(64) } });
      if (drift === "workflow") f.seed("workflow", { ...(V2_DTO_FIXTURES.workflow.valid as object), rev: 2 });
      if (drift === "owner") f.seed("owner", { personId: "other" });
      expect(() => f.apply(f.check(ask))).toThrow();
    }
  });
  test("first artifact copy can be approved, but cannot reuse approval for changed bytes or execution", () => {
    const f = setup();
    f.mutateTask({ spec: { ...f.t.spec, sharedDigest: null, artifactId: null, visibility: "home_only" } });
    const bind = { ...f.bind, head: null, actions: ["artifact.share"], originalDigest: "d".repeat(64), sharedDigest: "c".repeat(64) };
    const ask = f.apply(f.command("ask.create", { bind })).ask;
    const signed = f.apply(f.answer(ask)).ask;
    const check = f.command("authorization.check", { askId: ask.id, bind: signed.bind, action: "artifact.share" });
    expect(f.apply(check).authorizationDigest).toBe(v2ObjectDigest(bind));
    expect(() => f.apply(f.command("authorization.check", { askId: ask.id, bind: { ...bind, sharedDigest: "d".repeat(64) },
      action: "artifact.share" }))).toThrow("authorization_mismatch");
    expect(() => f.apply(f.command("ask.create", { bind: { ...bind, actions: ["artifact.share", "merge"] } })))
      .toThrow("authorization_mismatch");
  });
  test("scope, fence, action scope and transaction boundary are enforced", () => {
    const f = setup();
    for (const patch of [{ projectId: "other" }, { epoch: 2 }, { serviceGeneration: 2 }, { bootId: "other" }]) {
      expect(() => f.apply({ ...f.command("ask.create"), ...patch } as AskCommand)).toThrow();
    }
    expect(() => f.domain.applyInTransaction({} as never, f.command("ask.create"))).toThrow("transaction_required");
    expect(() => f.owner.inCallerTransaction(f.scope(), [], ctx => f.domain.applyInTransaction(ctx, f.command("ask.create"))))
      .toThrow("transaction_required");
    const original = f.scope(), scope = { ...original, actor: { ...original.actor, actions: [] } };
    expect(() => f.db.transaction(() => f.owner.inCallerTransaction(scope, [],
      ctx => f.domain.applyInTransaction(ctx, f.command("ask.create"))))()).toThrow("forbidden");
  });
  test("event failure and later caller failure roll back every domain row and event", () => {
    for (const eventFailure of [true, false]) {
      const f = setup(); if (eventFailure) f.failEvent();
      expect(() => f.apply(f.command("ask.create"), () => { throw Error("receipt failed"); })).toThrow();
      for (const table of ["v2_asks", "v2_ask_audit", "fixture_events"]) expect(f.db.query(`SELECT * FROM ${table}`).all()).toHaveLength(0);
    }
  });
});
