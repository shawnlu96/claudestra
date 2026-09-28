/**
 * bridge/stop-settle.ts + jsonl-watcher 的 apiError 标记：Claude Code 以 API 错误结束的一轮（额度墙 / StopFailure）不把错误文字
 * 当答复推回 caller、不消化回程簿，之后接着做完的一轮照常推回（2026-09-28 22:19 撞墙现场的回归测试）；不是撞墙的错误
 * 给 caller 推一条说明（每槽一次）；挂着的 API 请求那一轮就结掉（reply:null + apiError）。
 * Codex 的 StopFailure（撞额度时 codex-turn-failure 补的、打断时 typing-hook 映射的）照常结算（T24a 对抗审查 P1）。
 * 走 bridge 实际调用的 settleStopTurn / takeApiWaiters；watcher 一段把真实的 drainChannelWatcher 结果原样喂进去。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "discord.js";
import { AgentCallBook, type PendingAgentCall } from "../src/bridge/agent-calls.js";
import { drainChannelWatcher, startWatching, stopWatching } from "../src/bridge/jsonl-watcher.js";
import { awaitsResume, settleStopTurn, settlesOwnTurn, takeApiWaiters, type ApiWaiter, type CallerSettleDeps, type StopTurn } from "../src/bridge/stop-settle.js";
import { projectsSlug } from "../src/lib/jsonl-cost.js";

const LIMIT = "You've hit your weekly limit · resets Sep 30 at 6am (Asia/Tokyo)";
const FABLE = "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.";
const CODEX_LIMIT = "You've hit your usage limit. Upgrade to Pro or try again at 8:41 AM.";
const wallErr = { error: "rate_limit", text: LIMIT };
const call: PendingAgentCall = { callerChannelId: "c-pm", callerName: "agent-claudestra", targetName: "agent-task-t18", ts: 1000 };

let seq = 0;
/** 每个 harness 一个频道：「等续跑」标记是模块级的，共用频道会串到别的用例 */
function harness(runtime?: string, opts: { pushFails?: boolean } = {}) {
  const cid = `c-t18-${++seq}`;
  const book = new AgentCallBook(null);
  book.add(cid, { ...call }, "m1");
  const pushed: string[] = [];
  const notes: string[] = [];
  let nudged = 0;
  const deps: CallerSettleDeps = {
    answerable: (cid) => book.answerable(cid, () => false),
    consume: (cid, pac) => void book.consume(cid, pac.callerChannelId, pac),
    pushBack: async (_pac, _cid, body) => {
      if (opts.pushFails) throw new Error("caller 的 ws 断了");
      pushed.push(body);
    },
    nudgeAmbiguous: () => void nudged++,
    takeApiErrorNotice: (cid) => book.takeApiErrorNotice(cid, () => false),
    notify: async (_pac, _cid, body) => void notes.push(body),
    metric: () => {},
  };
  /** 与 bridge.ts 的 Stop 处理同一个入口：event 原样、drain 是 drainChannelWatcher 的返回值 */
  const turn = (event: string, drain: StopTurn["drain"], humanTurn = false): StopTurn =>
    ({ cid, stopChannelId: cid, stopWs: 1, candidateWs: 1, event, runtime, drain, humanTurn });
  const stop = (event: string, drain: StopTurn["drain"], humanTurn = false) => settleStopTurn(deps, turn(event, drain, humanTurn));
  return { cid, book, pushed, notes, nudged: () => nudged, stop, turn, slot: () => book.slot(cid, "c-pm") };
}

