/**
 * lib/quota-wall.ts + quota-wall-text.ts 的画面识别 + quota-wall-notice.ts：进闸只一次、并入、出闸四个来源、
 * 恢复名单、菜单完整匹配才发 Esc、「Limits reset」回显计数、两条通知的内容。
 */
import { describe, expect, test } from "bun:test";
import {
  countsAsWallActivity, emptyWallState, enterFromUsage, exitVia, isHumanSender, observeCache, markExit, noteOtherError, noteWallActivity, noteWallHit, notifyDue, probeDue,
  resumeTargets, wallActive, WALL_TIMING, type WallState,
} from "../src/lib/quota-wall.js";
import { recoveredNotice, wallNotice, wallResumeText } from "../src/lib/quota-wall-notice.js";
import { countLimitsResetEcho, matchLimitMenu, parseWallText } from "../src/lib/quota-wall-text.js";

const T0 = Date.parse("2026-09-28T13:19:40Z");
const WEEKLY = "You've hit your weekly limit · resets Sep 30 at 6am (Asia/Tokyo)";
const SESSION = "You've hit your session limit · resets 10:40pm (Asia/Tokyo)";
let n = 0;
const newId = () => `wall_${++n}`;
const hit = (s: WallState, cid: string, at: number, text = WEEKLY) =>
  noteWallHit(s, { channelId: cid, agent: `agent-${cid}`, at, error: "rate_limit", parsed: parseWallText(text, at)! }, newId);

describe("进闸与并入", () => {
  test("多个 agent 陆续撞墙只进一次闸，都进续跑名单", () => {
    const a = hit(emptyWallState(), "t19", T0);
    expect(a.entered).toBe(true);
    const b = hit(a.state, "t23", T0 + 1_000);
    const c = hit(b.state, "pm", T0 + 12_000);
    expect(b.entered || c.entered).toBe(false);
    expect(c.state.wall!.id).toBe(a.state.wall!.id);
    expect(Object.keys(c.state.wall!.hits)).toEqual(["t19", "t23", "pm"]);
    expect(c.state.wall!.kind).toBe("weekly");
    expect(c.state.wall!.resetsAt).toBe(Date.parse("2026-09-29T21:00:00Z"));
  });

  test("周墙里再撞 session 墙：种类保持 weekly，重置时刻取更晚的", () => {
    const a = hit(emptyWallState(), "a", T0, SESSION);
    expect(a.state.wall!.kind).toBe("session");
    const b = hit(a.state, "b", T0 + 5_000, WEEKLY);
    expect(b.state.wall!.kind).toBe("weekly");
    expect(b.state.wall!.resetsAt).toBe(Date.parse("2026-09-29T21:00:00Z"));
    const c = hit(b.state, "c", T0 + 9_000, SESSION);
    expect(c.state.wall!.resetsAt).toBe(Date.parse("2026-09-29T21:00:00Z"));
  });

  test("闸内别的 API 错误也记进名单；闸外返回 null（走原来的 60 秒续跑）", () => {
    expect(noteOtherError(emptyWallState(), { channelId: "x", agent: "agent-x", at: T0, error: "server_error" })).toBeNull();
    const s = noteOtherError(hit(emptyWallState(), "a", T0).state, { channelId: "x", agent: "agent-x", at: T0 + 1, error: "server_error" })!;
    expect(s.wall!.hits.x.error).toBe("server_error");
  });

  test("撞墙后又真的动了才从名单拿掉；错误条目自己带出的活动（宽限内）不算", () => {
    const s = hit(emptyWallState(), "a", T0).state;
    expect(noteWallActivity(s, "a", T0 + 1_000, 3_000)).toBeNull();
    expect(noteWallActivity(s, "a", T0 + 60_000, 3_000)!.wall!.hits.a).toBeUndefined();
    expect(noteWallActivity(s, "nobody", T0 + 60_000, 3_000)).toBeNull();
  });

  test("用量缓存 ≥100 且重置时刻未过 → 进闸；过了的不算", () => {
    const u = { sessionPct: 40, weekPct: 100, sessionResetsAtMs: null, weekResetsAtMs: T0 + 3_600_000, scrapedAt: T0 };
    const r = enterFromUsage(emptyWallState(), u, T0, newId);
    expect(r.entered).toBe(true);
    expect(r.state.wall).toMatchObject({ source: "usage_cache", kind: "weekly", resetsAt: T0 + 3_600_000 });
    expect(enterFromUsage(emptyWallState(), { ...u, weekResetsAtMs: T0 - 1 }, T0, newId).entered).toBe(false);
    expect(enterFromUsage(r.state, u, T0 + 1, newId).entered).toBe(false);
  });

  test("出闸前抓的旧缓存（还是 100%）不会让它刚出又进", () => {
    const exited = markExit(hit(emptyWallState(), "a", T0).state, "limits_reset", T0 + 600_000);
    const stale = { sessionPct: 100, weekPct: 100, sessionResetsAtMs: T0 + 9e6, weekResetsAtMs: T0 + 9e7, scrapedAt: T0 + 300_000 };
    expect(enterFromUsage(exited, stale, T0 + 610_000, newId).entered).toBe(false);
    // 用卡出闸：周重置日不变，还没发请求的窗口一渲染就写回 100%——同一窗口重置时刻没变就不进（T24 r1 P2-1）
    expect(enterFromUsage(exited, { ...stale, scrapedAt: T0 + 605_000 }, T0 + 610_000, newId).entered).toBe(false);
    const seen = { ...exited, wall: { ...exited.wall!, cache: { full: true, rolled: false, maxWeek: T0 + 9e7, maxSession: T0 + 9e6 } } };
    expect(enterFromUsage(seen, { ...stale, scrapedAt: T0 + 605_000 }, T0 + 610_000, newId).entered).toBe(false);
    expect(enterFromUsage(seen, { ...stale, weekResetsAtMs: T0 + 8e7, scrapedAt: T0 + 605_000 }, T0 + 610_000, newId).entered).toBe(false); // 更早：写回的旧值
    expect(enterFromUsage(seen, { ...stale, weekResetsAtMs: T0 + 6e8, scrapedAt: T0 + 605_000 }, T0 + 610_000, newId).entered).toBe(true);
    // 到点出闸的：新窗口又满了就照常进
    const natural = markExit(hit(emptyWallState(), "a", T0).state, "resets_at", T0 + 600_000);
    expect(enterFromUsage(natural, { ...stale, scrapedAt: T0 + 605_000 }, T0 + 610_000, newId).entered).toBe(true);
  });

  test("上一道闸恢复没做完又撞墙：还没续跑的名单带进新闸", () => {
    let s = hit(hit(emptyWallState(), "a", T0).state, "b", T0 + 1).state;
    s = markExit(s, "cli", T0 + 10_000);
    s.wall!.recovery!.step = "resume";
    s.wall!.recovery!.resumed = ["agent-a"];
    const r = hit(s, "c", T0 + 20_000);
    expect(r.entered).toBe(true);
    expect(Object.keys(r.state.wall!.hits).sort()).toEqual(["b", "c"]);
  });
});

