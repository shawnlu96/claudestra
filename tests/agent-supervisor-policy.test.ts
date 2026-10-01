/** i28-S1 处置表：每类故障的处置、次数上限、退避逐行钉住；两次观察判死 / 判卡住；心跳读法。 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CYBER_RECOVERY_TEXT, decide, HOUR_MS, isCyberPolicy, reportText, restartNudgeText, SUPERVISE_RULES, workKeyOf } from "../src/lib/agent-supervisor-policy.js";
import { TwoStrikes } from "../src/lib/agent-supervisor-judge.js";
import { readActivity, stuckSince, type ActivityRecord } from "../src/lib/agent-supervisor-activity.js";
import { MISS_GAP_MS } from "../src/lib/lend-health.js";

const MIN = 60_000;

describe("处置表", () => {
  test("表的每一行：处置、上限、计数范围", () => {
    expect(SUPERVISE_RULES.overload).toMatchObject({ action: "resume", limit: 3, scope: "work" });
    expect(SUPERVISE_RULES.cyber).toMatchObject({ action: "recover", limit: 1, scope: "work", advice: "改 Claude 同家审、标待换模型终审" });
    expect(SUPERVISE_RULES.dead).toMatchObject({ action: "restart", limit: 2, scope: "hour" });
    expect(SUPERVISE_RULES.stuck).toMatchObject({ action: "restart", limit: 2, scope: "hour" });
    expect(SUPERVISE_RULES.quota).toMatchObject({ action: "report", limit: 0 });
    expect(SUPERVISE_RULES.auth).toMatchObject({ action: "report", limit: 0 });
  });

  test("cyber：第一次发恢复消息，同一件活第二次报派活方并带建议", () => {
    expect(decide("cyber", [], 1000, 1000)).toEqual({ kind: "act", action: "recover", attempt: 1, limit: 1 });
    expect(decide("cyber", [1000], 5000, 5000)).toEqual({ kind: "report", attempts: 1, limit: 1, advice: "改 Claude 同家审、标待换模型终审" });
  });

  test("重启：每小时 2 次，第二次距第一次至少 5 分钟；一小时前的不算", () => {
    const t0 = 10 * HOUR_MS;
    expect(decide("dead", [], t0, t0)).toMatchObject({ kind: "act", action: "restart", attempt: 1 });
    expect(decide("dead", [t0], t0 + MIN, t0 + MIN)).toEqual({ kind: "wait", untilMs: t0 + 5 * MIN, attempt: 2 });
    expect(decide("stuck", [t0], t0 + 6 * MIN, t0 + 6 * MIN)).toMatchObject({ kind: "act", attempt: 2, limit: 2 });
    expect(decide("dead", [t0, t0 + 6 * MIN], t0 + 7 * MIN, t0 + 7 * MIN)).toMatchObject({ kind: "report", attempts: 2, limit: 2 });
    expect(decide("dead", [t0, t0 + 6 * MIN], t0 + HOUR_MS + 7 * MIN, t0 + HOUR_MS + 7 * MIN)).toMatchObject({ kind: "act", attempt: 1 });
  });

  test("满载：同一件活 3 次，每次等 60 秒（= bridge 的 60 秒续跑）", () => {
    expect(decide("overload", [], 0, 30_000)).toEqual({ kind: "wait", untilMs: 60_000, attempt: 1 });
    expect(decide("overload", [60_000], 60_000, 100_000)).toEqual({ kind: "wait", untilMs: 120_000, attempt: 2 });
    expect(decide("overload", [1, 2, 3], 4, 10 * MIN)).toMatchObject({ kind: "report", attempts: 3, limit: 3 });
  });

  test("额度 / 登录：从不自动处置，直接报", () => {
    expect(decide("quota", [], 0, 0)).toMatchObject({ kind: "report", limit: 0 });
    expect(decide("auth", [], 0, 0)).toMatchObject({ kind: "report", limit: 0 });
  });

  test("cyber_policy 只认 OpenAI 那句原文（适配器把它当标题给）", () => {
    expect(isCyberPolicy("This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing")).toBe(true);
    expect(isCyberPolicy("codex_error_info=cyber_policy")).toBe(true);
    expect(isCyberPolicy("Context window exceeded")).toBe(false);
    expect(isCyberPolicy("bad request")).toBe(false);
  });

  test("恢复消息是规格里的固定模板；重启后的补发只提醒、不重发原单", () => {
    expect(CYBER_RECOVERY_TEXT).toStartWith("上一回合被内容策略截断，不是你的问题。");
    expect(CYBER_RECOVERY_TEXT).toEndWith("然后照原单收尾。");
    const order = restartNudgeText({ kind: "order", taskId: "T1", intentId: "i1", step: "review" }, "dead");
    expect(order).toContain("T1 的 review");
    expect(order).toContain("已经交付过的不要再交一次");
    expect(restartNudgeText({ kind: "call", caller: "agent-a", callerChannelId: "c", since: 1 }, "stuck")).toContain("agent-a 还在等你的答复");
  });

  test("报派活方的那一句带次数和建议", () => {
    const w = { kind: "order" as const, taskId: "T1", intentId: "i1", step: "review" };
    expect(reportText("agent-rv", w, "cyber", { attempts: 1, limit: 1, advice: "改 Claude 同家审" })).toContain("自动处置已做 1/1 次，没恢复；建议：改 Claude 同家审");
    expect(workKeyOf(w)).toBe("order:i1");
    expect(workKeyOf({ kind: "call", caller: "a", callerChannelId: "c1", since: 9 })).toBe("call:c1:9");
  });
});

describe("两次观察（规则同 R5a）", () => {
  const id = { agent: "agent-a", sessionId: "s1", workKey: "order:i1" };
  const gone = { liveness: "no_window" as const, stuckSince: null };

  test("一次否定不算；隔 ≥ MISS_GAP_MS 同一身份同一种再否定才确认，确认后从头数", () => {
    const j = new TwoStrikes();
    expect(j.note(id, gone, 1000)).toBeNull();
    expect(j.note(id, gone, 1000 + MISS_GAP_MS - 1)).toBeNull();
    expect(j.note(id, gone, 1000 + MISS_GAP_MS)).toBe("no_window");
    expect(j.note(id, gone, 1000 + 2 * MISS_GAP_MS)).toBeNull();
  });

  test("running / unknown 清零；身份变了（换会话、换了活）按第一次算", () => {
    const j = new TwoStrikes();
    j.note(id, gone, 0);
    expect(j.note(id, { liveness: "unknown", stuckSince: null }, MISS_GAP_MS)).toBeNull();
    expect(j.note(id, gone, 2 * MISS_GAP_MS)).toBeNull();
    expect(j.note({ ...id, sessionId: "s2" }, gone, 3 * MISS_GAP_MS)).toBeNull();
    expect(j.note({ ...id, sessionId: "s2", workKey: "order:i2" }, gone, 4 * MISS_GAP_MS)).toBeNull();
    expect(j.note({ ...id, sessionId: "s2", workKey: "order:i2" }, gone, 5 * MISS_GAP_MS)).toBe("no_window");
  });

  test("卡住：两次看到的「最近一次动静」必须是同一个时刻；中间来过 update 就清零", () => {
    const j = new TwoStrikes();
    expect(j.note(id, { liveness: "running", stuckSince: 100 }, 0)).toBeNull();
    expect(j.note(id, { liveness: "running", stuckSince: 200 }, MISS_GAP_MS)).toBeNull(); // 中间有过动静
    expect(j.note(id, { liveness: "running", stuckSince: 200 }, 2 * MISS_GAP_MS)).toBe("stuck");
  });

  test("宿主没了优先于卡住；no_window 与 no_host 不互相凑成两次", () => {
    const j = new TwoStrikes();
    j.note(id, { liveness: "no_host", stuckSince: 5 }, 0);
    expect(j.note(id, gone, MISS_GAP_MS)).toBeNull();
    expect(j.note(id, gone, 2 * MISS_GAP_MS)).toBe("no_window");
  });

  test("不在名单里的丢掉旧否定", () => {
    const j = new TwoStrikes();
    j.note(id, gone, 0);
    j.keepOnly(new Set());
    expect(j.note(id, gone, MISS_GAP_MS)).toBeNull();
  });
});

describe("心跳（S1b 接入前没有文件 = 不判卡住）", () => {
  const rec = (o: Partial<ActivityRecord>): ActivityRecord => ({ v: 1, agent: "a", sessionId: "s1", hostPid: 1, busy: true, turnAt: 0, updateAt: 0, writtenAt: 0, ...o });

  test("回合在跑且超过阈值没动静才给最近一次动静的时刻", () => {
    expect(stuckSince(rec({ updateAt: 1000 }), "s1", 1000 + 20 * MIN, 20 * MIN)).toBe(1000);
    expect(stuckSince(rec({ updateAt: 1000 }), "s1", 1000 + 20 * MIN - 1, 20 * MIN)).toBeNull();
    expect(stuckSince(rec({ busy: false }), "s1", 99 * MIN, 20 * MIN)).toBeNull();
    expect(stuckSince(rec({}), "s-other", 99 * MIN, 20 * MIN)).toBeNull();
    expect(stuckSince(null, "s1", 99 * MIN, 20 * MIN)).toBeNull();
  });

  test("读：文件没有、坏了、名字带路径分隔都给 null", () => {
    const dir = mkdtempSync(join(tmpdir(), "s1-act-"));
    try {
      expect(readActivity("agent-a", dir)).toBeNull();
      writeFileSync(join(dir, "agent-a.json"), "{bad");
      expect(readActivity("agent-a", dir)).toBeNull();
      writeFileSync(join(dir, "agent-a.json"), JSON.stringify(rec({ agent: "agent-a" })));
      expect(readActivity("agent-a", dir)?.sessionId).toBe("s1");
      expect(readActivity("../x", dir)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