describe("Claude Code：以 API 错误结束的一轮不结算", () => {
  test("撞墙：不推、不消化、不给 caller 发说明（留给额度闸）；接着做完的一轮照常推回", async () => {
    const h = harness();
    expect(await h.stop("StopFailure", { text: null, apiError: true, error: wallErr })).toBe(false);
    expect(h.pushed).toEqual([]);
    expect(h.notes).toEqual([]);
    expect(h.slot()).toBeDefined();
    expect(await h.stop("Stop", { text: "T18 做完了，PR #150", apiError: false })).toBe(true);
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0]).toContain("T18 做完了，PR #150");
    expect(h.slot()).toBeUndefined();
  });

  test("错误前已经说了的话扣下，接着做完时一起推（常规审查 P2-2）", async () => {
    const h = harness();
    await h.stop("StopFailure", { text: "查到了：根因在 watcher", apiError: true, error: wallErr });
    await h.stop("Stop", { text: "修好了，PR #151" });
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0]).toContain("查到了：根因在 watcher");
    expect(h.pushed[0]).toContain("修好了，PR #151");
  });

  test("不是撞墙的错误：给 caller 推一条说明、每槽只推一次，回程留着", async () => {
    const h = harness();
    const err = { error: "server_error", text: "API Error: 500 Internal server error\n{…}" };
    await h.stop("StopFailure", { text: null, apiError: true, error: err });
    await h.stop("StopFailure", { text: null, apiError: true, error: err }); // 60 秒续跑又撞了一次
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]).toBe("[ℹ️ agent-task-t18 这轮以 API 错误结束：API Error: 500 Internal server error；回程保留，它恢复后的答复仍会推给你]");
    expect(h.slot()).toBeDefined();
    h.book.add(h.cid, { ...call, ts: 2000 }, "m2"); // caller 又问了一次：再出错会再说明
    await h.stop("StopFailure", { text: null, apiError: true, error: err });
    expect(h.notes).toHaveLength(2);
  });

  test("单个模型的额度（Fable limit，error 也是 rate_limit）不进闸，按普通错误说明", async () => {
    const h = harness();
    await h.stop("StopFailure", { text: null, apiError: true, error: { error: "rate_limit", text: FABLE } });
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]).toContain("Fable limit");
  });

  test("好几个 caller 在等：API 错误那一轮不发「分别回」提醒，每个 caller 各收一条说明", async () => {
    const h = harness();
    h.book.add(h.cid, { ...call, callerChannelId: "c-other", callerName: "agent-other" }, "m9");
    await h.stop("StopFailure", { text: null, apiError: true, error: { error: "server_error", text: "API Error: 529 Overloaded" } });
    expect(h.nudged()).toBe(0);
    expect(h.notes).toHaveLength(2);
  });

  test("撞墙后人触发的回合（owner 用完卡顺手问别的事）不结算旧 caller；接着做的那一轮（bridge 续跑）才结算", async () => {
    const h = harness();
    await h.stop("StopFailure", { text: null, apiError: true, error: wallErr });
    expect(await h.stop("Stop", { text: "（回 owner 的）天气是晴", apiError: false }, true)).toBe(true);
    expect(h.pushed).toEqual([]);
    expect(h.slot()).toBeDefined();
    await h.stop("Stop", { text: "T18 接着做完了", apiError: false }, false);
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0]).toContain("T18 接着做完了");
    expect(h.pushed[0]).not.toContain("天气");
  });

  test("等续跑期间 owner 在 Discord 打字不算接管；那几条请求被它自己 reply 答掉后，扣下的话不串给新 caller", async () => {
    const h = harness();
    await h.stop("StopFailure", { text: "旧的半句", apiError: true, error: wallErr });
    const pac = () => h.book.answerable(h.cid, () => false);
    expect(awaitsResume(h.cid, pac())).toBe(true);
    h.book.consume(h.cid, "c-pm"); // 它用 send_to_agent 明确答了 PM
    h.book.add(h.cid, { ...call, callerChannelId: "c-new", callerName: "agent-new", ts: 3000 }, "m5");
    expect(awaitsResume(h.cid, pac())).toBe(false);
    await h.stop("Stop", { text: "给新 caller 的答复" });
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0]).not.toContain("旧的半句");
  });

  test("没撞过墙：人触发的回合照旧按原规则结算", async () => {
    const h = harness();
    await h.stop("Stop", { text: "答复", apiError: false }, true);
    expect(h.pushed).toHaveLength(1);
  });

  test("StopFailure 没文字、也还没读到错误条目：不静默消化，也不猜着发说明", async () => {
    const h = harness("claude-code");
    await h.stop("StopFailure", { text: null });
    expect(h.slot()).toBeDefined();
    expect(h.notes).toEqual([]);
  });

  test("正常结束没文字：照旧静默消化、不推", async () => {
    const h = harness();
    await h.stop("Stop", { text: null });
    expect(h.pushed).toEqual([]);
    expect(h.slot()).toBeUndefined();
  });

  test("推回失败：回程簿条目还在（搬家契约）", async () => {
    const h = harness(undefined, { pushFails: true });
    await h.stop("Stop", { text: "答复" });
    expect(h.slot()).toBeDefined();
  });

  test("别人的频道不结算", () => {
    expect(settlesOwnTurn({ cid: "c-other", stopChannelId: "c-t18", stopWs: 1, candidateWs: 2, event: "Stop", drain: { text: "x" } })).toBe(false);
  });
});

