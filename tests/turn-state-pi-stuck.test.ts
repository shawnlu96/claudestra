/**
 * PSF-1：Pi 回合结束了，但别的扩展在 agent_settled 里不返回，挡住了我们上报 Stop，事件态卡在 thinking。
 * 画面两帧都是 Pi 的空闲画面（🔗 状态行在、没有内嵌文字的忙碌横线）且安静过阈值 → main 判 idle，押后消息照常投。
 * Pi 画面样本同 tests/turn-state.test.ts / tests/pi-idle-verdict.test.ts。
 */
import { describe, expect, test } from "bun:test";
import { PI_STUCK_THINKING_QUIET_MS } from "../src/lib/pi-stuck-thinking.js";
import { agentMsgMustWait, STUCK_THINKING_QUIET_MS, turnState, type TurnInput } from "../src/lib/turn-state.js";

const piPane = (body: string, indicator = "─".repeat(52)) =>
  [body, indicator, "─".repeat(52), "~/projects/x (develop) • agent-pi_x", "↑17M ↓2.8M R1032M (auto)", "🔗 agent-pi_x 💬 pi--10", ""].join("\n");
const PI_IDLE = piPane("  已回复。");
const PI_BUSY = piPane("  正在读文件…", "── ⠧ Working ─────────────────────────────────────");
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
  test("只对 Pi 生效：Codex 窗口出现同样画面仍只看事件态", () => {
    expect(stuck({ runtime: "codex" }).main).toBe("busy");
  });
  test("阈值远大于工具调用间停顿、远小于 30 分钟押后告警", () => {
    expect(PI_STUCK_THINKING_QUIET_MS).toBeGreaterThanOrEqual(60_000);
    expect(PI_STUCK_THINKING_QUIET_MS).toBeLessThanOrEqual(5 * 60_000);
  });
});
