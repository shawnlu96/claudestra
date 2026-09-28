/**
 * bridge/stop-settle.ts + jsonl-watcher 的 apiError 标记：Claude Code 以 API 错误结束的一轮（额度墙 / StopFailure）不把错误文字
 * 当答复推回 caller、不消化回程簿，之后正常结束的一轮照常推回（2026-09-28 22:19 撞墙现场的回归测试）。
 * Codex 的 StopFailure（撞额度时 codex-turn-failure 补的、打断时 typing-hook 映射的）照常结算（T24a 对抗审查 P1）。
 * 走 bridge 实际调用的 settleStopTurn；watcher 一段把真实的 drainChannelWatcher 结果原样喂进去。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "discord.js";
import { AgentCallBook, type PendingAgentCall } from "../src/bridge/agent-calls.js";
import { drainChannelWatcher, startWatching, stopWatching } from "../src/bridge/jsonl-watcher.js";
import { settleStopTurn, settlesOwnTurn, type CallerSettleDeps, type StopTurn } from "../src/bridge/stop-settle.js";
import { projectsSlug } from "../src/lib/jsonl-cost.js";

const LIMIT = "You've hit your weekly limit · resets Sep 30 at 6am (Asia/Tokyo)";
const CODEX_LIMIT = "You've hit your usage limit. Upgrade to Pro or try again at 8:41 AM.";
const call: PendingAgentCall = { callerChannelId: "c-pm", callerName: "agent-claudestra", targetName: "agent-task-t18", ts: 1000 };

function harness(runtime?: string) {
  const book = new AgentCallBook(null);
  book.add("c-t18", { ...call }, "m1");
  const pushed: string[] = [];
  const deps: CallerSettleDeps = {
    answerable: (cid) => book.answerable(cid, () => false),
    consume: (cid, pac) => void book.consume(cid, pac.callerChannelId, pac),
    pushBack: async (_pac, _cid, body) => void pushed.push(body),
    nudgeAmbiguous: () => {},
    metric: () => {},
  };
  /** 与 bridge.ts 的 Stop 处理同一个入口：event 原样、drain 是 drainChannelWatcher 的返回值 */
  const stop = (event: string, drain: StopTurn["drain"]) =>
    settleStopTurn(deps, { cid: "c-t18", stopChannelId: "c-t18", stopWs: 1, candidateWs: 1, event, runtime, drain });
  return { book, pushed, stop, slot: () => book.slot("c-t18", "c-pm") };
}

describe("Claude Code：以 API 错误结束的一轮不结算", () => {
  test("最后一条是额度错误：不推、不消化；之后的真实答复照常推回 caller", async () => {
    const h = harness();
    expect(await h.stop("StopFailure", { text: LIMIT, apiError: true })).toBe(false);
    expect(h.pushed).toEqual([]);
    expect(h.slot()).toBeDefined();
    expect(await h.stop("Stop", { text: "T18 做完了，PR #150", apiError: false })).toBe(true);
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0]).toContain("T18 做完了，PR #150");
    expect(h.slot()).toBeUndefined();
  });

  test("StopFailure 没文字也不静默消化（以前这里把回程簿清了）", async () => {
    const h = harness("claude-code");
    await h.stop("StopFailure", { text: null });
    expect(h.slot()).toBeDefined();
  });

  test("正常结束没文字：照旧静默消化、不推", async () => {
    const h = harness();
    await h.stop("Stop", { text: null });
    expect(h.pushed).toEqual([]);
    expect(h.slot()).toBeUndefined();
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

  test("Codex 的非额度 API 错误（isApiErrorMessage=true）：不结算，交给 60 秒续跑", async () => {
    const h = harness("codex");
    expect(await h.stop("StopFailure", { text: "API Error: 500", apiError: true })).toBe(false);
    expect(h.slot()).toBeDefined();
  });
});

describe("jsonl-watcher 的 apiError 标记 → settleStopTurn（真实 drain 结果直接喂进去）", () => {
  const home = mkdtempSync(join(tmpdir(), "stop-settle-home-"));
  const realHome = process.env.HOME;
  const SID = "6db1303f-57ce-47f1-85ff-9a616045a2c3";
  const cwd = join(home, "repo");
  const file = join(home, ".claude", "projects", projectsSlug(cwd), `${SID}.jsonl`);
  const line = (o: object) => appendFileSync(file, JSON.stringify(o) + "\n");
  const asst = (text: string, extra: object = {}) => ({ type: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text }] }, ...extra });
  const errEntry = asst(LIMIT, { isApiErrorMessage: true, error: "rate_limit", message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: LIMIT }] } });
  const drain = () => drainChannelWatcher("local-t24-probe", {} as Client);
  beforeAll(async () => {
    process.env.HOME = home;
    mkdirSync(join(home, ".claude", "projects", projectsSlug(cwd)), { recursive: true });
    writeFileSync(file, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
    await startWatching("agent-t24-probe", cwd, SID, "local-t24-probe", {} as Client);
  });
  afterAll(() => {
    stopWatching("agent-t24-probe");
    process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("撞墙那一轮 Stop（CC 报的是 Stop 也一样）不结算；下一轮正常答复推回", async () => {
    const h = harness();
    line(asst("先看下代码"));
    line(errEntry);
    line({ type: "system", subtype: "turn_duration", durationMs: 800 });
    const r1 = await drain();
    expect(r1).toMatchObject({ apiError: true });
    expect(r1.text).toContain(LIMIT);
    expect(await h.stop("Stop", r1)).toBe(false);
    expect(h.pushed).toEqual([]);
    line({ type: "user", message: { role: "user", content: "接着做" } });
    line(asst("做完了"));
    const r2 = await drain();
    expect(r2).toEqual({ drained: true, text: "做完了", apiError: false });
    await h.stop("Stop", r2);
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0]).toContain("做完了");
  });

  test("新一轮的用户提示就复位标记：Stop 先到、新一轮的 assistant 条目还没读到，也不会带着上一轮的错误跳过结算", async () => {
    line(errEntry);
    expect((await drain()).apiError).toBe(true);
    line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } });
    expect((await drain()).apiError).toBe(true); // tool_result 不是新一轮
    line({ type: "user", message: { role: "user", content: "新问题" } });
    expect((await drain()).apiError).toBe(false);
  });
});
