import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTIVITY_GRACE_MS, loadResumeStates, STALE_RESUME_MS, STREAK_IDLE_MS, RESUME_DELAY_MS, saveResumeStates, RESUME_WINDOW_MS, dueForResume, giveUpText, markResumed, noteActivity, noteApiError, noteTurnOk,
  dropStale, resumeDelayMs, SAVE_ERROR_LOG_GAP_MS, resumeText, type ApiErrorState,
} from "../src/lib/api-error-resume.js";
import { TRANSIENT_BACKOFF_MS } from "../src/lib/transient-error.js";

const T0 = 1_000_000;
const NET = "Pi 回合失败：Connection error.";

/** 假时钟：撞错 → 等到点 → 续跑 → 续跑后立刻又撞（断网还没恢复），返回每次续跑的等待时长和最后的结果 */
function outage(m: Map<string, ApiErrorState>, cid: string, failures: number, start = T0) {
  let now = start;
  const waits: number[] = [];
  let last: "track" | "escalate" = "track";
  for (let i = 0; i < failures; i++) {
    last = noteApiError(m, cid, NET, now);
    if (last === "escalate") break;
    let wait = 0;
    while (!dueForResume(m, now + wait).includes(cid)) wait += 1_000;
    waits.push(wait);
    now += wait;
    markResumed(m, cid, now);
    now += 5_000; // 续跑开始跑，几秒后又撞
  }
  return { waits, last, now };
}

describe("网络类错误：静默退避续跑", () => {
  test("退避 1、2、4、8 分钟续 4 次，第 5 次再撞才升级", () => {
    const m = new Map<string, ApiErrorState>();
    const r = outage(m, "c1", 5);
    expect(r.waits).toEqual([...TRANSIENT_BACKOFF_MS]);
    expect(r.last).toBe("escalate");
    expect(m.has("c1")).toBe(false);
  });

  test("预算用完只报一次：升级后记录删掉，下一次撞错是新的一串、从 1 分钟重新退避", () => {
    const m = new Map<string, ApiErrorState>();
    const r = outage(m, "c1", 5);
    expect(noteApiError(m, "c1", NET, r.now + 1_000)).toBe("track");
    expect(resumeDelayMs(m.get("c1")!)).toBe(TRANSIENT_BACKOFF_MS[0]);
  });

  test("续跑后正常结束一个回合 = 清零；结束时刻早于续跑的不算", () => {
    const m = new Map<string, ApiErrorState>();
    const r = outage(m, "c1", 3); // 续了 3 次，第 3 次续跑后网络恢复
    noteTurnOk(m, "c1", r.now - 10_000); // 续跑前那一轮的 Stop：不算恢复
    expect(m.get("c1")?.net?.n).toBe(3);
    noteTurnOk(m, "c1", r.now);
    expect(m.has("c1")).toBe(false);
    expect(noteApiError(m, "c1", NET, r.now + 60_000)).toBe("track");
    expect(m.get("c1")?.net).toMatchObject({ n: 0, since: r.now + 60_000 });
  });

  test("续跑后隔了 10 分钟以上才又撞（黑洞式断网）：仍是同一串，接着数；1 小时既没撞也没正常结束才丢", () => {
    const m = new Map<string, ApiErrorState>();
    const r = outage(m, "c1", 2);
    dueForResume(m, r.now + RESUME_WINDOW_MS);
    expect(noteApiError(m, "c1", NET, r.now + RESUME_WINDOW_MS + 60_000)).toBe("track");
    expect(m.get("c1")?.net?.n).toBe(2);
    markResumed(m, "c1", r.now + RESUME_WINDOW_MS + 5 * 60_000);
    dueForResume(m, r.now + RESUME_WINDOW_MS + 5 * 60_000 + STREAK_IDLE_MS);
    expect(m.has("c1")).toBe(false);
  });

  test("续跑还没发出去又撞：同一次，不多算次数、重新计时", () => {
    const m = new Map<string, ApiErrorState>();
    noteApiError(m, "c1", NET, T0);
    expect(noteApiError(m, "c1", "Pi 回合失败：terminated", T0 + 30_000)).toBe("track");
    expect(m.get("c1")).toMatchObject({ errorAt: T0 + 30_000, net: { n: 0, since: T0, last: "Pi 回合失败：terminated" } });
    expect(dueForResume(m, T0 + 60_000)).toEqual([]);
    expect(dueForResume(m, T0 + 90_000)).toEqual(["c1"]);
  });

  test("错误后它自己动了：照旧取消这次续跑", () => {
    const m = new Map<string, ApiErrorState>();
    noteApiError(m, "c1", NET, T0);
    expect(noteActivity(m, "c1", T0 + ACTIVITY_GRACE_MS + 1)).toBeDefined();
    expect(m.has("c1")).toBe(false);
  });

  test("CC 的错误码 + 原文：按原文判网络类", () => {
    const m = new Map<string, ApiErrorState>();
    expect(noteApiError(m, "c1", "unknown", T0, "API Error: Unable to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)")).toBe("track");
    expect(m.get("c1")?.net?.last).toBe("API Error: Unable to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)");
  });

  test("续跑文案按实际等待写", () => {
    expect(resumeText(NET, T0, TRANSIENT_BACKOFF_MS[2])).toContain("之后 4 分钟没有新活动");
    expect(resumeText(NET, T0)).toContain("之后 60 秒没有新活动");
  });

  test("升级那句：连续几次、从几点开始、最后一次原文", () => {
    const m = new Map<string, ApiErrorState>();
    outage(m, "c1", 4);
    const before = m.get("c1");
    const why = giveUpText(before, "server_error", "API Error: Connection dropped (ECONNRESET)\n后面的行");
    const hhmm = new Date(T0).toTimeString().slice(0, 5);
    expect(why).toContain(`连续 5 次网络类错误（${hhmm} 起，自动续跑 4 次已用完`);
    expect(why).toContain("最后一次：Connection dropped (ECONNRESET)。需要人看");
  });
});

