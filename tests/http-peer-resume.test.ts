/**
 * 跨机调用轮询落盘（bridge/peer-call-book.ts）：bridge 重启后按原截止时间接着轮询对方 thread，
 * 发起方还没连上时推回进押后队列，peer 已删 / 已过截止时间都要告诉发起方并摘掉记录。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initHttpPeer, routeToHttpPeer, type HttpPeerDeps } from "../src/bridge/http-peer";
import type { PendingPeerCall } from "../src/bridge/peer-call-book";
import type { Envelope } from "../src/bridge/router";
import type { HttpPeer } from "../src/lib/peers";

const dir = mkdtempSync(join(tmpdir(), "peer-calls-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PEER: HttpPeer = { name: "t", baseUrl: "http://x", outToken: "k".repeat(32), addedAt: "" };
const fakeWs = {} as any;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readBook = (p: string): Record<string, PendingPeerCall> => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});

function boot(path: string, fetchImpl: () => Promise<Response>, extra: Partial<HttpPeerDeps> = {}) {
  const pushed: string[] = [];
  const held: Envelope[] = [];
  initHttpPeer({
    deliver: async (env) => {
      pushed.push(env.content);
      return { envelope: env, outcome: { kind: "sent" } };
    },
    fetchImpl: fetchImpl as unknown as typeof fetch,
    pollIntervalMs: 10,
    pollGiveUpMs: 5_000,
    callBookPath: path,
    findPeer: async (n) => (n === PEER.name ? PEER : null),
    hold: (env) => held.push(env),
    ...extra,
  });
  return { pushed, held };
}

function seed(path: string, rec: Partial<PendingPeerCall> = {}) {
  const full: PendingPeerCall = {
    callerChannelId: "chan", callerName: "caller", peerName: "t", peerAgent: "x", threadId: "th1", deadline: Date.now() + 5_000, ...rec,
  };
  writeFileSync(path, JSON.stringify({ hp_1: full }));
}

describe("跨机调用重启续轮询", () => {
  test("拿到 thread 后落盘；重启后接着轮询，回复推回发起方并摘掉记录", async () => {
    const path = join(dir, "a.json");
    let n = 0;
    // 第一次启动：POST 回 202，之后的轮询永远不返回（模拟 bridge 在等回复时被重启）
    boot(path, () => (n++ === 0 ? Promise.resolve(json(202, { ok: true, accepted: true, threadId: "th-a" })) : new Promise<Response>(() => {})));
    routeToHttpPeer(fakeWs, "chan", "caller", PEER, "x", "问题", "拿到后写报告");
    await sleep(40);
    const saved = Object.values(readBook(path));
    expect(saved.length).toBe(1);
    expect(saved[0]).toMatchObject({ callerChannelId: "chan", callerName: "caller", peerName: "t", peerAgent: "x", threadId: "th-a", expecting: "拿到后写报告" });
    expect(saved[0]).not.toHaveProperty("ws");

    const h = boot(path, async () => json(200, { ok: true, reply: "重启后的答案", threadId: "th-a" }), { getClientWs: () => fakeWs });
    await sleep(60);
    expect(h.pushed.length).toBe(1);
    expect(h.pushed[0]).toContain("重启后的答案");
    expect(h.pushed[0]).toContain("拿到后写报告");
    expect(readBook(path)).toEqual({});
  });

  test("发起方还没连上：推回进押后队列，不丢", async () => {
    const path = join(dir, "b.json");
    seed(path);
    const h = boot(path, async () => json(200, { ok: true, reply: "答案", threadId: "th1" }), { getClientWs: () => null });
    await sleep(60);
    expect(h.pushed.length).toBe(0);
    expect(h.held.length).toBe(1);
    expect(h.held[0].content).toBe("答案");
    expect(h.held[0].to).toMatchObject({ kind: "local", channelId: "chan", agentName: "caller" });
  });

  test("peer 已被删：告诉发起方、摘掉记录，不轮询", async () => {
    const path = join(dir, "c.json");
    seed(path, { peerName: "gone" });
    let fetched = 0;
    const h = boot(path, async () => (fetched++, json(404, {})), { getClientWs: () => fakeWs });
    await sleep(60);
    expect(fetched).toBe(0);
    expect(h.pushed.length).toBe(1);
    expect(h.pushed[0]).toContain("找不到 peer gone");
    expect(readBook(path)).toEqual({});
  });

  test("重启时已过截止时间：直接报超时并摘掉，不重新计时", async () => {
    const path = join(dir, "d.json");
    seed(path, { deadline: Date.now() - 1 });
    let fetched = 0;
    const h = boot(path, async () => (fetched++, json(404, {})), { getClientWs: () => fakeWs });
    await sleep(60);
    expect(fetched).toBe(0);
    expect(h.pushed.length).toBe(1);
    expect(h.pushed[0]).toContain("超时");
    expect(readBook(path)).toEqual({});
  });

  test("空回合已通知过：重启后不再重复通知", async () => {
    const path = join(dir, "e.json");
    seed(path, { emptyNoticed: true, deadline: Date.now() + 50 });
    const h = boot(path, async () => json(200, { ok: true, reply: "", threadId: "th1" }), { getClientWs: () => fakeWs });
    await sleep(120);
    expect(h.pushed.filter((t) => t.includes("没有文本回复")).length).toBe(0);
    expect(h.pushed.at(-1)).toContain("没有补回复"); // 收尾文案仍按「空回合后」说
  });
});