describe("Codex 的 StopFailure 照常结算", () => {
  test("撞额度（codex-turn-failure 补的 StopFailure，条目不带 isApiErrorMessage）：⛔ 那句推给 caller、回程簿消化", async () => {
    const h = harness("codex");
    expect(await h.stop("StopFailure", { text: CODEX_LIMIT, apiError: false })).toBe(true);
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0]).toContain("usage limit");
    expect(h.slot()).toBeUndefined();
  });

  test("被打断（typing-hook 把 Interrupt 映射成 StopFailure）：那一轮就结掉，owner 之后另问的答复不串给旧 caller", async () => {
    const h = harness("codex");
    await h.stop("StopFailure", { text: null });
    expect(h.slot()).toBeUndefined();
    await h.stop("Stop", { text: "（回 owner 的）今天的天气查询结果……" });
    expect(h.pushed).toEqual([]);
  });

  test("Codex 的非额度 API 错误（isApiErrorMessage=true）：不结算、给 caller 说明，交给 60 秒续跑", async () => {
    const h = harness("codex");
    expect(await h.stop("StopFailure", { text: null, apiError: true, error: { error: "stream disconnected", text: "API Error: stream disconnected" } })).toBe(false);
    expect(h.slot()).toBeDefined();
    expect(h.notes).toHaveLength(1);
  });
});

describe("takeApiWaiters：挂着的 API 请求那一轮就结掉", () => {
  const w = (cid: string, n: number): ApiWaiter => ({ agentChannelId: cid, agentName: "agent-task-t18", threadId: `thr-${n}`, tokenId: "tok" });

  test("正常结束：drain 文字当答复；结完清掉队列", () => {
    const h = harness();
    const q = new Map([["tok:t18", [w(h.cid, 1)]]]);
    const r = takeApiWaiters(q, h.turn("Stop", { text: "答复" }), true);
    expect(r.map((x) => x.result)).toEqual([{ threadId: "thr-1", agent: "agent-task-t18", viaFallback: true, reply: "答复" }]);
    expect(q.size).toBe(0);
  });

  test("以 API 错误结束：reply:null + apiError + 错误类型，两条请求都结掉（常规审查 P1-1）", () => {
    const h = harness();
    const q = new Map([["tok:t18", [w(h.cid, 1), w(h.cid, 2)]]]);
    const r = takeApiWaiters(q, h.turn("StopFailure", { text: "说了一半", apiError: true, error: wallErr }), false);
    expect(r.map((x) => x.result)).toEqual([1, 2].map((n) => ({ threadId: `thr-${n}`, agent: "agent-task-t18", viaFallback: true, reply: null, apiError: true, error: "rate_limit" })));
    expect(q.size).toBe(0);
  });

  test("CC 的 StopFailure 还没读到错误条目：error 填事件名", () => {
    const h = harness();
    const r = takeApiWaiters(new Map([["k", [w(h.cid, 1)]]]), h.turn("StopFailure", { text: null }), false);
    expect(r[0].result).toMatchObject({ reply: null, apiError: true, error: "StopFailure" });
  });

  test("别人的频道 / 别的 agent 的请求不动", () => {
    const h = harness();
    const q = new Map([["k1", [w("c-someone", 1)]]]);
    expect(takeApiWaiters(q, h.turn("Stop", { text: "x" }), true)).toEqual([]);
    const other: StopTurn = { ...h.turn("StopFailure", { text: null, apiError: true }), stopChannelId: "c-else", candidateWs: 2 };
    expect(takeApiWaiters(new Map([["k2", [w(h.cid, 2)]]]), other, false)).toEqual([]);
    expect(q.size).toBe(1);
  });
});

