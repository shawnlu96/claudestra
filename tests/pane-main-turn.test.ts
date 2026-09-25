import { describe, expect, test } from "bun:test";
import { paneLooksWorking, paneMainTurnBusy } from "../src/lib/tmux-helper.js";

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
});
