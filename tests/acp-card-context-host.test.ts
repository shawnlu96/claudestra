import { describe, expect, test } from "bun:test";
import { CardContextHost, type CardHostState } from "../src/lib/acp/card-context-host.ts";
import { AcpTurnLoop, type PromptOutcome } from "../src/lib/acp/turn.ts";

// CTXA 宿主一侧：真的 AcpTurnLoop + 假的适配器 IO / 宿主状态 / 时钟。不起进程、不调模型。

const MIN3 = 3 * 60_000;
const tick = () => new Promise((r) => setTimeout(r, 0));

function rig(opts: { mode?: "on" | "observe" | "off"; expected?: string; commitMs?: number; lease?: false } = {}) {
  let clock = 1_000_000;
  const prompts: string[] = [];
  const pending: ((o: PromptOutcome) => void)[] = [];
  const logs: string[] = [];
  const failures: string[] = [];
  const stops: string[] = [];
  let stopVerdict: { block?: boolean; reason?: string } = {};
  const state: CardHostState = { sessionId: "s1", registered: true, capable: true, rotating: false, compacting: false, adapterRunning: false };
  let card!: CardContextHost;
  const loop = new AcpTurnLoop({
    prompt: (text) => (prompts.push(text), new Promise((r) => pending.push(r))),
    reportStop: async (r) => (stops.push(r.event), (() => { const v = stopVerdict; stopVerdict = {}; return v; })()),
    onFailure: (f) => failures.push(f.message),
    onSlotEnd: (e) => card.onSlotEnd(e),
    admit: (h) => card.admit(h),
    now: () => clock,
    log: (m) => logs.push(m),
  });
  card = new CardContextHost({
    hostId: "h1", loop, mode: opts.mode ?? "on", commitMs: opts.commitMs,
    liveBinding: opts.lease === false ? undefined : "atomic", // 单测缺省接上租约 port，只为钉住两段受理；生产现状见 lease: false
    identity: { card: "CTXA", expectedSessionId: opts.expected ?? "s1" }, now: () => clock,
    state: () => state, log: (m) => logs.push(m),
  });
  card.noteAttach();
  const usage = (tokens: number, window = 1_000_000) => card.noteEntries([{ type: "system", subtype: "context_usage", tokens, window }]);
  const finish = async (o: PromptOutcome = { kind: "done" }) => (pending.shift()!(o), await tick(), await tick());
  const binding = { card: "CTXA", sessionId: "s1" };
  const status = () => (card.call({ op: "card_context", binding }) as any).status;
  /** 只发第一段（card_compact）：受理成功是 prepared，调度器占住、等确认 */
  const prepare = (opId: string, over: Record<string, unknown> = {}) => {
    const s = status();
    return card.call({ op: "card_compact", opId, card: "CTXA", expectedSessionId: s.sessionId, hostId: s.hostId,
      attachGen: s.attachGen, turnGen: s.turnGen, slotGen: s.slotGen, binding, ...over }) as any;
  };
  const commit = (opId: string, b: unknown = binding) => card.call({ op: "card_commit", opId, hostId: "h1", binding: b }) as any;
  /** 两段一起（bridge acpCardCompact 的做法）：prepared 了就按同一份登记确认 */
  const ask = (opId: string, over: Record<string, unknown> = {}) => {
    const p = prepare(opId, over);
    return p.prepared ? commit(opId) : p;
  };
  /** 跑完一轮普通回合，回合内报 tokens，然后闲置 idleMs */
  const turn = async (tokens: number, idleMs = MIN3) => {
    void loop.submit("hi");
    usage(tokens);
    await finish();
    clock += idleMs;
  };
  return {
    loop, card, state, prompts, logs, failures, stops, usage, finish, status, ask, prepare, commit, turn, advance: (ms: number) => (clock += ms),
    blockNextStop: (reason: string) => void (stopVerdict = { block: true, reason }),
  };
}

