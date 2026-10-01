/**
 * i28-W7 lab 场景 4–8（进程内双实例，tests/lend-lab-kit.ts）：起 worker 前授权被改（W1c）、B 掉线、B 重启、回执丢失、隔离反例（W4 验收线 1）。
 * LEND_LAB_TRACE=1 时打印证据摘要（docs/team/lend-trial-evidence.md）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { CallerIdentity } from "../src/lib/caller-identity.js";
import { CHOICE_CHANGED } from "../src/lib/lend-grant-spawn.js";
import { getOrder } from "../src/lib/lend-journal.js";
import { lendFrameGate, routeLendTool } from "../src/lib/lend-tools.js";
import { EFFORT, H1, lab, MATE, MODEL, type Lab } from "./lend-lab-kit.js";

let L: Lab;
afterEach(() => L?.f.close());

/** T1 自动卡走到 B 上的 worker 已起、首条派单已发 */
async function running(): Promise<string> {
  L = await lab();
  await L.toReview();
  await L.passes(5);
  const id = L.orders()[0].orderId;
  expect(L.bState(id)).toBe("started");
  return id;
}

describe("场景 4 起 worker 前授权被改（W1c）", () => {
  test("父进程按旧模型组好参数之后、manager create 闸口之前改了授权：闸口拒起 → not_started 退回 A → 下一张单按新授权起", async () => {
    L = await lab();
    await L.toReview();
    L.markNow();
    L.hooks.beforeCreateGate = () => L.grant([{ ...L.entry, codexModel: "gpt-5.1-codex" }]); // 出借方本人在这段工夫里改了模型
    await L.passes(4);
    const [order] = L.orders();
    expect(L.refusedSpawns).toEqual([{ name: expect.stringMatching(/^agent-lend-/), why: CHOICE_CHANGED }]);
    expect(L.spawned).toEqual([]);
    expect(L.bState(order.orderId)).toBe("released");
    expect(getOrder(L.db, order.orderId)!.reason).toContain(CHOICE_CHANGED);
    expect(L.orders()[0]).toMatchObject({ status: "released", reason: expect.stringContaining("not_started") });

    const t2 = await L.handOffer("T2"); // 下一张单：按改过的授权起
    await L.passes(4);
    expect(L.bState(t2)).toBe("started");
    expect(L.spawned).toEqual([{ name: expect.stringMatching(/^agent-lend-/), order: t2, args: ["--model", "gpt-5.1-codex", "--effort", EFFORT] }]);
    L.report("场景 4 起 worker 前授权被改");
  });
});

describe("场景 5 B 掉线", () => {
  test("推送一直送不到：2 分钟推送 TTL 撤回 → 自动卡放回本机；B 回来后不领、不出第二份审查", async () => {
    L = await lab();
    await L.pass({ a: false }); // B 先报过 hello，A 以为推得过去
    await L.toReview();
    L.markNow();
    L.net.bOffline = true;
    await L.passes(26); // 130 秒
    const [order] = L.orders();
    expect(order).toMatchObject({ status: "cancelled", reason: expect.stringContaining("推送超时") });
    expect(L.pushes.some((r) => r.failed.includes(order.orderId))).toBe(true);
    expect(L.f.intents().some((i) => i.action === "ensure_session" && i.status === "done")).toBe(true); // 本机审查 session 接手

    L.net.bOffline = false;
    await L.passes(12); // B 回来：hello、poll 都通，但这张单已撤
    expect(L.bState(order.orderId)).toBeUndefined();
    expect(L.ops()).not.toContain("claim");
    expect(L.reviews()).toEqual([]);
    expect(L.f.intents().filter((i) => i.action === "review" && i.recipient === `peer:${MATE}`)).toHaveLength(1);
    L.report("场景 5a B 掉线（推送阶段）");
  });

  test("worker 在跑时 B 掉线：租约截止 B 自停 worker，A 结成 unknown 交 PM、不自动转派；B 回来交不进结论", async () => {
    const id = await running();
    L.markNow();
    L.net.bOffline = true;
    await L.passes(125); // 10 分钟租约 + 余量
    expect(L.bState(id)).toBe("stopped");
    expect(L.killed).toEqual([L.spawned[0].name]);
    expect(getOrder(L.db, id)!.reason).toContain("心跳过期");
    expect(L.orders()[0].status).toBe("unknown");
    expect(L.pmNotices.some((t) => t.includes(id))).toBe(true);
    expect(L.f.intents().filter((i) => i.action === "review")).toHaveLength(1); // 没有自动转派

    L.net.bOffline = false;
    await L.passes(3);
    expect(L.reviews()).toEqual([]);
    expect(L.spawned).toHaveLength(1);
    L.report("场景 5b B 掉线（worker 在跑）");
  });
});

