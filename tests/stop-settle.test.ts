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
import { AgentCallBook, expiredNotice, type PendingAgentCall } from "../src/bridge/agent-calls.js";
import { drainChannelWatcher, startWatching, stopWatching } from "../src/bridge/jsonl-watcher.js";
import { noteDelivered, settleStopTurn, type TurnTrigger, settlesOwnTurn, takeApiWaiters, type ApiWaiter, type CallerSettleDeps, type StopTurn } from "../src/bridge/stop-settle.js";
import { projectsSlug } from "../src/lib/jsonl-cost.js";

const LIMIT = "You've hit your weekly limit · resets Sep 30 at 6am (Asia/Tokyo)";
const FABLE = "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.";
const CODEX_LIMIT = "You've hit your usage limit. Upgrade to Pro or try again at 8:41 AM.";
const wallErr = { error: "rate_limit", text: LIMIT };
const call: PendingAgentCall = { callerChannelId: "c-pm", callerName: "agent-claudestra", targetName: "agent-task-t18", ts: 1000 };

const wh = (c?: PendingAgentCall) => c?.requests?.flatMap((r) => r.withheld ?? []) ?? []; // 扣下的话逐条存在请求上（T6c1 r2）
let seq = 0;
/** 每个 harness 一个频道：「等续跑」标记是模块级的，共用频道会串到别的用例 */
function harness(runtime?: string, opts: { pushFails?: boolean; restarted?: boolean } = {}) {
  const cid = `c-t18-${++seq}`;
  const book = new AgentCallBook(null);
  book.add(cid, { ...call }, "m1");
  // PM 的请求送到、开了这一轮（扣下的话只归开这一轮的 caller）；restarted = 重启后没见过这个频道的投递和 Stop
  if (!opts.restarted) noteDelivered(cid, { kind: "local", channelId: "c-pm" }, 1000, true);
  const pushed: string[] = [];
  const to: string[] = [];
  const notes: string[] = [];
  const rearmed: string[] = [];
  const unattributed: string[] = [];
  let nudged = 0;
  const deps: CallerSettleDeps = {
    answerable: (cid) => book.answerable(cid, () => false),
    waiting: (cid) => book.waiting(cid, () => false),
    rearmResume: (cid) => void rearmed.push(cid),
    consume: (cid, pac) => void book.consume(cid, pac.callerChannelId, pac),
    pushBack: async (pac, _cid, body) => {
      if (opts.pushFails) throw new Error("caller 的 ws 断了");
      pushed.push(body);
      to.push(pac.callerChannelId);
    },
    unattributed: (_cid, text) => void unattributed.push(text),
    nudgeAmbiguous: () => void nudged++,
    takeApiErrorNotice: (cid) => book.takeApiErrorNotice(cid, () => false),
    markApiError: (cid, text, caller) => book.markApiError(cid, () => false, text, caller),
    clearWithheld: (cid, pac) => book.clearWithheld(cid, pac),
    notify: async (_pac, _cid, body) => void notes.push(body),
    metric: () => {},
  };
  /** 与 bridge.ts 的 Stop 处理同一个入口：event 原样、drain 是 drainChannelWatcher 的返回值 */
  const turn = (event: string, drain: StopTurn["drain"], trigger: TurnTrigger = "insider"): StopTurn =>
    ({ cid, stopChannelId: cid, stopWs: 1, candidateWs: 1, event, runtime, drain, trigger });
  const stop = (event: string, drain: StopTurn["drain"], trigger: TurnTrigger = "insider") => settleStopTurn(deps, turn(event, drain, trigger));
  /** bridge 的真实路径：不给 humanTurn，按 deliverToLocal 送达时 noteDelivered 记下的来源判；idle = 送到时目标闲着（开新一轮），回合中途送到的传 false */
  const delivered = (from: { kind: string; owner?: boolean; peer?: string; channelId?: string; label?: string }, at?: number, idle = true) => noteDelivered(cid, from, at, idle);
  const stopReal = (event: string, drain: StopTurn["drain"]) => settleStopTurn(deps, { ...turn(event, drain), trigger: undefined });
  return { cid, book, deps, pushed, to, notes, rearmed, unattributed, nudged: () => nudged, stop, stopReal, delivered, turn, slot: () => book.slot(cid, "c-pm") };
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

  test("错误前已经说了的话扣下，结算时单独一条、带抬头先推，再推这一轮的答复（PM 09-29）", async () => {
    const h = harness();
    await h.stop("StopFailure", { text: "查到了：根因在 watcher", apiError: true, error: wallErr });
    await h.stop("Stop", { text: "修好了，PR #151" });
    expect(h.pushed).toHaveLength(2);
    expect(h.pushed[0]).toBe("[ℹ️ agent-task-t18 撞墙前扣下的答复（那一轮以 API 错误结束，下面是出错前它已经说了的话）：]\n\n查到了：根因在 watcher");
    expect(h.pushed[1]).toContain("修好了，PR #151");
    expect(h.pushed[1]).not.toContain("根因在 watcher");
    expect(h.slot()).toBeUndefined();
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
    expect(h.notes[0]).toContain("换模型（/model）"); // 不说「恢复后」：续跑只会再撞，要人换模型
  });

  test("好几个 caller 在等：API 错误那一轮不发「分别回」提醒，每个 caller 各收一条说明", async () => {
    const h = harness();
    h.book.add(h.cid, { ...call, callerChannelId: "c-other", callerName: "agent-other" }, "m9");
    await h.stop("StopFailure", { text: null, apiError: true, error: { error: "server_error", text: "API Error: 529 Overloaded" } });
    expect(h.nudged()).toBe(0);
    expect(h.notes).toHaveLength(2);
  });

  test("撞墙后 guest / 外部 token 触发的回合不结算旧 caller；接着做的那一轮（bridge 续跑）才结算", async () => {
    const h = harness();
    await h.stop("StopFailure", { text: null, apiError: true, error: wallErr });
    expect(await h.stop("Stop", { text: "（回 guest 的）天气是晴", apiError: false }, "stranger")).toBe(true);
    expect(h.pushed).toEqual([]);
    expect(h.slot()).toBeDefined();
    await h.stop("Stop", { text: "T18 接着做完了", apiError: false });
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0]).toContain("T18 接着做完了");
    expect(h.pushed[0]).not.toContain("天气");
  });

  test("撞墙后 owner 触发的回合（Discord 上说「继续」、Web 上接着问）照常结算旧 caller：owner 和 PM 在同一侧（PM 09-29）", async () => {
    const h = harness();
    await h.stop("StopFailure", { text: null, apiError: true, error: wallErr });
    expect(await h.stop("Stop", { text: "T18 接着做完了", apiError: false }, "owner")).toBe(true);
    expect(h.pushed).toHaveLength(1);
    expect(h.slot()).toBeUndefined();
  });

  test("等续跑期间 owner 在 Discord 打字不算接管；那几条请求被它自己 reply 答掉后，扣下的话不串给新 caller", async () => {
    const h = harness();
    await h.stop("StopFailure", { text: "旧的半句", apiError: true, error: wallErr });
    expect(h.book.awaitingResume(h.cid, () => false)).toBe(true);
    expect(wh(h.slot())).toEqual(["旧的半句"]); // 落在回程簿上：重启后还在
    h.book.consume(h.cid, "c-pm"); // 它用 send_to_agent 明确答了 PM
    h.book.add(h.cid, { ...call, callerChannelId: "c-new", callerName: "agent-new", ts: 3000 }, "m5");
    expect(h.book.awaitingResume(h.cid, () => false)).toBe(false);
    await h.stop("Stop", { text: "给新 caller 的答复" });
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0]).not.toContain("旧的半句");
  });

  test("真实来源判定：撞错后 guest / peer token 触发的回合不结算、它说的话不扣也不外推；bridge 续跑那轮结算，扣下的话单独一条（T24 r1 P1-2）", async () => {
    const h = harness();
    const overloaded = { error: "overloaded", text: "API Error: 529 Overloaded" };
    h.delivered({ kind: "local", channelId: "c-pm" }); // PM 的 send_to_agent
    await h.stopReal("StopFailure", { text: "查到根因在 X", apiError: true, error: overloaded });
    h.delivered({ kind: "api" }); // guest token B 问了件别的事（没有 owner 标记）
    await h.stopReal("StopFailure", { text: "（答 B 的）半句", apiError: true, error: overloaded });
    h.delivered({ kind: "api", owner: true, peer: "sekai" }); // peer 永远不算 owner
    expect(await h.stopReal("Stop", { text: "（答 B 的）结论" })).toBe(true);
    expect(h.pushed).toEqual([]);
    h.delivered({ kind: "bridge" }); // 60 秒续跑
    await h.stopReal("Stop", { text: "X 修好了" });
    expect(h.pushed).toHaveLength(2);
    expect(h.pushed[0]).toContain("撞墙前扣下的答复");
    expect(h.pushed[0]).toContain("查到根因在 X");
    expect(h.pushed[1]).toContain("X 修好了");
    expect(h.pushed.join("\n")).not.toContain("答 B");
  });

  test("来源按开启这一轮的那条：外人那一轮中途投进一条 bridge 消息，不会因此把外人的答复结算给 PM；续跑也重新排上（T24 r2 P2-1 A）", async () => {
    const h = harness();
    await h.stop("StopFailure", { text: null, apiError: true, error: wallErr });
    h.delivered({ kind: "api" }, 1_000); // guest 开启这一轮
    h.delivered({ kind: "bridge" }, 60_000, false); // 回合中途的 ask 过期通知
    expect(await h.stopReal("Stop", { text: "（给 guest 的）结论" })).toBe(true);
    expect(h.pushed).toEqual([]);
    expect(h.rearmed).toEqual([h.cid]);
  });

  test("PM 续跑的那一轮中途来一条 peer 请求：PM 的答复照样结算（T24 r2 P2-1 B）；同一批补投取最严", async () => {
    const h = harness();
    await h.stop("StopFailure", { text: null, apiError: true, error: wallErr });
    h.delivered({ kind: "bridge" }, 1_000); // 续跑开启这一轮
    h.delivered({ kind: "api", peer: "sekai" }, 60_000, false);
    expect(await h.stopReal("Stop", { text: "PM 要的结论" })).toBe(true);
    expect(h.pushed).toHaveLength(1);
    const g = harness();
    await g.stop("StopFailure", { text: null, apiError: true, error: wallErr });
    g.delivered({ kind: "local", channelId: "c-pm" }, 1_000);
    g.delivered({ kind: "api" }, 1_500); // 一起补投的 guest 消息：这一轮也在答它，不结算
    await g.stopReal("Stop", { text: "混着答的" });
    expect(g.pushed).toEqual([]);
  });

  test("被打断的续跑没有 Stop：之后 guest 在目标闲着时送到的消息重新记来源，不按旧的 insider 结算（T24 adv1 P1-3）", async () => {
    const h = harness();
    await h.stop("StopFailure", { text: "查到根因在 X", apiError: true, error: wallErr });
    h.delivered({ kind: "bridge" }, 1_000, true); // 续跑开启这一轮
    h.delivered({ kind: "api" }, 20_000, true); // guest 抢占 C-c 打断它（CC 不发 Stop），打断后目标闲着才送到
    expect(await h.stopReal("Stop", { text: "（给 guest 的）结论" })).toBe(true);
    expect(h.pushed).toEqual([]);
    expect(h.rearmed).toEqual([h.cid]);
    const g = harness();
    await g.stop("StopFailure", { text: null, apiError: true, error: wallErr });
    g.delivered({ kind: "bridge" }, 1_000, true); // owner 在终端按 Esc 打断了续跑，十分钟后 guest 来问
    g.delivered({ kind: "api" }, 600_000, true);
    await g.stopReal("Stop", { text: "（给 guest 的）结论" });
    expect(g.pushed).toEqual([]);
    const b = harness(); // 同一批里目标还没显出在跑（闲着）：不因此把 guest 降回 insider
    await b.stop("StopFailure", { text: null, apiError: true, error: wallErr });
    b.delivered({ kind: "api" }, 1_000, true);
    b.delivered({ kind: "bridge" }, 2_000, true);
    await b.stopReal("Stop", { text: "（给 guest 的）结论" });
    expect(b.pushed).toEqual([]);
  });

  test("CC 到点自己续跑的那一轮（没有 bridge 投递）继承撞墙那一轮的来源：PM 的照样结算、guest 的不结算；重启后没见过 Stop 的仍按外人（T24 adv1 P1-4）", async () => {
    const h = harness();
    h.delivered({ kind: "local", channelId: "c-pm" });
    await h.stopReal("StopFailure", { text: "查到根因在 X", apiError: true, error: wallErr });
    expect(await h.stopReal("Stop", { text: "X 修好了" })).toBe(true); // continuing automatically at 3:20am
    expect(h.pushed).toHaveLength(2);
    expect(h.pushed[1]).toContain("X 修好了");
    expect(h.rearmed).toEqual([]);
    const g = harness(); // 撞墙的那一轮是 guest 开的：CC 自己接着跑的还是在答 guest，不结算 PM
    g.delivered({ kind: "api" });
    await g.stopReal("StopFailure", { text: "（给 guest 的）半句", apiError: true, error: wallErr });
    await g.stopReal("Stop", { text: "（给 guest 的）结论" });
    expect(g.pushed).toEqual([]);
    const r = harness(undefined, { restarted: true }); // 重启后：这一轮是重启前开的，来源不知道
    r.book.markApiError(r.cid, () => false, "旧的半句");
    await r.stopReal("Stop", { text: "不知道在答谁" });
    expect(r.pushed).toEqual([]);
    expect(r.rearmed).toEqual([r.cid]);
  });

  test("真实来源判定：owner 在 Web 上（owner:self 的 api，带 owner 标记）触发的回合结算旧 caller", async () => {
    const h = harness();
    h.delivered({ kind: "local", channelId: "c-pm" });
    await h.stopReal("StopFailure", { text: null, apiError: true, error: wallErr });
    h.delivered({ kind: "api", owner: true });
    expect(await h.stopReal("Stop", { text: "接着做完了" })).toBe(true);
    expect(h.pushed).toHaveLength(1);
    expect(h.slot()).toBeUndefined();
  });

  test("两个 caller 在等时撞错：两槽都记上等续跑", async () => {
    const h = harness();
    h.book.add(h.cid, { ...call, callerChannelId: "c-other", callerName: "agent-other" }, "m9");
    await h.stop("StopFailure", { text: null, apiError: true, error: wallErr });
    expect(h.book.forTarget(h.cid).every((c) => c.requests?.some((r) => r.apiErrorAt))).toBe(true);
    expect(h.book.awaitingResume(h.cid, () => false)).toBe(true);
  });

  test("没撞过墙：人触发的回合照旧按原规则结算", async () => {
    const h = harness();
    await h.stop("Stop", { text: "答复", apiError: false }, "stranger");
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

  test("扣下的话推失败：回程和扣下的话都留着，这一轮的正文也扣上，不丢（T24 r2 P2-5）", async () => {
    const h = harness(undefined, { pushFails: true });
    await h.stop("StopFailure", { text: "半句", apiError: true, error: wallErr });
    await h.stop("Stop", { text: "做完了" });
    expect(wh(h.slot())).toEqual(["半句", "做完了"]);
  });

  test("好几个 caller 在等时撞错：扣下的话只挂在开启这一轮的那个 caller 上，别的 caller 收不到（T24 wf delivery-hold-3）", async () => {
    const h = harness();
    h.book.add(h.cid, { ...call, callerChannelId: "c-other", callerName: "agent-other" }, "m9");
    h.delivered({ kind: "local", channelId: "c-pm" }, 1_000, true); // PM 的请求开了这一轮
    await h.stopReal("StopFailure", { text: "（给 PM 的）查到一半", apiError: true, error: wallErr });
    expect(wh(h.book.slot(h.cid, "c-other"))).toEqual([]);
    await h.stopReal("Stop", { text: "做完了" }); // CC 自己接着跑：继承来源
    expect(h.to).toEqual(["c-pm"]);
    expect(h.pushed[0]).toContain("（给 PM 的）查到一半");
    expect(h.nudged()).toBe(1); // 正文照旧不猜：提醒它分别回
  });

  test("顺序路径：B 的回合先撞错、A 的回合再撞错——各自的话只回各自的 caller；对不上是谁的就不扣，只告诉 owner（T24 wf delivery-hold-3）", async () => {
    const h = harness(); // c-pm = B，已经在等
    h.delivered({ kind: "local", channelId: "c-pm" }, 1_000, true);
    await h.stopReal("StopFailure", { text: "（给 B 的）半句", apiError: true, error: { error: "overloaded", text: "API Error: 529" } });
    h.book.add(h.cid, { ...call, callerChannelId: "c-a", callerName: "agent-a" }, "m9");
    h.delivered({ kind: "local", channelId: "c-a" }, 60_000, true);
    await h.stopReal("StopFailure", { text: "（给 A 的）半句", apiError: true, error: wallErr });
    expect(wh(h.book.slot(h.cid, "c-pm"))).toEqual(["（给 B 的）半句"]);
    expect(wh(h.book.slot(h.cid, "c-a"))).toEqual(["（给 A 的）半句"]);
    h.delivered({ kind: "bridge" }, 200_000, true); // 出闸续跑：bridge 开的，两个都在等
    await h.stopReal("StopFailure", { text: "续跑又撞了，说了一句", apiError: true, error: wallErr });
    expect(h.unattributed).toEqual(["续跑又撞了，说了一句"]);
    expect(h.book.forTarget(h.cid).flatMap(wh)).not.toContain("续跑又撞了，说了一句");
    h.delivered({ kind: "bridge" }, 400_000, true);
    await h.stopReal("Stop", { text: "都做完了" });
    expect(h.to).toEqual(["c-pm", "c-a"]);
    expect(h.pushed[0]).toContain("给 B 的");
    expect(h.pushed[0]).not.toContain("给 A 的");
    expect(h.pushed[1]).toContain("给 A 的");
  });

  test("补投同批里 A、B 两个 caller 的请求一起开了这一轮：谁的话都不扣（不猜）", async () => {
    const h = harness();
    h.book.add(h.cid, { ...call, callerChannelId: "c-a", callerName: "agent-a" }, "m9");
    h.delivered({ kind: "local", channelId: "c-pm" }, 1_000, true);
    h.delivered({ kind: "local", channelId: "c-a" }, 1_500, true);
    await h.stopReal("StopFailure", { text: "混着答的半句", apiError: true, error: wallErr });
    expect(h.book.forTarget(h.cid).every((c) => !wh(c).length)).toBe(true);
    expect(h.unattributed).toHaveLength(1);
  });

  test("推回 caller 返回 error / dropped（pushBackToCaller 不抛错）：当没送到，扣下的话留着、回程不消化（T24 adv1 P2-2）", async () => {
    const h = harness();
    const deps = { ...h.deps, pushBack: async () => ({ kind: "error" }) };
    h.delivered({ kind: "local", channelId: "c-pm" }, 1_000, true);
    await settleStopTurn(deps, { ...h.turn("StopFailure", { text: "半句", apiError: true, error: wallErr }), trigger: undefined });
    await settleStopTurn(deps, { ...h.turn("Stop", { text: "做完了" }), trigger: undefined });
    expect(wh(h.slot())).toEqual(["半句", "做完了"]);
  });

  test("它直接 reply / send_to_agent 答掉带着扣下的话的槽：consume 不悄悄清掉，交给 onWithheld 推", async () => {
    const h = harness();
    const seen: string[][] = [];
    h.book.onWithheld = (p) => void seen.push(p.withheld ?? []);
    await h.stop("StopFailure", { text: "半句", apiError: true, error: wallErr });
    h.book.consume(h.cid, "c-pm");
    expect(seen).toEqual([["半句"]]);
  });

  test("2 小时过期：带着等续跑的回程不静默删，sweepStale 交出来，用固定模板告诉 caller、附上扣下的话（T24 r2 P2-2）", async () => {
    const h = harness();
    await h.stop("StopFailure", { text: "半句", apiError: true, error: wallErr });
    const gone = h.book.sweepStale(Date.now() + 3 * 3_600_000, 2 * 3_600_000, () => undefined);
    expect(gone).toHaveLength(1);
    expect(h.slot()).toBeUndefined();
    const text = expiredNotice(gone[0]);
    expect(text).toMatch(/^\[ℹ️ agent-task-t18 没有给出答复（原因：它 \d\d:\d\d 那一轮以 API 错误结束，之后 2 小时没有接着做完），扣下的话附后，请重发或换人\]/);
    expect(text).toEndWith("\n\n半句");
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
    expect(r1).toEqual({ drained: true, text: "先看下代码", apiError: true, error: { error: "rate_limit", text: LIMIT }, turnMark: expect.any(String) });
    expect(await h.stop("Stop", r1)).toBe(false);
    expect(h.pushed).toEqual([]);
    prompt("接着做");
    line(asst("做完了"));
    const r2 = await drain();
    expect(r2).toEqual({ drained: true, text: "做完了", apiError: false, turnMark: expect.any(String) });
    await h.stop("Stop", r2);
    expect(h.pushed).toHaveLength(2);
    expect(h.pushed[0]).toContain("撞墙前扣下的答复");
    expect(h.pushed[0]).toContain("先看下代码");
    expect(h.pushed[1]).toContain("做完了");
    // 回合级幂等的判据（stop-settle markRepeat）：这一轮又来一次 Stop，会话记录里没有新的 assistant 条目，turnMark 不变
    expect(r2.turnMark).not.toBe(r1.turnMark);
    prompt("晚到的 B");
    expect((await drain()).turnMark).toBe(r2.turnMark);
  });

  test("同一批里先错误后正常（CC 内部重试成功）：apiError=false，答复里不夹报错原文", async () => {
    prompt("下一个问题");
    line(synth("API Error: 529 Overloaded", "overloaded"));
    line(asst("真答复"));
    expect(await drain()).toEqual({ drained: true, text: "真答复", apiError: false, turnMark: expect.any(String) });
  });

  test("只认合成条目：agent 自己的话以「You've hit your … limit」开头照常是答复", async () => {
    prompt("GitHub 那边怎样");
    line(asst("You've hit your API limit on GitHub, so I paused the sync."));
    line(asst(LIMIT));
    expect(await drain()).toEqual({ drained: true, text: `You've hit your API limit on GitHub, so I paused the sync.\n${LIMIT}`, apiError: false, turnMark: expect.any(String) });
  });

  test("Codex 的额度条目（不带 isApiErrorMessage、带 error）：⛔ 那句算答复，要推给 caller", async () => {
    prompt("跑一下");
    line(asst(CODEX_LIMIT, { error: CODEX_LIMIT }));
    expect(await drain()).toEqual({ drained: true, text: CODEX_LIMIT, apiError: false, turnMark: expect.any(String) });
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
