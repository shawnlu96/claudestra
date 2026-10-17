/**
 * NRT-2：收到「正在自动重试」的请求方在每种结局下都收到一句结局说明（升级 / 被取消 / 撞额度撤掉 / 1 小时不再跟踪 / 退避中重启），
 * 恢复了不打扰；之后已答复过的不再说「没处理完」；上一串刚升级、新串又起不串话；回程槽不被「正在重试」消化（探针 T2、T5）。
 * harness 同 tests/turn-failure-transient.test.ts：真实 onAcpFrame + settleStopTurn，续跑的结局走 api-error-resume。
 */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { onAcpFrame } from "../src/bridge/acp-link.ts";
import { AgentCallBook, type PendingAgentCall } from "../src/bridge/agent-calls.ts";
import { setExtensionSocket } from "../src/bridge/pi-abort.ts";
import { noteDelivered, settleStopTurn, type CallerSettleDeps, type StopTurn } from "../src/bridge/stop-settle.ts";
import { channelTurnOk, dropOffline, dueForResume, endStreak, markResumed, noteActivity, noteApiError, noteTurnOk, type ApiErrorState } from "../src/lib/api-error-resume.ts";
import { TRANSIENT_BACKOFF_MS } from "../src/lib/transient-error.ts";

const NET = "Pi 回合失败：Connection error.";
const sockets = new Map<string, { send(d: string): void }>();
beforeAll(() => {
  setExtensionSocket((ch) => sockets.get(ch), {
    deliver: async () => undefined, ownerId: () => "", books: () => ({}) as never,
    hold: () => { throw new Error("不该押消息"); },
  });
});
afterAll(() => Bun.sleep(200));

let seq = 0, key = 0;
function harness() {
  const cid = `c-nrt2-${++seq}`;
  const ws = { send: () => {} };
  sockets.set(cid, ws);
  const book = new AgentCallBook(null);
  const notes: { to: string; body: string }[] = [];
  const pushed: string[] = [];
  const expired: string[] = [];
  book.onExpired = (p, why) => void expired.push(`${p.callerChannelId}:${why}`);
  const deps: CallerSettleDeps = {
    answerable: (c) => book.answerable(c, () => false),
    waiting: (c) => book.waiting(c, () => false),
    rearmResume: () => {},
    consume: (c, pac) => void book.consume(c, pac.callerChannelId, pac),
    pushBack: async (pac, _c, body) => void pushed.push(`${pac.callerChannelId}:${body}`),
    nudgeAmbiguous: () => {},
    takeApiErrorNotice: (c) => book.takeApiErrorNotice(c, () => false),
    markApiError: (c, text, caller) => book.markApiError(c, () => false, text, caller),
    clearWithheld: (c, pac) => book.clearWithheld(c, pac),
    notify: async (pac, _c, body) => void notes.push({ to: pac.callerChannelId, body }),
    metric: () => {},
    recovered: () => {},
  };
  const now = Date.now();
  /** c-pm 发请求；consumed = 回程被一句「收到」消化了 */
  const ask = (consumed = true, caller = "c-pm", ts = Date.now() - 1000) => {
    const call: PendingAgentCall = { callerChannelId: caller, callerName: `agent-${caller}`, targetName: "agent-pi", ts };
    book.add(cid, call, `m-${caller}-${ts}`);
    noteDelivered(cid, { kind: "local", channelId: caller }, Date.now() - 500, true, true);
    if (consumed) book.consume(cid, caller);
  };
  const stop = (event: string, drain: StopTurn["drain"]) =>
    settleStopTurn(deps, { cid, stopChannelId: cid, stopWs: ws, candidateWs: ws, event, runtime: "pi", drain } as StopTurn);
  const failTurn = async (drain: StopTurn["drain"] = { text: null, apiError: true, error: { error: NET, text: `API Error: ${NET}` } }) => {
    await acpFail();
    await stop("StopFailure", drain);
  };
  const acpFail = () => onAcpFrame({ type: "acp_failure", channelId: cid, failure: { kind: "error", key: `rpc:${cid}:${++key}`, message: NET }, label: "Pi" }, ws, {} as never);
  const APIERR = { text: null, apiError: true, error: { error: NET, text: `API Error: ${NET}` } };
  /** bridge 的续跑消息开了下一轮 */
  const resume = () => {
    markResumed(states, cid, Date.now());
    noteDelivered(cid, { kind: "bridge", label: "api-error-resume" }, Date.now() - 1, true, false);
  };
  /** 真实宿主顺序的一轮失败：acp_failure → 错误条目（api_error_turn）→ StopFailure */
  const round = async (resumed: boolean, drain: StopTurn["drain"] = APIERR) => {
    if (resumed) resume();
    await acpFail();
    const r = noteApiError(states, cid, NET, Date.now());
    await Bun.sleep(1);
    await stop("StopFailure", drain);
    await Bun.sleep(1);
    return r;
  };
  const states = new Map<string, ApiErrorState>();
  /** 续跑 n 次都又撞，返回最后一次的结果 */
  const outage = (n: number, start = now) => {
    let t = start, r = noteApiError(states, cid, NET, t);
    for (let i = 0; i < n && r === "track"; i++) {
      t += 10 * 60_000;
      markResumed(states, cid, t);
      r = noteApiError(states, cid, NET, (t += 5_000));
    }
    return { r, t };
  };
  const bodies = () => notes.map((n) => n.body);
  const of = (caller: string) => notes.filter((n) => n.to === caller).map((n) => lab(n.body));
  return { cid, book, deps, notes, pushed, expired, bodies, of, ask, stop, failTurn, round, resume, states, outage, now };
}
const RETRYING = "正在自动重试";
const FAILED = "自动重试没救回来";
const STOPPED = "自动重试停了";
const settle = () => Bun.sleep(0);
const lab = (b: string) => (b.includes(FAILED) ? "FAILED" : b.includes(STOPPED) ? "STOPPED" : b.includes(RETRYING) ? "RETRYING" : b.slice(0, 24));
/** 假时钟（退避按 1/2/4/8 分钟真实推进），结束恢复 */
async function withClock(fn: (advance: (ms: number) => void) => Promise<void>): Promise<void> {
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    await fn((ms) => void (now += ms));
  } finally {
    clock.mockRestore();
  }
}