describe("出闸（任一来源）", () => {
  const w = () => hit(emptyWallState(), "a", T0).state.wall!;
  test("到了 resetsAt + 1 分钟余量", () => {
    const at = w().resetsAt!;
    expect(exitVia(w(), { now: at + 30_000 })).toBeNull();
    expect(exitVia(w(), { now: at + WALL_TIMING.exitSlackMs })).toBe("resets_at");
  });
  test("窗口出现「Limits reset」回显", () => expect(exitVia(w(), { now: T0 + 1, limitsReset: true })).toBe("limits_reset"));
  test("用量探测 <100 且是进闸之后的观测", () => {
    expect(exitVia(w(), { now: T0 + 400_000, probe: { pct: 3, observedAt: T0 - 1 } })).toBeNull();
    expect(exitVia(w(), { now: T0 + 400_000, probe: { pct: 100, observedAt: T0 + 300_000 } })).toBeNull();
    expect(exitVia(w(), { now: T0 + 400_000, probe: { pct: 3, observedAt: T0 + 300_000 } })).toBe("probe");
  });
  test("状态栏缓存：闸里见过满、后来 <100 才出闸；撞墙时停在 99% 的旧值不算（T24 r1 P2-1）", () => {
    const c = { sessionPct: 0, weekPct: 2, sessionResetsAtMs: 5e12, weekResetsAtMs: 6e12, scrapedAt: T0 + 5 };
    const obs = (x: typeof c) => observeCache({ v: 1, wall: w() }, x)!.wall!;
    expect(exitVia(obs(c), { now: T0 + 10, cache: c })).toBeNull(); // 从没见过满
    const full = obs({ ...c, weekPct: 100 });
    expect(exitVia(full, { now: T0 + 10, cache: { ...c, weekPct: 100 } })).toBeNull();
    expect(observeCache({ v: 1, wall: full }, { ...c, scrapedAt: T0 + 9 })).toBeNull(); // 记下的样子没变：不落盘
    const after = full;
    expect(exitVia(after, { now: T0 + 10, cache: { ...c, scrapedAt: T0 + 9 } })).toBe("usage_cache");
    expect(exitVia(after, { now: T0 + 10, cache: { ...c, scrapedAt: T0 - 5 } })).toBeNull();
    // 重置时刻前进了（窗口滚过去了）：没见过满也出
    const w99 = obs({ ...c, weekPct: 99 });
    const rolled = { ...c, weekResetsAtMs: 7e12, scrapedAt: T0 + 9 };
    expect(exitVia(observeCache({ v: 1, wall: w99 }, rolled)!.wall!, { now: T0 + 10, cache: rolled })).toBe("usage_cache");
  });
  test("重置时刻只认前进：空闲会话写回上一周期的旧 reset（不相等但更早）不算窗口滚过去（T24 r2 P2-3）", () => {
    const c = { sessionPct: 0, weekPct: 99, sessionResetsAtMs: 5e12, weekResetsAtMs: 6e12, scrapedAt: T0 + 5 };
    const first = observeCache({ v: 1, wall: w() }, c)!.wall!;
    const old = { ...c, weekResetsAtMs: 6e12 - 7 * 86_400_000, weekPct: 40, scrapedAt: T0 + 9 };
    const after = observeCache({ v: 1, wall: first }, old)?.wall ?? first;
    expect(after.cache).toMatchObject({ rolled: false, maxWeek: 6e12 });
    expect(exitVia(after, { now: T0 + 10, cache: old })).toBeNull();
  });
  test("带 five_hour 的写者把 7d 从 100 往下写成 99：按「闸里见过满、之后 <100」出闸（PM 定的规则；真撞墙会再从 api_error_turn 进闸）", () => {
    const c = { sessionPct: 20, weekPct: 100, sessionResetsAtMs: 5e12, weekResetsAtMs: 6e12, scrapedAt: T0 + 5 };
    const full = observeCache({ v: 1, wall: w() }, c)!.wall!;
    const down = { ...c, weekPct: 99, scrapedAt: T0 + 9 };
    expect(exitVia(observeCache({ v: 1, wall: full }, down)?.wall ?? full, { now: T0 + 10, cache: down })).toBe("usage_cache");
  });
  test("CLI clear；已出闸的不再出", () => {
    expect(exitVia(w(), { now: T0, cli: true })).toBe("cli");
    const s = markExit({ v: 1, wall: w() }, "cli", T0 + 1);
    expect(wallActive(s)).toBe(false);
    expect(s.wall!.recovery!.step).toBe("menus");
    expect(exitVia(s.wall!, { now: T0 + 2, cli: true })).toBeNull();
  });
  test("5 分钟探一次；进闸 20 秒后才通知一次", () => {
    const x = w();
    expect(probeDue(x, T0 + 60_000)).toBe(false);
    expect(probeDue(x, T0 + WALL_TIMING.probeEveryMs)).toBe(true);
    expect(notifyDue(x, T0 + 5_000)).toBe(false);
    expect(notifyDue(x, T0 + 20_000)).toBe(true);
    expect(notifyDue({ ...x, notifiedAt: T0 + 20_000 }, T0 + 60_000)).toBe(false);
  });
});