describe("场景 6 B 重启", () => {
  test("worker 在跑时调度服务重启：靠 journal 续上（不建第二个 worker），beat 续租，结论只入账一次", async () => {
    const id = await running();
    L.markNow();
    const until = L.orders()[0].leaseUntil!;
    L.restartB();
    await L.passes(4);
    expect(L.spawned).toHaveLength(1);
    expect(L.bState(id)).toBe("started");
    expect(L.orders()[0].leaseUntil!).toBeGreaterThan(until);
    expect(L.wire.filter((w) => w.op === "hello").map((w) => w.body.boot)).toContain("boot-lab-0002");

    L.net.dropResultAnswers = 1; // 交结论那一下 A 入账了、应答丢了，紧接着又重启一次
    expect(await L.workerSubmit(id)).toMatchObject({ ok: true, forwarded: false, message: "结论已记下，调度服务会原样转给对方" });
    L.restartB();
    await L.passes(2);
    expect(L.bState(id)).toBe("acked");
    expect(L.reviews()).toHaveLength(1);
    expect(L.receipts).toEqual([expect.objectContaining({ orderId: id, outcome: "acked" })]);
    L.report("场景 6 B 重启");
  });
});

describe("场景 7 回执丢失", () => {
  test("result 应答连丢两次：B 原字节重发（同一 sha256），A 回同一张回执，只入账一次", async () => {
    const id = await running();
    L.markNow();
    L.net.dropResultAnswers = 2;
    const r = await L.workerSubmit(id);
    expect(r).toMatchObject({ ok: true, forwarded: false });
    await L.passes(3);
    const results = L.wire.filter((w) => w.op === "result");
    expect(results).toHaveLength(3);
    expect(new Set(results.map((w) => JSON.stringify(w.body))).size).toBe(1);
    const seqs = results.map((w) => (w.answer as { receipt: { eventSeq: number } }).receipt.eventSeq);
    expect(new Set(seqs).size).toBe(1);
    expect(L.reviews()).toHaveLength(1);
    expect(L.bState(id)).toBe("acked");
    expect(await L.workerSubmit(id).catch(() => null)).toMatchObject({ ok: false, code: "no_order" }); // 单已结，worker 再交拒
    L.report("场景 7 回执丢失");
  });
});

describe("场景 8 隔离反例（W4 验收线 1）", () => {
  test("worker 拿着有效凭据直连 bridge：白名单外的工具和原生帧一律拒；本单的 take_review 照常", async () => {
    const id = await running();
    const row = getOrder(L.db, id)!;
    const me: CallerIdentity = { agent: row.agent, sessionId: row.sessionId, family: "codex", verified: true };
    const deps = { db: L.db, call: async () => { throw new Error("不该出站"); }, log: () => {}, now: L.now };
    const tool = async (name: string, args: unknown = {}, who = me) => (await routeLendTool(name, who, args, deps)) as Record<string, unknown>;
    const outside = ["plan_feature", "rewrite_dag", "start_node", "show_dag", "fleet", "send_to_agent", "reply", "dispatch", "review", "stage", "ask_codex"];
    const got = await Promise.all(outside.map(async (t) => [t, (await tool(t)).code]));
    expect(got).toEqual(outside.map((t) => [t, "lend_forbidden"]));
    expect((await tool("take_order")).code).toBe("wrong_step"); // 审查单不给开工工具
    expect((await tool("deliver", { orderId: id })).code).toBe("wrong_step");
    expect((await tool("take_review", { orderId: "lend:T9:s1:r1:a0" })).code).toBe("order_mismatch");
    expect((await tool("take_review", {}, { ...me, verified: false })).code).toBe("identity_unverified");
    expect((await tool("take_review", {}, { ...me, sessionId: "thr-other" })).code).toBe("session_mismatch");
    expect((await tool("submit_verdict", { v: 1, orderId: id, head: "f".repeat(40), verdict: "pass", p0: 0, p1: 0, p2: 0, findings: [], reportPath: "report.md" })).code)
      .toBe("head_mismatch");
    expect(await tool("take_review")).toMatchObject({ ok: true, orders: [expect.objectContaining({ orderId: id, head: H1 })] });

    const frames: object[] = [];
    const native = ["reply", "route_to_agent", "project_info", "send_to_agent", "fleet_list", "ask_codex", "create_channel"];
    for (const type of native) expect(lendFrameGate({ type, requestId: type }, () => ({ agent: row.agent }), (f) => void frames.push(f), () => {})).toBe(true);
    expect(frames).toEqual(native.map((t) => ({ type: "response", requestId: t, error: `lend_forbidden:${t}` })));
    expect(lendFrameGate({ type: "order_tool" }, () => ({ agent: row.agent }), () => {}, () => {})).toBe(false);
    expect(L.reviews()).toEqual([]);
    if (process.env.LEND_LAB_TRACE) console.log(`=== 场景 8 隔离反例 ===\n  工具：${JSON.stringify(got)}\n  原生帧：${JSON.stringify(frames.map((f) => (f as { error: string }).error))}`);
  });
});

describe("模型 / 档位只由出借方定", () => {
  test("A 的订单里写什么都不影响：create 参数只看 B 授权", async () => {
    await running();
    expect(L.spawned[0].args).toEqual(["--model", MODEL, "--effort", EFFORT]);
    expect(JSON.stringify(L.orders()[0].wire)).not.toContain(MODEL);
  });
});