test("slot-consumed-by-retrying-notice（T5）：有回程槽、drain 没带 apiError → 说「正在重试」但槽留着，续跑成功后答复推回去", async () => {
  const h = harness();
  h.ask(false);
  await h.failTurn({ text: null });
  expect(h.bodies()).toHaveLength(1);
  expect(h.bodies()[0]).toContain(RETRYING);
  expect(h.book.waiting(h.cid, () => false)).toHaveLength(1);
  await h.stop("Stop", { text: "审完了：结论 X" });
  expect(h.pushed).toHaveLength(1);
  expect(h.pushed[0]).toContain("审完了：结论 X");
});

test("stale-ended-cross-streak（T2）：上一串刚升级、新请求的新一串开始 → 只收到「正在重试」，新一串用完才收到它自己的结局", async () => {
  const h = harness();
  expect(h.outage(TRANSIENT_BACKOFF_MS.length, h.now - 41 * 60_000).r).toBe("escalate"); // 上一串（别人的请求）约 40 秒前升级
  h.ask();
  await h.failTurn();
  expect(noteApiError(h.states, h.cid, NET, Date.now())).toBe("track"); // 新一串第一次
  await settle();
  expect(h.bodies()).toHaveLength(1);
  expect(h.bodies()[0]).toContain(RETRYING);
  expect(h.outage(TRANSIENT_BACKOFF_MS.length, Date.now()).r).toBe("escalate");
  await settle();
  expect(h.bodies().filter((b) => b.includes(FAILED))).toHaveLength(1);
});

test("被取消（错误后它又有了新活动）：补一句「自动重试停了」", async () => {
  const h = harness();
  h.ask();
  await h.failTurn();
  noteApiError(h.states, h.cid, NET, h.now);
  expect(noteActivity(h.states, h.cid, h.now + 10_000)).toBeDefined();
  await settle();
  expect(h.bodies()).toHaveLength(2);
  expect(h.bodies()[1]).toContain(STOPPED);
  expect(h.bodies()[1]).toContain("新活动");
});

