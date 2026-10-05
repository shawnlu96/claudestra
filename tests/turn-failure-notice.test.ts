/**
 * ACPE1：ACP agent 的一轮以不可重试的错误中止 → 开这一轮的请求方收到一条带原文的回推（acp-link 记下 → stop-settle 在 StopFailure 时推）。
 * 2026-10-06 现场：audit-codex 先 reply「开始审了」把回程槽消化掉，4 秒后 cyber_policy 中止，debug 一小时没收到任何东西。
 * 走真实的 onAcpFrame（acp_failure 帧）+ settleStopTurn（bridge 的 Stop 入口）；推回只记在 deps 里。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { onAcpFrame } from "../src/bridge/acp-link.ts";
import { AgentCallBook, type PendingAgentCall } from "../src/bridge/agent-calls.ts";
import { setExtensionSocket } from "../src/bridge/pi-abort.ts";
import { markRepeat, noteDelivered, settleStopTurn, takeApiWaiters, type ApiWaiter, type CallerSettleDeps, type StopTurn } from "../src/bridge/stop-settle.ts";

const CYBER = "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.";
const X = "c-debug";
const sockets = new Map<string, { send(d: string): void }>();
const discord = {} as any;

beforeAll(() => {
  setExtensionSocket((ch) => sockets.get(ch), {
    deliver: async () => undefined, ownerId: () => "", books: () => ({}) as any,
    hold: () => { throw new Error("不该押消息"); },
  });
});
// onFailure 开回合失败卡是 fire-and-forget（查 registry 后写 ask 库）：等它写完再收尾，不然临时状态目录先被删、报 disk I/O error
afterAll(() => Bun.sleep(200));

let seq = 0;
function harness() {
  const cid = `c-acpe1-${++seq}`;
  const ws = { send: () => {} };
  sockets.set(cid, ws);
  const book = new AgentCallBook(null);
  const notes: { to: string; body: string }[] = [];
  const pushed: { to: string; body: string }[] = [];
  const deps: CallerSettleDeps = {
    answerable: (c) => book.answerable(c, () => false),
    waiting: (c) => book.waiting(c, () => false),
    rearmResume: () => {},
    consume: (c, pac) => void book.consume(c, pac.callerChannelId, pac),
    pushBack: async (pac, _c, body) => void pushed.push({ to: pac.callerChannelId, body }),
    nudgeAmbiguous: () => {},
    takeApiErrorNotice: (c) => book.takeApiErrorNotice(c, () => false),
    markApiError: (c, text, caller) => book.markApiError(c, () => false, text, caller),
    clearWithheld: (c, pac) => book.clearWithheld(c, pac),
    notify: async (pac, _c, body) => void notes.push({ to: pac.callerChannelId, body }),
    metric: () => {},
    recovered: () => {},
  };
  const now = Date.now();
  /** X 用 send_to_agent 发请求：挂回程槽、送到时开了这一轮（asks = intent request 且不是 oneShot） */
  const ask = (caller = X, at = now - 1000) => {
    const call: PendingAgentCall = { callerChannelId: caller, callerName: `agent-${caller}`, targetName: "agent-audit-codex", ts: at };
    book.add(cid, call, `m-${caller}`);
    noteDelivered(cid, { kind: "local", channelId: caller }, at, true, true);
  };
  const fail = (failure: Record<string, unknown>) => onAcpFrame({ type: "acp_failure", channelId: cid, failure, label: "Codex" }, ws, discord);
  const cyber = () => fail({ kind: "error", key: `air:${cid}`, message: CYBER, retry: false });
  const turn = (event: string, drain: StopTurn["drain"]): StopTurn =>
    ({ cid, stopChannelId: cid, stopWs: ws, candidateWs: ws, event, runtime: "codex", drain });
  const stop = (event = "StopFailure", drain: StopTurn["drain"] = { text: `API Error: ${CYBER}`, apiError: false }) => settleStopTurn(deps, turn(event, drain));
  return { cid, book, notes, pushed, ask, fail, cyber, turn, stop, deps, now, slot: (caller = X) => book.slot(cid, caller) };
}

describe("请求方收到失败回推", () => {
  test("现场：回程槽已被「开始审了」消化 → 失败时仍推一条给 X，带原文；重复的失败帧、重复的 Stop 都只推一次", async () => {
    const h = harness();
    h.ask();
    h.book.consume(h.cid, X); // audit-codex reply 到 debug 频道那一句（forwardReplyToAgentClaude 按答复消化）
    await h.cyber();
    await h.cyber(); // 宿主重连补发同一个失败
    await h.stop();
    await h.stop();
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0].to).toBe(X);
    expect(h.notes[0].body).toContain(h.cid);
    expect(h.notes[0].body).toContain(CYBER);
    expect(h.notes[0].body).toContain("没有被处理完");
    expect(h.pushed).toEqual([]);
  });

  test("同一轮的 Stop 被 hook 重复上报（markRepeat）：不再推", async () => {
    const h = harness();
    h.ask();
    await h.cyber();
    const t = h.turn("StopFailure", { text: `API Error: ${CYBER}`, apiError: false, turnMark: "m1" });
    await settleStopTurn(h.deps, markRepeat(t));
    await settleStopTurn(h.deps, markRepeat(t));
    expect(h.notes).toHaveLength(1);
  });

  test("槽还在（它没回过话）：推失败说明并消化槽，不再拿「API Error」当答复兜底推一遍；出错前说的话带上", async () => {
    const h = harness();
    h.ask();
    await h.cyber();
    await h.stop("StopFailure", { text: `我先看了 diff，第一处问题在 a.ts\nAPI Error: ${CYBER}`, apiError: false });
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0].body).toContain("你的请求没有被处理");
    expect(h.notes[0].body).toContain("第一处问题在 a.ts");
    expect(h.notes[0].body.match(/API Error/g)).toBeNull();
    expect(h.pushed).toEqual([]);
    expect(h.slot()).toBeUndefined();
  });

  test("两个请求方一起开的一轮：各推一条，出错前的话归属不明、不带", async () => {
    const h = harness();
    h.ask(X);
    h.ask("c-pm", h.now - 500);
    await h.cyber();
    await h.stop("StopFailure", { text: `半句话\nAPI Error: ${CYBER}`, apiError: false });
    expect(h.notes.map((n) => n.to).sort()).toEqual([X, "c-pm"].sort());
    expect(h.notes.every((n) => !n.body.includes("半句话"))).toBe(true);
  });
});

