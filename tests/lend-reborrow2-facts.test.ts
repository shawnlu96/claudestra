/** REBOR2 read-only facts, marker classification, family epoch and authority; every refusal leaves the ledger byte-identical. */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { closeLedger } from "../src/lib/ledger-store.js";
import { appendEvent } from "../src/lib/ledger-write.js";
import { getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { readReborrowBinding } from "../src/lib/lend-reborrow-marker.js";
import { classifyReserved, reborrow2Marker } from "../src/lib/lend-reborrow2-marker.js";
import { HELLO_FRESH_MS } from "../src/lib/lend-wire-v2.js";
import { assertReborrow2Authority, assertReborrow2Cas, captureReborrow2Facts } from "../src/lib/lend-reborrow2-facts.js";
import { borrowOf, fp, fp2, now, other, peer, pm, repo, rows, setupLedger, switchFamily, taskId, type EndKind } from "./lend-reborrow2-fixture.js";

let db: Database;
afterEach(() => closeLedger(":memory:"));
const same = (family: "codex" | "claude" = "codex") => captureReborrow2Facts(db, taskId, { peer, fp, repo, family });
const cross = (family: "codex" | "claude" = "codex") => captureReborrow2Facts(db, taskId, { peer: other, fp: fp2, repo, family });

describe("reserved marker classification", () => {
  const b = { orderId: "lend:RB2:s1:r0:a0", gen: 1, peer: "same" as const, end: "stopped" as const, src: "lend/RB2-abcd", ended: 50 };
  test("v2 round-trips and an old provider's v1 parser refuses it instead of claiming an ordinary order", () => {
    const line = reborrow2Marker(b);
    expect(classifyReserved(["x", line])).toEqual({ kind: "v2", binding: b });
    expect(() => readReborrowBinding([line])).toThrow();
  });
  test.each([
    ["mixed", (l: string) => [l, "[lend-reborrow:v1 old=lend:RB2:s1:r0:a0 gen=1 reclaim=3]"]],
    ["duplicate", (l: string) => [l, l]],
    ["damaged", (l: string) => [l.replace("gen=1", "gen=x")]],
    ["unknown end", (l: string) => [l.replace("end=stopped", "end=whatever")]],
  ])("%s is invalid, never v1 or ordinary", (_name, make) => {
    expect(classifyReserved(make(reborrow2Marker(b))).kind).toBe("invalid");
  });
  test("cross peer may only carry a borrower-proven end", () => {
    expect(() => reborrow2Marker({ ...b, peer: "cross" })).toThrow();
    expect(classifyReserved([reborrow2Marker({ ...b, peer: "cross", end: "not_started" })]).kind).toBe("v2");
  });
  test("v1 and plain acceptance keep the old classification", () => {
    expect(classifyReserved(["[lend-reborrow:v1 old=lend:RB2:s1:r0:a0 gen=1 reclaim=3]"]).kind).toBe("v1");
    expect(classifyReserved(["plain"]).kind).toBe("none");
  });
});

describe.each(["checkout", "push", "model400", "reclaim"] as EndKind[])("ended by %s", (end) => {
  test("same peer adopts the terminal facts read-only and quotes the original lease/order", () => {
    ({ db } = setupLedger(end));
    const before = rows(db);
    const f = same();
    expect(f.lease).toEqual(getWriteLease(db, taskId)!);
    expect(f.end).toBe(end === "checkout" ? "not_started" : end === "reclaim" ? "cancelled" : "stopped");
    expect(f.target.branch).toBe(f.lease.branch);
    db.transaction(() => assertReborrow2Cas(db, f)).immediate();
    assertReborrow2Authority(db, f, pm.actor, borrowOf(peer), fp, now);
    expect(rows(db)).toBe(before);
  });
  test("cross peer only when the borrower ledger proves the old side left nothing", () => {
    ({ db } = setupLedger(end));
    const before = rows(db);
    if (end === "checkout") {
      const f = cross();
      expect(f).toMatchObject({ samePeer: false, end: "not_started", target: { peer: other, branch: "lend/RB2-1234" } });
      assertReborrow2Authority(db, f, pm.actor, borrowOf(other), fp2, now);
    } else expect(() => cross()).toThrow("不能换 peer");
    expect(rows(db)).toBe(before);
  });
});

describe("cross peer not_started must be a real never-started release", () => {
  test("clean revocation of a working worker (canonical not_started) refuses cross peer; same peer still allowed", () => {
    ({ db } = setupLedger("revokedWorking"));
    const before = rows(db);
    expect(same().end).toBe("not_started");
    expect(() => cross()).toThrow("worker 已起过");
    expect(rows(db)).toBe(before);
  });
  test("clean revocation before any worker start may still move peer", () => {
    ({ db } = setupLedger("revokedStarting"));
    expect(cross()).toMatchObject({ samePeer: false, end: "not_started" });
  });
  test.each([
    ["beat of another generation", `json_set(beat, '$.gen', 7)`],
    ["damaged beat", `'{not json'`],
  ])("%s cannot prove never-started", (_n, sql) => {
    ({ db } = setupLedger("revokedStarting"));
    db.run(`UPDATE lend_orders SET beat = ${sql}`);
    expect(() => cross()).toThrow("不能换 peer");
  });
  test("a beat changing after preparation fails the CAS", () => {
    ({ db } = setupLedger("revokedStarting"));
    const f = cross();
    db.run(`UPDATE lend_orders SET beat = json_set(beat, '$.phase', 'working')`);
    expect(() => db.transaction(() => assertReborrow2Cas(db, f)).immediate()).toThrow();
  });
});

describe("cross peer needs the original instance authenticated and authorised now", () => {
  const before = () => { ({ db } = setupLedger("checkout")); return rows(db); };
  test.each([
    ["no hello row", () => db.run("DELETE FROM lend_peers WHERE peer = ?", [peer]), "没有经认证的 hello"],
    ["instance changed", () => db.run("UPDATE lend_peers SET fp = 'ffff-ffff-ffff-ffff' WHERE peer = ?", [peer]), "实例指纹已变"],
    ["grant revoked", () => db.run("UPDATE lend_peers SET grant = NULL WHERE peer = ?", [peer]), "撤销写授权"],
  ])("%s refuses at capture, ledger untouched", (_n, mutate, why) => {
    const b = before();
    mutate();
    expect(() => cross()).toThrow(why);
    expect(rows(db)).toBe(b);
  });
  test("stale original hello or expired grant refuses at authority", () => {
    before();
    const f = cross();
    expect(f.origin).toMatchObject({ peer, fp });
    db.run("UPDATE lend_peers SET helloAt = ? WHERE peer = ?", [now - HELLO_FRESH_MS - 1, peer]);
    expect(() => assertReborrow2Authority(db, f, pm.actor, borrowOf(other), fp2, now)).toThrow("hello 过期");
    db.run("UPDATE lend_peers SET helloAt = ? WHERE peer = ?", [now, peer]);
    db.run("UPDATE lend_peers SET grant = json_set(grant, '$.until', ?) WHERE peer = ?", [now, peer]);
    expect(() => assertReborrow2Authority(db, f, pm.actor, borrowOf(other), fp2, now)).toThrow("授权到期");
  });
  test("original identity changing after preparation fails the CAS / authority", () => {
    before();
    const f = cross();
    db.run("UPDATE lend_peers SET boot = 'mate-reboot' WHERE peer = ?", [peer]);
    expect(() => db.transaction(() => assertReborrow2Cas(db, f)).immediate()).toThrow("变化");
    expect(() => assertReborrow2Authority(db, f, pm.actor, borrowOf(other), fp2, now)).toThrow("原提供方实例身份或授权在准备后变化");
  });
  test("same peer does not consult the original row twice (the target is the original)", () => {
    before();
    expect(same().origin).toBeNull();
  });
});

describe("refusals", () => {
  test.each(["pooled", "claimed", "unknown"])("a %s order on any peer blocks", (status) => {
    ({ db } = setupLedger("push"));
    db.run("UPDATE lend_orders SET status = ?, peer = 'zzz'", [status]);
    expect(() => same()).toThrow("活单或未知结果");
  });
  test("same peer with a different instance key is the wrong instance", () => {
    ({ db } = setupLedger("push"));
    expect(() => captureReborrow2Facts(db, taskId, { peer, fp: fp2, repo, family: "codex" })).toThrow("错实例");
  });
  test("a recorded model safety refusal is never continued elsewhere", () => {
    ({ db } = setupLedger("checkout"));
    appendEvent(db, { actor: "scheduler", now: 60 }, { project: "p", target: taskId, kind: "escalate", data: { op: "model_safety_hold", cls: "safety" } });
    expect(() => cross()).toThrow("安全拒绝");
    expect(() => same()).toThrow("安全拒绝");
  });
  test("a cyber-policy end reason is refused", () => {
    ({ db } = setupLedger("model400"));
    db.run("UPDATE lend_write_leases SET reason = 'stopped: This content was flagged for possible cybersecurity risk'");
    expect(() => same()).toThrow("安全拒绝");
  });
  test("an order issued after the lease ended blocks a second successor", () => {
    ({ db } = setupLedger("push"));
    db.run("UPDATE lend_orders SET createdAt = 999999");
    expect(() => same()).toThrow("已经签发过写单");
  });
  test.each(["UPDATE tasks SET rev = rev + 1", "UPDATE tasks SET specRev = specRev + 1", "UPDATE lend_orders SET reason = 'changed'",
    "UPDATE lend_write_leases SET prevAssignee = 'x'"])("CAS refuses drift: %s", (sql) => {
    ({ db } = setupLedger("push"));
    const f = same();
    db.run(sql);
    const before = rows(db);
    expect(() => db.transaction(() => assertReborrow2Cas(db, f)).immediate()).toThrow();
    expect(rows(db)).toBe(before);
  });
  test("CAS needs the writer transaction; materials appended after preparation fail it", () => {
    ({ db } = setupLedger("push"));
    const f = same();
    expect(() => assertReborrow2Cas(db, f)).toThrow("写事务");
    appendEvent(db, pm, { project: "p", target: taskId, kind: "note", text: "new evidence" });
    expect(() => db.transaction(() => assertReborrow2Cas(db, f)).immediate()).toThrow("发生变化");
  });
});

describe("author family epoch and authority", () => {
  test("changing family without a formal epoch is refused", () => {
    ({ db } = setupLedger("checkout"));
    expect(() => cross("claude")).toThrow("family epoch");
  });
  test("an epoch set before the lease ended is not a new epoch", () => {
    ({ db } = setupLedger("checkout"));
    db.run("UPDATE lend_write_leases SET updatedAt = 999999");
    db.run("UPDATE lend_orders SET createdAt = 1"); // keep the original order before the moved end time
    switchFamily(db, "claude", 70);
    expect(() => cross("claude")).toThrow("family epoch");
  });
  test("a real PM workflow epoch after the end permits the change; a review by that family does not", () => {
    ({ db } = setupLedger("checkout"));
    switchFamily(db, "claude", 70);
    const f = cross("claude");
    expect(f).toMatchObject({ family: "claude", originalFamily: "codex" });
    expect(f.epochSeq).toBeGreaterThan(0);
    expect(() => cross("codex")).toThrow("流程已正式改为 claude");
    db.run("INSERT INTO events (ts,actor,project,target,kind,data) VALUES (80,'r','p',?,'review',?)", [taskId, JSON.stringify({ reviewerFamily: "claude" })]);
    expect(() => cross("claude")).toThrow("不能再由 claude 接写");
  });
  test("non-PM, stale key, missing grant or borrow are refused", () => {
    ({ db } = setupLedger("checkout"));
    const f = cross();
    expect(() => assertReborrow2Authority(db, f, "agent-worker", borrowOf(other), fp2, now)).toThrow("真实 PM");
    expect(() => assertReborrow2Authority(db, f, pm.actor, borrowOf(other), fp, now)).toThrow("实例身份");
    expect(() => assertReborrow2Authority(db, f, pm.actor, null, fp2, now)).toThrow("borrow");
    expect(() => assertReborrow2Authority(db, f, pm.actor, borrowOf(other), fp2, now + 10_000_000)).toThrow();
    db.run("UPDATE lend_peers SET grant = NULL WHERE peer = ?", [other]);
    expect(() => assertReborrow2Authority(db, f, pm.actor, borrowOf(other), fp2, now)).toThrow("未授权");
  });
});
