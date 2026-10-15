/**
 * PSF-1 验收追加 7（capture-race）：probeTurnAt 隔 1 秒抓第二帧期间，agent 开了新回合 / 进了压缩，
 * 这次判闲作废——不能拿采样前读的状态和安静时长判 idle，也不能把事件态收成 done。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { __resetEventBusForTest, emitEvent, getAgentStatus } from "../src/bridge/event-bus.js";
import { probeTurnAt } from "../src/bridge/turn-probe.js";

const AGENT = "agent-pi_x";
const CH = "c-pi";
const RULE = "─".repeat(52);
const PI_IDLE = ["  已回复。", RULE, "", RULE, "~/projects/x (main) • agent-pi_x", "🔗 agent-pi_x 💬 pi-x-1", ""].join("\n");
const status = (s: "thinking" | "done" | "compacting", trigger: string, ts?: string) =>
  emitEvent({ agent: AGENT, chatId: CH, type: "agent_status", data: { status: s, trigger }, ...(ts ? { ts } : {}) });
const hostNeverAsked = async () => {
  throw new Error("tmux 上的 Pi 画面认得出时不该去问宿主");
};

/** 第一帧照常返回；第二帧抓屏期间先跑 during（注入新活动），再返回同样的空闲画面 */
function grabber(during?: () => void) {
  let n = 0;
  return async () => {
    if (n++ === 1) during?.();
    return PI_IDLE;
  };
}

beforeEach(() => {
  __resetEventBusForTest();
  status("thinking", "delivery", new Date(Date.now() - 10 * 60_000).toISOString()); // 10 分钟前点亮，之后 Stop 被挡住
});

describe("probeTurnAt：Pi 画面兜底的采样竞态", () => {
  test("采样期间没有新活动：判 idle，事件态收成 done（pane_idle）", async () => {
    const t = await probeTurnAt("w", "pi", AGENT, CH, hostNeverAsked, grabber());
    expect(t.main).toBe("idle");
    expect(getAgentStatus(AGENT)).toBe("done");
  });

  test("第二次抓屏期间开了新回合（thinking）：判 busy，不收 done", async () => {
    const t = await probeTurnAt("w", "pi", AGENT, CH, hostNeverAsked, grabber(() => status("thinking", "delivery")));
    expect(t.main).toBe("busy");
    expect(getAgentStatus(AGENT)).toBe("thinking");
  });

  test("第二次抓屏期间进了压缩：按当前事件态判 compacting，不收 done", async () => {
    const t = await probeTurnAt("w", "pi", AGENT, CH, hostNeverAsked, grabber(() => status("compacting", "compact_start")));
    expect(t.main).toBe("compacting");
    expect(getAgentStatus(AGENT)).toBe("compacting");
  });

  test("新活动的时间戳和上一条一样旧（只靠安静时长看不出）：照样作废", async () => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const t = await probeTurnAt("w", "pi", AGENT, CH, hostNeverAsked, grabber(() => status("thinking", "jsonl_activity", old)));
    expect(t.main).toBe("busy");
    expect(getAgentStatus(AGENT)).toBe("thinking");
  });
});
