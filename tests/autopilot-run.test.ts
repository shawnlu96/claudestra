/** lib/autopilot-run.ts：五类结果归类、下次醒来、让位、额度重置时间（CC / Codex 两种写法） */
import { describe, expect, test } from "bun:test";
import {
  AUTOPILOT_TIMING as T, classifyRun, emptyEvidence, nextStreaks, nextWake, parseResetAt, yieldReason, type RunEvidence,
} from "../src/lib/autopilot-run.js";

const ev = (over: Partial<RunEvidence> = {}): RunEvidence => ({ ...emptyEvidence(), ...over });
const GRACE = 45_000;
const NOW = Date.parse("2026-09-28T11:00:00Z"); // 东京 20:00、上海 19:00

describe("classifyRun：五类各一条", () => {
  test("normal：只看了看", () => {
    expect(classifyRun(ev({ tools: 2 })).outcome).toBe("normal");
    expect(classifyRun(ev()).reason).toBe("没调工具");
  });
  test("action_taken：调了可能改东西的工具", () => {
    expect(classifyRun(ev({ tools: 5, mutating: 2 })).outcome).toBe("action_taken");
  });
  test("blocked_approval：本轮发了按钮且没干别的 / 回合停在没答的提问上", () => {
    expect(classifyRun(ev({ buttonsSent: 1 })).outcome).toBe("blocked_approval");
    expect(classifyRun(ev({ questionOpen: true, mutating: 3 })).outcome).toBe("blocked_approval");
  });
  test("发了按钮但也干了别的活 → action_taken（照提醒说的「记下来先跳过」接着干了）", () => {
    expect(classifyRun(ev({ buttonsSent: 1, tools: 4, mutating: 2 })).outcome).toBe("action_taken");
  });
  test("rate_limited：撞额度优先于一切", () => {
    const r = classifyRun(ev({ rateLimitText: "You've hit your limit · resets 2am (Asia/Shanghai)", mutating: 3, failure: "x" }));
    expect(r.outcome).toBe("rate_limited");
    expect(r.reason).toContain("resets 2am");
  });
  test("failed：API 报错 / bridge 判的失败", () => {
    expect(classifyRun(ev({ failure: "API 报错：overloaded", mutating: 1 })).outcome).toBe("failed");
  });
});

