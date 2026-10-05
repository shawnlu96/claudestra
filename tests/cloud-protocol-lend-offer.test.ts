/**
 * cloud-PP2：新纯入口 lend-offer-protocol 的 parseOfferRequest / offerBody 与原 lend-wire-v2 的 parseV2Request("offer") / offerBody
 * 在固定样本上逐项一致（错误文本与路径按基线 9ca60d84 跑出来的原样钉死），常量单一来源且值不变；生产旧入口
 * （manager lend inbox 收单、lend-dispatch 推单）走的就是同一 core。
 */
import { describe, expect, test } from "bun:test";
import { createPushLoop, type PushSend } from "../src/lib/lend-dispatch.js";
import { offerBody, parseOffer, parseOfferRequest, type OfferRequest } from "../src/lib/lend-offer-protocol.js";
import * as schema from "../src/lib/lend-wire-v2-schema.js";
import * as v2 from "../src/lib/lend-wire-v2.js";
import { lendInbox } from "../src/manager/lend-inbox.js";
import type { OfferSummary } from "../src/lib/lend-wire-types.js";

const SHA = "a".repeat(40);
const S: OfferSummary = { orderId: "lend:T1:s1:r0:a0", taskId: "T1", step: "write", family: "codex", repo: "o/r", pr: null, head: SHA, round: 0, specRev: 1, offeredAt: 1 };
const body = (orders: unknown, extra: Record<string, unknown> = {}) => ({ v: 1, proto: 3, orders, ...extra });
const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...S, orderId: `o${i}` }));
export const SAMPLES: [string, unknown][] = [
  ["合法最小", body([S])],
  ["合法边界：20 单、pr/round/specRev/offeredAt 上限、proto 2 与 99", body(many(20).map((o) => ({ ...o, pr: 1e9, round: 1e6, specRev: 1e6, offeredAt: 8.64e15, step: "fix", family: "claude" })), { proto: 2 })],
  ["proto 99", body([{ ...S, step: "review", pr: 1 }], { proto: 99 })],
  ["不是对象", null], ["数组", [S]], ["缺 orders", { v: 1, proto: 3 }], ["多字段", body([S], { x: 1 })],
  ["版本不对", body([S], { v: 2 })], ["proto 1", body([S], { proto: 1 })], ["proto 100", body([S], { proto: 100 })], ["proto 小数", body([S], { proto: 2.5 })],
  ["orders 空", body([])], ["orders 21", body(many(21))], ["orders 不是数组", body("x")], ["同单两次", body([S, S])],
  ["单缺字段", body([{ ...S, head: undefined }].map((o) => { const { head: _h, ...r } = o; return r; }))], ["单多字段", body([{ ...S, extra: 1 }])],
  ["orderId 过长", body([{ ...S, orderId: "x".repeat(201) }])], ["orderId 错类型", body([{ ...S, orderId: 1 }])],
  ["taskId 过长", body([{ ...S, taskId: "t".repeat(65) }])], ["step 不认识", body([{ ...S, step: "build" }])], ["family 不认识", body([{ ...S, family: "gpt" }])],
  ["repo 坏", body([{ ...S, repo: "o/.." }])], ["pr 0", body([{ ...S, pr: 0 }])], ["pr 字符串", body([{ ...S, pr: "1" }])], ["head 大写", body([{ ...S, head: "A".repeat(40) }])],
  ["round 超界", body([{ ...S, round: 1e6 + 1 }])], ["specRev 负", body([{ ...S, specRev: -1 }])], ["offeredAt 超界", body([{ ...S, offeredAt: 8.64e15 + 1 }])],
  ["v 缺", { proto: 3, orders: [S] }], ["第二单坏", body([S, { ...S, orderId: "o2", family: 1 }])],
];

/** 基线 9ca60d84 的 parseV2Request("offer") 对每个样本的结果：null = 通过（value 即原样），否则是错误全文 */
const BASELINE: Record<string, string | null> = {
  "合法最小": null,
  "合法边界：20 单、pr/round/specRev/offeredAt 上限、proto 2 与 99": null,
  "proto 99": null,
  "不是对象": "$: \u8981\u662f\u5bf9\u8c61",
  "数组": "$: \u8981\u662f\u5bf9\u8c61",
  "缺 orders": "$: \u7f3a\u5b57\u6bb5 orders",
  "多字段": "$: \u4e0d\u8ba4\u8bc6\u7684\u5b57\u6bb5 x",
  "版本不对": "v: \u53ea\u8ba4\u7248\u672c 1",
  "proto 1": "proto: \u8981\u662f 2\u201399 \u7684\u6574\u6570",
  "proto 100": "proto: \u8981\u662f 2\u201399 \u7684\u6574\u6570",
  "proto 小数": "proto: \u8981\u662f 2\u201399 \u7684\u6574\u6570",
  "orders 空": "orders: \u4e0d\u80fd\u662f\u7a7a\u7684",
  "orders 21": "orders: \u8981\u662f\u4e0d\u8d85\u8fc7 20 \u9879\u7684\u6570\u7ec4",
  "orders 不是数组": "orders: \u8981\u662f\u4e0d\u8d85\u8fc7 20 \u9879\u7684\u6570\u7ec4",
  "同单两次": "orders: \u540c\u4e00\u5355\u51fa\u73b0\u4e24\u6b21",
  "单缺字段": "orders[0]: \u7f3a\u5b57\u6bb5 head",
  "单多字段": "orders[0]: \u4e0d\u8ba4\u8bc6\u7684\u5b57\u6bb5 extra",
  "orderId 过长": "orders[0].orderId: \u683c\u5f0f\u4e0d\u5bf9",
  "orderId 错类型": "orders[0].orderId: \u683c\u5f0f\u4e0d\u5bf9",
  "taskId 过长": "orders[0].taskId: \u683c\u5f0f\u4e0d\u5bf9",
  "step 不认识": "orders[0].step: \u53ea\u8ba4 review / write / fix",
  "family 不认识": "orders[0].family: \u53ea\u8ba4 codex / claude",
  "repo 坏": "orders[0].repo: \u683c\u5f0f\u4e0d\u5bf9",
  "pr 0": "orders[0].pr: \u8981\u662f 1\u20131000000000 \u7684\u6574\u6570",
  "pr 字符串": "orders[0].pr: \u8981\u662f 1\u20131000000000 \u7684\u6574\u6570",
  "head 大写": "orders[0].head: \u683c\u5f0f\u4e0d\u5bf9",
  "round 超界": "orders[0].round: \u8981\u662f 0\u20131000000 \u7684\u6574\u6570",
  "specRev 负": "orders[0].specRev: \u8981\u662f 0\u20131000000 \u7684\u6574\u6570",
  "offeredAt 超界": "orders[0].offeredAt: \u8981\u662f 0\u20138640000000000000 \u7684\u6574\u6570",
  "v 缺": "$: \u7f3a\u5b57\u6bb5 v",
  "第二单坏": "orders[1].family: \u53ea\u8ba4 codex / claude",
};