describe("现有行为不变", () => {
  test("可重试的失败（retry: true）：不记，Stop 照旧按 drain 兜底推回", async () => {
    const h = harness();
    h.ask();
    await h.fail({ kind: "error", key: "air:retry", message: "Reconnecting…", retry: true });
    await h.stop("StopFailure", { text: "API Error: Reconnecting…", apiError: false });
    expect(h.notes).toEqual([]);
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0].body).toContain("没用 reply()");
  });

  test("额度卡、登录卡不记：Stop 照旧", async () => {
    const h = harness();
    h.ask();
    await h.fail({ kind: "quota", key: "quota:1", message: "You've hit your usage limit." });
    await h.fail({ kind: "auth", key: "auth:1", message: "Authentication required" });
    await h.stop("StopFailure", { text: "You've hit your usage limit.", apiError: false });
    expect(h.notes).toEqual([]);
    expect(h.pushed).toHaveLength(1);
  });

  test("适配器没说能不能重试（标了 isApiErrorMessage、等续跑）：有槽的只收 onApiErrorTurn 那句「回程保留」，没槽的请求方收失败说明", async () => {
    const h = harness();
    h.ask(X);
    h.ask("c-pm", h.now - 500);
    h.book.consume(h.cid, "c-pm");
    await h.fail({ kind: "error", key: "rpc:7", message: "stream disconnected" });
    await h.stop("StopFailure", { text: null, apiError: true, error: { error: "stream disconnected", text: "API Error: stream disconnected" } });
    const toX = h.notes.filter((n) => n.to === X);
    expect(toX).toHaveLength(1);
    expect(toX[0].body).toContain("回程保留");
    const toPm = h.notes.filter((n) => n.to === "c-pm");
    expect(toPm).toHaveLength(1);
    expect(toPm[0].body).toContain("stream disconnected");
    expect(h.slot()).toBeDefined(); // 回程留着等续跑
  });
});

describe("不推给不相干的人", () => {
  test("owner 开的一轮：不推（回合失败卡就是通知），也不把错误原文当答复推给别的在等的 caller", async () => {
    const h = harness();
    h.book.add(h.cid, { callerChannelId: X, callerName: "agent-debug", targetName: "agent-audit-codex", ts: h.now - 9000 }, "m-old");
    noteDelivered(h.cid, { kind: "user", owner: true }, h.now - 1000, true);
    await h.cyber();
    await h.stop();
    expect(h.notes).toEqual([]);
    expect(h.pushed).toEqual([]);
    expect(h.slot()).toBeDefined();
  });

  test("没有投递记录的一轮（自己续跑）：不推", async () => {
    const h = harness();
    await h.cyber();
    await h.stop();
    expect(h.notes).toEqual([]);
  });

  test("自己续跑的一轮中途送到别的消息（按上一轮建出、at = -Infinity）：上一轮的请求方不收", async () => {
    const h = harness();
    h.ask();
    await h.stop("Stop", { text: "审完了：0 P1", apiError: false }); // 上一轮正常答完
    noteDelivered(h.cid, { kind: "api", peer: "Shawn" }, h.now, false); // 它自己续跑时 peer 的消息照投
    await h.cyber();
    await h.stop();
    expect(h.notes).toEqual([]);
  });

  test("开这一轮的是答复 / 转发 / oneShot（不是请求）：不推", async () => {
    const h = harness();
    noteDelivered(h.cid, { kind: "local", channelId: X }, h.now - 1000, true, false);
    await h.cyber();
    await h.stop();
    expect(h.notes).toEqual([]);
  });

  test("这一轮开始之前记的失败（宿主起不来时报的）：不算这一轮的", async () => {
    const h = harness();
    await h.cyber();
    h.ask(X, Date.now() + 1000);
    await h.stop();
    expect(h.notes).toEqual([]);
  });
});

test("peer 开的一轮：没有 agent 回推；挂着的 API 请求按现有兜底拿到带原文的错误", async () => {
  const h = harness();
  noteDelivered(h.cid, { kind: "api", peer: "Shawn" }, h.now - 1000, true);
  await h.cyber();
  const t = h.turn("StopFailure", { text: `API Error: ${CYBER}`, apiError: false });
  const own = await settleStopTurn(h.deps, t);
  const waiter: ApiWaiter = { agentChannelId: h.cid, agentName: "agent-audit-codex", threadId: "thr-peer", tokenId: "tok" };
  const out = takeApiWaiters(new Map([["k", [waiter]]]), t, own);
  expect(h.notes).toEqual([]);
  expect(out[0]?.result.reply).toContain(CYBER);
});