describe("nextWake：结果决定下次什么时候醒", () => {
  const s0 = { idle: 0, fail: 0 };
  test("很短的正常一轮不被当成空转：干了活的短轮次永不退避；没进展的一两轮也照常接着推", () => {
    let s = s0;
    for (let i = 0; i < 6; i++) s = nextStreaks(s, "action_taken", ev({ tools: 1, mutating: 1 }));
    expect(nextWake("action_taken", s, ev({ mutating: 1 }), NOW, GRACE).delayMs).toBe(GRACE);
    s = nextStreaks(s, "normal", ev({ tools: 1 }));
    s = nextStreaks(s, "normal", ev({ tools: 1 }));
    expect(nextWake("normal", s, ev({ tools: 1 }), NOW, GRACE)).toEqual({ delayMs: GRACE, why: "正常一轮，接着推" });
  });
  test("每轮都只读查看（等 CI / 等 peer）：连续 3 轮就待命，不会每 45 秒推一次推到截止", () => {
    let s = s0;
    for (let i = 0; i < 3; i++) s = nextStreaks(s, "normal", ev({ tools: 2 }));
    expect(nextWake("normal", s, ev({ tools: 2 }), NOW, GRACE)).toMatchObject({ delayMs: T.standbyStepsMs[0], hold: "standby" });
  });
  test("证据丢了的一轮不计入待命 / 失败计数", () => {
    expect(nextStreaks({ idle: 2, fail: 1 }, "normal", ev({ evidenceLost: true }))).toEqual({ idle: 2, fail: 1 });
  });
  test("action_taken 接着推", () => {
    expect(nextWake("action_taken", s0, ev({ mutating: 1 }), NOW, GRACE).delayMs).toBe(GRACE);
  });
  test("连续 3 轮 normal 才待命：5 → 15 → 30 → 60 封顶；干一次活就清零", () => {
    let s = s0;
    const got: number[] = [];
    for (let i = 0; i < 7; i++) {
      s = nextStreaks(s, "normal", ev());
      got.push(nextWake("normal", s, ev(), NOW, GRACE).delayMs);
    }
    expect(got).toEqual([GRACE, GRACE, ...T.standbyStepsMs, T.standbyStepsMs[3]]);
    expect(nextWake("normal", { idle: 3, fail: 0 }, ev(), NOW, GRACE).hold).toBe("standby");
    expect(nextStreaks(s, "action_taken", ev({ mutating: 1 })).idle).toBe(0);
  });
  test("撞额度：按重置时间 + 2 分钟醒；解析不出退回 30 分钟；和待命计数无关", () => {
    const w = nextWake("rate_limited", s0, ev({ rateLimitText: "You've hit your limit · resets 2am (Asia/Shanghai)" }), NOW, GRACE);
    expect(w.hold).toBe("rate_limit");
    expect(w.delayMs).toBe(Date.parse("2026-09-28T18:00:00Z") - NOW + T.rateLimitSlackMs);
    expect(nextWake("rate_limited", s0, ev({ rateLimitText: "You've hit your usage limit" }), NOW, GRACE).delayMs).toBe(T.rateLimitFallbackMs);
    expect(nextStreaks({ idle: 2, fail: 2 }, "rate_limited", ev())).toEqual({ idle: 0, fail: 0 });
  });
  test("在等人拍板：hold=blocked，最多等 60 分钟", () => {
    expect(nextWake("blocked_approval", s0, ev({ buttonsSent: 1 }), NOW, GRACE)).toMatchObject({ delayMs: T.blockedMaxWaitMs, hold: "blocked" });
  });
  test("失败：1 → 5 → 15 分钟，再往后每小时", () => {
    let s = s0;
    const got: number[] = [];
    for (let i = 0; i < 5; i++) {
      s = nextStreaks(s, "failed", ev({ failure: "x" }));
      got.push(nextWake("failed", s, ev({ failure: "x" }), NOW, GRACE).delayMs);
    }
    expect(got).toEqual([...T.failStepsMs, T.failSteadyMs, T.failSteadyMs]);
  });
});

describe("yieldReason：人优先", () => {
  test("不在线 / 主回合在跑 / 人刚说过话都让位；安静够久才推进", () => {
    expect(yieldReason({ online: false, turnBusy: false }, NOW)).toBe("agent_offline");
    expect(yieldReason({ online: true, turnBusy: true }, NOW)).toBe("turn_busy");
    expect(yieldReason({ online: true, turnBusy: false, lastHumanAt: NOW - 30_000 }, NOW)).toBe("human_recent");
    expect(yieldReason({ online: true, turnBusy: false, lastHumanAt: NOW - T.humanQuietMs }, NOW)).toBeNull();
    expect(yieldReason({ online: true, turnBusy: false }, NOW)).toBeNull();
  });
  test("人叫停了（之后没再说别的）→ 不推进，哪怕已经安静很久；打断收尾提醒还没投 → 先等它（T13a）", () => {
    expect(yieldReason({ online: true, turnBusy: false, interruptHold: "stopped" }, NOW)).toBe("human_stopped");
    expect(yieldReason({ online: true, turnBusy: false, lastHumanAt: NOW - T.humanQuietMs * 10, interruptHold: "stopped" }, NOW)).toBe("human_stopped");
    expect(yieldReason({ online: true, turnBusy: false, interruptHold: "notice" }, NOW)).toBe("cut_notice");
    expect(yieldReason({ online: true, turnBusy: false, interruptHold: null }, NOW)).toBeNull();
  });
});

