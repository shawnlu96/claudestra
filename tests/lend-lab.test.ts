/**
 * i28-W7 lab 场景 1–3（进程内双实例，tests/lend-lab-kit.ts）：推送主路径、上限、一键收回。A 是真台账 + 真调度 tick（reviewFirst），
 * B 是真 lend 循环 + 真收单闸 + 真 create 闸口 + 真 MCP 路由。LEND_LAB_TRACE=1 时每个场景打印证据摘要（docs/team/lend-trial-evidence.md）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { getLendPeer } from "../src/lib/ledger-lend-peers.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { EFFORT, lab, MATE, MODEL, type Lab } from "./lend-lab-kit.js";

let L: Lab;
afterEach(() => L?.f.close());

const intents = (L: Lab) => L.f.intents().map((i) => `${i.action}:${i.recipient ?? "-"}:${i.status}`);
const planText = (L: Lab, task = "T1") => listEvents(L.f.db, { project: "p", target: task }).filter((e) => e.kind === "scheduler" && e.data.op === "plan").map((e) => e.text);

describe("场景 1 推送主路径", () => {
  test("reviewFirst 派审 → A 推送 → B 收单即领 → 按授权的模型 / 档位起 worker → worker 经 MCP 交结论 → A 记 review、B 一行收据", async () => {
    L = await lab();
    await L.toReview();
    L.markNow();
    await L.pass(); // B hello → A 调度按 reviewFirst 挂给 mate → A 推送 → B 收下
    expect(getLendPeer(L.f.db, MATE)).toMatchObject({ proto: 2, grant: expect.objectContaining({ repos: ["o/r"] }), slots: { codex: { total: 2, busy: 0 } } });
    expect(planText(L).at(-1)).toBe("挂池：对抗式跨模型审查挂给 mate 的 codex worker（scheduler.json remote.reviewFirst 指定先给 mate）");
    const [order] = L.orders();
    expect(order).toMatchObject({ status: "pooled", peer: MATE, family: "codex", step: "review" });
    expect(L.bState(order.orderId)).toBe("asked");
    expect(L.ops()).not.toContain("claim"); // 推送只是通知：收下不等于领

    await L.pass(); // 下一个 pass 领单（v1 claim CAS）
    expect(L.orders()[0].status).toBe("claimed");
    await L.passes(3); // clone → 起 worker → 首条派单
    expect(L.bState(order.orderId)).toBe("started");
    expect(L.spawned).toEqual([{ name: expect.stringMatching(/^agent-lend-/), order: order.orderId, args: ["--model", MODEL, "--effort", EFFORT] }]);
    expect(L.firstOrders).toHaveLength(1);

    const r = await L.workerSubmit(order.orderId);
    expect(r).toMatchObject({ ok: true, forwarded: true, duplicate: false, message: "结论已交给对方并拿到回执" });
    const [rv] = L.reviews();
    expect(rv).toMatchObject({ actor: `peer:${MATE}`, text: `远端审查（mate，单号 ${order.orderId}）：pass` });
    expect(rv.data).toMatchObject({ verdict: "pass", reviewer: `peer:${MATE}`, reviewerFamily: "codex", reviewerSessionId: `lend:${MATE}:${order.orderId}`,
      lend: { orderId: order.orderId, peer: MATE, gen: 1, claim: { family: "codex", session: `thr-${L.spawned[0].name}` } } });

    await L.pass(); // B 原样重发拿回执 → 验签 → acked → 停 worker → 写收据
    expect(L.bState(order.orderId)).toBe("acked");
    expect(new Set(L.killed)).toEqual(new Set([L.spawned[0].name])); // kill 幂等：收尾前后各确认一次
    expect(L.registry.size).toBe(0);
    expect(L.receipts).toEqual([expect.objectContaining({ orderId: order.orderId, taskId: "T1", step: "review", family: "codex", outcome: "acked", ackSig: expect.anything() })]);
    expect(L.orders()[0].status).toBe("done");
    expect(L.reviews()).toHaveLength(1);
    await L.pass();
    expect(L.f.task().stage).toBe("merge");
    expect(L.v1Strict().every(([, ok]) => ok)).toBe(true);
    L.report("场景 1 推送主路径");
  });
});

describe("场景 2 上限", () => {
  test("授权 2、待审 3：B 只收 2 张，第 3 张拒收 no_slot → A 当场撤回告诉 PM；B 报满后自动卡的审查按 W5 放本机，lend-orders 说得出为什么", async () => {
    L = await lab({ slots: 2, maxOpen: 3 });
    await L.pass({ a: false }); // B hello（授权 2 个 Codex 位）
    const ids = [await L.handOffer("T2"), await L.handOffer("T3"), await L.handOffer("T4")];
    L.markNow();
    await L.pass({ a: false }); // 一批推 3 张：收 2、拒 1
    expect(L.pushes.at(-1)).toMatchObject({ pushed: ids, acked: ids.slice(0, 2) });
    expect(ids.map((id) => L.bState(id))).toEqual(["asked", "asked", undefined]);
    expect(L.orders("T4")[0]).toMatchObject({ status: "cancelled", reason: expect.stringContaining("no_slot") });
    expect(L.pmNotices.some((t) => t.includes("T4"))).toBe(true);
    await L.passes(4, { a: false }); // 领 2 张、起 2 个 worker，第 3 个位不存在
    expect(ids.map((id) => L.bState(id))).toEqual(["started", "started", undefined]);
    expect(L.spawned).toHaveLength(2);
    expect(L.ops().filter((o) => o === "claim")).toHaveLength(2);
    expect(getLendPeer(L.f.db, MATE)!.slots.codex).toEqual({ total: 2, busy: 2 }); // hello 报满
    const peers = await L.aCli("pm", "lend-peers", "--peer", MATE);
    expect(peers.peers[0]).toMatchObject({ open: 2, slots: { codex: 0 } });

    await L.toReview(); // 这时自动卡 T1 进审查：reviewFirst 的 mate 没有空位 → 本机
    const shown = await L.aCli("pm", "lend-orders", "T1"); // W5 的只读命令：下一轮会放哪、为什么
    const placement = JSON.stringify(shown.placement);
    expect(shown.placement).toEqual({ role: "review", where: "local", reason: expect.stringContaining("reviewFirst 里的 peer 都不能接（mate：对方没有空闲的 codex 槽）") });
    await L.pass();
    expect(L.orders("T1")).toEqual([]);
    expect(intents(L)).toContain("ensure_session:-:done");
    expect(planText(L).at(-1)).toBe("为 reviewer 建本卡独立 session");
    L.report("场景 2 上限");
    const t4 = L.orders("T4").map((o) => [o.orderId, o.status, o.reason]);
    if (process.env.LEND_LAB_TRACE) {
      console.log(`  ledger lend-orders T1 → placement ${placement}\n  ledger lend-peers --peer mate → ${JSON.stringify(peers.peers)}`);
      console.log(`  ledger lend-orders T4 → ${JSON.stringify(t4)}`);
    }
  });
});

describe("场景 3 一键收回", () => {
  test("在跑时 B 收回：worker 先停，beat 带 ended{revoked, clean} → A 释放、卡放回本机；收回后 B 不收新单", async () => {
    L = await lab();
    await L.toReview();
    await L.passes(4);
    const [order] = L.orders();
    expect(L.bState(order.orderId)).toBe("started");
    L.markNow();

    L.grant([]); // 出借方本人点「收回」：lend.json 里这条没了
    await L.pass({ a: false });
    expect(L.killed).toEqual([L.spawned[0].name]); // 先停 worker，这一轮不出站之前就停了
    expect(L.bState(order.orderId)).toBe("stopped");
    expect(getLendPeer(L.f.db, MATE)!.grant).toBeNull(); // hello 报授权已收回
    await L.pass({ a: false }); // 下一次 beat 带 ended
    const ended = L.wire.filter((w) => w.op === "beat").flatMap((w) => w.body.orders as Record<string, unknown>[]).filter((x) => x.ended);
    expect(ended).toEqual([expect.objectContaining({ orderId: order.orderId, ended: { reason: "revoked", clean: true } })]);
    expect(L.orders()[0].status).toBe("released");

    await L.pass(); // A 调度重排：mate 没授权 → 本机
    expect(intents(L).at(-1)).toMatch(/^(ensure_session|review):/);
    expect(intents(L).filter((i) => i.startsWith("review:peer:mate"))).toHaveLength(1);

    const t2 = await L.handOffer("T2"); // PM 手挂一张给 mate：A 不推（对方没授权），B 不轮询（没有这条授权），推送 TTL 到点撤回告诉 PM
    expect(L.pushes.at(-1)?.pushed ?? []).not.toContain(t2);
    await L.passes(30);
    expect(L.pushes.flatMap((r) => r.pushed)).not.toContain(t2);
    expect(L.bState(t2)).toBeUndefined();
    expect(L.ops().filter((o) => o === "claim")).toHaveLength(1);
    expect(L.orders("T2")[0]).toMatchObject({ status: "cancelled" });
    expect(L.receipts).toEqual([expect.objectContaining({ orderId: order.orderId, outcome: "stopped" })]);
    L.report("场景 3 一键收回");
  });
});

/**
 * W7 实测时独立撞到、i28-N10 已修的回归（docs/team/lend-trial-evidence.md「问题 1」）：`ledger scheduler-pool` 投递前重算放置曾丢了 reviewFirst，
 * reviewFirst 的 peer 比本机忙时计划挂给它、投递时重算成「放本机」→ 意图 cancelled → 这一轮回本机。两边都空闲时平手按「peer 先于本机」碰巧一致，场景 1 测不出。
 */
describe("回归：reviewFirst 的 peer 比本机忙也照样给它（N10）", () => {
  test("mate 已在跑 1 张（还有 1 个空位），本机空闲：T1 的审查挂给 mate 并被领走", async () => {
    L = await lab({ slots: 2, maxOpen: 3 });
    await L.pass({ a: false });
    const t2 = await L.handOffer("T2");
    await L.passes(4, { a: false });
    expect(L.bState(t2)).toBe("started");
    await L.toReview();
    await L.pass();
    expect(planText(L).at(-1)).toBe("挂池：对抗式跨模型审查挂给 mate 的 codex worker（scheduler.json remote.reviewFirst 指定先给 mate）");
    expect(intents(L).filter((i) => i.startsWith("review:peer:mate"))).toEqual(["review:peer:mate:pending"]);
    expect(L.orders("T1")).toEqual([expect.objectContaining({ peer: MATE, status: "pooled" })]);
    await L.passes(4);
    expect(L.orders("T1")[0].status).toBe("claimed");
    expect(L.spawned).toHaveLength(2);
    expect(planText(L)).not.toContain("为 reviewer 建本卡独立 session"); // 本机没起审查 session
  });
});
