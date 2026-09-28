/**
 * lib/quota-wall-text.ts：撞墙原文识别——weekly / session / 泛称三种写法与重置时刻（跨日期、跨年、时区），
 * 临时 429 和 agent 自己话里引用这句都不算撞墙。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isLimitHitText, isModelLimitHit, matchLimitMenu, paneShowsLowPriority, paneShowsWallWait, parseWallText, wallHitOf } from "../src/lib/quota-wall-text.js";
import { paneMainTurnBusy } from "../src/lib/turn-state.js";

const at = (iso: string) => Date.parse(iso);

/** 本机 ~/.claude/projects 里 CC 合成的模型级额度原文（2026-09-29 扫：前一句 83 处、后一句 15 处） */
const REAL_MODEL_LIMIT = [
  "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.",
  "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.",
];

describe("isLimitHitText", () => {
  test("认 CC 的几种写法（2026-09-28 实录的原文）", () => {
    expect(isLimitHitText("You've hit your weekly limit · resets Sep 30 at 6am (Asia/Tokyo)")).toBe(true);
    expect(isLimitHitText("You've hit your session limit · resets 10:40pm (Asia/Tokyo)")).toBe(true);
    expect(isLimitHitText("You've hit your limit · resets 2am (Asia/Shanghai)")).toBe(true);
    expect(isLimitHitText("You’ve hit your usage limit. Upgrade to Pro or try again at 8:41 AM.")).toBe(true);
    expect(isLimitHitText("You've hit your weekly limit · resets Fri 9am (Asia/Tokyo)")).toBe(true);
    expect(isLimitHitText("You've hit your usage limit")).toBe(true);
    // 单个模型的额度（error 也是 rate_limit）：本机 jsonl 里 CC 合成的这两句原样各出现几十次
    for (const t of REAL_MODEL_LIMIT) expect(isLimitHitText(t)).toBe(true);
  });

  test("agent 话里常见的「hit your … limit」：limit 后面不是标点 / 行尾就不算（常规审查 P1-2 的误判样本）", () => {
    expect(isLimitHitText("You've hit your API limit on GitHub, so I paused the sync.")).toBe(false);
    expect(isLimitHitText("Hit your rate limit on npm, retrying…")).toBe(false);
    expect(isLimitHitText("You've hit your limit of three retries")).toBe(false);
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

  test("星期写法与 Codex 的 try again（常规审查 P2-6）", () => {
    const now = at("2026-09-28T13:00:00Z"); // 周一，东京 22:00
    expect(parseWallText("You've hit your weekly limit · resets Fri 9am (Asia/Tokyo)", now)).toEqual({
      kind: "weekly", resetsAt: at("2026-10-02T00:00:00Z"), resetsText: "Fri 9am (Asia/Tokyo)",
    });
    expect(parseWallText("You've hit your weekly limit · resets Mon 9am (Asia/Tokyo)", now)!.resetsAt).toBe(at("2026-10-05T00:00:00Z"));
    expect(parseWallText("You've hit your usage limit. Try again in 3 hours.", now)!.resetsAt).toBe(now + 3 * 3600_000);
  });

  test("wallHitOf：只有 error=rate_limit 的账号级额度才进闸", () => {
    const now = Date.now();
    expect(wallHitOf("rate_limit", "You've hit your session limit · resets 10:40pm (Asia/Tokyo)", now)?.kind).toBe("session");
    expect(wallHitOf("rate_limit", REAL_MODEL_LIMIT[0], now)).toBeNull();
    expect(wallHitOf("rate_limit", "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited", now)).toBeNull();
    expect(wallHitOf("server_error", "You've hit your weekly limit", now)).toBeNull();
    expect(isModelLimitHit("rate_limit", REAL_MODEL_LIMIT[1])).toBe(true);
    expect(isModelLimitHit("rate_limit", "You've hit your weekly limit · resets Fri 9am (Asia/Tokyo)")).toBe(false);
    expect(isModelLimitHit("rate_limit", "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited")).toBe(false);
  });

  test("只写时刻 / 星期的重置按原文时区取日期：本机时区差十几个小时也解得出（T24 r1 P2-6）", () => {
    const saved = process.env.TZ;
    try {
      for (const tz of ["America/Los_Angeles", "Pacific/Kiritimati", "Asia/Tokyo"]) {
        process.env.TZ = tz;
        const now = at("2026-09-28T13:00:00Z"); // 东京 22:00
        expect(parseWallText("You've hit your limit · resets 2am (Asia/Tokyo)", now)!.resetsAt).toBe(at("2026-09-28T17:00:00Z"));
        expect(parseWallText("You've hit your weekly limit · resets Fri 9am (Asia/Tokyo)", now)!.resetsAt).toBe(at("2026-10-02T00:00:00Z"));
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  test("不是撞墙原文 → null", () => {
    expect(parseWallText("API Error: 429 This request would exceed your account's rate limit.", Date.now())).toBeNull();
  });
});

describe("paneShowsWallWait（T35 实测：撞墙等待画面带「esc to cancel」，CC_BUSY_RE 判成忙）", () => {
  const border = "─".repeat(40);
  const menu = [
    "⏺ 看下代码", "  ⎿  You've hit your weekly limit · resets Sep 30 at 6am (Asia/Tokyo)", "", " What do you want to do?",
    " ❯ 1. Stop and wait for limit to reset", "   2. Wait here, then continue automatically at Sep 30 at 6am", "   3. Switch to usage credits",
    " Enter to confirm · Esc to cancel",
  ].join("\n");
  const countdownBelow = [
    "✻ Worked for 3m 2s", "", border, "❯ ", border,
    "  ⚠ /low-priority to continue now at lower priority · uses your weekly limit", "  continuing automatically at 3:20am · esc to cancel",
  ].join("\n");
  const countdownAbove = ["  ⎿  You've hit your session limit", "  continuing automatically at 3:20am · esc to cancel", "", border, "❯ ", border, "  ? for shortcuts"].join("\n");

  test("菜单开着 / 状态栏自动续跑倒计时：不算在跑（通用判忙只认顶格 spinner 行，菜单的「Esc to cancel」也不再判成忙）", () => {
    expect(paneMainTurnBusy(menu)).toBe(false);
    for (const p of [menu, countdownBelow]) expect(paneShowsWallWait(p)).toBe(true);
  });

  test("只看状态栏 / 底部菜单：对话里留着的那句（续跑之后还在屏幕上）不算，不然空闲的会话会一直被当成撞墙押消息", () => {
    expect(paneShowsWallWait(countdownAbove)).toBe(false);
  });

  test("拿掉这些行之后还有 spinner：照旧算在跑；没有撞墙画面：不归它管", () => {
    const running = ["✻ Pondering… (2m 3s · ↓ 1.2k tokens)", "  continuing automatically at 3:20am · esc to cancel", "", border, "❯ ", border].join("\n");
    expect(paneShowsWallWait(running)).toBe(false);
    expect(paneShowsWallWait(["✻ Worked for 3m 2s", "", border, "❯ ", border, "  ? for shortcuts"].join("\n"))).toBe(false);
  });
});

describe("真实画面样本（T35 2026-09-29 录的 CC 画面，去掉 ANSI：tests/fixtures/quota-wall/）", () => {
  const pane = (f: string) => readFileSync(join(import.meta.dir, "fixtures/quota-wall", `${f}.txt`), "utf8");
  test("停在额度菜单（新版 5 项、有 LP、光标停在 usage credits 上）/ 状态栏倒计时：都算撞墙等待，不发键", () => {
    for (const f of ["menu-5-items", "menu-no-lp", "menu-on-credits", "menu-on-lp", "walled", "walled-channel", "walled-typing", "lp-off-offer"]) {
      expect([f, paneShowsWallWait(pane(f))]).toEqual([f, true]);
    }
  });
  test("在跑 / 压缩中 / 开了 low-priority 在跑 / 普通空闲：不算", () => {
    for (const f of ["busy-queued", "compacting", "lp-on-allowance", "lp-on-autocontinue", "draft", "fresh-placeholder"]) {
      expect([f, paneShowsWallWait(pane(f))]).toEqual([f, false]);
    }
  });
  test("新版菜单的几项（Don’t continue automatically / Continue now at lower priority / claim a $250 credit）认得，出闸能发 Esc 关掉", () => {
    for (const f of ["menu-5-items", "menu-no-lp", "menu-on-credits", "menu-on-lp"]) expect([f, matchLimitMenu(pane(f))]).toEqual([f, true]);
    expect(matchLimitMenu(pane("walled"))).toBe(false); // 状态栏倒计时不是菜单：没东西要关
  });
  test("对话里贴了一段忙窗口的抓屏（缩进的假输入框 + spinner + 排队提示）：真菜单 / 真倒计时照样认出来（T24 adv1 P1-1，审查员沙箱画面）", () => {
    for (const f of ["menu-fakebox", "walled-fakebox"]) expect([f, paneShowsWallWait(pane(f))]).toEqual([f, true]);
  });
  test("窄窗口：菜单选项折行、状态栏倒计时折行都认得（T24 adv1 P1-2）；折行的菜单不算完整认得，出闸不发 Esc", () => {
    expect(paneShowsWallWait(pane("menu-narrow60"))).toBe(true);
    expect(matchLimitMenu(pane("menu-narrow60"))).toBe(false);
    const border = "─".repeat(58);
    const foot = ["✻ Worked for 0s · done 1:58 AM", "", border, "❯ ", border, "  ⚠ Usage limit reached · continuing automatically at 3:20am", "  · esc to cancel"];
    expect(paneShowsWallWait(foot.join("\n"))).toBe(true);
    expect(paneShowsWallWait(["✻ Pondering… (2m 3s · ↓ 1.2k tokens)", ...foot.slice(1)].join("\n"))).toBe(false); // 顶格 spinner = 真在跑
    const garbled = ["   What do you want to do?", "   ❯ 1. Stop and wait for limit to reset", "Some prose at column 0", "   Enter to confirm · Esc to cancel"];
    expect(paneShowsWallWait(garbled.join("\n"))).toBe(false); // 选项之间夹着顶格的别的内容：不是菜单
  });
  test("CC 2.1.283 的另外三种倒计时：周额度 80 列截断、重置时间未知、到点后 continuing shortly（T24 wf keys-screens-2；按 CC 源码文案从 walled.txt 推出）", () => {
    for (const f of ["walled-weekly-80col", "walled-when-resets", "walled-shortly"]) expect([f, paneShowsWallWait(pane(f))]).toEqual([f, true]);
  });
  test("手机宽度（48 列）的 3 项菜单折成好几行、菜单带促销说明行：都认得（T24 wf delivery-hold-7 / keys-screens-5）", () => {
    const narrow = [
      "✻ Worked for 0s", "▔".repeat(48), "   What do you want to do?", "", "   ❯ 1. Stop and wait for limit to",
      "        reset", "     2. Wait here, then continue", "        automatically at Sep 30 at 6am", "     3. Switch to usage", "        credits", "", "   Enter to confirm · Esc to cancel",
    ];
    expect(paneShowsWallWait(narrow.join("\n"))).toBe(true);
    const promo = ["   What do you want to do?", "   Claim a $250 credit to keep going in the cloud.", "", "   ❯ 1. Stop and wait for limit to reset", "   Enter to confirm · Esc to cancel"];
    expect(paneShowsWallWait(promo.join("\n"))).toBe(true);
  });
  test("开了 low-priority 在跑（状态栏 Lower priority until …）认得；撞墙等待、没开 LP 的不算（T24 wf gate-state-2）", () => {
    for (const f of ["lp-on-allowance", "lp-on-autocontinue"]) expect([f, paneShowsLowPriority(pane(f))]).toEqual([f, true]);
    for (const f of ["walled", "lp-off-offer", "menu-5-items", "draft"]) expect([f, paneShowsLowPriority(pane(f))]).toEqual([f, false]);
  });
  test("回合中弹出的别的对话框（底部也是「Enter to confirm · Esc to cancel」）不算额度菜单（T24 r2 P2-6）", () => {
    const other = ["   Do you want to proceed?", "", "   ❯ 1. Yes", "     2. No", "", "   Enter to confirm · Esc to cancel"].join("\n");
    expect(paneShowsWallWait(other)).toBe(false);
  });
});