describe("受理", () => {
  test("闲置满 3 分钟 + 过 20 万：受理，独占一轮 /compact；受理 / 槽结局 / 实际压缩完成分开记", async () => {
    const r = rig();
    await r.turn(200_000);
    const res = r.ask("op-a");
    expect(res).toMatchObject({ ok: true, accepted: true, kind: "idle", op: { opId: "op-a", outcome: null, compacted: false } });
    await tick();
    expect(r.prompts.at(-1)).toBe("/compact");
    expect(r.loop.busy).toBe(true);
    r.card.noteEntries([{ type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "manual" } }]);
    await r.finish();
    expect((r.card.call({ op: "card_context", opId: "op-a" }) as any).status.op).toMatchObject({ outcome: "done", compacted: true });
    expect(r.status().usage.state).toBe("stale"); // 压缩后旧 usage 作废，等新的
  });

  test("压缩失败：槽结局 failed、compacted=false；不自动重发", async () => {
    const r = rig();
    await r.turn(250_000);
    r.ask("op-f");
    await tick();
    await r.finish({ kind: "failed", failure: { kind: "error", key: "k", message: "boom" } });
    expect((r.card.call({ op: "card_context", opId: "op-f" }) as any).status.op).toMatchObject({ outcome: "failed", compacted: false });
    expect(r.prompts.filter((p) => p === "/compact")).toHaveLength(1);
  });

  test("同一个 opId 再来：回原记录，不重放", async () => {
    const r = rig();
    await r.turn(250_000);
    r.ask("op-d");
    expect(r.ask("op-d")).toMatchObject({ ok: true, duplicate: true, op: { opId: "op-d" } });
    await tick();
    await r.finish();
    expect(r.ask("op-d")).toMatchObject({ ok: true, duplicate: true, op: { outcome: "done" } });
    expect(r.prompts.filter((p) => p === "/compact")).toHaveLength(1);
  });

  test("两个申请（同一份查询身份）只受理一个", async () => {
    const r = rig();
    await r.turn(250_000);
    const s = r.status();
    const body = { op: "card_compact", card: "CTXA", expectedSessionId: "s1", hostId: s.hostId, attachGen: s.attachGen, turnGen: s.turnGen, slotGen: s.slotGen,
      binding: { card: "CTXA", sessionId: "s1" } };
    const a = r.card.call({ ...body, opId: "x1" }) as any;
    const b = r.card.call({ ...body, opId: "x2" }) as any;
    expect(a.prepared).toBe(true);
    expect(b).toMatchObject({ ok: false, reason: "turn-drift" });
    expect(r.commit("x1")).toMatchObject({ ok: true, accepted: true });
    await tick();
    expect(r.prompts.filter((p) => p === "/compact")).toHaveLength(1);
  });
});

test("完整记录淘汰之后同一个 opId 再来：op-expired，不重放（request-0..50 之后再请求 request-0）", async () => {
  const r = rig();
  for (let i = 0; i <= 50; i++) {
    await r.turn(250_000);
    expect(r.ask(`request-${i}`)).toMatchObject({ accepted: true });
    await tick();
    await r.finish();
    r.advance(MIN3);
  }
  await r.turn(250_000);
  expect(r.ask("request-0")).toMatchObject({ ok: false, reason: "op-expired" });
  expect(r.prompts.filter((p) => p === "/compact")).toHaveLength(51);
});