describe("新旧 offer 解析逐项一致", () => {
  test.each(SAMPLES)("%s", (name, body) => {
    const now = parseOfferRequest(body);
    expect(now).toEqual(v2.parseV2Request("offer", body));
    const want = BASELINE[name];
    if (want === null) expect(now).toEqual({ ok: true, value: body as OfferRequest });
    else expect(now).toEqual({ ok: false, error: want });
  });
  test("样本表与基线表一一对应", () => expect(SAMPLES.map(([n]) => n)).toEqual(Object.keys(BASELINE)));
  test("parseOffer 抛协议错；非协议异常照原样往外抛（guard 只吞 V2Error）", () => {
    expect(() => parseOffer(null)).toThrow("$: 要是对象");
    expect(() => schema.guard(() => { throw new TypeError("boom"); })).toThrow("boom");
  });
});

describe("构造与常量", () => {
  test("offerBody：旧 export 就是新 core；截到 OFFER_MAX，v / proto 不变", () => {
    expect(v2.offerBody).toBe(offerBody);
    const many = Array.from({ length: 25 }, (_, i) => ({ ...S, orderId: `o${i}` })) as OfferSummary[];
    expect(offerBody(many)).toEqual({ v: 1, proto: 3, orders: many.slice(0, 20) });
    expect(offerBody([S])).toEqual({ v: 1, proto: 3, orders: [S] });
    expect(JSON.stringify(offerBody([S]))).toBe(`{"v":1,"proto":3,"orders":[${JSON.stringify(S)}]}`);
  });
  test("LEND_PROTO / OFFER_MAX / BODY_V 新旧入口同值同源", () => {
    expect([v2.LEND_PROTO, v2.OFFER_MAX, v2.V2_BODY_VERSION]).toEqual([3, 20, 1]);
    expect([schema.LEND_PROTO, schema.OFFER_MAX, schema.BODY_V]).toEqual([v2.LEND_PROTO, v2.OFFER_MAX, v2.V2_BODY_VERSION]);
  });
});

describe("生产旧入口委托同一 core", () => {
  test("manager lend inbox：坏正文按 core 的错误原文拒（身份 / 授权 / 大小检查仍在原层，先于解析）", async () => {
    for (const [name, body] of SAMPLES) {
      const want = BASELINE[name];
      if (want === null) continue;
      const r = await lendInbox(["--", "peerA", "0000-0000-0000-0000", JSON.stringify(body)], {
        env: {}, findPeer: async () => { throw new Error("不该走到查 peer"); }, readLend: () => { throw new Error("x"); }, context: () => { throw new Error("x"); },
      } as never);
      expect(r).toEqual({ ok: false, code: "invalid", error: want });
    }
    const big = await lendInbox(["--", "peerA", "0000-0000-0000-0000", "x".repeat(96 * 1024 + 1)], { env: {} } as never);
    expect(big).toEqual({ ok: false, code: "invalid", error: `请求体超过 ${96 * 1024} 字节` });
    expect(await lendInbox(["--", "peerA", "0000-0000-0000-0000", "{}"], { env: { DISCORD_CHANNEL_ID: "1" } } as never)).toMatchObject({ ok: false, code: "forbidden" });
  });

  test("lend-dispatch 推单：发出去的正文 = 新 offerBody，且过得了新 parseOfferRequest", async () => {
    const sent: OfferRequest[] = [];
    const cands = Array.from({ length: 22 }, (_, i) => ({ peer: "peerA", summary: { ...S, orderId: `o${i}` } }));
    const loop = createPushLoop({
      now: () => 1, candidates: () => cands as never, problem: async () => null, ttlDue: () => false, sweep: async () => {}, log: () => {},
      send: async (_p, body): Promise<PushSend> => { sent.push(body); return { status: 200, e2e: true, body: { ok: true, v: 1, accepted: body.orders.map((o) => o.orderId), refused: [] } }; },
      record: async () => true,
    });
    await loop.tick();
    expect(sent).toEqual([offerBody(cands.map((c) => c.summary))]);
    expect(sent[0].orders).toHaveLength(20);
    expect(parseOfferRequest(sent[0])).toEqual({ ok: true, value: sent[0] });
  });
});
