import { beforeAll, describe, expect, test } from "bun:test";
import { acpCardCompact, acpCardContext, onAcpFrame, onAcpHostGone, setCardBindingSourceForTest } from "../src/bridge/acp-link.ts";
import { noteAcpChannel } from "../src/bridge/acp-state.ts";
import { setExtensionSocket } from "../src/bridge/pi-abort.ts";

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
