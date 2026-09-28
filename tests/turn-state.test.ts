/**
 * lib/turn-state.ts：「忙不忙」只看主回合（N7 / T7）。只剩后台 subagent 在跑时押后闸曾把 agent 消息押 17 分钟。
 * 「只剩后台」画面是 2026-09-28 沙箱实抓的（主回合 done、底栏 ◯ 行还在）；Pi 画面样本同 tests/busy-windows.test.ts。
 */
import { describe, expect, test } from "bun:test";
import { flushHeld } from "../src/bridge/held-flush.js";
import { HeldQueue } from "../src/bridge/held-queue.js";
import type { Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { agentMsgMustWait, paneLooksWorking, paneShowsCompacting, thinkingLooksStuck, turnState, type TurnInput } from "../src/lib/turn-state.js";

const RULE = "─".repeat(80);
const footer = (agentsBar: string[]) =>
  [RULE, "❯ ", RULE, "  Opus 5.5 · ctx 96% · 5h 26% · 7d 83%", "  ⏵⏵ bypass permissions on · 1 shell · ← for agents", "", ...agentsBar].join("\n");
const AGENTS_BAR = ["  ⏺ main", "  ◯ general-purpose  Sleep 240 then done                  15s · ↓ 33.5k tokens"];
/** 主回合已结束，只剩后台 agent（底栏 ◯ 行 + 「1 shell still running」） */
const ONLY_BG = ["  等那条 sleep 跑完，同一个任务会再发一次通知。", "", "✻ Baked for 21s · done 6:33 PM · 1 shell still running", "", footer(AGENTS_BAR)].join("\n");
/** 老版本 TUI：主回合结束后的「Waiting for N background agent」（tests/modal-parser.test.ts 的 gc-car 实抓） */
const WAITING_BG = [
  "  没有需要我主动做的事了,等后台任务完成。", "✻ Waiting for 1 background agent to finish", "─────", "❯ 露天的 放心", "─────",
  "  Opus 4.8 · ctx 59% · 5h 77% · 7d 17%", "  ⏵⏵ bypass permissions on (shift+tab to cycle) ·", "  ⏺ main", "  ◯ general-purpose  Anal… 1m 13s · ↓ 58.1k tokens",
].join("\n");
/** 主回合在跑，底栏同时有后台 agent：spinner 被挤到倒数第 12 行（旧抢占判据只看尾部 10 行会漏） */
const MAIN_BUSY_WITH_BG = ["✽ Recombobulating… (12s · ↓ 1.2k tokens)", "  ⎿  Tip: Use /theme to change the color theme", footer(AGENTS_BAR)].join("\n");
const CC_IDLE = ["✻ Worked for 46s · done 9:51 PM", "", footer([])].join("\n");
const piPane = (body: string) =>
  [body, "─".repeat(52), "─".repeat(52), "~/projects/x (develop) • agent-pi_x", "↑17M ↓2.8M R1032M (auto)", "🔗 agent-pi_x 💬 pi--10", ""].join("\n");

const at = (over: Partial<TurnInput>): TurnInput => ({ pane: CC_IDLE, ...over });

describe("turnState：main 只看主回合", () => {
  test("只剩后台 agent → main=idle、bg=true，agent 消息不押（旧判据 paneLooksWorking 判忙）", () => {
    for (const pane of [ONLY_BG, WAITING_BG]) {
      expect(paneLooksWorking(pane)).toBe(true);
      const s = turnState(at({ pane, status: "done" }));
      expect(s).toEqual({ main: "idle", bg: true });
      expect(agentMsgMustWait(s)).toBe(false);
    }
  });

  test("主回合在跑（spinner 在尾部 14 行内，底栏有后台 agent 也认得出）→ busy，bg 不重复报", () => {
    const s = turnState(at({ pane: MAIN_BUSY_WITH_BG }));
    expect(s.main).toBe("busy");
    expect(s.bg).toBe(false);
    expect(agentMsgMustWait(s)).toBe(true);
  });

  test("尾部成片空行不把 spinner 挤出窗口", () => {
    expect(turnState(at({ pane: MAIN_BUSY_WITH_BG + "\n".repeat(30) })).main).toBe("busy");
  });

  test("事件态 thinking（自发回合 / 画面还没刷出来）→ busy；compacting → compacting，两者都押", () => {
    expect(turnState(at({ status: "thinking" })).main).toBe("busy");
    const c = turnState(at({ pane: MAIN_BUSY_WITH_BG, status: "compacting" }));
    expect(c.main).toBe("compacting");
    expect(agentMsgMustWait(c)).toBe(true);
  });

  test("CC 空闲 → idle", () => {
    expect(turnState(at({ status: "done" })).main).toBe("idle");
  });

  test("空画面（tmuxRaw 出错返回空串）→ unknown，不是 idle", () => {
    expect(turnState(at({ pane: "" })).main).toBe("unknown");
    expect(turnState(at({ pane: "\n\n  \n" })).main).toBe("unknown");
  });

  test("画面在压缩（手动 /compact，watcher 还没置 compacting）→ compacting，排在 busy 前面（人类消息不 C-c 掉压缩）", () => {
    const compacting = ["✻ Compacting conversation… (12s)", "  ▰▰▰▱▱▱▱ 37%", footer([])].join("\n");
    const s = turnState(at({ pane: compacting, status: "done" }));
    expect(s.main).toBe("compacting");
    expect(agentMsgMustWait(s)).toBe(true);
  });

  test("抓不到画面 → unknown（押后闸放行）；CC 横幅和忙碌标记都不在 → unknown", () => {
    const none = turnState(at({ pane: null }));
    expect(none.main).toBe("unknown");
    expect(agentMsgMustWait(none)).toBe(false);
    expect(turnState(at({ pane: `${RULE}\n  some dialog\n${RULE}` })).main).toBe("unknown");
  });
});

describe("turnState：Codex / Pi 只看事件态", () => {
  // 输出里恰好有 CC 的 spinner 形状和后台字样：旧判据会把 Pi 窗口判忙
  const PI_LOOKS_CC_BUSY = piPane("Reading… (3s · ↓ 1k tokens)\nWaiting for 1 background agent");
  test("Pi 窗口不被 CC 正则误判：done → idle、bg=false", () => {
    expect(paneLooksWorking(PI_LOOKS_CC_BUSY)).toBe(true);
    for (const runtime of ["pi", "codex"]) {
      const s = turnState(at({ pane: PI_LOOKS_CC_BUSY, runtime, status: "done" }));
      expect(s).toEqual({ main: "idle", bg: false });
    }
  });
  test("thinking → busy；没画面也照判", () => {
    expect(turnState(at({ pane: null, runtime: "pi", status: "thinking" })).main).toBe("busy");
    expect(turnState(at({ pane: piPane(""), runtime: "codex", status: "thinking" })).main).toBe("busy");
  });
  test("bg 只来自 bg-activity", () => {
    expect(turnState(at({ pane: PI_LOOKS_CC_BUSY, runtime: "pi", bgActive: true })).bg).toBe(true);
  });
});

describe("后台 subagent 结束 → CC 自动开 task-notification 回合", () => {
  // 沙箱实抓：subagent 结束 26ms 后通知回合就开了，spinner 一出来就判忙——撞车靠这个挡，不靠时间窗
  const NOTIFY_TURN = [
    "⏺ Agent \"Run 4 sequential sleeps\" finished · 8s", "", "⏺ Calling claudestra…", "",
    "✳ Booping… (7s · ↓ 354 tokens)", "  ⎿  Tip: Run /install-slack-app to use Claude in Slack", footer([]),
  ].join("\n");
  test("通知回合在跑 → busy，agent 消息押", () => {
    const s = turnState(at({ pane: NOTIFY_TURN, status: "done" }));
    expect(s.main).toBe("busy");
    expect(agentMsgMustWait(s)).toBe(true);
  });
});

describe("押后队列：只剩后台在跑时 flush 能投出 agent 消息", () => {
  test("working 注入 agentMsgMustWait(turnState) → 押着的 agent 消息投出、出队", async () => {
    const ws = {} as never;
    const to = { kind: "local", agentName: "agent-pm", channelId: "c-pm", ws } as LocalEndpoint;
    const env = {
      from: { kind: "local", agentName: "agent-task-t3", channelId: "c-t3", ws }, to, intent: "request", content: "交付",
      meta: { messageId: "m1", triggerKind: "agent_tool", ts: "2026-09-28T00:00:00Z", threadId: "thr-1" },
    } as Envelope;
    const held = new HeldQueue(null);
    held.set("c-pm", [{ env, to, heldAt: 1 }]);
    const delivered: string[] = [];
    await flushHeld({
      held, compacting: () => false, isHumanRequest: () => false, client: () => ({ ws }), touch: () => undefined,
      working: async () => agentMsgMustWait(turnState({ pane: ONLY_BG, status: "done" })),
      deliver: async (e) => (delivered.push(String(e.content)), { envelope: e, outcome: { kind: "sent" } }),
    }, "c-pm", "sweep");
    expect(delivered).toEqual(["交付"]);
    expect(held.get("c-pm") ?? []).toEqual([]);
  });
});

describe("thinking 反向对账（permission-watcher）的单帧判据", () => {
  test("只剩后台在跑、事件态卡 thinking → 判卡住（会收敛成带 bgPending 的 done）", () => {
    expect(thinkingLooksStuck(ONLY_BG, "thinking", false)).toBe(true);
    expect(thinkingLooksStuck(WAITING_BG, "thinking", false)).toBe(true);
  });
  test("主回合在跑 / 长 MCP 调用 / 本来就不是 thinking → 不收敛", () => {
    expect(thinkingLooksStuck(MAIN_BUSY_WITH_BG, "thinking", false)).toBe(false);
    expect(thinkingLooksStuck(ONLY_BG, "thinking", true)).toBe(false);
    expect(thinkingLooksStuck(ONLY_BG, "done", false)).toBe(false);
  });
});

describe("N7 对抗复核", () => {
  const rows = ["  ⏺ main", ...Array.from({ length: 6 }, (_, k) => `  ◯ general-purpose  task ${k}                  ${k + 10}s · ↓ 20.${k}k tokens`)];
  test("P1：回合开头首个 token 前的 spinner 不带括号，事件态还是 done → busy，agent 消息押", () => {
    const pane = ["⏺ Background command \"Sleep 20 seconds in background\" completed (exit code 0)", "", "✢ Concocting…", "  ⎿  Tip: x", "", footer([])].join("\n");
    const s = turnState(at({ pane, status: "done" }));
    expect(s.main).toBe("busy");
    expect(agentMsgMustWait(s)).toBe(true);
  });
  test("5：回合中途自动压缩，事件态还是 thinking → compacting（人类消息不 C-c 掉压缩）", () => {
    const pane = ["✻ Compacting conversation… (40s)", "  ▰▰▰▱▱▱▱ 37%", "", footer([])].join("\n");
    expect(turnState(at({ pane, status: "thinking" })).main).toBe("compacting");
  });
  test("6：6 个后台 agent 行把 spinner 挤出尾部 14 行——仍判 busy，对账也不会把它误收敛成 done", () => {
    const pane = ["✽ Pondering… (1m 3s · ↓ 2.1k tokens)", "  ⎿  Tip: x", "", footer(rows)].join("\n");
    expect(turnState(at({ pane, status: "done" })).main).toBe("busy");
    expect(thinkingLooksStuck(pane, "thinking", false)).toBe(false);
    const idle = ["✻ Worked for 46s · done 9:51 PM", "", footer(rows)].join("\n");
    expect(turnState(at({ pane: idle, status: "done" }))).toEqual({ main: "idle", bg: true });
  });
});

describe("压缩画面（N7 对抗复验 P2-B / F）", () => {
  const rows = ["  ⏺ main", ...Array.from({ length: 6 }, (_, k) => `  ◯ general-purpose  task ${k}   ${k + 10}s · ↓ 20.${k}k tokens`)];
  test("底栏 6 个后台行时仍认得压缩（permission-watcher 置 compacting 也用这个判据）", () => {
    const pane = ["⏺ x", "", "✻ Compacting conversation… (12s)", "", footer(rows)].join("\n");
    expect(paneShowsCompacting(pane)).toBe(true);
    expect(turnState(at({ pane, status: "done" })).main).toBe("compacting");
  });
  test("空闲画面正文里提到 compacting 不算（锚定 spinner 行）", () => {
    const pane = ["  我们下一步要处理 Compacting 期间的消息押后。", "", "✻ Worked for 12s · done 6:31 PM", "", footer([])].join("\n");
    expect(paneShowsCompacting(pane)).toBe(false);
    expect(turnState(at({ pane, status: "done" })).main).toBe("idle");
  });
});

