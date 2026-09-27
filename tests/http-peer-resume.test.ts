/**
 * 跨机调用轮询落盘（bridge/peer-call-book.ts）：bridge 重启后按原截止时间接着轮询对方 thread，
 * 发起方还没连上时推回进押后队列，peer 已删 / 已过截止时间都要告诉发起方并摘掉记录。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelHttpPeerCallsForChannel, initHttpPeer, routeToHttpPeer, type HttpPeerDeps } from "../src/bridge/http-peer";
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
    expect(h.held[0].meta.messageId).toBe("hp_hp_1_reply"); // 按 callId 派生：重启后重推同一条 ID 不变
    expect(h.held[0].to).toMatchObject({ kind: "local", channelId: "chan", agentName: "caller" });
    // 押后投递时 from.ws 已被剥掉，看门狗不能再靠 ws 相等识别「bridge 合成的推回」
    expect(h.held[0].meta.skipInterAgentWatchdog).toBe(true);
  });

  test("发起方在线但投递失败（连接刚断）：推回进押后队列，记录照常摘掉也不丢", async () => {
    const path = join(dir, "f.json");
    seed(path);
    const h = boot(path, async () => json(200, { ok: true, reply: "答案", threadId: "th1" }), {
      getClientWs: () => fakeWs,
      deliver: async (env) => ({ envelope: env, outcome: { kind: "error", error: new Error("ws closed") } }),
    });
    await sleep(60);
    expect(h.held.map((e) => e.content)).toEqual(["答案"]);
    expect(readBook(path)).toEqual({});
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

  test("同名 peer 已换成别的实例（peerId 不符）：不拿新实例的凭据去问旧 thread，告诉发起方并摘掉", async () => {
    const path = join(dir, "g.json");
    seed(path, { peerId: "old-instance" });
    let fetched = 0;
    const h = boot(path, async () => (fetched++, json(200, { ok: true, reply: "别人的答案", threadId: "th1" })), { getClientWs: () => fakeWs });
    await sleep(60);
    expect(fetched).toBe(0);
    expect(h.pushed[0]).toContain("换了实例");
    expect(readBook(path)).toEqual({});
  });

  test("peers.json 暂时读不了：后台重试，读到后接着轮询（不等下一次重启）", async () => {
    const path = join(dir, "h.json");
    seed(path);
    let reads = 0;
    const h = boot(path, async () => json(200, { ok: true, reply: "终于拿到", threadId: "th1" }), {
      getClientWs: () => fakeWs,
      resumeRetryMs: 20,
      findPeer: async () => {
        if (reads++ < 2) throw new Error("EBUSY");
        return PEER;
      },
    });
    await sleep(150);
    expect(h.pushed).toEqual(["终于拿到"]);
  });

  test("轮询期间 peer 被删：停止轮询并告诉发起方", async () => {
    const path = join(dir, "i.json");
    seed(path);
    let n = 0;
    const h = boot(path, async () => json(404, {}), { getClientWs: () => fakeWs, findPeer: async () => (n++ === 0 ? PEER : null) });
    await sleep(80);
    expect(h.pushed.length).toBe(1);
    expect(h.pushed[0]).toContain("被删除或换成了别的实例");
    expect(readBook(path)).toEqual({});
  });

  test("用户接管取消：记录当场从盘上删掉（轮询没退出就重启也不会恢复已取消的调用）", async () => {
    const path = join(dir, "j.json");
    let n = 0;
    boot(path, () => (n++ === 0 ? Promise.resolve(json(202, { ok: true, accepted: true, threadId: "th-j" })) : new Promise<Response>(() => {})));
    routeToHttpPeer(fakeWs, "chan-j", "caller", PEER, "x", "问题");
    await sleep(40);
    expect(Object.keys(readBook(path)).length).toBe(1);
    expect(cancelHttpPeerCallsForChannel("chan-j")).toBe(1);
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