test("撞额度撤掉（quota-wall-wiring cancelResume → endStreak）：补一句「自动重试停了」", async () => {
  const h = harness();
  h.ask();
  await h.failTurn();
  noteApiError(h.states, h.cid, NET, h.now);
  endStreak(h.states, h.cid, h.now + 5_000, { failed: false, why: "撞了额度，续跑交给额度闸（出闸后续跑）" });
  await settle();
  expect(h.bodies()[1]).toContain(STOPPED);
  expect(h.bodies()[1]).toContain("额度闸");
});

test("续跑后 1 小时既没撞也没正常结束、被删：补一句「自动重试停了」", async () => {
  const h = harness();
  h.ask();
  await h.failTurn();
  noteApiError(h.states, h.cid, NET, h.now);
  markResumed(h.states, h.cid, h.now + 60_000);
  dueForResume(h.states, h.now + 62 * 60_000);
  await settle();
  expect(h.states.has(h.cid)).toBe(false);
  expect(h.bodies()[1]).toContain(STOPPED);
  expect(h.bodies()[1]).toContain("1 小时");
});

test("续跑那轮已经答复过（回程槽被消化）后又撞到用完：不再说「没处理完」", async () => {
  const h = harness();
  h.ask(false);
  await h.failTurn(); // 有槽、以 API 错误结束：只说「回程保留」，登记等结局
  h.book.consume(h.cid, "c-pm"); // 续跑那轮 reply 答了它
  expect(h.outage(TRANSIENT_BACKOFF_MS.length).r).toBe("escalate");
  await settle();
  expect(h.bodies().some((b) => b.includes(FAILED))).toBe(false);
});

test("续跑那轮用 send_to_agent 回过请求方（回程早被「收到」消化）后又撞到用完：不再说「没处理完」", async () => {
  const h = harness();
  h.ask();
  await h.failTurn();
  noteDelivered("c-pm", { kind: "local", channelId: h.cid }, Date.now() + 1_000, false, true);
  expect(h.outage(TRANSIENT_BACKOFF_MS.length).r).toBe("escalate");
  await settle();
  expect(h.bodies()).toHaveLength(1);
});

// ── 第 1 轮对抗审查（reviews/NRT-2-r1-adv.md）探针反转 ──

test("C3：网络类留下的槽（drain 没带 apiError）记了等续跑 → 退避中外人开的一轮正常结束，它的话不推给请求方", async () => {
  const h = harness();
  h.ask(false);
  await h.failTurn({ text: null });
  noteApiError(h.states, h.cid, NET, Date.now() - 30_000);
  expect(h.book.waiting(h.cid, () => false)[0]?.apiErrorAt).toBeDefined();
  noteDelivered(h.cid, { kind: "api", owner: false }, Date.now(), true, false); // 外人（scoped token）
  await h.stop("Stop", { text: "（给外人的答复）guest 专属内容" });
  expect(h.pushed).toEqual([]);
});

test("C1：同上，agent 被 kill（dropChannel）→ onExpired 告诉请求方；之后续跑作废不再补第二条", async () => {
  const h = harness();
  h.ask(false);
  await h.failTurn({ text: null });
  noteApiError(h.states, h.cid, NET, Date.now() - 60_000);
  h.book.dropChannel(h.cid);
  dropOffline(h.states, h.cid, Date.now(), false);
  await settle();
  expect(h.expired).toEqual(["c-pm:之后它被关掉了"]);
  expect(h.of("c-pm")).toEqual(["RETRYING"]);
});

test("C2：请求送达 1 小时 59 分后才失败，2 小时扫槽 → onExpired 告诉请求方", async () => {
  const h = harness();
  h.ask(false, "c-pm", Date.now() - (2 * 3_600_000 - 60_000));
  await h.failTurn({ text: null });
  noteApiError(h.states, h.cid, NET, Date.now());
  h.book.sweepStale(Date.now() + 120_000, 2 * 3_600_000, () => undefined);
  expect(h.expired).toEqual(["c-pm:之后 2 小时没有接着做完"]);
});

/** 断网不恢复：第 1 轮 + 续跑 4 轮都失败，最后一轮升级（真实顺序，每轮都有 StopFailure） */
async function outageRounds(h: ReturnType<typeof harness>, advance: (ms: number) => void, between?: (i: number) => void): Promise<string> {
  let r = await h.round(false);
  for (const [i, w] of TRANSIENT_BACKOFF_MS.entries()) {
    advance(w);
    between?.(i);
    r = await h.round(true);
  }
  return r;
}

