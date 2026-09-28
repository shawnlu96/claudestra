/**
 * lib/quota-wall-text.ts：撞墙原文识别——weekly / session / 泛称三种写法与重置时刻（跨日期、跨年、时区），
 * 临时 429 和 agent 自己话里引用这句都不算撞墙。
 */
import { describe, expect, test } from "bun:test";
import { isLimitHitText, parseWallText } from "../src/lib/quota-wall-text.js";

const at = (iso: string) => Date.parse(iso);

describe("isLimitHitText", () => {
  test("认 CC 的几种写法（2026-09-28 实录的原文）", () => {
    expect(isLimitHitText("You've hit your weekly limit · resets Sep 30 at 6am (Asia/Tokyo)")).toBe(true);
    expect(isLimitHitText("You've hit your session limit · resets 10:40pm (Asia/Tokyo)")).toBe(true);
    expect(isLimitHitText("You've hit your limit · resets 2am (Asia/Shanghai)")).toBe(true);
    expect(isLimitHitText("You’ve hit your usage limit. Upgrade to Pro or try again at 8:41 AM.")).toBe(true);
    // 单个模型的额度（本机 48 条实录，error 也是 rate_limit）
    expect(isLimitHitText("You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.")).toBe(true);
    expect(isLimitHitText("You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.")).toBe(true);
  });

  test("临时 429 限流、别处引用这句、普通文字都不算", () => {
    expect(isLimitHitText("API Error: 429 This request would exceed your account's rate limit. Please try again later.")).toBe(false);
    expect(isLimitHitText("API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited")).toBe(false);
    expect(isLimitHitText("现场：CC 回的是 You've hit your weekly limit · resets Sep 30")).toBe(false);
    expect(isLimitHitText("收到，接着做")).toBe(false);
  });
});

describe("parseWallText", () => {
  test("weekly：带日期带时区，跨到后天", () => {
    const now = at("2026-09-28T13:19:44Z"); // 东京 22:19
    expect(parseWallText("You've hit your weekly limit · resets Sep 30 at 6am (Asia/Tokyo)", now)).toEqual({
      kind: "weekly", resetsAt: at("2026-09-29T21:00:00Z"), resetsText: "Sep 30 at 6am (Asia/Tokyo)",
    });
  });

  test("session：只有时刻，当天晚些时候", () => {
    const now = at("2026-09-28T13:00:00Z"); // 东京 22:00
    const h = parseWallText("You've hit your session limit · resets 10:40pm (Asia/Tokyo)", now)!;
    expect(h.kind).toBe("session");
    expect(h.resetsAt).toBe(at("2026-09-28T13:40:00Z"));
  });

  test("只有时刻、已过本机零点但重置在对方时区的明天凌晨", () => {
    const now = at("2026-09-28T17:30:00Z"); // 上海 9/29 01:30
    const h = parseWallText("You've hit your limit · resets 2am (Asia/Shanghai)", now)!;
    expect(h.kind).toBe("unknown");
    expect(h.resetsAt).toBe(at("2026-09-28T18:00:00Z"));
  });

  test("跨年：12 月底撞墙、1 月初重置", () => {
    const now = at("2026-12-30T10:00:00Z");
    expect(parseWallText("You've hit your weekly limit · resets Jan 2 at 6am (UTC)", now)!.resetsAt).toBe(at("2027-01-02T06:00:00Z"));
  });

  test("没写重置时间 / 认不出：resetsAt = null，种类照认", () => {
    expect(parseWallText("You've hit your weekly limit", Date.now())).toEqual({ kind: "weekly", resetsAt: null, resetsText: null });
    expect(parseWallText("You've hit your session limit · resets soon", Date.now())!.resetsAt).toBeNull();
  });

  test("单个模型的额度（Fable / Opus）不算整机撞墙 → null；显示照样按 ⛔", () => {
    expect(parseWallText("You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.", Date.now())).toBeNull();
    expect(parseWallText("You've reached your Fable 5 limit. Run /usage-credits to continue.", Date.now())).toBeNull();
    expect(parseWallText("You've hit your Opus limit · resets 3pm", Date.now())).toBeNull();
    expect(parseWallText("You've hit your usage limit.", Date.now())!.kind).toBe("unknown");
  });

  test("不是撞墙原文 → null", () => {
    expect(parseWallText("API Error: 429 This request would exceed your account's rate limit.", Date.now())).toBeNull();
  });
});
