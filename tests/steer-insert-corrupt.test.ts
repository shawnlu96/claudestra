import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCallBook, type PendingAgentCall } from "../src/bridge/agent-calls.js";
import type { Envelope } from "../src/bridge/router.js";
import { answerableUnmixed, noteDelivered, resetStopSettleForTest, settleStopTurn } from "../src/bridge/stop-settle.js";
import {
  configureSteerInsert, insertSnapshot, insertTargetQuarantined, insertUnseenFrom, noteInsert, openInsertBook, settleInsertReply, takeInsertReminders,
} from "../src/bridge/steer-insert.js";
import { wireInsertNotices } from "../src/bridge/steer-insert-notices.js";
import { requestStillHeld } from "../src/lib/held-pac.js";

const clock = 1_000_000;
const env = (id: string, caller: string, target = "T"): Envelope => ({
  from: { kind: "local", channelId: caller, agentName: caller, ws: undefined as never },
  to: { kind: "local", channelId: target, agentName: target, ws: undefined as never }, intent: "request", content: `request ${id}`,
  meta: { messageId: id, threadId: id, ts: "now", triggerKind: "agent_tool", inboundRoute: { action: "insert", via: "steer", p: 0.9 } },
});
function world(raw: unknown) {
  const root = mkdtempSync(join(tmpdir(), "insert-corrupt-return-"));
  const insertPath = join(root, "insert.json"), callsPath = join(root, "calls.json");
  writeFileSync(insertPath, JSON.stringify(raw));
  let calls = new AgentCallBook(callsPath);
  const pushed: string[] = [], notices: Envelope[] = [];
  const add = (target: string, caller: string, id?: string) => calls.add(target,
    { callerChannelId: caller, callerName: caller, targetName: target, ts: clock }, id);
  const wire = () => wireInsertNotices({
    hold: (e) => { notices.push(e); }, stoppedAt: () => undefined,
    dropRequest: (t, c, id) => calls.dropRequest(t, c, id), invalidate: (t, id) => calls.invalidateInsert(t, id),
  });
  wire(); openInsertBook(insertPath);
  const held = (target: string) => (r: { callerChannelId: string; messageId?: string }) => requestStillHeld(r, insertUnseenFrom(target));
  const deps = {
    answerable: (t: string) => answerableUnmixed(calls, t, held(t)), waiting: (t: string) => calls.waiting(t, held(t)),
    consume: (t: string, p: PendingAgentCall) => { calls.consume(t, p.callerChannelId, p); },
    pushBack: async (_p: PendingAgentCall, _t: string, body: string) => { pushed.push(body); },
    nudgeAmbiguous: () => {}, rearmResume: () => {}, takeApiErrorNotice: () => [], markApiError: () => undefined,
    clearWithheld: () => {}, notify: async () => {}, metric: () => {}, recovered: () => {},
  };
  const stop = async (target = "T") => {
    noteDelivered(target, { kind: "user", owner: true }, clock + 1, true);
    await settleStopTurn(deps, { cid: target, stopChannelId: target, stopWs: 1, candidateWs: 1, event: "Stop", drain: { text: "OWNER_PRIVATE_ANSWER" } });
  };
  const reopen = () => { calls = new AgentCallBook(callsPath); openInsertBook(insertPath); wire(); };
  return { add, stop, pushed, notices, reopen, wire, calls: () => calls, insertPath };
}
const good = { env: env("good", "Y"), at: clock };
beforeEach(() => { resetStopSettleForTest(); configureSteerInsert({ now: () => clock }); openInsertBook(null); });
afterEach(() => {
  openInsertBook(null); resetStopSettleForTest();
  configureSteerInsert({ now: () => Date.now(), removed: () => {}, invalid: () => false, stoppedAt: () => undefined });
});

