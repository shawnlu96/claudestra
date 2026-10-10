import { expect, test } from "bun:test";
import { parseLendRequest } from "../src/lib/lend-wire.js";
import { helloAnswer, parseV2Request, parseV2Response } from "../src/lib/lend-wire-v2.js";
import { offerBody } from "../src/lib/lend-offer-protocol.ts";
const H = "b".repeat(40);

const wireClone = (v: unknown) => JSON.parse(JSON.stringify(v));
test("hello/beat external bodies keep existing v2 protocol shape, with no central fence fields", () => {
  const hello = { v: 1, proto: 2, boot: "boot-0001", seq: 1,
    grant: { until: 60000, roles: ["review"], repos: ["team/repository"], ordersPerDay: 3, ordersLeftToday: 3 },
    slots: { codex: { total: 1, busy: 0 }, claude: { total: 0, busy: 0 } }, paused: null };
  expect<unknown>(parseV2Request("hello", wireClone(hello))).toEqual({ ok: true, value: hello });
  const reply = { ok: true, v: 1, ...helloAnswer() };
  expect(parseV2Response("hello", wireClone(reply))).toEqual({ ok: true, value: helloAnswer() });
  const beat = { v: 1, orders: [{ orderId: "order", gen: 1, phase: "working", lastActivityAt: 1000, excerpt: "测试" }] };
  expect<unknown>(parseV2Request("beat", wireClone(beat))).toEqual({ ok: true, value: { ...beat, orders: [{ ...beat.orders[0], ended: null }] } });
  expect(parseV2Request("hello", { ...hello, serviceGeneration: 1 }).ok).toBe(false);
});

test("recorded central offer/lease responses cross legacy claim/beat/result consumers", () => {
  const o = { orderId: "order" };
  const offer = offerBody([{ orderId: o.orderId, taskId: "task", step: "review", family: "codex",
    repo: "team/repository", pr: 1, head: H, round: 0, specRev: 1, offeredAt: 2000 }]);
    expect(parseV2Request("offer", wireClone(offer))).toEqual({ ok: true, value: offer });
    expect(offer.orders[0]).toEqual({ orderId: o.orderId, taskId: "task", step: "review", family: "codex",
      repo: "team/repository", pr: 1, head: H, round: 0, specRev: 1, offeredAt: 2000 });
    const rawClaim = { v: 1, orderId: o.orderId, worker: "worker" };
    expect<unknown>(parseLendRequest("claim", wireClone(rawClaim))).toEqual({ ok: true, value: rawClaim });
    const lease = { gen: 1, expiresAt: 602000, ms: 600000 };
    expect(lease).toEqual({ gen: 1, expiresAt: 602000, ms: 600000 });
    const rawRenew = { v: 1, orderId: o.orderId, gen: lease.gen, action: "renew", reason: null, detail: null };
    expect<unknown>(parseLendRequest("lease", wireClone(rawRenew))).toEqual({ ok: true, value: rawRenew });
    const renewed = { gen: 1, expiresAt: 617000, ms: 600000 };
    const beatReply = { ok: true, v: 1, orders: [{ orderId: o.orderId, verdict: "ok", lease: renewed }] };
    expect<unknown>(parseV2Response("beat", wireClone(beatReply))).toEqual({ ok: true, value: beatReply.orders });
    const rawResult = { v: 1, orderId: o.orderId, gen: lease.gen,
      verdict: { v: 1, orderId: o.orderId, head: H, verdict: "pass", p0: 0, p1: 0, p2: 0, findings: [], reportPath: "review.md" },
      report: "已核对", session: { id: "session", family: "codex" } };
    const parsed = parseLendRequest("result", wireClone(rawResult));
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && JSON.stringify(parsed.value)).toBe(JSON.stringify(rawResult));
    expect(parseLendRequest("result", { ...rawResult, epoch: 1 }).ok).toBe(false);
});
