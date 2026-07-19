import { describe, expect, test } from "bun:test";
import { encodePeerHandshake, parsePeerHandshake, type PeerHandshake } from "../src/lib/peers";
import { extractReplyText } from "../src/bridge/http-peer";

describe("peer handshake encode/parse", () => {
  const good: PeerHandshake = {
    v: 1,
    name: "ahh",
    url: "http://100.64.0.7:3847",
    token: "a".repeat(64),
  };

  test("roundtrip", () => {
    const s = encodePeerHandshake(good);
    expect(parsePeerHandshake(s)).toEqual(good);
  });

  test("url 尾斜杠归一", () => {
    const s = encodePeerHandshake({ ...good, url: "http://x.example:3847///" });
    expect(parsePeerHandshake(s)?.url).toBe("http://x.example:3847");
  });

  test("前后空白容忍(用户从聊天软件复制常带)", () => {
    const s = "  " + encodePeerHandshake(good) + "\n";
    expect(parsePeerHandshake(s)).toEqual(good);
  });

  test("拒绝:非 base64 / 非 JSON", () => {
    expect(parsePeerHandshake("not-a-handshake!!!")).toBeNull();
    expect(parsePeerHandshake("")).toBeNull();
  });

  test("拒绝:版本不对", () => {
    const s = Buffer.from(JSON.stringify({ ...good, v: 2 })).toString("base64url");
    expect(parsePeerHandshake(s)).toBeNull();
  });

  test("拒绝:缺字段", () => {
    for (const drop of ["name", "url", "token"] as const) {
      const bad: any = { ...good };
      delete bad[drop];
      const s = Buffer.from(JSON.stringify(bad)).toString("base64url");
      expect(parsePeerHandshake(s)).toBeNull();
    }
  });

  test("拒绝:url 不是 http(s)", () => {
    const s = Buffer.from(JSON.stringify({ ...good, url: "ftp://x" })).toString("base64url");
    expect(parsePeerHandshake(s)).toBeNull();
  });

  test("拒绝:token 太短(不像真 secret)", () => {
    const s = Buffer.from(JSON.stringify({ ...good, token: "short" })).toString("base64url");
    expect(parsePeerHandshake(s)).toBeNull();
  });
});

describe("extractReplyText — 对方 messages/threads 响应契约", () => {
  test("wait 命中:顶层 reply string", () => {
    expect(extractReplyText({ ok: true, reply: "你好", threadId: "t", agent: "x" })).toBe("你好");
  });

  test("reply:null(回合结束无文本)→ null(调用方走空回复分支)", () => {
    expect(extractReplyText({ ok: true, reply: null, threadId: "t" })).toBeNull();
  });

  test("202 accepted(无 reply)→ null(调用方转轮询)", () => {
    expect(extractReplyText({ ok: true, accepted: true, threadId: "t" })).toBeNull();
  });

  test("空白 reply 视为无内容", () => {
    expect(extractReplyText({ ok: true, reply: "   " })).toBeNull();
  });

  test("null/undefined body", () => {
    expect(extractReplyText(null)).toBeNull();
    expect(extractReplyText(undefined)).toBeNull();
  });

  test("变体容错:reply 是对象 {text}", () => {
    expect(extractReplyText({ ok: true, reply: { text: "hi" } })).toBe("hi");
  });
});

// ── 轮询状态机(fake fetch + fake deliver 注入)──────────────────────────
import { initHttpPeer, routeToHttpPeer } from "../src/bridge/http-peer";
import type { HttpPeer } from "../src/lib/peers";

function makeHarness(responses: Array<() => Response>) {
  const pushed: string[] = [];
  let i = 0;
  initHttpPeer({
    deliver: async (env) => {
      pushed.push(env.content);
      return { envelope: env, outcome: { kind: "sent" } };
    },
    fetchImpl: (async () => {
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r();
    }) as unknown as typeof fetch,
    pollIntervalMs: 10,
    pollGiveUpMs: 300,
  });
  return { pushed };
}

