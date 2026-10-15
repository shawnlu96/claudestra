/**
 * PSF-1：Pi 回合结束了，但别的扩展在 agent_settled 里不返回，挡住了我们上报 Stop，事件态卡在 thinking。
 * 画面两帧都是 Pi 的空闲画面（🔗 状态行在、没有内嵌文字的忙碌横线）且安静过阈值 → main 判 idle，押后消息照常投。
 * Pi 画面样本同 tests/turn-state.test.ts / tests/pi-idle-verdict.test.ts。
 */
import { describe, expect, test } from "bun:test";
import { flushHeld } from "../src/bridge/held-flush.js";
import { HeldQueue } from "../src/bridge/held-queue.js";
import type { Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { PI_STUCK_THINKING_QUIET_MS } from "../src/lib/pi-stuck-thinking.js";
import { agentMsgMustWait, holdsUntilIdle, STUCK_THINKING_QUIET_MS, turnState, type TurnInput } from "../src/lib/turn-state.js";

const piPane = (body: string, indicator = "─".repeat(52)) =>
  [body, indicator, "─".repeat(52), "~/projects/x (develop) • agent-pi_x", "↑17M ↓2.8M R1032M (auto)", "🔗 agent-pi_x 💬 pi--10", ""].join("\n");
const PI_IDLE = piPane("  已回复。");
const PI_BUSY = piPane("  正在读文件…", "── ⠧ Working ─────────────────────────────────────");
/**
 * 2026-10-15 只读抓的生产 Pi 1.2.0 agent（dn-review-pi，装了 pi-lens）空闲帧的尾部结构：两条 149 列分隔线、pi-lens 行、
 * 路径行、用量行、我们的 🔗 状态行。正文换成占位，路径 / 名字 / 用量数字 / 模型名全换掉，列宽和行序照原样。
 */
const RULE = "─".repeat(149);
const REAL_PI_IDLE = [
  " 占位：上一轮的回复正文。", "", RULE, "", RULE, " pi-lens  ✓ clean", "~/projects/x (main)",
  `↑0 ↓0 R0 CH0% 0%/0 (auto)${" ".repeat(49)}(provider) model • max`, "🔗 agent-pi_x 💬 pi-x-1 LSP Inactive ○", "", "", "",
].join("\n");
/** 认不出是 Pi：状态行不在画面上（被滚走 / 扩展没加载） */
const NO_STATUS = ["  已回复。", "─".repeat(52), "─".repeat(52), "~/projects/x (develop) • agent-pi_x", ""].join("\n");

const stuck = (over: Partial<TurnInput>) =>
  turnState({ runtime: "pi", status: "thinking", pane: PI_IDLE, paneAgain: PI_IDLE, quietMs: PI_STUCK_THINKING_QUIET_MS, ...over });

describe("Pi 事件态卡在 thinking、画面明确空闲（PSF-1）", () => {
  test("两帧都是 Pi 空闲画面、安静过阈值 → idle，押后消息放行", () => {
    const s = stuck({});
    expect(s.main).toBe("idle");
    expect(agentMsgMustWait(s)).toBe(false);
  });
  test("Pi 画面在忙（任一帧有忙碌横线）→ busy", () => {
    expect(stuck({ pane: PI_BUSY, paneAgain: PI_BUSY }).main).toBe("busy");
    expect(stuck({ paneAgain: PI_BUSY }).main).toBe("busy");
    expect(stuck({ pane: PI_BUSY }).main).toBe("busy");
  });
  test("安静时长没过阈值 → busy（CC 的 8 秒对 Pi 不够）", () => {
    expect(stuck({ quietMs: PI_STUCK_THINKING_QUIET_MS - 1 }).main).toBe("busy");
    expect(stuck({ quietMs: STUCK_THINKING_QUIET_MS }).main).toBe("busy");
    expect(stuck({ quietMs: undefined }).main).toBe("busy");
  });
  test("认不出 Pi 画面（没有状态行 / 没抓到 / 只抓了一帧）→ busy", () => {
    expect(stuck({ pane: NO_STATUS, paneAgain: NO_STATUS }).main).toBe("busy");
    expect(stuck({ pane: null }).main).toBe("busy");
    expect(stuck({ paneAgain: null }).main).toBe("busy");
    expect(stuck({ paneAgain: undefined }).main).toBe("busy");
  });
  test("审查 r1 P1：只有一行状态行、没有输入框边框 → 认不出，busy", () => {
    expect(stuck({ pane: "🔗 agent-pi_x", paneAgain: "🔗 agent-pi_x" }).main).toBe("busy");
  });
  test("审查 r1 P1：忙碌横线被 16 行工具输出隔在尾部 15 行之外 → 仍 busy", () => {
    const far = piPane(["── ⠧ Working " + "─".repeat(40), ...Array.from({ length: 16 }, (_, n) => `  工具输出 ${n}`)].join("\n"));
    expect(stuck({ pane: far, paneAgain: far }).main).toBe("busy");
  });
  test("页脚过长 / 只有一条边框 → 认不出，busy", () => {
    const longFooter = piPane("  已回复。").replace("🔗", Array.from({ length: 6 }, () => "x\n").join("") + "🔗");
    expect(stuck({ pane: longFooter, paneAgain: longFooter }).main).toBe("busy");
    const oneRule = ["  已回复。", "─".repeat(52), "~/projects/x", "🔗 agent-pi_x"].join("\n");
    expect(stuck({ pane: oneRule, paneAgain: oneRule }).main).toBe("busy");
  });
  test("bridge 断开时的状态行也认", () => {
    const off = PI_IDLE.replace(/🔗 .*/, "⚠️ bridge 断开");
    expect(stuck({ pane: off, paneAgain: off }).main).toBe("idle");
  });
  test("只对 Pi 生效：Codex 窗口出现同样画面仍只看事件态", () => {
    expect(stuck({ runtime: "codex" }).main).toBe("busy");
  });
  test("真 Pi 1.2.0 空闲画面结构（多一行 pi-lens 状态）也认得出", () => {
    expect(stuck({ pane: REAL_PI_IDLE, paneAgain: REAL_PI_IDLE }).main).toBe("idle");
  });
  test("阈值远大于工具调用间停顿、远小于 30 分钟押后告警", () => {
    expect(PI_STUCK_THINKING_QUIET_MS).toBeGreaterThanOrEqual(60_000);
    expect(PI_STUCK_THINKING_QUIET_MS).toBeLessThanOrEqual(5 * 60_000);
  });
});

describe("押后队列：Pi 漏报 Stop 后，扫描能把 agent 消息投出（PSF-1 验收 5 的链路部分）", () => {
  const ws = {} as never;
  const to = { kind: "local", agentName: "agent-pi_x", channelId: "c-pi", ws } as LocalEndpoint;
  const env = {
    from: { kind: "local", agentName: "agent-pm", channelId: "c-pm", ws }, to, intent: "request", content: "派活",
    meta: { messageId: "m1", triggerKind: "agent_tool", ts: "2026-10-15T00:00:00Z", threadId: "thr-1" },
  } as Envelope;
  const sweep = async (quietMs: number) => {
    const held = new HeldQueue(null);
    held.set("c-pi", [{ env, to, heldAt: 1 }]);
    const delivered: string[] = [];
    await flushHeld({
      held, compacting: () => false, isHumanRequest: () => false, client: () => ({ ws }), touch: () => undefined,
      working: async () => holdsUntilIdle("local", undefined, turnState({ runtime: "pi", status: "thinking", pane: REAL_PI_IDLE, paneAgain: REAL_PI_IDLE, quietMs })),
      deliver: async (e) => (delivered.push(String(e.content)), { envelope: e, outcome: { kind: "sent" } }),
    }, "c-pi", "sweep");
    return { delivered, left: held.get("c-pi") ?? [] };
  };
  test("安静过阈值的那次扫描投出、出队", async () => {
    const r = await sweep(PI_STUCK_THINKING_QUIET_MS);
    expect(r.delivered).toEqual(["派活"]);
    expect(r.left).toEqual([]);
  });
  test("阈值之前的扫描照旧押着", async () => {
    const r = await sweep(PI_STUCK_THINKING_QUIET_MS - 1_000);
    expect(r.delivered).toEqual([]);
    expect(r.left.length).toBe(1);
  });
});