test("A1：回程早被「收到」消化，断网 5 轮（每轮都有 StopFailure）→ 只收到一次「正在重试」和一次「没救回来」", async () => {
  await withClock(async (advance) => {
    const h = harness();
    h.ask();
    expect(await outageRounds(h, advance)).toBe("escalate");
    expect(h.of("c-pm")).toEqual(["RETRYING", "FAILED"]);
  });
});

test("A2：回程槽还在，断网 5 轮 →「没救回来」只一次", async () => {
  await withClock(async (advance) => {
    const h = harness();
    h.ask(false);
    await outageRounds(h, advance);
    expect(h.of("c-pm").filter((x) => x === "FAILED")).toHaveLength(1);
    expect(h.of("c-pm")).not.toContain("RETRYING");
  });
});

test("E1：续跑那轮 reply 消化了回程槽，之后撞到用完（升级那轮也有 StopFailure）→ 不说「没处理完」", async () => {
  await withClock(async (advance) => {
    const h = harness();
    h.ask(false);
    await outageRounds(h, advance, (i) => void (i === 0 && h.book.consume(h.cid, "c-pm")));
    expect(h.of("c-pm")).not.toContain("FAILED");
  });
});

test("E2：续跑那轮用 send_to_agent 回过请求方，之后撞到用完 → 不说「没处理完」", async () => {
  await withClock(async (advance) => {
    const h = harness();
    h.ask();
    await outageRounds(h, advance, (i) => void (i === 0 && noteDelivered("c-pm", { kind: "local", channelId: h.cid }, Date.now() + 1_000, false, true)));
    expect(h.of("c-pm")).toEqual(["RETRYING"]);
  });
});

test("B1r：X 一串退避中，Y 的请求送到（取消 X 这串），Y 这一轮 2.5 秒后网络失败 → Y 不收 X 的「停了」，Y 这一串用完收到自己的「没救回来」", async () => {
  await withClock(async (advance) => {
    const h = harness();
    h.ask(true, "c-x");
    await h.round(false);
    advance(40_000);
    h.ask(true, "c-y");
    noteActivity(h.states, h.cid, Date.now());
    advance(2_500);
    expect(await outageRounds(h, advance)).toBe("escalate");
    expect(h.of("c-x")).toEqual(["RETRYING", "STOPPED"]);
    expect(h.of("c-y")).toEqual(["RETRYING", "FAILED"]);
  });
});

test("B2r：X 的一串刚升级，Y 的请求在那一轮 Stop 时补投、2.5 秒后网络失败，之后续跑成功 → Y 不收 X 的「没救回来」", async () => {
  await withClock(async (advance) => {
    const h = harness();
    h.ask(true, "c-x");
    expect(await outageRounds(h, advance)).toBe("escalate");
    advance(500);
    h.ask(true, "c-y");
    advance(2_000);
    expect(await h.round(false)).toBe("track");
    advance(60_000);
    h.resume();
    advance(30_000);
    channelTurnOk(h.cid, Date.now());
    noteTurnOk(h.states, h.cid, Date.now());
    await h.stop("Stop", { text: "Y 的活做完了" });
    await settle();
    expect(h.of("c-x")).toEqual(["RETRYING", "FAILED"]);
    expect(h.of("c-y")).toEqual(["RETRYING"]);
  });
});

// 放最后：重新加载的 turn-failure 会接管 onStreakEnd（单个回调）
test("退避中 bridge 重启：名单落盘，重启后这一串用完照样补最终说明；第一次 Stop 交来通道之前到的结局先排着", async () => {
  const h = harness();
  h.ask();
  await h.failTurn();
  const fresh = await import(`../src/bridge/turn-failure.ts?restart=${Date.now()}`);
  expect(h.outage(TRANSIENT_BACKOFF_MS.length).r).toBe("escalate");
  await settle();
  expect(h.bodies()).toHaveLength(1); // 还没有通道
  const sent: string[] = [];
  fresh.useRetryPort({ notify: async (_c: string, r: { caller: string }, body: string) => void sent.push(`${r.caller}:${body}`), slotGone: () => false });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toStartWith("c-pm:");
  expect(sent[0]).toContain(FAILED);
});