const PEER: HttpPeer = { name: "t", baseUrl: "http://x", outToken: "k".repeat(32), addedAt: "" };
const fakeWs = {} as any;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("http-peer 出站状态机", () => {
  test("wait 命中:回复推回 caller", async () => {
    const h = makeHarness([() => json(200, { ok: true, reply: "答案", threadId: "t1", agent: "x" })]);
    routeToHttpPeer(fakeWs, "chan", "caller", PEER, "x", "问题");
    await sleep(50);
    expect(h.pushed.length).toBe(1);
    expect(h.pushed[0]).toBe("答案");
  });

  test("202 → 轮询 404 → 兑现", async () => {
    const h = makeHarness([
      () => json(202, { ok: true, accepted: true, threadId: "t2" }),
      () => json(404, { ok: false, error: "not yet" }),
      () => json(200, { ok: true, reply: "迟到的答案", threadId: "t2", agent: "x" }),
    ]);
    routeToHttpPeer(fakeWs, "chan", "caller", PEER, "x", "问题");
    await sleep(120);
    expect(h.pushed.length).toBe(1);
    expect(h.pushed[0]).toBe("迟到的答案");
  });

  test("轮询遇 401 立即终止并报鉴权错误(不空转到超时)", async () => {
    const h = makeHarness([
      () => json(202, { ok: true, accepted: true, threadId: "t3" }),
      () => json(401, { ok: false, error: "revoked" }),
    ]);
    routeToHttpPeer(fakeWs, "chan", "caller", PEER, "x", "问题");
    await sleep(80);
    expect(h.pushed.length).toBe(1);
    expect(h.pushed[0]).toContain("拒绝了鉴权");
  });

  test("403 scope 拒绝:错误消息推回 caller", async () => {
    const h = makeHarness([() => json(403, { ok: false, error: "not in scope" })]);
    routeToHttpPeer(fakeWs, "chan", "caller", PEER, "x", "问题");
    await sleep(50);
    expect(h.pushed[0]).toContain("拒绝了请求");
    expect(h.pushed[0]).toContain("not in scope");
  });

  test("网络不可达:错误消息推回 caller,不静默", async () => {
    const h = makeHarness([]);
    initHttpPeer({
      deliver: async (env) => {
        h.pushed.push(env.content);
        return { envelope: env, outcome: { kind: "sent" } };
      },
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    routeToHttpPeer(fakeWs, "chan", "caller", PEER, "x", "问题");
    await sleep(50);
    expect(h.pushed[0]).toContain("网络不可达");
  });

  test("200 空回复(reply:\"\"):终止并告知,不进轮询", async () => {
    const h = makeHarness([() => json(200, { ok: true, reply: "", threadId: "t4", agent: "x" })]);
    routeToHttpPeer(fakeWs, "chan", "caller", PEER, "x", "问题");
    await sleep(50);
    expect(h.pushed.length).toBe(1);
    expect(h.pushed[0]).toContain("没有文本回复");
  });

  test("轮询到 deadline 放弃:超时消息推回", async () => {
    const h = makeHarness([
      () => json(202, { ok: true, accepted: true, threadId: "t5" }),
      () => json(404, { ok: false }),
    ]);
    routeToHttpPeer(fakeWs, "chan", "caller", PEER, "x", "问题");
    await sleep(500);
    expect(h.pushed.length).toBe(1);
    expect(h.pushed[0]).toContain("超时");
  });

  test("expecting 期望回注到 pushback 头部", async () => {
    const h = makeHarness([() => json(200, { ok: true, reply: "数据在此", threadId: "t6", agent: "x" })]);
    routeToHttpPeer(fakeWs, "chan", "caller", PEER, "x", "问题", "拿到数据后写进报告");
    await sleep(50);
    expect(h.pushed[0]).toContain("拿到数据后写进报告");
    expect(h.pushed[0]).toContain("数据在此");
  });
});
