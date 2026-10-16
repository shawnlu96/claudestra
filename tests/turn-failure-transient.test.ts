/**
 * NRT-1 第 2 轮：ACP 网络类失败告诉请求方「正在自动重试」，这一串续跑用完再补一条最终说明；恢复了不打扰。
 * 走真实的 onAcpFrame（acp_failure 帧）+ settleStopTurn（Stop 入口），续跑的结局走 api-error-resume 的 noteApiError / noteTurnOk。
 * harness 同 tests/turn-failure-notice.test.ts。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { onAcpFrame } from "../src/bridge/acp-link.ts";
import { AgentCallBook, type PendingAgentCall } from "../src/bridge/agent-calls.ts";
import { setExtensionSocket } from "../src/bridge/pi-abort.ts";
import { noteDelivered, settleStopTurn, type CallerSettleDeps, type StopTurn } from "../src/bridge/stop-settle.ts";
import { markResumed, noteApiError, noteTurnOk, type ApiErrorState } from "../src/lib/api-error-resume.ts";
import { TRANSIENT_BACKOFF_MS } from "../src/lib/transient-error.ts";

const NET = "Pi 回合失败：Connection error.";
const sockets = new Map<string, { send(d: string): void }>();
beforeAll(() => {
  setExtensionSocket((ch) => sockets.get(ch), {
    deliver: async () => undefined, ownerId: () => "", books: () => ({}) as never,
    hold: () => { throw new Error("不该押消息"); },
  });
});
afterAll(() => Bun.sleep(200)); // 非网络类那支开卡是 fire-and-forget，等它写完

let seq = 0;
function harness() {
  const cid = `c-nrt1-${++seq}`;
  const ws = { send: () => {} };
  sockets.set(cid, ws);
  const book = new AgentCallBook(null);
  const notes: { to: string; body: string }[] = [];
  const deps: CallerSettleDeps = {
    answerable: (c) => book.answerable(c, () => false),
    waiting: (c) => book.waiting(c, () => false),
    rearmResume: () => {},
    consume: (c, pac) => void book.consume(c, pac.callerChannelId, pac),
    pushBack: async () => {},
    nudgeAmbiguous: () => {},
    takeApiErrorNotice: (c) => book.takeApiErrorNotice(c, () => false),
    markApiError: (c, text, caller) => book.markApiError(c, () => false, text, caller),
    clearWithheld: (c, pac) => book.clearWithheld(c, pac),
    notify: async (pac, _c, body) => void notes.push({ to: pac.callerChannelId, body }),
    metric: () => {},
    recovered: () => {},
  };
  const now = Date.now();
  /** c-pm 发请求，回程被一句「收到」消化了 */
  const ask = () => {
    const call: PendingAgentCall = { callerChannelId: "c-pm", callerName: "agent-c-pm", targetName: "agent-pi", ts: now - 1000 };
    book.add(cid, call, "m-c-pm");
    noteDelivered(cid, { kind: "local", channelId: "c-pm" }, now - 1000, true, true);
    book.consume(cid, "c-pm");
  };
  const failTurn = async (message: string) => {
    await onAcpFrame({ type: "acp_failure", channelId: cid, failure: { kind: "error", key: `rpc:${cid}`, message }, label: "Pi" }, ws, {} as never);
    const turn: StopTurn = { cid, stopChannelId: cid, stopWs: ws, candidateWs: ws, event: "StopFailure", runtime: "pi",
      drain: { text: null, apiError: true, error: { error: message, text: `API Error: ${message}` } } } as StopTurn;
    await settleStopTurn(deps, turn);
  };
  const states = new Map<string, ApiErrorState>();
  /** 续跑 n 次都又撞（断网没恢复），返回最后一次的结果 */
  const outage = (n: number, start = now) => {
    let t = start, r = noteApiError(states, cid, NET, t);
    for (let i = 0; i < n && r === "track"; i++) {
      t += 10 * 60_000;
      markResumed(states, cid, t);
      r = noteApiError(states, cid, NET, (t += 5_000));
    }
    return { r, t };
  };
  return { cid, notes, ask, failTurn, states, outage };
}

test("网络类失败：请求方收到「正在自动重试」；续跑用完再收到一条最终说明，只一条", async () => {
  const h = harness();
  h.ask();
  await h.failTurn(NET);
  expect(h.notes).toHaveLength(1);
  expect(h.notes[0].body).toContain(`正在自动重试（最多 ${TRANSIENT_BACKOFF_MS.length} 次`);
  expect(h.notes[0].body).not.toContain("不可重试");
  expect(h.outage(TRANSIENT_BACKOFF_MS.length).r).toBe("escalate");
  await Bun.sleep(0);
  expect(h.notes).toHaveLength(2);
  expect(h.notes[1]).toMatchObject({ to: "c-pm" });
  expect(h.notes[1].body).toContain("自动重试没救回来");
  expect(h.notes[1].body).toContain(`连续 ${TRANSIENT_BACKOFF_MS.length + 1} 次网络类错误`);
});

test("续跑后恢复（正常结束一个回合）：不再补说明", async () => {
  const h = harness();
  h.ask();
  await h.failTurn(NET);
  const { t } = h.outage(2);
  markResumed(h.states, h.cid, t + 60_000);
  noteTurnOk(h.states, h.cid, t + 120_000);
  expect(h.outage(TRANSIENT_BACKOFF_MS.length, t + 10 * 60_000).r).toBe("escalate"); // 之后另一串用完：不是这个请求方的事
  await Bun.sleep(0);
  expect(h.notes).toHaveLength(1);
});

test("这一串在登记之前就用完了（几路事件先后不定）：晚到的登记当场补最终说明", async () => {
  const h = harness();
  h.ask();
  expect(h.outage(TRANSIENT_BACKOFF_MS.length).r).toBe("escalate");
  await h.failTurn(NET);
  await Bun.sleep(0);
  expect(h.notes.map((n) => n.body.includes("自动重试没救回来"))).toEqual([false, true]);
});

test("非网络类失败：文案照旧「不可重试」，不登记", async () => {
  const h = harness();
  h.ask();
  await h.failTurn("Pi 回合失败：400 invalid request: tool schema rejected");
  expect(h.notes).toHaveLength(1);
  expect(h.notes[0].body).toContain("不可重试");
});