describe("恢复名单", () => {
  test("按撞墙先后；队里有消息的（补投会叫醒它）和已续过的不续", () => {
    let s = hit(emptyWallState(), "b", T0 + 5).state;
    s = hit(s, "a", T0).state;
    s = hit(s, "c", T0 + 9).state;
    s = markExit(s, "cli", T0 + 99);
    s.wall!.recovery!.resumed = ["agent-c"];
    expect(resumeTargets(s.wall!, (cid) => cid === "b")).toEqual(["a"]);
  });
  test("人发的照投：Discord 用户、非 peer 的 API；agent / bridge / peer 不算", () => {
    expect(isHumanSender({ kind: "user" })).toBe(true);
    expect(isHumanSender({ kind: "api" })).toBe(true);
    expect(isHumanSender({ kind: "api", peer: "sekai" })).toBe(false);
    expect(isHumanSender({ kind: "local" })).toBe(false);
    expect(isHumanSender({ kind: "bridge" })).toBe(false);
  });
});

const MENU = `
 ⎿  You've hit your weekly limit · resets Sep 30 at 6am (Asia/Tokyo)

 What do you want to do?

 ❯ 1. Stop and wait for limit to reset
   2. Wait here, then continue automatically at Sep 30 at 6am
   3. Switch to usage credits

 Enter to confirm · Esc to cancel
`;

