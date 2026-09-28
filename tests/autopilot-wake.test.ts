/** lib/autopilot-wake.ts：唤醒合并去重、领取、放回、收尾排下次、让位太久只记一次、落盘重载后不丢不重 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTOPILOT_TIMING as T, emptyEvidence } from "../src/lib/autopilot-run.js";
import {
  claimWake, decideFire, enqueueWake, finishRun, markDelivered, noteLongYield, releaseRateLimitHold, unclaimRun, type AutopilotFields,
} from "../src/lib/autopilot-wake.js";

const NOW = Date.parse("2026-09-28T11:00:00Z");
const GRACE = 45_000;

describe("enqueueWake：积压合并成一次", () => {
  test("三次回合结束 → 一条唤醒，序号取最新、firstAt 留最早、merged=2", () => {
    const m: AutopilotFields = {};
    enqueueWake(m, { source: "start", dueAt: NOW }, NOW);
    enqueueWake(m, { source: "turn_end", dueAt: NOW + GRACE }, NOW + 1000);
    const w = enqueueWake(m, { source: "turn_end", dueAt: NOW + 2000 + GRACE }, NOW + 2000);
    expect(w).toMatchObject({ seq: 3, source: "turn_end", merged: 2, firstAt: new Date(NOW).toISOString(), dueAt: new Date(NOW + 2000 + GRACE).toISOString() });
    expect(m.wakeSeq).toBe(3);
  });
  test("额度 / 失败退避不被人工回合结束提前", () => {
    const m: AutopilotFields = {};
    enqueueWake(m, { source: "turn_end", dueAt: NOW + 3_600_000, hold: "rate_limit" }, NOW);
    const w = enqueueWake(m, { source: "turn_end", dueAt: NOW + GRACE }, NOW + 5000);
    expect(w.dueAt).toBe(new Date(NOW + 3_600_000).toISOString());
    expect(w.hold).toBe("rate_limit");
    expect(w.merged).toBe(1);
  });
  test("等人拍板 / 待命被回合结束提前放行（有人答了、说话了）", () => {
    for (const hold of ["blocked", "standby"] as const) {
      const m: AutopilotFields = {};
      enqueueWake(m, { source: "turn_end", dueAt: NOW + 3_600_000, hold }, NOW);
      const w = enqueueWake(m, { source: "turn_end", dueAt: NOW + GRACE }, NOW + 5000);
      expect(w.dueAt).toBe(new Date(NOW + GRACE).toISOString());
      expect(w.hold).toBeUndefined();
    }
  });
});

describe("claimWake：同一个 agent 同时最多一个 run", () => {
  test("没到时间不领；领了之后 wake 变 run；有 run 时新触发只入队不领", () => {
    const m: AutopilotFields = {};
    enqueueWake(m, { source: "start", dueAt: NOW + 1000 }, NOW);
    expect(claimWake(m, NOW, "r1")).toBeNull();
    const r = claimWake(m, NOW + 1000, "r1")!;
    expect(r).toMatchObject({ runId: "r1", seq: 1, source: "start" });
    expect(m.wake).toBeUndefined();
    enqueueWake(m, { source: "turn_end", dueAt: NOW }, NOW + 2000);
    expect(claimWake(m, NOW + 5000, "r2")).toBeNull();
    expect(m.run?.runId).toBe("r1");
  });
  test("领到没递出去 → 原样放回（序号不变）；递出去了就不能放回", () => {
    const m: AutopilotFields = {};
    enqueueWake(m, { source: "start", dueAt: NOW }, NOW);
    claimWake(m, NOW, "r1");
    expect(unclaimRun(m, "r1", NOW, 60_000)).toBe(true);
    expect(m.run).toBeUndefined();
    expect(m.wake).toMatchObject({ seq: 1, source: "retry", dueAt: new Date(NOW + 60_000).toISOString() });
    claimWake(m, NOW + 60_000, "r2");
    markDelivered(m, "r2", NOW + 60_000);
    expect(unclaimRun(m, "r2", NOW + 60_000, 60_000)).toBe(false);
  });
});

describe("finishRun", () => {
  test("只认当前 runId：重复的 done、别的 runId 都不收；收尾按结果排下一次", () => {
    const m: AutopilotFields = {};
    enqueueWake(m, { source: "start", dueAt: NOW }, NOW);
    claimWake(m, NOW, "r1");
    expect(finishRun(m, "rX", "normal", emptyEvidence(), NOW, GRACE)).toBeNull();
    const f = finishRun(m, "r1", "blocked_approval", { ...emptyEvidence(), buttonsSent: 1 }, NOW + 60_000, GRACE)!;
    expect(f.outcome).toBe("blocked_approval");
    expect(m.run).toBeUndefined();
    expect(m.lastRun).toMatchObject({ runId: "r1", outcome: "blocked_approval" });
    expect(m.wake).toMatchObject({ hold: "blocked", dueAt: new Date(NOW + 60_000 + T.blockedMaxWaitMs).toISOString() });
    expect(finishRun(m, "r1", "normal", emptyEvidence(), NOW + 70_000, GRACE)).toBeNull();
  });
  test("streak 跨 run 累计：连续 3 轮空 normal 进待命", () => {
    const m: AutopilotFields = {};
    let t = NOW;
    let f;
    for (let i = 1; i <= 3; i++) {
      enqueueWake(m, { source: "turn_end", dueAt: t }, t);
      claimWake(m, t, `r${i}`);
      f = finishRun(m, `r${i}`, "normal", emptyEvidence(), (t += 10_000), GRACE)!;
    }
    expect(f!.streaks.idle).toBe(3);
    expect(m.wake?.hold).toBe("standby");
  });
});

describe("noteLongYield：让位太久记一次「未推进」", () => {
  test("从到期时刻算，挡在待命 / 额度里的时间不算：待命 60 分钟到点恰好让位，不会立刻记「排队 60 分钟」", () => {
    const m: AutopilotFields = {};
    enqueueWake(m, { source: "turn_end", dueAt: NOW + 3_600_000, hold: "standby" }, NOW);
    expect(noteLongYield(m, NOW + 3_600_000)).toBe(false);
    expect(noteLongYield(m, NOW + 3_600_000 + T.maxYieldDelayMs)).toBe(true);
  });
  test("不到上限不记；到了记一次；同一条唤醒不再记；新触发合并进来也不重复记", () => {
    const m: AutopilotFields = {};
    enqueueWake(m, { source: "turn_end", dueAt: NOW }, NOW);
    expect(noteLongYield(m, NOW + T.maxYieldDelayMs - 1)).toBe(false);
    expect(noteLongYield(m, NOW + T.maxYieldDelayMs)).toBe(true);
    expect(noteLongYield(m, NOW + T.maxYieldDelayMs + 60_000)).toBe(false);
    enqueueWake(m, { source: "turn_end", dueAt: NOW }, NOW + T.maxYieldDelayMs + 90_000);
    expect(noteLongYield(m, NOW + T.maxYieldDelayMs + 120_000)).toBe(false);
  });
});

describe("落盘 → 重新加载（模拟 bridge 重启）", () => {
  const roundTrip = (path: string, m: AutopilotFields): AutopilotFields => {
    writeFileSync(path, JSON.stringify({ a: m }));
    return (JSON.parse(readFileSync(path, "utf8")) as { a: AutopilotFields }).a;
  };
  test("没领的唤醒重启后还在、照常能领（不丢）", () => {
    const p = join(mkdtempSync(join(tmpdir(), "ap-wake-")), "missions.json");
    const m: AutopilotFields = {};
    enqueueWake(m, { source: "turn_end", dueAt: NOW + GRACE }, NOW);
    const back = roundTrip(p, m);
    expect(claimWake(back, NOW + GRACE, "r1")?.seq).toBe(1);
  });
  test("已领、已投递的 run 重启后不会再被领一次（不重）；它的 done 照样只收一次", () => {
    const p = join(mkdtempSync(join(tmpdir(), "ap-wake-")), "missions.json");
    const m: AutopilotFields = {};
    enqueueWake(m, { source: "turn_end", dueAt: NOW }, NOW);
    claimWake(m, NOW, "r1");
    markDelivered(m, "r1", NOW);
    const back = roundTrip(p, m);
    expect(claimWake(back, NOW + 3_600_000, "r2")).toBeNull();
    enqueueWake(back, { source: "turn_end", dueAt: NOW }, NOW + 1000); // 重启期间又来一次触发：排着，不领
    expect(claimWake(back, NOW + 3_600_000, "r2")).toBeNull();
    const f = finishRun(back, "r1", "normal", { ...emptyEvidence(), evidenceLost: true }, NOW + 120_000, GRACE);
    expect(f?.run.runId).toBe("r1");
    expect(finishRun(roundTrip(p, back), "r1", "normal", emptyEvidence(), NOW + 130_000, GRACE)).toBeNull();
  });
});

describe("decideFire：到点该做什么（都从落盘字段算，重启后照样接上）", () => {
  const idle = { turn: "idle" as const, tracked: true };
  test("刚开启没有 wake → 入队 start；wake 没到 → 等；到了 → 试着推进", () => {
    const m: AutopilotFields = {};
    expect(decideFire(m, NOW, idle)).toEqual({ kind: "enqueue_start", dueAt: NOW });
    enqueueWake(m, { source: "start", dueAt: NOW + 5000 }, NOW);
    expect(decideFire(m, NOW, idle)).toEqual({ kind: "wait", ms: 5000 });
    expect(decideFire(m, NOW + 5000, idle)).toEqual({ kind: "try" });
  });
  test("旧数据还在退避（resumeAt 在将来）→ 入队时照旧等到那时", () => {
    expect(decideFire({ resumeAt: new Date(NOW + 600_000).toISOString() } as AutopilotFields, NOW, idle)).toEqual({ kind: "enqueue_start", dueAt: NOW + 600_000 });
    expect(decideFire({ resumeAt: new Date(NOW - 1).toISOString() } as AutopilotFields, NOW, idle)).toEqual({ kind: "enqueue_start", dueAt: NOW });
  });
  test("领了没投递：短时间内等（投递可能在路上），超时放回；本进程知道递出去了 → 补标，绝不放回", () => {
    const m: AutopilotFields = {};
    enqueueWake(m, { source: "start", dueAt: NOW }, NOW);
    claimWake(m, NOW, "r1");
    expect(decideFire(m, NOW + 1000, idle).kind).toBe("wait");
    expect(decideFire(m, NOW + T.claimStaleMs, idle)).toEqual({ kind: "unclaim" });
    expect(decideFire(m, NOW + T.claimStaleMs, { ...idle, deliveredHere: true })).toEqual({ kind: "mark_delivered" });
  });
  test("已投递：忙就等；重启过（没在记账）且空闲 → 证据不全收尾；太久没等到结束 → 失败收尾", () => {
    const m: AutopilotFields = {};
    enqueueWake(m, { source: "start", dueAt: NOW }, NOW);
    claimWake(m, NOW, "r1");
    markDelivered(m, "r1", NOW);
    expect(decideFire(m, NOW + 60_000, { turn: "busy", tracked: false }).kind).toBe("wait");
    expect(decideFire(m, NOW + 60_000, { turn: "idle", tracked: false })).toEqual({ kind: "close", lost: true });
    expect(decideFire(m, NOW + 60_000, idle)).toEqual({ kind: "wait", ms: T.runStaleMs - 60_000 });
    expect(decideFire(m, NOW + T.runStaleMs, idle)).toMatchObject({ kind: "close", lost: false, failure: expect.stringContaining("没等到回合结束") });
  });
  test("重启后忙闲未知（Codex / Pi 没有事件态）→ 不直接收尾，等到 runStaleMs 再按证据不全收", () => {
    const m: AutopilotFields = {};
    enqueueWake(m, { source: "start", dueAt: NOW }, NOW);
    claimWake(m, NOW, "r1");
    markDelivered(m, "r1", NOW);
    expect(decideFire(m, NOW + 60_000, { turn: "unknown", tracked: false })).toEqual({ kind: "wait", ms: T.runStaleMs - 60_000 });
    expect(decideFire(m, NOW + T.runStaleMs, { turn: "unknown", tracked: false })).toEqual({ kind: "close", lost: true });
  });
});

describe("releaseRateLimitHold：额度闸出闸", () => {
  test("等额度的唤醒马上放行；别的 hold 不动", () => {
    const m: AutopilotFields = {};
    enqueueWake(m, { source: "turn_end", dueAt: NOW + 30 * 3_600_000, hold: "rate_limit" }, NOW);
    expect(releaseRateLimitHold(m, NOW + 60_000)).toBe(true);
    expect(m.wake!.hold).toBeUndefined();
    expect(m.wake!.dueAt).toBe(new Date(NOW + 60_000).toISOString());
    expect(claimWake(m, NOW + 60_000, "run_x")).not.toBeNull();
    const other: AutopilotFields = {};
    enqueueWake(other, { source: "turn_end", dueAt: NOW + 900_000, hold: "failed" }, NOW);
    expect(releaseRateLimitHold(other, NOW)).toBe(false);
    expect(other.wake!.hold).toBe("failed");
  });
});
