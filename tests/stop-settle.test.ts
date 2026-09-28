/**
 * bridge/stop-settle.ts + jsonl-watcher 的 apiError 标记：以 API 错误结束的一轮（额度墙 / StopFailure）不把错误文字
 * 当答复推回 caller、不消化回程簿；之后正常结束的一轮照常推回（2026-09-28 22:19 撞墙现场的回归测试）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "discord.js";
import { AgentCallBook, type PendingAgentCall } from "../src/bridge/agent-calls.js";
import { drainChannelWatcher, startWatching, stopWatching } from "../src/bridge/jsonl-watcher.js";
import { settleCallers, settlesOwnTurn, type CallerSettleDeps } from "../src/bridge/stop-settle.js";
import { projectsSlug } from "../src/lib/jsonl-cost.js";

const LIMIT = "You've hit your weekly limit · resets Sep 30 at 6am (Asia/Tokyo)";
const call: PendingAgentCall = { callerChannelId: "c-pm", callerName: "agent-claudestra", targetName: "agent-task-t18", ts: 1000 };

function harness() {
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
  /** bridge.ts 的 Stop 流程：先判这一轮算不算自己答完，算才结算 */
  const stop = async (event: string, drained: { text: string | null; apiError?: boolean }) => {
    if (settlesOwnTurn({ cid: "c-t18", stopChannelId: "c-t18", stopWs: 1, candidateWs: 1, event, apiError: drained.apiError })) {
      await settleCallers(deps, "c-t18", drained.text);
    }
  };
  return { book, pushed, stop };
}

describe("drain 兜底遇到 API 错误", () => {
  test("最后一条是额度错误：不推、不消化；之后的真实答复照常推回 caller", async () => {
    const h = harness();
    await h.stop("Stop", { text: LIMIT, apiError: true });
    expect(h.pushed).toEqual([]);
    expect(h.book.slot("c-t18", "c-pm")).toBeDefined();
    await h.stop("Stop", { text: "T18 做完了，PR #150", apiError: false });
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0]).toContain("T18 做完了，PR #150");
    expect(h.book.slot("c-t18", "c-pm")).toBeUndefined();
  });

  test("StopFailure 没文字也不静默消化（以前这里把回程簿清了）", async () => {
    const h = harness();
    await h.stop("StopFailure", { text: null });
    expect(h.book.slot("c-t18", "c-pm")).toBeDefined();
  });

  test("正常结束没文字：照旧静默消化、不推", async () => {
    const h = harness();
    await h.stop("Stop", { text: null });
    expect(h.pushed).toEqual([]);
    expect(h.book.slot("c-t18", "c-pm")).toBeUndefined();
  });

  test("别人的频道不结算", () => {
    expect(settlesOwnTurn({ cid: "c-other", stopChannelId: "c-t18", stopWs: 1, candidateWs: 2, event: "Stop" })).toBe(false);
  });
});

describe("jsonl-watcher 的 apiError 标记", () => {
  const home = mkdtempSync(join(tmpdir(), "stop-settle-home-"));
  const realHome = process.env.HOME;
  const SID = "6db1303f-57ce-47f1-85ff-9a616045a2c3";
  const cwd = join(home, "repo");
  const file = join(home, ".claude", "projects", projectsSlug(cwd), `${SID}.jsonl`);
  const line = (o: object) => appendFileSync(file, JSON.stringify(o) + "\n");
  const asst = (text: string, extra: object = {}) => ({ type: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text }] }, ...extra });
  beforeAll(() => {
    process.env.HOME = home;
    mkdirSync(join(home, ".claude", "projects", projectsSlug(cwd)), { recursive: true });
    writeFileSync(file, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
  });
  afterAll(() => {
    stopWatching("agent-t24-probe");
    process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("撞墙条目 → apiError=true、text 是那句（按 ⛔ 收）；下一轮正常条目 → false", async () => {
    await startWatching("agent-t24-probe", cwd, SID, "local-t24-probe", {} as Client);
    line(asst("先看下代码"));
    line(asst(LIMIT, { isApiErrorMessage: true, error: "rate_limit", message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: LIMIT }] } }));
    line({ type: "system", subtype: "turn_duration", durationMs: 800 });
    const r1 = await drainChannelWatcher("local-t24-probe", {} as Client);
    expect(r1.apiError).toBe(true);
    expect(r1.text).toContain(LIMIT);
    line({ type: "user", message: { role: "user", content: "接着做" } });
    line(asst("做完了"));
    const r2 = await drainChannelWatcher("local-t24-probe", {} as Client);
    expect(r2).toEqual({ drained: true, text: "做完了", apiError: false });
  });
});
