import { beforeAll, describe, expect, test } from "bun:test";
import { acpCardCompact, acpCardContext, onAcpFrame, onAcpHostGone, setCardBindingSourceForTest } from "../src/bridge/acp-link.ts";
import { noteAcpChannel } from "../src/bridge/acp-state.ts";
import { setExtensionSocket } from "../src/bridge/pi-abort.ts";
import { startWatching, stopWatching } from "../src/bridge/jsonl-watcher.ts";
import { CardContextHost, type CardHostState } from "../src/lib/acp/card-context-host.ts";
import { AcpTurnLoop, type PromptOutcome } from "../src/lib/acp/turn.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

// CTXA bridge 一头：卡片调用走 acp_call；旧宿主 = unavailable（不降级成普通 slash），结果不明的 opId 不再发

const sockets = new Map<string, { sent: any[]; send(d: string): void }>();
const sock = (ch: string) => {
  const s = { sent: [] as any[], send: (d: string) => void s.sent.push(JSON.parse(d)) };
  sockets.set(ch, s);
  noteAcpChannel(ch, "acp");
  return s;
};
const discord = {} as any;
const req = (opId: string) => ({ opId, card: "CTXA", expectedSessionId: "s1", hostId: "h1", attachGen: 1, turnGen: 3, slotGen: 0 });
const lastCall = (s: { sent: any[] }) => s.sent.filter((f) => f.type === "acp_call").at(-1);
const answer = (ch: string, s: any, body: Record<string, unknown>) => onAcpFrame({ type: "acp_call_result", channelId: ch, id: lastCall(s).id, ...body }, s, discord);
const STATUS = { cap: "card_compact_v1", hostId: "h1", attachGen: 1, sessionId: "s1", turnGen: 3, slotGen: 0, busyBudget: "blocked-capability" };

const bindings = new Map<string, { card: string; sessionId: string }>();
beforeAll(() => {
  setCardBindingSourceForTest((ch) => bindings.get(ch) ?? null);
  setExtensionSocket((ch) => sockets.get(ch), {
    deliver: async () => undefined, ownerId: () => "", books: () => ({}) as any,
    hold: () => { throw new Error("card fixture must not queue"); },
  });
});

describe("能力宣告", () => {
  test("旧宿主不认 card_context / card_compact：unavailable，没有发出任何 slash", async () => {
    const ch = "local-card-old";
    const s = sock(ch);
    const q = acpCardContext(ch);
    await answer(ch, s, { ok: false, error: "不认识的调用 card_context" });
    expect(await q).toMatchObject({ ok: false, reason: "old-host" });
    const c = acpCardCompact(ch, req("o-old"));
    await answer(ch, s, { ok: false, error: "不认识的调用 card_compact" });
    expect(await c).toMatchObject({ ok: false, reason: "old-host" });
    expect(s.sent.filter((f) => f.op === "slash")).toEqual([]);
  });

  test("新宿主：状态原样交出；不是 ACP 频道 / 宿主不在线直接 unavailable", async () => {
    const ch = "local-card-new";
    const s = sock(ch);
    const q = acpCardContext(ch);
    expect(lastCall(s)).toMatchObject({ op: "card_context" });
    await answer(ch, s, { ok: true, status: STATUS });
    expect(await q).toEqual({ ok: true, status: STATUS as any });
    expect(await acpCardContext("local-card-nowhere")).toMatchObject({ ok: false, reason: "not-acp" });
    noteAcpChannel("local-card-offline", "acp");
    expect(await acpCardContext("local-card-offline")).toMatchObject({ ok: false, reason: "offline" });
  });
});

describe("现行登记（cardWorkerIndex）随帧带给宿主", () => {
  test("查询 / 申请都在发帧那一刻带上本频道当前登记；台账里没有 = null（宿主拒 not-bound），换绑后带新的", async () => {
    const ch = "local-card-bind";
    const s = sock(ch);
    void acpCardContext(ch);
    expect(lastCall(s)).toMatchObject({ op: "card_context", binding: null });
    bindings.set(ch, { card: "CTXA", sessionId: "s1" });
    void acpCardCompact(ch, req("b1"));
    expect(lastCall(s)).toMatchObject({ op: "card_compact", binding: { card: "CTXA", sessionId: "s1" } });
    bindings.set(ch, { card: "T-next", sessionId: "s1" });
    void acpCardCompact(ch, req("b2"));
    expect(lastCall(s)).toMatchObject({ op: "card_compact", binding: { card: "T-next", sessionId: "s1" } });
    bindings.delete(ch);
    onAcpHostGone(ch, s);
  });
});

