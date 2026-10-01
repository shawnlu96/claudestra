/**
 * i28-S1 bridge 那一半：恢复后关卡只在正常结束的一轮、60 秒续跑统一计数（监护对象同一件活 3 次、落盘 / 其余照旧 1 次）、撞错记录只记监护对象、
 * 失败卡在上限前不推 owner、只关回合失败卡；以及 auto-tick 让开监护认领的那张卡。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardsToClose, failureCardQuiet, noteOverload, overloadEscalate, readOverload, type BridgeView } from "../src/lib/agent-supervisor-bridge.js";
import { heldObservation, supervisorHolds } from "../src/lib/agent-supervisor-hold.js";
import { recordSupervise, type SuperviseRecord } from "../src/lib/agent-supervisor-ledger.js";
import type { Supervised } from "../src/lib/agent-supervisor-scope.js";
import { openAsk } from "../src/lib/ledger-asks.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { settleStopTurn, type CallerSettleDeps, type StopTurn } from "../src/bridge/stop-settle.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

const CYBER = "This content was flagged for possible cybersecurity risk.";
const CONFIG: SchedulerConfig = { enabled: true, pollMs: 5000, autoDispatch: true, supervise: { enabled: true, stuckMin: 20 },
  projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/repo" } } };
const RV: Supervised = { agent: "agent-rv-t1", channelId: "ch-rv", sessionId: "s-rv", project: "p", runtime: "codex", transport: "acp",
  work: { kind: "order", taskId: "T1", intentId: "i-1", step: "review" } };

const view = (list: Supervised[], db: BridgeView["db"] = () => null): BridgeView => ({ config: () => CONFIG, supervised: () => list, db });

let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0)) c(); });

describe("恢复后关卡：只在 agent 自己正常结束的一轮", () => {
  let seq = 0;
  function settle() {
    const cid = `c-s1-${++seq}`;
    const book = new AgentCallBook(null);
    const recovered: string[] = [];
    const deps: CallerSettleDeps = {
      answerable: (c) => book.answerable(c, () => false), waiting: (c) => book.waiting(c, () => false), rearmResume: () => {},
      consume: (c, pac) => void book.consume(c, pac.callerChannelId, pac), pushBack: async () => {}, nudgeAmbiguous: () => {},
      takeApiErrorNotice: (c) => book.takeApiErrorNotice(c, () => false), markApiError: (c, t, caller) => book.markApiError(c, () => false, t, caller),
      clearWithheld: (c, pac) => book.clearWithheld(c, pac), notify: async () => {}, metric: () => {}, recovered: (c) => void recovered.push(c),
    };
    const stop = (t: Partial<StopTurn>) => settleStopTurn(deps, { cid, stopChannelId: cid, stopWs: 1, candidateWs: 1, event: "Stop", drain: { text: null }, ...t });
    return { cid, recovered, stop };
  }

  test("Stop 正常结束 → 关；StopFailure（Codex 回合失败）、API 错误、别人的频道、重复的 Stop → 不关", async () => {
    const h = settle();
    await h.stop({ event: "StopFailure", runtime: "codex" });
    await h.stop({ event: "Stop", drain: { text: null, apiError: true } });
    await h.stop({ event: "Stop", stopChannelId: "someone-else", stopWs: 2 });
    await h.stop({ event: "Stop", repeated: true });
    expect(h.recovered).toEqual([]);
    await h.stop({ event: "Stop", runtime: "codex" });
    expect(h.recovered).toEqual([h.cid]);
  });
});

describe("60 秒续跑统一计数", () => {
  const W = 10 * 60_000;
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), "s1-gr-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return join(dir, "ov.json");
  };

  test("不在监护名单：同改动前——续过、窗口内又撞就升级，其余续", () => {
    const path = tmp();
    expect(overloadEscalate("c-free", 1000, { resumedAt: 500 }, W, view([]), path)).toBe(true);
    expect(overloadEscalate("c-free", 1000, undefined, W, view([]), path)).toBe(false);
    expect(overloadEscalate("c-free", W + 1000, { resumedAt: 500 }, W, view([]), path)).toBe(false);
    expect(readOverload(path)).toEqual({});
  });

  test("监护对象：同一件活一共续 3 次；用完以后隔多久再撞、bridge 重启（内存清空）都还是升级", () => {
    const path = tmp();
    const v = view([{ ...RV, channelId: "c-sup" }]);
    expect(overloadEscalate("c-sup", 0, undefined, W, v, path)).toBe(false); // 第 1 次
    expect(overloadEscalate("c-sup", 1000, { resumedAt: undefined }, W, v, path)).toBe(false); // 还没续出去又撞：同一次
    expect(overloadEscalate("c-sup", 60_000, { resumedAt: 60_000 }, W, v, path)).toBe(false); // 第 2 次
    expect(overloadEscalate("c-sup", 120_000, { resumedAt: 119_000 }, W, v, path)).toBe(false); // 第 3 次
    const after = [1, 2, 3, 4, 5, 6].map((i) => overloadEscalate("c-sup", 120_000 + i * 60_000, i % 2 ? { resumedAt: 120_000 } : undefined, W, v, path));
    expect(after).toEqual([true, true, true, true, true, true]);
    expect(overloadEscalate("c-sup", 5 * 24 * 3600_000, undefined, W, v, path)).toBe(true); // 隔了几天、新进程
    expect(readOverload(path)["c-sup"].grant).toMatchObject({ key: "order:i-1@s-rv", used: 3 });
  });

  test("换了活（或换了会话）从头数", () => {
    const path = tmp();
    const v = view([{ ...RV, channelId: "c-sup" }]);
    for (let i = 0; i < 3; i++) overloadEscalate("c-sup", i * 1000, undefined, W, v, path);
    expect(overloadEscalate("c-sup", 9000, undefined, W, v, path)).toBe(true);
    const next = view([{ ...RV, channelId: "c-sup", work: { kind: "order", taskId: "T1", intentId: "i-2", step: "review" } }]);
    expect(overloadEscalate("c-sup", 10_000, undefined, W, next, path)).toBe(false);
    const swapped = view([{ ...RV, channelId: "c-sup", sessionId: "s-new", work: { kind: "order", taskId: "T1", intentId: "i-2", step: "review" } }]);
    expect(overloadEscalate("c-sup", 11_000, undefined, W, swapped, path)).toBe(false);
  });

  test("bridge 的文件丢了：按台账里这件活已记的续跑数", () => {
    const f = autoFixture();
    cleanup.push(() => f.close());
    const path = tmp();
    const v = view([{ ...RV, channelId: "c-sup" }], () => f.db);
    for (let i = 1; i <= 3; i++) {
      recordSupervise(f.db, { actor: "scheduler", now: Date.now() }, { agent: "agent-rv-t1", project: "p", target: "T1", sessionId: "s-rv", fault: "overload",
        faultKey: `overload:agent-rv-t1:${i}`, workKey: "order:i-1", step: "resume", phase: "done", result: "ok", attempt: i, limit: 3 });
    }
    expect(overloadEscalate("c-sup", Date.now(), undefined, W, v, path)).toBe(true);
  });

  test("记不住次数（写盘失败）：按改动前升级；名单读不出来：按不在名单", () => {
    const dir = mkdtempSync(join(tmpdir(), "s1-gr-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "blocker"), "x");
    expect(overloadEscalate("c-sup", 0, undefined, W, view([{ ...RV, channelId: "c-sup" }]), join(dir, "blocker", "ov.json"))).toBe(true);
    const broken: BridgeView = { config: () => CONFIG, db: () => null, supervised: () => { throw new Error("db locked"); } };
    expect(overloadEscalate("c-x", 1000, { resumedAt: 500 }, W, broken, join(dir, "ov.json"))).toBe(true);
    expect(overloadEscalate("c-x", 1000, undefined, W, broken, join(dir, "ov.json"))).toBe(false);
  });

  test("撞错记录只记监护对象，留给调度服务留痕", () => {
    const dir = mkdtempSync(join(tmpdir(), "s1-ov-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "ov.json");
    noteOverload("c-free", "agent-free", "500", "track", 1000, view([]), path);
    expect(readOverload(path)).toEqual({});
    noteOverload("ch-rv", "agent-rv-t1", "server_overloaded", "track", 1000, view([RV]), path);
    noteOverload("ch-rv", "agent-rv-t1", "server_overloaded", "escalate", 2000, view([RV]), path);
    expect(readOverload(path)["ch-rv"]).toEqual({ agent: "agent-rv-t1", events: [
      { at: 1000, error: "server_overloaded", act: "track" }, { at: 2000, error: "server_overloaded", act: "escalate" }] });
    overloadEscalate("ch-rv", 3000, undefined, 60_000, view([RV]), path);
    noteOverload("ch-rv", "agent-rv-t1", "server_overloaded", "track", 3000, view([RV]), path);
    expect(readOverload(path)["ch-rv"]).toMatchObject({ grant: { used: 1 }, events: [{ at: 1000 }, { at: 2000 }, { at: 3000 }] }); // 记撞错不冲掉次数
  });
});

describe("失败卡推不推 owner、恢复后关哪些", () => {
  const rec = (o: Partial<SuperviseRecord>): SuperviseRecord => ({ agent: "agent-rv-t1", project: "p", target: "T1", sessionId: "s-rv", fault: "cyber",
    faultKey: "ask_1", workKey: "order:i-1", step: "recover", phase: "claim", attempt: 1, limit: 1, ...o });

  test("监护对象的 cyber 截断在恢复次数用完前不推；用完了、不是 cyber、不在名单都照旧推", () => {
    const f = autoFixture();
    cleanup.push(() => f.close());
    const v = view([RV], () => f.db);
    expect(failureCardQuiet("agent-rv-t1", CYBER, Date.now(), v)).toBe(true);
    expect(failureCardQuiet("agent-rv-t1", "Context window exceeded", Date.now(), v)).toBe(false);
    expect(failureCardQuiet("agent-rv-t1", CYBER, Date.now(), view([], () => f.db))).toBe(false);
    recordSupervise(f.db, { actor: "scheduler", now: Date.now() }, rec({}));
    expect(failureCardQuiet("agent-rv-t1", CYBER, Date.now(), v)).toBe(false);
  });

  test("只关这个 agent 的回合失败卡；额度、登录、别人的卡不关；监护关着一张都不关", () => {
    const f = autoFixture();
    cleanup.push(() => f.close());
    const now = Date.now();
    const mine = openAsk(f.db, { project: "p", fromAgent: "agent-rv-t1", source: "codex", kind: "owner_action", title: "Codex 回合失败", extra: { failure: "error" } }, now - 10);
    openAsk(f.db, { project: "p", fromAgent: "agent-rv-t1", source: "codex", kind: "decide", title: "额度", extra: { quota: true } }, now - 10);
    openAsk(f.db, { project: "p", fromAgent: "agent-rv-t1", source: "codex", kind: "owner_action", title: "需要登录" }, now - 10);
    openAsk(f.db, { project: "p", fromAgent: "agent-other", source: "codex", kind: "owner_action", title: "Codex 回合失败", extra: { failure: "error" } }, now - 10);
    expect(cardsToClose(f.db, "agent-rv-t1", "p", now, CONFIG).map((a) => a.id)).toEqual([mine.id]);
    expect(cardsToClose(f.db, "agent-rv-t1", "p", now - 20, CONFIG)).toEqual([]); // 这一轮之后才开的不关
    expect(cardsToClose(f.db, "agent-rv-t1", "p", now, { ...CONFIG, supervise: { enabled: false, stuckMin: 20 } })).toEqual([]);
    expect(cardsToClose(f.db, "agent-rv-t1", "q", now, CONFIG)).toEqual([]);
    expect(cardsToClose(f.db, "agent-rv-t1", "p", now, null)).toEqual([]);
  });

  test("auto-tick 只让开监护认领了恢复、恢复消息没确定失败的那张回合失败卡", () => {
    const f = autoFixture();
    cleanup.push(() => f.close());
    const now = Date.now();
    const card = openAsk(f.db, { project: "p", fromAgent: "agent-rv-t1", source: "codex", kind: "owner_action", title: "Codex 回合失败", extra: { failure: "error" } }, now);
    expect(supervisorHolds(f.db, "agent-rv-t1")).toBe(false);
    recordSupervise(f.db, { actor: "scheduler", now: now + 1 }, rec({ faultKey: card.id, cardId: card.id }));
    expect(supervisorHolds(f.db, "agent-rv-t1")).toBe(true);
    recordSupervise(f.db, { actor: "scheduler", now: now + 2 }, rec({ faultKey: card.id, cardId: card.id, phase: "done", result: "failed" }));
    expect(supervisorHolds(f.db, "agent-rv-t1")).toBe(false);
  });

  test("heldObservation：只把回合失败（error）当成还在跑；额度 / 登录、交了结果的照原样", () => {
    const yes = () => true;
    expect(heldObservation({ state: "result", outcome: "failed", failure: { kind: "error", message: "x" } }, yes)).toEqual({ state: "running", busy: false });
    expect(heldObservation({ state: "unknown", reason: "r", failure: { kind: "error", message: "x" } }, yes)).toEqual({ state: "running", busy: false });
    const quota = { state: "result" as const, outcome: "failed" as const, failure: { kind: "quota" as const, message: "x" } };
    expect(heldObservation(quota, yes)).toBe(quota);
    const done = { state: "result" as const, outcome: "delivered" as const, eventSeq: 3 };
    expect(heldObservation(done, yes)).toBe(done);
    const err = { state: "result" as const, outcome: "failed" as const, failure: { kind: "error" as const, message: "x" } };
    expect(heldObservation(err, () => false)).toBe(err);
  });
});