describe("非网络类错误：照旧 60 秒续一次、再撞立即升级", () => {
  test("Prompt is too long / 额度 / 登录失效都不走退避", () => {
    for (const [code, text] of [
      ["invalid_request", "Prompt is too long"],
      ["authentication_failed", "Please run /login · API Error: 401 OAuth access token has expired."],
      ["invalid_request", "API Error: Opus 5's safeguards flagged this message (https://www.anthropic.com/legal/aup)."],
    ]) {
      const m = new Map<string, ApiErrorState>();
      expect(noteApiError(m, "c1", code, T0, text)).toBe("track");
      expect(m.get("c1")?.net).toBeUndefined();
      expect(resumeDelayMs(m.get("c1")!)).toBe(RESUME_DELAY_MS);
      markResumed(m, "c1", T0 + RESUME_DELAY_MS);
      expect(noteApiError(m, "c1", code, T0 + RESUME_DELAY_MS + 30_000, text)).toBe("escalate");
      expect(giveUpText(undefined, code, text)).toContain("连续两次因 API 错误中断");
    }
  });

  test("网络类连败中间撞了非网络类错误：按老规矩，续过、窗口内又撞就升级", () => {
    const m = new Map<string, ApiErrorState>();
    const r = outage(m, "c1", 1);
    expect(noteApiError(m, "c1", "invalid_request", r.now, "Prompt is too long")).toBe("escalate");
  });
});