describe("parseResetAt", () => {
  test("CC：只有时刻 + 时区，今天已过就算明天", () => {
    expect(parseResetAt("You've hit your limit · resets 2am (Asia/Shanghai)", NOW)).toBe(Date.parse("2026-09-28T18:00:00Z"));
    expect(parseResetAt("resets 4:40pm (Asia/Tokyo)", NOW)).toBe(Date.parse("2026-09-29T07:40:00Z"));
    expect(parseResetAt("resets 9:30pm (Asia/Tokyo)", NOW)).toBe(Date.parse("2026-09-28T12:30:00Z"));
  });
  test("CC：带月日（周额度）", () => {
    expect(parseResetAt("You've hit your weekly limit · resets Oct 3, 2am (Asia/Tokyo)", NOW)).toBe(Date.parse("2026-10-02T17:00:00Z"));
  });
  test("CC：时区名认不出按本机时区算，不抛", () => {
    const got = parseResetAt("resets 2am (Mars/Base)", NOW);
    expect(got).not.toBeNull();
    expect(new Date(got!).getHours()).toBe(2);
  });
  test("Codex：try again at（本机时区），带或不带日期", () => {
    const at = parseResetAt("You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again at 8:41 AM.", NOW)!;
    expect(new Date(at).getHours()).toBe(8);
    expect(new Date(at).getMinutes()).toBe(41);
    expect(at).toBeGreaterThan(NOW);
    expect(at - NOW).toBeLessThanOrEqual(86_400_000);
    expect(parseResetAt("or try again at Sep 30th, 2026 8:41 PM.", NOW)).toBe(new Date(2026, 8, 30, 20, 41).getTime());
  });
  test("Codex：try again in N hours M minutes", () => {
    expect(parseResetAt("try again in 2 hours 13 minutes.", NOW)).toBe(NOW + (2 * 60 + 13) * 60_000);
    expect(parseResetAt("try again in 1 day and 3 hours", NOW)).toBe(NOW + 27 * 3_600_000);
  });
  test("收尾晚了几分钟：按看到那句话的时刻解析（rateLimitAt），不会滚到明天", () => {
    const seen = Date.parse("2026-09-27T17:59:00Z"); // 上海 01:59 看到「resets 2am」
    const closeAt = Date.parse("2026-09-27T18:05:00Z"); // 02:05 才收尾
    const w = nextWake("rate_limited", { idle: 0, fail: 0 }, ev({ rateLimitText: "resets 2am (Asia/Shanghai)", rateLimitAt: seen }), closeAt, GRACE);
    expect(w.delayMs).toBe(T.rateLimitSlackMs);
  });
  test("12am / 12pm、跨年的周额度", () => {
    const now = Date.parse("2026-09-28T12:00:00Z"); // 上海 20:00
    expect(parseResetAt("resets 12am (Asia/Shanghai)", now)).toBe(Date.parse("2026-09-28T16:00:00Z"));
    expect(parseResetAt("resets 12pm (Asia/Shanghai)", now)).toBe(Date.parse("2026-09-29T04:00:00Z"));
    expect(parseResetAt("resets Jan 2, 9am (Asia/Shanghai)", Date.parse("2026-12-31T02:00:00Z"))).toBe(Date.parse("2027-01-02T01:00:00Z"));
  });
  test("新版 CC 的 session / weekly limit 文案照样解析", () => {
    expect(parseResetAt("You've hit your session limit · resets 4:30pm (Asia/Tokyo)", Date.parse("2026-09-28T03:00:00Z"))).toBe(Date.parse("2026-09-28T07:30:00Z"));
  });
  test("认不出 / 太远 → null", () => {
    expect(parseResetAt("You've hit your usage limit", NOW)).toBeNull();
    expect(parseResetAt("try again in a moment", NOW)).toBeNull();
    expect(parseResetAt("try again at Jan 5th, 2027 8:41 AM", NOW)).toBeNull();
  });
});