describe("菜单匹配：完整认得才发 Esc", () => {
  test("2026-09-28 实录的菜单", () => expect(matchLimitMenu(MENU)).toBe(true));
  test("session 版（Upgrade your plan）", () => {
    expect(matchLimitMenu(MENU.replace("3. Switch to usage credits", "3. Upgrade your plan").replace("at Sep 30 at 6am", "when the limit resets"))).toBe(true);
  });
  test("多一个不认识的选项 / 文案变了 → 不发", () => {
    expect(matchLimitMenu(MENU.replace("   3. Switch to usage credits\n", "   3. Switch to usage credits\n   4. Use a limit reset\n"))).toBe(false);
    expect(matchLimitMenu(MENU.replace("Stop and wait for limit to reset", "Stop and wait"))).toBe(false);
  });
  test("第 1 项不是 Stop and wait / 编号不连续 → 不发", () => {
    expect(matchLimitMenu(MENU.replace("1. Stop and wait for limit to reset", "1. Switch to usage credits"))).toBe(false);
    expect(matchLimitMenu(MENU.replace("3. Switch", "4. Switch"))).toBe(false);
  });
  test("别的弹窗（权限确认、Rewind）不发", () => {
    expect(matchLimitMenu(" Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel")).toBe(false);
    expect(matchLimitMenu(" Rewind\n Restore the code and/or conversation\n Enter to continue · Esc to cancel")).toBe(false);
  });
  test("菜单下面还有别的内容（已关掉、只是在滚动区里）不发", () => {
    expect(matchLimitMenu(`${MENU}\n❯ 接着做\n`)).toBe(false);
  });
});

describe("「Limits reset」回显计数", () => {
  test("只数行首的回显（CC 回显带 ⎿），别处引用不算", () => {
    const pane = "> /limit-reset\n  ⎿  Limits reset · your weekly reset day stays Wed · 2 resets left\n说明：Limits reset · 是回显";
    expect(countLimitsResetEcho(pane)).toBe(1);
    expect(countLimitsResetEcho("")).toBe(0);
  });
});

describe("通知", () => {
  const s0 = hit(hit(emptyWallState(), "a", T0).state, "b", T0 + 1).state;
  test("进闸：种类、重置时间、排队条数、重置卡", () => {
    const text = wallNotice(s0.wall!, { now: T0 + 20_000, queued: 7, credits: 2 });
    expect(text).toContain("Sep 30 at 6am (Asia/Tokyo)");
    expect(text).toContain("7");
    expect(text).toContain("/limit-reset");
    expect(text).toContain("agent-a");
    expect(wallNotice(s0.wall!, { now: T0, queued: 0, credits: 0 })).not.toContain("/limit-reset");
  });
  test("出闸：关了几个菜单、补投几条、续跑几个、用了多久、要人处理的窗口", () => {
    const s = markExit(s0, "limits_reset", T0 + 3 * 3_600_000 + 12 * 60_000);
    Object.assign(s.wall!.recovery!, { step: "done", escSent: ["a", "b"], flushed: 5, resumed: ["agent-a"], running: ["agent-b"], manual: ["agent-z"] });
    const text = recoveredNotice(s.wall!);
    expect(text).toMatch(/3 (小时|h)/);
    expect(text).toContain("5");
    expect(text).toContain("agent-z");
  });
  test("续跑话术带撞墙时刻", () => {
    expect(wallResumeText(new Date(2026, 8, 28, 22, 19).getTime(), "rate_limit")).toContain("22:19");
  });
});

describe("countsAsWallActivity：撞墙后它是不是真的又跑起来了", () => {
  test("jsonl 里出了新东西 / 它往外发消息才算；投递时的 thinking、送进来的消息、错误原文不算（菜单开着的会话收到消息并不会动）", () => {
    expect(countsAsWallActivity("tool_start", {})).toBe(true);
    expect(countsAsWallActivity("assistant_text", { text: "接着改" })).toBe(true);
    expect(countsAsWallActivity("agent_status", { status: "thinking", trigger: "jsonl_activity" })).toBe(true);
    expect(countsAsWallActivity("chat_message", { direction: "out" })).toBe(true);
    expect(countsAsWallActivity("agent_status", { status: "thinking" })).toBe(false);
    expect(countsAsWallActivity("chat_message", { direction: "in" })).toBe(false);
    expect(countsAsWallActivity("assistant_text", { text: "You've hit your weekly limit", rateLimited: true })).toBe(false);
    expect(countsAsWallActivity("assistant_text", { text: "API Error: 529", apiError: true })).toBe(false);
  });
});
