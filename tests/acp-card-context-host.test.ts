import { describe, expect, test } from "bun:test";
import { CardContextHost, type CardHostState } from "../src/lib/acp/card-context-host.ts";
import { AcpTurnLoop, type PromptOutcome } from "../src/lib/acp/turn.ts";

// CTXA 宿主一侧：真的 AcpTurnLoop + 假的适配器 IO / 宿主状态 / 时钟。不起进程、不调模型。

const MIN3 = 3 * 60_000;
const tick = () => new Promise((r) => setTimeout(r, 0));

function rig(opts: { mode?: "on" | "observe" | "off"; expected?: string } = {}) {
  let clock = 1_000_000;
  const prompts: string[] = [];
  const pending: ((o: PromptOutcome) => void)[] = [];
  const logs: string[] = [];
  const state: CardHostState = { sessionId: "s1", registered: true, capable: true, rotating: false, compacting: false, adapterRunning: false };
  let card!: CardContextHost;
  const loop = new AcpTurnLoop({
    prompt: (text) => (prompts.push(text), new Promise((r) => pending.push(r))),
    reportStop: async () => ({}),
    onFailure: () => {},
    onSlotEnd: (e) => card.onSlotEnd(e),
    admit: () => card.admit(),
    now: () => clock,
    log: (m) => logs.push(m),
  });
  card = new CardContextHost({
    hostId: "h1", loop, mode: opts.mode ?? "on", identity: { card: "CTXA", expectedSessionId: opts.expected ?? "s1" }, now: () => clock,
    state: () => state, log: (m) => logs.push(m),
  });
  card.noteAttach();
  const usage = (tokens: number, window = 1_000_000) => card.noteEntries([{ type: "system", subtype: "context_usage", tokens, window }]);
  const finish = async (o: PromptOutcome = { kind: "done" }) => (pending.shift()!(o), await tick(), await tick());
  const status = () => (card.call({ op: "card_context" }) as any).status;
  const ask = (opId: string, over: Record<string, unknown> = {}) => {
    const s = status();
    return card.call({ op: "card_compact", opId, card: "CTXA", expectedSessionId: s.sessionId, hostId: s.hostId,
      attachGen: s.attachGen, turnGen: s.turnGen, slotGen: s.slotGen, ...over }) as any;
  };
  /** 跑完一轮普通回合，回合内报 tokens，然后闲置 idleMs */
  const turn = async (tokens: number, idleMs = MIN3) => {
    void loop.submit("hi");
    usage(tokens);
    await finish();
    clock += idleMs;
  };
  return { loop, card, state, prompts, logs, usage, finish, status, ask, turn, advance: (ms: number) => (clock += ms) };
}

describe("受理", () => {
  test("闲置满 3 分钟 + 过 20 万：受理，独占一轮 /compact；受理 / 槽结局 / 实际压缩完成分开记", async () => {
    const r = rig();
    await r.turn(200_000);
    const res = r.ask("op-a");
    expect(res).toMatchObject({ ok: true, accepted: true, kind: "idle", op: { opId: "op-a", outcome: null, compacted: false } });
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
    await r.finish({ kind: "failed", failure: { kind: "error", key: "k", message: "boom" } });
    expect((r.card.call({ op: "card_context", opId: "op-f" }) as any).status.op).toMatchObject({ outcome: "failed", compacted: false });
    expect(r.prompts.filter((p) => p === "/compact")).toHaveLength(1);
  });

  test("同一个 opId 再来：回原记录，不重放", async () => {
    const r = rig();
    await r.turn(250_000);
    r.ask("op-d");
    expect(r.ask("op-d")).toMatchObject({ ok: true, duplicate: true, op: { opId: "op-d" } });
    await r.finish();
    expect(r.ask("op-d")).toMatchObject({ ok: true, duplicate: true, op: { outcome: "done" } });
    expect(r.prompts.filter((p) => p === "/compact")).toHaveLength(1);
  });

  test("两个申请（同一份查询身份）只受理一个", async () => {
    const r = rig();
    await r.turn(250_000);
    const s = r.status();
    const body = { op: "card_compact", card: "CTXA", expectedSessionId: "s1", hostId: s.hostId, attachGen: s.attachGen, turnGen: s.turnGen, slotGen: s.slotGen };
    const a = r.card.call({ ...body, opId: "x1" }) as any;
    const b = r.card.call({ ...body, opId: "x2" }) as any;
    expect(a.accepted).toBe(true);
    expect(b).toMatchObject({ ok: false, reason: "turn-drift" });
    expect(r.prompts.filter((p) => p === "/compact")).toHaveLength(1);
  });
});

describe("拒绝（不重放、不降级为普通 slash）", () => {
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
      attachGen: s.attachGen, turnGen: s.turnGen, slotGen: s.slotGen })).toMatchObject({ ok: false, reason: "turn-drift" });
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
  test("on：过 30 万后下一轮前先独占压缩，原 prompt 原位留着；同一份 usage 只压一次，失败也放行", async () => {
    const r = rig();
    await r.turn(300_000, 0);
    void r.loop.submit("next");
    await tick();
    expect(r.prompts.slice(-1)).toEqual(["/compact"]);
    await r.finish({ kind: "failed", failure: { kind: "error", key: "k2", message: "compact failed" } });
    expect(r.prompts.slice(-1)).toEqual(["next"]); // 没有第二次 /compact，不无限排队
    await r.finish();
    expect(r.prompts.filter((p) => p === "/compact")).toHaveLength(1);
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
