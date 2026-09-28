import { describe, expect, test } from "bun:test";
import { paneLooksWorking, paneMainTurnBusy } from "../src/lib/turn-state.js";

// 主回合已结束、只剩后台 subagent:pane 仍「工作中」(侧栏该亮),但不能当成主回合在跑去抢占 C-c——
// 那一下会把后台 agent 全停掉(bn_market_maker 09-15 以来 14 次 agents_killed 全部对上 bridge 的「⚡ 抢占打断」)。
const footer = "─────\n❯ \n─────\n  Ctx 78% · 5h 27% 7d 60% · mm-frontend\n  ⏵⏵ bypass permissions on · 1 shell · ← for agents";

describe("paneMainTurnBusy", () => {
  test("只剩后台 agent(mm-frontend 2026-09-25 实抓):工作中但主回合空闲", () => {
    const pane = [
      "⏺ Resumed; waiting on CI and the three agents.",
      "✻ Waiting for 3 background agents to finish",
      footer,
      "  ⏺ main",
      "  ◯ general-purpose  Reading publishAccount in heartbeat.ts",
      "  ◯ general-purpose  Anal… 1m 13s · ↓ 58.1k tokens",
    ].join("\n");
    expect(paneLooksWorking(pane)).toBe(true);
    expect(paneMainTurnBusy(pane)).toBe(false);
  });

  test("主回合在跑:esc to interrupt / spinner 计时 / 排队消息", () => {
    expect(paneMainTurnBusy("✶ Thinking… (esc to interrupt)\n" + footer)).toBe(true);
    expect(paneMainTurnBusy("✻ Crunching… (2m 7s · ↓ 4.6k tokens)\n" + footer + "\n  ◯ general-purpose  Anal… 1m 13s · ↓ 58.1k tokens")).toBe(true);
    expect(paneMainTurnBusy("❯ Press up to edit queued messages\n" + footer)).toBe(true);
  });

  test("真空闲", () => {
    expect(paneMainTurnBusy("✻ Worked for 46s · done 9:51 PM\n" + footer)).toBe(false);
  });

  test("spinner 锚定行首：空闲画面里工具输出带「…(12s)」不算忙（N7 复核 P1：否则 Discord 抢占会对空闲 CC 连发 C-c）", () => {
    const idle = ["⏺ Bash(bun run build)", "  ⎿  Compiling… (12s)", "     done", "", "✻ Worked for 20s · done 6:01 PM", footer].join("\n");
    expect(paneMainTurnBusy(idle)).toBe(false);
    expect(paneMainTurnBusy("  正在下载… (3s 左右)\n" + footer)).toBe(false);
  });

  test("跑过一小时的回合：spinner 计时带 h 也认", () => {
    expect(paneMainTurnBusy("✽ Pondering… (1h 2m 3s · ↓ 9.9k tokens)\n" + footer)).toBe(true);
    expect(paneMainTurnBusy("· Cooking… (1h 5s)\n" + footer)).toBe(true);
  });

  // 2026-09-28 沙箱逐 80ms 抓屏：bg shell 结束 → CC 自动开通知回合，前 8 帧（约 0.64s）spinner 不带括号，
  // 回合收尾跑 Stop hook 时括号里先是文字再是耗时。两种都在回合里，agent 消息投进去会落进丢弃窗口
  const box = ["─".repeat(80), "❯ ", "─".repeat(80), "  Opus 5.5 · ctx 95% · 5h 44% · 7d 88%", "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"];
  const turnStart = [
    "⏺ sleep 20 已经在后台跑起来了，「已启动」也发出去了。", "", "✻ Baked for 6s · done 7:46 PM", "",
    "⏺ Background command \"Sleep 20 seconds in background\" completed (exit code 0)", "",
    "✢ Concocting…", "  ⎿  Tip: Run tasks in the cloud while you keep coding locally · clau.de/web", "", ...box,
  ].join("\n");
  test("回合开头、首个 token 前的 spinner 不带括号（✢ Concocting…）→ 忙", () => {
    expect(paneMainTurnBusy(turnStart)).toBe(true);
  });
  test("回合收尾跑 Stop hook（括号里先文字后耗时）→ 忙", () => {
    const stopHook = ["⏺ 测试完成。", "", "✻ Concocting… (running Stop hook · 3s · ↓ 38 tokens)", "  ⎿  Tip: x", "", ...box].join("\n");
    expect(paneMainTurnBusy(stopHook)).toBe(true);
  });
  test("不带括号那一支只认第 0 列、行尾是「…」：缩进的正文 / 空闲态收尾行不算", () => {
    expect(paneMainTurnBusy(["  · 正在整理…", "✻ Crunched for 3s · done 7:47 PM", "✻ Waiting for 1 background agent to finish", "", ...box].join("\n"))).toBe(false);
  });
  test("6 个后台 agent 行把 spinner 挤出尾部 14 行，按输入框定位仍判忙；只剩后台照样判闲", () => {
    const rows = ["  ⏺ main", ...Array.from({ length: 6 }, (_, k) => `  ◯ general-purpose  task ${k}                  ${k + 10}s · ↓ 20.${k}k tokens`)];
    const busy = ["✽ Pondering… (1m 3s · ↓ 2.1k tokens)", "  ⎿  Tip: x", "", ...box, "", ...rows].join("\n");
    expect(busy.split("\n").slice(-14).some((l) => l.includes("Pondering"))).toBe(false);
    expect(paneMainTurnBusy(busy)).toBe(true);
    const idle = ["✻ Worked for 46s · done 9:51 PM", "", ...box, "", ...rows].join("\n");
    expect(paneMainTurnBusy(idle)).toBe(false);
    expect(paneLooksWorking(idle)).toBe(true);
  });
});