describe("corrupt-return：坏确认账 + 独立落盘回程簿 + 真 Stop 结算", () => {
  test("corrupt-return：reminded=3 不能把 owner drain 推给 X，好条目 Y 保留", async () => {
    const w = world({ T: { bad: { env: env("bad", "X"), at: clock, reminded: 3 }, good } });
    w.add("T", "X", "bad"); w.add("T", "Y", "good");
    await w.stop();
    expect(w.pushed).toEqual([]);
    expect(w.calls().slot("T", "X")).toBeUndefined();
    expect(w.calls().slot("T", "Y")?.messageIds).toEqual(["good"]);
    expect([...insertSnapshot("T")]).toEqual(["good"]);
    expect(w.notices).toHaveLength(1);
    expect(w.notices[0].to).toMatchObject({ channelId: "X" });
    expect(w.notices[0].content).toContain("确认记录损坏");
    expect(JSON.stringify(w.notices)).not.toContain("OWNER_PRIVATE_ANSWER");
    w.reopen(); await w.stop();
    expect(w.pushed).toEqual([]);
    expect(w.notices).toHaveLength(1);
  });

  for (const [name, broken] of [
    ["from=null", { ...env("bad", "X"), from: null }],
    ["冒称Y且env.messageId指向good", { ...env("good", "Y"), content: null }],
    ["env=null", null],
  ]) test(`corrupt-return：${name}，只按外层 T/bad 撤 X，不借坏 env 认人`, async () => {
    const w = world({ T: { bad: { env: broken, at: clock }, good, "x-good": { env: env("x-good", "X"), at: clock } } });
    w.add("T", "X", "bad"); w.add("T", "X", "x-good"); w.add("T", "Y", "good");
    await w.stop();
    expect(w.pushed).toEqual([]);
    expect(w.calls().slot("T", "X")?.messageIds).toEqual(["x-good"]);
    expect(w.calls().slot("T", "Y")?.messageIds).toEqual(["good"]);
    expect([...insertSnapshot("T")].sort()).toEqual(["good", "x-good"]);
    expect(w.notices.map((e) => e.to)).toEqual([expect.objectContaining({ channelId: "X" })]);
  });

  test("corrupt-return：旧回程没有 messageId 时持久化隔离，重启、TTL 及后续 Stop 都不推 owner 内容", async () => {
    const w = world({ T: { bad: { env: null, at: clock }, good } });
    w.add("T", "X"); w.add("T", "Y", "good");
    await w.stop();
    expect(w.pushed).toEqual([]);
    expect(w.calls().slot("T", "X")?.requests?.[0].insertQuarantined).toBe(true);
    expect(w.notices[0].content).toContain("回程已隔离");
    w.reopen();
    expect(w.calls().exact("T", "X", () => false)).toBeUndefined();
    w.calls().sweepStale(clock + 3 * 86_400_000, 1, (t) => insertUnseenFrom(t));
    expect(w.calls().slot("T", "X")?.requests?.[0].insertQuarantined).toBe(true);
    await w.stop();
    expect(w.pushed).toEqual([]);
    expect(w.calls().slot("T", "Y")?.messageIds).toEqual(["good"]);
    w.add("T", "X", "fresh");
    const fresh = w.calls().exact("T", "X", () => false);
    expect(fresh?.messageIds).toEqual(["fresh"]);
    w.calls().consume("T", "X", fresh);
    expect(w.calls().slot("T", "X")?.requests?.[0].insertQuarantined).toBe(true);
  });

  test("corrupt-return：整目标账坏且没有 id，仅隔离该目标的回程，不影响别的目标", async () => {
    const w = world({ T: null, U: { good: { env: env("good", "Z", "U"), at: clock } } });
    w.add("T", "X", "bad"); w.add("U", "Z", "good");
    await w.stop();
    expect(w.pushed).toEqual([]);
    expect(w.calls().slot("T", "X")?.requests?.[0].insertQuarantined).toBe(true);
    expect(w.calls().slot("U", "Z")?.requests?.[0].insertQuarantined).toBeUndefined();
    expect([...insertSnapshot("U")]).toEqual(["good"]);
    expect(w.notices[0].to).toMatchObject({ channelId: "X" });
    expect(JSON.parse(readFileSync(w.insertPath, "utf8")).T).toBeUndefined();
  });

  test("corrupt-return：回程也没有可信 caller 时不猜地址，持久化隔离", async () => {
    const w = world({ T: { bad: { env: null, at: clock } } });
    w.add("T", "", "bad");
    await w.stop(); w.reopen(); await w.stop();
    expect(w.pushed).toEqual([]);
    expect(w.calls().slot("T", "")?.requests?.[0].insertQuarantined).toBe(true);
    expect(w.notices).toEqual([]);
  });

  test("corrupt-return：处理器缺失时整本坏账遇到新插队也不丢保护，恢复后隔离无法对应的请求", async () => {
    const w = world({ T: null });
    w.add("T", "X", "bad");
    configureSteerInsert({ invalid: () => false });
    w.add("T", "Z", "new"); noteInsert(env("new", "Z"), "T");
    await w.stop();
    expect(w.pushed).toEqual([]);
    expect(insertTargetQuarantined("T")).toBe(true);
    w.wire(); await w.stop();
    expect(w.pushed).toEqual([]);
    expect(w.calls().slot("T", "X")?.requests?.[0].insertQuarantined).toBe(true);
    expect(w.calls().slot("T", "Z")?.requests?.[0].insertQuarantined).toBe(true);
  });

  test("corrupt-return：处理器不可用时保留坏账并隔离目标，提醒和新插队不能覆盖坏账保护", async () => {
    const w = world({ T: { bad: { env: null, at: clock }, good } });
    w.add("T", "X", "bad"); w.add("T", "Y", "good");
    configureSteerInsert({ invalid: () => false });
    await w.stop();
    expect(w.pushed).toEqual([]);
    expect(insertTargetQuarantined("T")).toBe(true);
    takeInsertReminders("T", new Set(["good"]));
    noteInsert(env("new", "Z"), "T"); w.add("T", "Z", "new");
    expect(JSON.parse(readFileSync(w.insertPath, "utf8")).T.bad).toBeDefined();
    expect(insertTargetQuarantined("T")).toBe(true);
    w.wire(); await w.stop();
    expect(w.pushed).toEqual([]);
    expect([...insertSnapshot("T")].sort()).toEqual(["good", "new"]);
    expect(w.calls().slot("T", "X")).toBeUndefined();
  });

  test("corrupt-return：回程落盘失败时恢复原槽、保留确认保护，恢复写入后才精确清理并通知", async () => {
    const w = world({ T: { bad: { env: env("bad", "X"), at: clock, reminded: 3 }, good } });
    w.add("T", "X", "bad"); w.add("T", "Y", "good");
    const persist = w.calls().persist.bind(w.calls());
    w.calls().persist = () => false;
    await w.stop();
    expect(w.pushed).toEqual([]);
    expect(w.calls().slot("T", "X")?.messageIds).toEqual(["bad"]);
    expect(insertTargetQuarantined("T")).toBe(true);
    expect(w.notices).toEqual([]);
    expect(JSON.parse(readFileSync(w.insertPath, "utf8")).T.bad).toBeDefined();
    w.calls().persist = persist;
    await w.stop();
    expect(w.pushed).toEqual([]);
    expect(w.calls().slot("T", "X")).toBeUndefined();
    expect(w.notices).toHaveLength(1);
  });

  test("corrupt-return：回程视图和 TTL 扫描中触发坏账清理，旧快照不能复活被撤销的请求", () => {
    const w = world({ T: { bad: { env: env("bad", "X"), at: clock, reminded: 3 }, good } });
    w.add("T", "X", "bad"); w.add("T", "Y", "good");
    expect(w.calls().answerable("T", (r) => requestStillHeld(r, insertUnseenFrom("T")))).toBeUndefined();
    expect(w.calls().slot("T", "X")).toBeUndefined();
    writeFileSync(w.insertPath, JSON.stringify({ T: { bad: { env: null, at: clock }, good } }));
    openInsertBook(w.insertPath);
    w.add("T", "X", "bad");
    w.calls().add("T", { callerChannelId: "X", callerName: "X", targetName: "T", ts: clock - 100 }, "stale");
    w.calls().sweepStale(clock + 10, 50, (t) => insertUnseenFrom(t)); // bad 尚未过期，旧快照会把它写回
    expect(w.calls().slot("T", "X")).toBeUndefined();
    expect(w.calls().slot("T", "Y")?.messageIds).toEqual(["good"]);
  });

  test("corrupt-return：作废/确认销账入口碰到坏记录，同样先按外层 id 撤回程", async () => {
    const w = world({ T: { bad: { env: null, at: clock }, good } });
    w.add("T", "X", "bad"); w.add("T", "Y", "good");
    settleInsertReply("T", ["bad"]);
    w.reopen(); await w.stop();
    expect(w.pushed).toEqual([]);
    expect(w.calls().slot("T", "X")).toBeUndefined();
    expect(w.calls().slot("T", "Y")?.messageIds).toEqual(["good"]);
    expect(w.notices).toHaveLength(1);
  });
});
