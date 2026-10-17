/**
 * peer-PEERGONE1：发给单已结束的出借 worker 在本机拦下（lib/peer-lend-target.ts + bridge/http-peer.ts routeToHttpPeer），
 * 接收方 notInScope 的 403 带 code。假 fetch，不连真 peer。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initHttpPeer, routeToHttpPeer } from "../src/bridge/http-peer";
import { notInScope } from "../src/bridge/api-respond";
import { LEND_SCHEMA } from "../src/lib/ledger-lend-schema";
import { lendOrdersOfWorker, lendTargetRefusal, type LendOrderState } from "../src/lib/peer-lend-target";
import type { HttpPeer } from "../src/lib/peers";

const dir = mkdtempSync(join(tmpdir(), "peer-lend-target-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const T = Date.UTC(2026, 9, 17, 14, 36);
const done: LendOrderState = { status: "done", updatedAt: T };

describe("lendTargetRefusal", () => {
  test("只有结束的单 → 拒，话里有『已结束』『已回收』和状态", () => {
    for (const target of ["agent-lend-abc", "lend-abc"]) {
      const r = lendTargetRefusal(target, [done]);
      expect(r).toContain("已结束");
      expect(r).toContain("已回收");
      expect(r).toContain("agent-lend-abc");
      expect(r).toContain("done");
    }
    expect(lendTargetRefusal("agent-lend-abc", [{ status: "cancelled", updatedAt: T - 1 }, { status: "released", updatedAt: T }])).toContain("released");
  });
  test("有一条活着（pooled / claimed / unknown）、没记录、不是出借 worker → null", () => {
    for (const status of ["pooled", "claimed", "unknown"]) expect(lendTargetRefusal("agent-lend-abc", [done, { status, updatedAt: T - 5 }])).toBeNull();
    expect(lendTargetRefusal("agent-lend-abc", [])).toBeNull();
    expect(lendTargetRefusal("claudestra", [done])).toBeNull();
  });
});

describe("lendOrdersOfWorker（只读查台账）", () => {
  const path = join(dir, "ledger.sqlite");
  const db = new Database(path);
  LEND_SCHEMA(db);
  const cols = "orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256, status, worker, leaseMs, createdBy, createdAt, updatedAt";
  const ins = db.prepare(`INSERT INTO lend_orders (${cols})
    VALUES (?, ?, 'p', 'Sekai', 'claude', 'write', 1, 0, 'h', 'r', 'w', 't', 's', ?, ?, 1000, 'pm', 1, ?)`);
  ins.run("o1", "t1", "done", "agent-lend-abc", T);
  ins.run("o2", "t2", "claimed", "agent-lend-def", T);
  db.close();
  test("带不带前缀都查到；别的 worker 不混进来", () => {
    expect(lendOrdersOfWorker("agent-lend-abc", path)).toEqual([done]);
    expect(lendOrdersOfWorker("lend-abc", path)).toEqual([done]);
    expect(lendOrdersOfWorker("agent-lend-zzz", path)).toEqual([]);
  });
  test("台账不在 / 不是出借 worker 名：空，不建库", () => {
    expect(lendOrdersOfWorker("agent-lend-abc", join(dir, "none.sqlite"))).toEqual([]);
    expect(lendOrdersOfWorker("claudestra", path)).toEqual([]);
  });
});

describe("routeToHttpPeer 拦截", () => {
  const PEER: HttpPeer = { name: "Sekai", baseUrl: "http://x", outToken: "k".repeat(32), addedAt: "" };
  const fakeWs = {} as any;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  function boot(lendOrders: (t: string) => LendOrderState[]) {
    const calls: string[] = [];
    initHttpPeer({
      deliver: async (env) => ({ envelope: env, outcome: { kind: "sent" } }),
      fetchImpl: (async (url: string) => { calls.push(String(url)); return new Response(JSON.stringify({ ok: true, accepted: true, threadId: "th" }), { status: 202 }); }) as unknown as typeof fetch,
      callBookPath: null,
      findPeer: async () => PEER,
      getClientWs: () => fakeWs,
      lendOrders,
    });
    return calls;
  }

  test("只有 done 的单：抛出拒绝的话，不发 HTTP", async () => {
    const calls = boot(() => [done]);
    expect(() => routeToHttpPeer(fakeWs, "chan", "agent-pm", PEER, "agent-lend-abc", "补一句")).toThrow(/已结束.*已回收/);
    await sleep(30);
    expect(calls).toEqual([]);
  });
  test("有 claimed 的单 / 台账没记录 / 查库抛错：照常发", async () => {
    for (const orders of [() => [done, { status: "claimed", updatedAt: T }], () => [], () => { throw new Error("db locked"); }]) {
      const calls = boot(orders as (t: string) => LendOrderState[]);
      expect(routeToHttpPeer(fakeWs, "chan", "agent-pm", PEER, "agent-lend-abc", "补一句").ok).toBe(true);
      await sleep(30);
      expect(calls.length).toBe(1);
    }
  });
  test("lendSupplement 走 sendLendRelay，不进 routeToHttpPeer（bridge.ts 分支先判）", () => {
    const src = readFileSync(join(import.meta.dir, "../src/bridge.ts"), "utf8");
    expect(src).toContain('msg.lendSupplement === true ? await sendLendRelay(httpPeer, peerAgentName, String(msg.text || "")) : routeToHttpPeer(');
    expect(readFileSync(join(import.meta.dir, "../src/bridge/lend-relay-send.ts"), "utf8")).not.toContain("peer-lend-target");
  });
});

test("notInScope：403 带 code，error 原文不变", async () => {
  const r = notInScope("agent-lend-abc");
  expect(r.status).toBe(403);
  expect(await r.json()).toEqual({ ok: false, error: 'agent "agent-lend-abc" not in token scope', code: "agent_not_in_scope" });
});