describe("jsonl-watcher 的 apiError 标记 → settleStopTurn（真实 drain 结果直接喂进去）", () => {
  const home = mkdtempSync(join(tmpdir(), "stop-settle-home-"));
  const realHome = process.env.HOME;
  const SID = randomUUID(); // 夹具会话：写死的 id 可能正好是本机真实会话，followMovedSession 会去 watch 它
  const cwd = join(home, "repo");
  const file = join(home, ".claude", "projects", projectsSlug(cwd), `${SID}.jsonl`);
  const line = (o: object) => appendFileSync(file, JSON.stringify(o) + "\n");
  const asst = (text: string, extra: object = {}) => ({ type: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text }] }, ...extra });
  const synth = (text: string, error: string) => asst(text, { isApiErrorMessage: true, error, message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text }] } });
  const errEntry = synth(LIMIT, "rate_limit");
  const prompt = (content: string) => line({ type: "user", message: { role: "user", content } });
  const drain = () => drainChannelWatcher("local-t24-probe", {} as Client);
  beforeAll(async () => {
    process.env.HOME = home;
    mkdirSync(join(home, ".claude", "projects", projectsSlug(cwd)), { recursive: true });
    writeFileSync(file, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
    await startWatching("agent-t24-probe", cwd, SID, "local-t24-probe", {} as Client);
  });
  afterAll(async () => {
    await drain(); // 等在途的 processNewData 跑完（它和 drain 排同一把锁），再停、再还原 HOME
    stopWatching("agent-t24-probe");
    await new Promise((r) => setTimeout(r, 50));
    process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("撞墙那一轮 Stop（CC 报的是 Stop 也一样）不结算，错误前的话扣下；下一轮正常答复连同它一起推回", async () => {
    const h = harness();
    line(asst("先看下代码"));
    line(errEntry);
    line({ type: "system", subtype: "turn_duration", durationMs: 800 });
    const r1 = await drain();
    expect(r1).toEqual({ drained: true, text: "先看下代码", apiError: true, error: { error: "rate_limit", text: LIMIT } });
    expect(await h.stop("Stop", r1)).toBe(false);
    expect(h.pushed).toEqual([]);
    prompt("接着做");
    line(asst("做完了"));
    const r2 = await drain();
    expect(r2).toEqual({ drained: true, text: "做完了", apiError: false });
    await h.stop("Stop", r2);
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0]).toContain("先看下代码\n\n做完了");
  });

  test("同一批里先错误后正常（CC 内部重试成功）：apiError=false，答复里不夹报错原文", async () => {
    prompt("下一个问题");
    line(synth("API Error: 529 Overloaded", "overloaded"));
    line(asst("真答复"));
    expect(await drain()).toEqual({ drained: true, text: "真答复", apiError: false });
  });

  test("只认合成条目：agent 自己的话以「You've hit your … limit」开头照常是答复", async () => {
    prompt("GitHub 那边怎样");
    line(asst("You've hit your API limit on GitHub, so I paused the sync."));
    line(asst(LIMIT));
    expect(await drain()).toEqual({ drained: true, text: `You've hit your API limit on GitHub, so I paused the sync.\n${LIMIT}`, apiError: false });
  });

  test("Codex 的额度条目（不带 isApiErrorMessage、带 error）：⛔ 那句算答复，要推给 caller", async () => {
    prompt("跑一下");
    line(asst(CODEX_LIMIT, { error: CODEX_LIMIT }));
    expect(await drain()).toEqual({ drained: true, text: CODEX_LIMIT, apiError: false });
  });

  test("新一轮的用户提示就复位标记：Stop 先到、新一轮的 assistant 条目还没读到，也不会带着上一轮的错误跳过结算", async () => {
    line(errEntry);
    expect((await drain()).apiError).toBe(true);
    line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } });
    expect((await drain()).apiError).toBe(true); // tool_result 不是新一轮
    prompt("新问题");
    expect((await drain()).apiError).toBe(false);
  });
});