describe("申请", () => {
  test("受理：身份原样带给宿主，回包的受理记录要和申请对上", async () => {
    const ch = "local-card-ok";
    const s = sock(ch);
    const c = acpCardCompact(ch, req("o1"));
    expect(lastCall(s)).toMatchObject({ op: "card_compact", ...req("o1") });
    await answer(ch, s, { ok: true, accepted: true, kind: "idle", op: { opId: "o1", hostId: "h1", outcome: null, compacted: false } });
    expect(await c).toMatchObject({ ok: true, accepted: true, duplicate: false, op: { opId: "o1" } });
  });

  test("宿主拒绝：原因原样带回（不重试）", async () => {
    const ch = "local-card-rej";
    const s = sock(ch);
    const c = acpCardCompact(ch, req("o2"));
    await answer(ch, s, { ok: false, reason: "turn-drift", error: "代次对不上" });
    expect(await c).toEqual({ ok: false, reason: "turn-drift", error: "代次对不上" });
    expect(s.sent.filter((f) => f.type === "acp_call")).toHaveLength(1);
  });

  test("断线 / 回包对不上 = 结果不明：同一个 opId 不再发；按 opId 查到结局", async () => {
    const ch = "local-card-lost";
    const s = sock(ch);
    const c = acpCardCompact(ch, req("o3"));
    onAcpHostGone(ch, s);
    expect(await c).toMatchObject({ ok: false, reason: "uncertain" });
    expect(await acpCardCompact(ch, req("o3"))).toMatchObject({ ok: false, reason: "uncertain-prior" });
    const bad = acpCardCompact(ch, req("o4"));
    await answer(ch, s, { ok: true, accepted: true, op: { opId: "o4", hostId: "h-other" } });
    expect(await bad).toMatchObject({ ok: false, reason: "bad-reply" });
    expect(await acpCardCompact(ch, req("o4"))).toMatchObject({ ok: false, reason: "uncertain-prior" });
    expect(s.sent.filter((f) => f.op === "card_compact")).toHaveLength(2);
    const q = acpCardContext(ch, "o3");
    expect(lastCall(s)).toMatchObject({ op: "card_context", opId: "o3" });
    await answer(ch, s, { ok: true, status: { ...STATUS, op: { opId: "o3", hostId: "h1", outcome: "done", compacted: true } } });
    expect(await q).toMatchObject({ ok: true, status: { op: { outcome: "done", compacted: true } } });
    expect(await acpCardCompact(ch, req("o3"))).toMatchObject({ ok: false, reason: "uncertain-prior" }); // 查到结局也不重发
  });

  test("同一个 opId 在途时再申请：不发第二次", async () => {
    const ch = "local-card-dup";
    const s = sock(ch);
    const first = acpCardCompact(ch, req("o5"));
    expect(await acpCardCompact(ch, req("o5"))).toMatchObject({ ok: false, reason: "in-flight" });
    await answer(ch, s, { ok: true, duplicate: true, op: { opId: "o5", hostId: "h1", outcome: "done", compacted: true } });
    expect(await first).toMatchObject({ ok: true, duplicate: true });
    expect(s.sent.filter((f) => f.op === "card_compact")).toHaveLength(1);
  });
});

test("宿主超时不回：结果不明，同一个 opId 不再发", async () => {
  const ch = "local-card-timeout";
  const s = sock(ch);
  expect(await acpCardCompact(ch, req("o6"))).toMatchObject({ ok: false, reason: "uncertain" });
  expect(await acpCardCompact(ch, req("o6"))).toMatchObject({ ok: false, reason: "uncertain-prior" });
  expect(s.sent.filter((f) => f.op === "card_compact")).toHaveLength(1);
}, 20_000);

test("结果不明满 500 条且都指向当前宿主：不删旧的（lost-0 仍不重发），新申请拒 uncertain-full", async () => {
  const ch = "local-card-flood";
  const s = sock(ch);
  for (let i = 0; i < 500; i++) {
    const c = acpCardCompact(ch, req(`lost-${i}`));
    await answer(ch, s, { ok: true, accepted: true, op: { opId: "wrong", hostId: "h1" } });
    expect(await c).toMatchObject({ ok: false, reason: "bad-reply" });
  }
  expect(await acpCardCompact(ch, req("lost-0"))).toMatchObject({ ok: false, reason: "uncertain-prior" });
  expect(await acpCardCompact(ch, req("fresh-op"))).toMatchObject({ ok: false, reason: "uncertain-full" });
  expect(s.sent.filter((f) => f.op === "card_compact")).toHaveLength(500);
  expect(s.sent.filter((f) => f.op === "card_compact" && f.opId === "lost-0")).toHaveLength(1);
});