describe("两段受理：prepared 占住调度器，确认时再核现行登记", () => {
  test("prepared 之后台账退休 / 换卡 / 换会话：作废，不进模型，槽结局 revoked；调度器放开，后面的消息照常", async () => {
    for (const [b, why] of [[null, "not-bound"], [{ card: "T-next", sessionId: "s1" }, "binding-revoked"], [{ card: "CTXA", sessionId: "s2" }, "binding-revoked"]] as const) {
      const r = rig();
      await r.turn(250_000);
      expect(r.prepare("p1")).toMatchObject({ ok: true, prepared: true, accepted: false, op: { commit: "pending" } });
      void r.loop.submit("during hold");
      await tick();
      expect(r.prompts).toEqual(["hi"]); // 占住期间不开别的回合
      expect(r.commit("p1", b)).toMatchObject({ ok: false, reason: why, op: { commit: why } });
      await tick();
      expect(r.prompts).toEqual(["hi", "during hold"]);
      expect((r.card.call({ op: "card_context", opId: "p1" }) as any).status.op).toMatchObject({ outcome: "revoked", commit: why });
      expect(r.commit("p1")).toMatchObject({ ok: false, reason: why }); // 再确认只回已定的结论
      expect(r.prompts.filter((p) => p === "/compact")).toHaveLength(0);
    }
  });

  test("等不到确认：commitMs 后作废，之后再确认也不压缩", async () => {
    const r = rig({ commitMs: 5 });
    await r.turn(250_000);
    expect(r.prepare("p2")).toMatchObject({ prepared: true });
    await new Promise((res) => setTimeout(res, 20));
    expect(r.commit("p2")).toMatchObject({ ok: false, reason: "commit-timeout" });
    expect(r.prompts.filter((p) => p === "/compact")).toHaveLength(0);
    expect(r.loop.busy).toBe(false);
  });

  test("prepared 之后适配器重接 / 自发开回合：作废；确认成功再确认回 duplicate；没 prepared 的 opId：not-prepared", async () => {
    const r = rig();
    await r.turn(250_000);
    r.prepare("p3");
    r.card.noteAttach();
    expect(r.commit("p3")).toMatchObject({ ok: false, reason: "old-attach" });
    const q = rig();
    await q.turn(250_000);
    q.prepare("p4");
    q.state.adapterRunning = true;
    expect(q.commit("p4")).toMatchObject({ ok: false, reason: "running" });
    q.state.adapterRunning = false;
    const o = rig();
    await o.turn(250_000);
    o.prepare("p5");
    expect(o.commit("p5")).toMatchObject({ ok: true, accepted: true, op: { commit: "committed" } });
    expect(o.commit("p5")).toMatchObject({ ok: true, accepted: true, duplicate: true });
    await tick();
    expect(o.prompts.filter((p) => p === "/compact")).toHaveLength(1);
    expect(o.commit("nope")).toMatchObject({ ok: false, reason: "not-prepared" });
    expect(o.card.call({ op: "card_commit", opId: "p5", hostId: "h-old", binding: { card: "CTXA", sessionId: "s1" } })).toMatchObject({ ok: false, reason: "old-host" });
  });

  // prepared 只占住调度器，宿主输入照收：确认时 prepare 之后变了的受理条件一律作废（fail-closed）
  test("prepared 之后到了压缩边界：usage 陈旧，作废；边界不记到还没进模型的那一槽", async () => {
    const r = rig();
    await r.turn(250_000);
    r.prepare("p6");
    r.card.noteEntries([{ type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto" } }]);
    expect(r.status().usage.state).toBe("stale");
    expect(r.commit("p6")).toMatchObject({ ok: false, reason: "usage-stale", op: { commit: "usage-stale", compacted: false } });
    await tick();
    expect(r.prompts.filter((p) => p === "/compact")).toHaveLength(0);
    expect((r.card.call({ op: "card_context", opId: "p6" }) as any).status.op).toMatchObject({ outcome: "revoked", compacted: false });
  });

  test("prepared 之后来了新的 usage（哪怕仍过线）：不是受理时那一份，作废", async () => {
    const r = rig();
    await r.turn(250_000);
    r.prepare("p7");
    r.usage(260_000);
    expect(r.commit("p7")).toMatchObject({ ok: false, reason: "usage-stale" });
    await tick();
    expect(r.prompts.filter((p) => p === "/compact")).toHaveLength(0);
  });

  test("prepared 之后外部排了 op 槽 / 命令 / 入站：代次或队列变了，作废；排着的照常跑", async () => {
    for (const add of [
      (r: ReturnType<typeof rig>) => void r.loop.submitOp("handoff", "op-x"),
      (r: ReturnType<typeof rig>) => void r.loop.submitCommand("/status"),
      (r: ReturnType<typeof rig>) => void r.loop.submit("inbound"),
    ]) {
      const r = rig();
      await r.turn(250_000);
      r.prepare("p8");
      add(r);
      expect(r.loop.queued).toBe(1);
      const res = r.commit("p8");
      expect(res.ok).toBe(false);
      expect(["turn-drift", "queued"]).toContain(res.reason);
      await tick();
      expect(r.prompts.filter((p) => p === "/compact")).toHaveLength(0);
      expect(r.prompts).toHaveLength(2); // 排着的那一轮照常开
    }
  });

  test("自己那一槽不算排队：prepare 后什么都没变，照常放行", async () => {
    const r = rig();
    await r.turn(250_000);
    r.prepare("p9");
    expect(r.loop.queued).toBe(0);
    expect(r.commit("p9")).toMatchObject({ ok: true, accepted: true });
    await tick();
    expect(r.prompts.at(-1)).toBe("/compact");
  });

  test("状态里照实报：现行登记的原子受理 blocked-capability", () => {
    expect(rig({ lease: false }).status().liveBinding).toBe("blocked-capability");
  });
});

describe("拒绝（不重放、不降级为普通 slash）", () => {
  test("现行登记：台账里已退休（没带登记）/ 换卡 / 同会话换绑：拒，不受理旧卡压缩", async () => {
    const r = rig();
    await r.turn(250_000);
    expect(r.ask("nb", { binding: null })).toMatchObject({ ok: false, reason: "not-bound" });
    expect(r.ask("rc", { binding: { card: "T-other", sessionId: "s1" } })).toMatchObject({ ok: false, reason: "binding-revoked" });
    expect(r.ask("rs", { binding: { card: "CTXA", sessionId: "s-new" } })).toMatchObject({ ok: false, reason: "binding-revoked" });
    expect(r.prompts.filter((p) => p === "/compact")).toHaveLength(0);
    expect((r.card.call({ op: "card_context" }) as any).status.verdict).toMatchObject({ reason: "not-bound" });
  });

  test("启动登记的会话和实际接上的不一致", async () => {
    const r = rig({ expected: "s-boot" });
    await r.turn(250_000);
    expect(r.ask("o")).toMatchObject({ ok: false, reason: "startup-mismatch" });
  });

  test("宿主重启（hostId 换了）/ 适配器重起（接线代次漂移）", async () => {
    const r = rig();
    await r.turn(250_000);
    expect(r.ask("o1", { hostId: "h-old" })).toMatchObject({ ok: false, reason: "old-host" });
    const before = r.status();
    r.card.noteAttach();
    expect(r.ask("o2", { attachGen: before.attachGen })).toMatchObject({ ok: false, reason: "old-attach" });
    expect(r.ask("o3")).toMatchObject({ ok: false, reason: "usage-stale" }); // 换了接线，之前的 usage 不算
  });

  test("查询之后开过回合（busy 与 idle 竞态）：代次对不上", async () => {
    const r = rig();
    await r.turn(250_000);
    const s = r.status();
    await r.turn(250_000);
    expect(r.card.call({ op: "card_compact", opId: "late", card: "CTXA", expectedSessionId: "s1", hostId: "h1",
      attachGen: s.attachGen, turnGen: s.turnGen, slotGen: s.slotGen, binding: { card: "CTXA", sessionId: "s1" } })).toMatchObject({ ok: false, reason: "turn-drift" });
  });

  test("在跑 / 排队 / 适配器自发回合 / 正在压缩 / 未登记 / 能力缺失", async () => {
    const r = rig();
    await r.turn(250_000);
    r.state.adapterRunning = true;
    expect(r.ask("a")).toMatchObject({ reason: "running" });
    r.state.adapterRunning = false;
    r.state.compacting = true;
    expect(r.ask("b")).toMatchObject({ reason: "compacting" });
    r.state.compacting = false;
    r.state.registered = false;
    expect(r.ask("c")).toMatchObject({ reason: "not-registered" });
    r.state.registered = true;
    r.state.capable = false;
    expect(r.ask("d")).toMatchObject({ reason: "no-capability" });
    r.state.capable = true;
    void r.loop.submit("busy");
    expect(r.ask("e")).toMatchObject({ reason: "running" });
    void r.loop.submit("more");
    expect(r.prompts.filter((p) => p === "/compact")).toHaveLength(0);
  });

  test("usage 缺失；闲置不满 3 分钟；observe / off 只拒不动", async () => {
    const r = rig();
    expect(r.ask("u")).toMatchObject({ ok: false, reason: "usage-unknown" });
    await r.turn(200_000, MIN3 - 1);
    expect(r.ask("w")).toMatchObject({ ok: false, reason: "idle-wait" });
    const o = rig({ mode: "observe" });
    await o.turn(300_000);
    expect(o.ask("ob")).toMatchObject({ ok: false, reason: "observe", wouldFire: "hard" });
    const off = rig({ mode: "off" });
    await off.turn(300_000);
    expect(off.ask("of")).toMatchObject({ ok: false, reason: "mode-off" });
    expect([...r.prompts, ...o.prompts, ...off.prompts].filter((p) => p === "/compact")).toHaveLength(0);
  });

  test("申请缺字段：bad-request", () => {
    expect(rig().card.call({ op: "card_compact", opId: "x" })).toMatchObject({ ok: false, reason: "bad-request" });
  });
});

describe("新回合受理边界（硬线）", () => {
  test("on：过 30 万后下一轮前先独占压缩，原 prompt 原位留着；压缩完成（边界 + 线下 usage）后放行", async () => {
    const r = rig();
    await r.turn(300_000, 0);
    void r.loop.submit("next");
    await tick();
    expect(r.prompts.slice(-1)).toEqual(["/compact"]);
    r.card.noteEntries([{ type: "system", subtype: "compact_boundary" }]);
    r.usage(40_000);
    await r.finish();
    expect(r.prompts.slice(-1)).toEqual(["next"]);
    await r.finish();
    expect(r.prompts.filter((p) => p === "/compact")).toHaveLength(1);
  });

  test("压缩失败：不放行下一轮，按失败收尾给原因；不重试压缩、不排队等；手动 /compact 成功后恢复", async () => {
    const r = rig();
    await r.turn(300_000, 0);
    void r.loop.submit("next");
    await tick();
    await r.finish({ kind: "failed", failure: { kind: "error", key: "k2", message: "compact failed" } });
    await tick();
    expect(r.prompts).toEqual(["hi", "/compact"]); // next 没进模型
    expect(r.failures.at(-1)).toContain("卡片硬线");
    expect(r.stops.at(-1)).toBe("StopFailure");
    expect(r.loop.busy).toBe(false); // 不无限排队
    expect((r.card.call({ op: "card_context" }) as any).status.admission.blocked).toContain("卡片硬线");
    void r.loop.submit("again");
    await tick();
    expect(r.prompts).toEqual(["hi", "/compact"]); // 仍拒，不再压
    r.loop.submitCommand("/compact"); // 预算恢复命令不拦
    await tick();
    expect(r.prompts.at(-1)).toBe("/compact");
    r.card.noteEntries([{ type: "system", subtype: "compact_boundary" }]);
    await r.finish();
    void r.loop.submit("after");
    await tick();
    expect(r.prompts.at(-1)).toBe("after");
  });

  test("压缩那一轮 done 但没到完成边界、usage 仍超线：同样拒开", async () => {
    const r = rig();
    await r.turn(300_000, 0);
    void r.loop.submit("next");
    await tick();
    r.usage(310_000);
    await r.finish();
    await tick();
    expect(r.prompts).toEqual(["hi", "/compact"]);
    expect(r.failures.at(-1)).toContain("没到压缩完成边界");
  });

  test("op 槽（交接 prompt）、补 reply 的 nudge 也先压缩；被拒的 op 槽结局 failed", async () => {
    const a = rig();
    await a.turn(300_000, 0);
    a.loop.submitOp("handoff ordinary prompt", "handoff");
    await tick();
    expect(a.prompts).toEqual(["hi", "/compact"]);
    await a.finish({ kind: "failed", failure: { kind: "error", key: "k3", message: "x" } });
    await tick();
    expect(a.prompts).toEqual(["hi", "/compact"]);
    expect(a.loop.slotStatus("handoff")).toMatchObject({ state: "ended", outcome: "failed" });

    const b = rig();
    void b.loop.submit("first");
    b.usage(300_000);
    b.blockNextStop("reply needed");
    await b.finish();
    await tick();
    expect(b.prompts).toEqual(["first", "/compact"]);
    b.card.noteEntries([{ type: "system", subtype: "compact_boundary" }]);
    await b.finish();
    expect(b.prompts).toEqual(["first", "/compact", "<hook_prompt>reply needed</hook_prompt>"]);
  });

  test("observe：只记一次日志，不压缩；回合中途超线不取消在跑的回合", async () => {
    const r = rig({ mode: "observe" });
    void r.loop.submit("long");
    r.usage(310_000); // 回合中途超线：ACP 没有中途预算能力
    expect(r.status().busyBudget).toBe("blocked-capability");
    void r.loop.submit("queued");
    await r.finish();
    await tick();
    expect(r.prompts).toEqual(["long", "queued"]);
    expect(r.logs.filter((l) => l.includes("卡片硬线（observe）"))).toHaveLength(1);
  });
});

test("生产现状（没有现行登记租约 port）：过硬线不自动压缩，这一轮拒开、给原因；手动 /compact 照放行", async () => {
  const r = rig({ lease: false });
  await r.turn(320_000);
  void r.loop.submit("next");
  await tick();
  await tick();
  expect(r.prompts).toEqual(["hi"]);
  expect(r.failures.at(-1)).toContain("blocked-capability");
  expect(r.stops.at(-1)).toBe("StopFailure");
  r.loop.submitCommand("/compact");
  await tick();
  expect(r.prompts.at(-1)).toBe("/compact");
});
