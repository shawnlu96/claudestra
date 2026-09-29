import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  test("排队提示只认输入框里的整行灰字：以这句开头的用户消息 / 草稿不算忙（T41a）", () => {
    const B = "─".repeat(40);
    const asked = ["❯ Press up to edit queued messages 是什么意思", "", "⏺ 那是排队提示。", "", "✻ Worked for 3s · done 9:51 PM", "", B, "❯ ", B].join("\n");
    expect(paneMainTurnBusy(asked)).toBe(false);
    expect(paneMainTurnBusy([B, "❯ Press up to edit queued messages 这句是什么", B].join("\n"))).toBe(false);
    expect(paneMainTurnBusy(["✻ Worked for 3s", B, "❯\u00a0Press up to edit queued messages", B].join("\n"))).toBe(true);
    const real = readFileSync(join(import.meta.dir, "fixtures/turn-zone/busy-queued.txt"), "utf8");
    expect(paneMainTurnBusy(real.replace(/^✢ Hatching.*$/m, ""))).toBe(true); // 去掉 spinner 也认得出排队
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

  test("API 重试 / 限流时 spinner 换成重试横幅 → 忙（CC 2.1.283 源码里的形态）", () => {
    for (const row of [
      "✻ Repeated 529 Overloaded errors · Retrying in 38s · attempt 5/10",
      "✻ Weekly limit reached · Retrying in 2h 14m (resets 11pm) · attempt 1/10",
      "✻ Waiting for API response · will retry in 5s · check your network",
      "✻ No response from the API after 2m · retrying, waiting up to 5m · attempt 2/10",
    ]) expect(paneMainTurnBusy(["⏺ 我先跑一下检查。", "", row, "", ...box].join("\n"))).toBe(true);
  });
  test("任务 activeForm 以 ASCII「...」结尾（CC 不再补「…」）→ 忙", () => {
    for (const row of ["✻ Running tests... (2m 3s · ↓ 4.1k tokens)", "✢ 正在跑测试..."]) {
      expect(paneMainTurnBusy(["⏺ 开跑。", "", row, "", ...box].join("\n"))).toBe(true);
    }
  });
  test("任务列表满 5 行 +「… +N」+ 排队消息预览：spinner 在边框上方第 9 行，仍判忙（往上找 12 行）", () => {
    const tasks = ["  ⎿  ✔ 读规格卡", "     ◼ 写 turn-state", "     ◻ 写 interrupt-gate", "     ◻ 接线 bridge", "     ◻ 补测试", "      … +3 pending"];
    const pane = ["⏺ Bash(bun run check)", "", "✻ Pondering… (2m 3s · ↓ 4.1k tokens)", ...tasks, "  ❯ 顺便把测试也跑一下", "", ...box].join("\n");
    expect(paneMainTurnBusy(pane)).toBe(true);
  });
  test("空闲收尾行不因新分支误判：Churned / Waiting for … background / Running 1 shell command…", () => {
    const idle = ["✻ Churned for 1m 51s · done 7:41 PM", "✻ Waiting for 3 background agents to finish", "⏺ Running 1 shell command…", "", ...box].join("\n");
    expect(paneMainTurnBusy(idle)).toBe(false);
  });
});