test("换宿主：旧宿主条目索引还在、新宿主满 500 条结果不明，新申请不清新宿主的记录（lost-0 永不重发）", async () => {
  const ch = "local-card-swap";
  const old = sock(ch);
  await startWatching("agent-card-swap", "/w", "sid", ch, discord, { transport: "acp" });
  const entry = { type: "assistant", timestamp: "t", message: { content: [{ type: "text", text: "hi" }] } };
  await onAcpFrame({ type: "acp_entries", channelId: ch, hostId: "h-old", firstSeq: 1, entries: [entry], requestId: "e1" }, old, discord);
  expect(old.sent.find((f) => f.requestId === "e1")?.result).toBe(true); // 旧宿主的条目确实处理过：entries 索引指向 h-old
  stopWatching("agent-card-swap");
  onAcpHostGone(ch, old);
  const s = sock(ch);
  for (let i = 0; i < 500; i++) {
    const c = acpCardCompact(ch, { ...req(`swap-${i}`), hostId: "h-new" });
    await answer(ch, s, { ok: true, accepted: true, op: { opId: "wrong", hostId: "h-new" } });
    expect(await c).toMatchObject({ ok: false, reason: "bad-reply" });
  }
  expect(await acpCardCompact(ch, { ...req("swap-0"), hostId: "h-new" })).toMatchObject({ ok: false, reason: "uncertain-prior" });
  expect(await acpCardCompact(ch, { ...req("swap-fresh"), hostId: "h-new" })).toMatchObject({ ok: false, reason: "uncertain-full" });
  expect(await acpCardCompact(ch, { ...req("swap-0"), hostId: "h-new" })).toMatchObject({ ok: false, reason: "uncertain-prior" });
  expect(s.sent.filter((f) => f.op === "card_compact" && f.opId === "swap-0")).toHaveLength(1);
}, 60_000);

describe("现行登记和宿主受理在同一段核对（真 bridge acpCardCompact + 真 CardContextHost / AcpTurnLoop）", () => {
  /** 宿主一侧：帧先进队列，deliver() 才交给真宿主处理，回包再经 onAcpFrame 回 bridge（模拟发帧到受理之间的窗口） */
  function hostRig(ch: string) {
    const prompts: string[] = [];
    let card!: CardContextHost;
    const loop = new AcpTurnLoop({
      prompt: (text) => (prompts.push(text), new Promise<PromptOutcome>(() => {})),
      reportStop: async () => ({}), onFailure: () => {}, onSlotEnd: (e) => card.onSlotEnd(e), admit: (h) => card.admit(h), log: () => {},
    });
    const state: CardHostState = { sessionId: "s1", registered: true, capable: true, rotating: false, compacting: false, adapterRunning: false };
    card = new CardContextHost({ hostId: "h1", loop, mode: "on", identity: { card: "CTXA", expectedSessionId: "s1" }, now: () => Date.now() + 10 * 60_000, state: () => state, log: () => {} });
    card.noteAttach();
    card.noteEntries([{ type: "system", subtype: "context_usage", tokens: 250_000, window: 1_000_000 }]);
    const inbox: any[] = [];
    const s = { sent: [] as any[], send: (d: string) => void (s.sent.push(JSON.parse(d)), inbox.push(JSON.parse(d))) };
    sockets.set(ch, s);
    noteAcpChannel(ch, "acp");
    const deliver = async () => {
      while (inbox.length) {
        const f = inbox.shift();
        await onAcpFrame({ type: "acp_call_result", channelId: ch, id: f.id, ...card.call(f)! }, s, discord);
        await tick();
      }
    };
    const status = () => (card.call({ op: "card_context", binding: { card: "CTXA", sessionId: "s1" } }) as any).status;
    const reqOf = (opId: string) => {
      const st = status();
      return { opId, card: "CTXA", expectedSessionId: st.sessionId, hostId: st.hostId, attachGen: st.attachGen, turnGen: st.turnGen, slotGen: st.slotGen };
    };
    return { prompts, s, deliver, reqOf };
  }

  test("发帧之后、宿主受理之前台账退休：不压缩（live-binding 复现）", async () => {
    const ch = "local-card-live-retire";
    const h = hostRig(ch);
    bindings.set(ch, { card: "CTXA", sessionId: "s1" });
    const c = acpCardCompact(ch, h.reqOf("live-1"));
    bindings.delete(ch); // 帧已发出、宿主还没处理：登记退休
    for (let i = 0; i < 5; i++) await h.deliver();
    expect(await c).toMatchObject({ ok: false, reason: "not-bound" });
    await tick();
    expect(h.prompts).toEqual([]);
  });

  test("发帧之后、宿主受理之前换卡：不压缩", async () => {
    const ch = "local-card-live-swap";
    const h = hostRig(ch);
    bindings.set(ch, { card: "CTXA", sessionId: "s1" });
    const c = acpCardCompact(ch, h.reqOf("live-2"));
    bindings.set(ch, { card: "T-next", sessionId: "s1" });
    for (let i = 0; i < 5; i++) await h.deliver();
    expect(await c).toMatchObject({ ok: false, reason: "binding-revoked" });
    await tick();
    expect(h.prompts).toEqual([]);
    bindings.delete(ch);
  });

  test("登记一直有效：受理，压缩一次", async () => {
    const ch = "local-card-live-ok";
    const h = hostRig(ch);
    bindings.set(ch, { card: "CTXA", sessionId: "s1" });
    const c = acpCardCompact(ch, h.reqOf("live-3"));
    for (let i = 0; i < 5; i++) await h.deliver();
    expect(await c).toMatchObject({ ok: true, accepted: true, op: { opId: "live-3" } });
    await tick();
    expect(h.prompts).toEqual(["/compact"]);
    bindings.delete(ch);
  });
});