describe("退避中 bridge 重启：计划落盘，读回来到点照续、接着数", () => {
  test("第 2 次撞错后的 2 分钟等待里重启：到点仍续跑，断网不恢复照样走到第 5 次才报", () => {
    const dir = mkdtempSync(join(tmpdir(), "nrt1-restart-"));
    const path = join(dir, "api-error-resume.json");
    try {
      const before = new Map<string, ApiErrorState>();
      const r = outage(before, "c1", 1);
      expect(noteApiError(before, "c1", NET, r.now)).toBe("track"); // 第 2 次撞：进 2 分钟等待，这时重启
      saveResumeStates(before, path);
      const after = loadResumeStates(path);
      expect(after.get("c1")?.net).toMatchObject({ n: 1, since: T0 });
      expect(dueForResume(after, r.now + TRANSIENT_BACKOFF_MS[1] - 1_000)).toEqual([]);
      expect(dueForResume(after, r.now + TRANSIENT_BACKOFF_MS[1])).toEqual(["c1"]);
      markResumed(after, "c1", r.now + TRANSIENT_BACKOFF_MS[1]);
      saveResumeStates(after, path);
      const rest = outage(loadResumeStates(path), "c1", 3, r.now + TRANSIENT_BACKOFF_MS[1] + 5_000); // 再重启一次，接着撞
      expect(rest.waits).toEqual(TRANSIENT_BACKOFF_MS.slice(2));
      expect(rest.last).toBe("escalate");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restart-drops-final-retry：第 4 次续跑发出后重启，读回 n=4 不当坏数据，下一次撞错照样升级（不重开 4 次预算）", () => {
    const dir = mkdtempSync(join(tmpdir(), "nrt1-n4-"));
    const path = join(dir, "api-error-resume.json");
    try {
      const before = new Map<string, ApiErrorState>();
      const r = outage(before, "c1", TRANSIENT_BACKOFF_MS.length); // 撞 4 次、续 4 次
      expect(r.last).toBe("track");
      expect(before.get("c1")?.net?.n).toBe(TRANSIENT_BACKOFF_MS.length);
      saveResumeStates(before, path);
      const errors = spyOn(console, "error");
      const after = loadResumeStates(path);
      expect(errors).not.toHaveBeenCalled(); // 不打「字段坏了」的假报警
      errors.mockRestore();
      expect(after.get("c1")?.net).toMatchObject({ n: TRANSIENT_BACKOFF_MS.length, since: T0 }); // 起点没被重置
      expect(giveUpText(after.get("c1"), NET, "")).toContain(`连续 ${TRANSIENT_BACKOFF_MS.length + 1} 次网络类错误`);
      expect(noteApiError(after, "c1", NET, r.now)).toBe("escalate");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("单条字段坏了（net 空、resumedAt 非数字）：丢掉那条，别的照常读回；撞错过了半小时还没续的读回来、投之前那道检查丢", () => {
    const dir = mkdtempSync(join(tmpdir(), "nrt1-field-"));
    try {
      const path = join(dir, "api-error-resume.json");
      writeFileSync(path, JSON.stringify({
        bad1: { errorAt: T0, error: "x", net: {} },
        bad2: { errorAt: T0, error: "x", resumedAt: "soon" },
        bad3: { errorAt: T0, error: "x", net: { n: 9, since: T0, last: "" } },
        bad4: { errorAt: T0, error: "x", net: { n: 4, since: T0, last: "" } },
        old: { errorAt: T0 - STALE_RESUME_MS, error: "x" },
        ok: { errorAt: T0, error: "x", net: { n: 1, since: T0, last: NET }, agent: "a" },
      }));
      const m = loadResumeStates(path);
      expect([...m.keys()]).toEqual(["old", "ok"]);
      expect(dropStale(m, "old", T0)).toBe(true);
      expect(dropStale(m, "ok", T0)).toBe(false);
      expect([...m.keys()]).toEqual(["ok"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("落盘文件坏了：不恢复、不抛（bridge 照常起）", () => {
    const dir = mkdtempSync(join(tmpdir(), "nrt1-bad-"));
    try {
      const path = join(dir, "api-error-resume.json");
      writeFileSync(path, '{"c1":{"errorAt":"x"}}');
      expect(loadResumeStates(path).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("save-failure-log-flood：落盘一直失败时同一错误一段时间只记一行，过了间隔再记一行", () => {
  const dir = mkdtempSync(join(tmpdir(), "nrt2-save-"));
  const blocker = join(dir, "file");
  writeFileSync(blocker, "");
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    const m = new Map<string, ApiErrorState>();
    for (let i = 0; i < 100; i++) {
      m.set("c1", { errorAt: T0 + i, error: "x" }); // 每次内容都变，不会被「和上次一样」挡掉
      saveResumeStates(m, join(blocker, "api-error-resume.json"), T0 + i * 1_000);
    }
    expect(errors).toHaveBeenCalledTimes(1);
    saveResumeStates(new Map(), join(blocker, "api-error-resume.json"), T0 + SAVE_ERROR_LOG_GAP_MS + 100_000);
    expect(errors).toHaveBeenCalledTimes(2);
  } finally {
    errors.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
