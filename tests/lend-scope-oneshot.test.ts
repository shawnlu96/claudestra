/**
 * i28-W6 A 侧直达：send_to_agent 发给 `lend-*@peer` 时 routeToHttpPeer 强制 oneShot——body 是 wait:0、拿到 202 就结束、
 * 不轮询、不进调用簿、不记交接；投递失败仍推回发起方。普通目标照旧（wait 25、挂调用簿、记交接）。假 fetch，不连真 peer。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initHttpPeer, routeToHttpPeer } from "../src/bridge/http-peer";
import { readHandoffs } from "../src/lib/handoff-log";
import { workerName } from "../src/lib/lend-drive";
import type { HttpPeer } from "../src/lib/peers";

const dir = mkdtempSync(join(tmpdir(), "lend-oneshot-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PEER: HttpPeer = { name: "mate", baseUrl: "http://x", outToken: "k".repeat(32), addedAt: "" };
const fakeWs = {} as any;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const book = (p: string): Record<string, unknown> => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});

function boot(path: string, respond: (n: number) => Response | Promise<Response>) {
  const calls: { url: string; body: Record<string, unknown> | null }[] = [];
  const pushed: string[] = [];
  initHttpPeer({
    deliver: async (env) => { pushed.push(env.content); return { envelope: env, outcome: { kind: "sent" } }; },
    fetchImpl: (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return respond(calls.length);
    }) as unknown as typeof fetch,
    pollIntervalMs: 10,
    pollGiveUpMs: 2_000,
    callBookPath: path,
    findPeer: async (n) => (n === PEER.name ? PEER : null),
    getClientWs: () => fakeWs,
  });
  return { calls, pushed };
}

const handoffsTo = async (agent: string, since: number) => (await readHandoffs(since)).filter((h) => h.remoteAgent === agent);

describe("发给出借 worker = oneShot", () => {
  for (const agent of [workerName("oneshot-a"), workerName("oneshot-b").replace(/^agent-/, "")]) {
    test(`${agent}：wait:0、只 POST 一次、不进调用簿、不记交接、不推回`, async () => {
      const since = Date.now() - 1;
      const path = join(dir, `${agent}.json`);
      const h = boot(path, () => json(202, { ok: true, accepted: true, threadId: "th-1" }));
      const r = routeToHttpPeer(fakeWs, "chan", "agent-pm", PEER, agent, "看一下第 3 条", "回个结论");
      expect(r.pushBack).toBe(false);
      await sleep(80);
      expect(h.calls.length).toBe(1);
      expect(h.calls[0]!.url).toBe(`http://x/api/v1/agents/${encodeURIComponent(agent)}/messages`);
      expect(h.calls[0]!.body).toMatchObject({ text: "看一下第 3 条", wait: 0 });
      expect(book(path)).toEqual({});
      expect(h.pushed).toEqual([]);
      expect(await handoffsTo(agent, since)).toEqual([]);
    });
  }

  test("投递失败仍推回发起方（oneShot 原有语义）", async () => {
    const agent = workerName("oneshot-c");
    const h = boot(join(dir, "c.json"), () => json(403, { ok: false, error: "not in scope" }));
    routeToHttpPeer(fakeWs, "chan", "agent-pm", PEER, agent, "在吗");
    await sleep(80);
    expect(h.calls.length).toBe(1);
    expect(h.pushed.length).toBe(1);
    expect(h.pushed[0]).toContain("peer 调用失败");
  });
});

describe("普通目标行为不变", () => {
  test("wait 25、拿到 thread 挂调用簿并轮询、记交接、要推回", async () => {
    const since = Date.now() - 1;
    const path = join(dir, "plain.json");
    const h = boot(path, (n) => (n === 1 ? json(202, { ok: true, accepted: true, threadId: "th-p" }) : new Promise<Response>(() => {})));
    const r = routeToHttpPeer(fakeWs, "chan", "agent-pm", PEER, "claudestra", "问题");
    expect(r.pushBack).toBe(true);
    await sleep(80);
    expect(h.calls[0]!.body).toMatchObject({ wait: 25 });
    expect(h.calls.length).toBeGreaterThanOrEqual(2); // 第二次起是轮询 thread
    expect(Object.values(book(path))).toEqual([expect.objectContaining({ peerAgent: "claudestra", threadId: "th-p" })]);
    expect((await handoffsTo("claudestra", since)).map((x) => x.event)).toEqual(["request"]);
  });

  test("调用方显式 oneShot 照旧", async () => {
    const h = boot(join(dir, "fyi.json"), () => json(202, { ok: true, accepted: true, threadId: "th-f" }));
    expect(routeToHttpPeer(fakeWs, "chan", "agent-pm", PEER, "claudestra", "FYI", undefined, true).pushBack).toBe(false);
    await sleep(50);
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]!.body).toMatchObject({ wait: 0 });
  });
});
