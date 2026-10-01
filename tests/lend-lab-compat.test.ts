/**
 * i28-W7 版本混搭（docs/design/remote-capacity.md §8.5），进程内双实例（tests/lend-lab-kit.ts）从挂单一路走到入账：
 * - 旧 A + 新 B：A 没有 hello / beat / ask 路由（404）→ B 记 proto 1，30 秒轮询、逐单 lease renew，worker 的 ask 明确回「对方版本不支持」；
 * - 新 A + 旧 B：B 不发 hello → A 不推送（也不按推送 TTL 撤），自动卡的 reviewFirst 认它为 proto 1 不挂；手挂的单 B 靠 poll 领、照常入账。
 * 「旧版」只关路由 / 关 v2 端口模拟，不拉旧代码；B 发出的每个 v1 正文都过 A 的 v1 严格解析器（金样本见 tests/lend-wire-v1-golden.test.ts）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { CallerIdentity } from "../src/lib/caller-identity.js";
import { getLendPeer, pushCandidates } from "../src/lib/ledger-lend-peers.js";
import { getOrder } from "../src/lib/lend-journal.js";
import { routeLendTool } from "../src/lib/lend-tools.js";
import { lab, MATE, type Lab } from "./lend-lab-kit.js";

let L: Lab;
afterEach(() => L?.f.close());

async function ask(id: string): Promise<Record<string, unknown>> {
  const row = getOrder(L.db, id)!;
  const who: CallerIdentity = { agent: row.agent, sessionId: row.sessionId, family: "codex", verified: true };
  const deps = { db: L.db, call: L.aBridge, log: () => {}, now: L.now };
  return (await routeLendTool("ask", who, { v: 1, orderId: id, question: "规格第 2 条指的是哪个文件？", options: ["x.ts", "y.ts"] }, deps)) as Record<string, unknown>;
}

describe("旧 A + 新 B", () => {
  test("hello 拿到 404 → proto 1：A 从不推送，B 30 秒轮询领单、逐单续租，ask 回「对方版本不支持」，结论照常入账", async () => {
    L = await lab({ oldA: () => true });
    L.markNow();
    await L.pass({ a: false });
    expect(L.wire.filter((w) => w.op === "hello").map((w) => w.status)).toEqual([404]);
    const id = await L.handOffer("T2"); // 旧 A 只有手挂（PM lend-offer）
    expect(pushCandidates(L.f.db, L.now())).toEqual([]);
    await L.passes(10, { a: false }); // 30 秒内轮询到，再三个 pass 领、clone、起 worker
    expect(L.bState(id)).toBe("started");
    expect(L.pushes.flatMap((r) => r.pushed)).toEqual([]);
    expect(getLendPeer(L.f.db, MATE)).toBeNull();

    L.advance(61_000);
    await L.pass({ a: false });
    expect(L.ops()).toContain("lease:renew");
    expect(L.ops()).not.toContain("beat"); // 404 之后不发 beat；hello 每个周期再探一次（对方升级了能认出来），回的都是 404
    expect(new Set(L.wire.filter((w) => w.op === "hello").map((w) => w.status))).toEqual(new Set([404]));
    expect(await ask(id)).toMatchObject({ ok: false, code: "peer_no_ask" });

    expect(await L.workerSubmit(id)).toMatchObject({ ok: true, forwarded: true });
    await L.pass({ a: false });
    expect(L.bState(id)).toBe("acked");
    expect(L.reviews("T2")).toHaveLength(1);
    expect(L.v1Strict().every(([, ok]) => ok)).toBe(true);
    const polls = L.ops().filter((o) => o === "poll").length;
    await L.passes(7, { a: false }); // 35 秒：v1 节奏
    expect(L.ops().filter((o) => o === "poll").length).toBe(polls + 1);
    L.report("版本混搭 旧 A + 新 B");
  });
});

describe("新 A + 旧 B", () => {
  test("B 不发 hello：自动卡的 reviewFirst 认它为 proto 1、放本机；手挂的单 A 不推、不按推送 TTL 撤，B 靠 poll 领、照常入账", async () => {
    L = await lab({ oldB: true });
    await L.toReview();
    L.markNow();
    const shown = await L.aCli("pm", "lend-orders", "T1");
    const placement = JSON.stringify(shown.placement);
    expect(shown.placement).toMatchObject({ where: "local", reason: expect.stringContaining("mate：没有 hello（proto 1") });
    const id = await L.handOffer("T2");
    await L.pass();
    expect(L.orders("T1")).toEqual([]);
    expect(pushCandidates(L.f.db, L.now())).toEqual([]);
    expect(L.wire.filter((w) => w.op === "hello" || w.op === "beat")).toEqual([]);

    L.advance(4 * 60_000); // 超过推送 TTL：proto 1 的单不撤
    await L.passes(6);
    expect(L.orders("T2")[0].status).toBe("claimed");
    expect(L.bState(id)).toBe("started");
    L.advance(61_000);
    await L.pass();
    expect(L.ops()).toContain("lease:renew");
    expect(await ask(id)).toMatchObject({ ok: false, code: "peer_no_ask" });
    expect(await L.workerSubmit(id)).toMatchObject({ ok: true, forwarded: true });
    await L.pass();
    expect(L.bState(id)).toBe("acked");
    expect(L.reviews("T2")).toHaveLength(1);
    expect(getLendPeer(L.f.db, MATE)).toBeNull();
    expect(L.v1Strict().every(([, ok]) => ok)).toBe(true);
    L.report("版本混搭 新 A + 旧 B");
    if (process.env.LEND_LAB_TRACE) console.log(`  ledger lend-orders T1 → placement ${placement}`);
  });
});

describe("新 A + 新 B 的对照", () => {
  test("同一张手挂单：推送收单、beat 续租（没有逐单 renew），ask 转给 A", async () => {
    L = await lab();
    await L.pass({ a: false });
    const id = await L.handOffer("T2");
    await L.passes(5, { a: false });
    expect(L.bState(id)).toBe("started");
    expect(getOrder(L.db, id)!.preview.source).toBe("push");
    L.advance(61_000);
    await L.passes(4, { a: false });
    expect(L.ops()).not.toContain("lease:renew");
    expect(L.ops()).toContain("beat");
    expect(await ask(id)).toMatchObject({ ok: false, code: "ask_failed" }); // kit 的 A 没接 ask（真 bridge 走 openOrderAsk），但 B 确实发出了
    expect(L.wire.filter((w) => w.op === "ask")).toHaveLength(1);
  });
});
