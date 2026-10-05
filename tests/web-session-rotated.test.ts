/**
 * 网页收到 session_rotated（/clear 轮转、Stop 自愈）：ctx 先置空 → 重拉历史 → 历史落地后插「已清空」提示 → 刷 agent 列表（CLR1）。
 */
import { describe, expect, test } from "bun:test";
import { translate, type BridgeEvent } from "@/lib/chat/stream-shape";
import { rotationNotice, settleRotation, type RotationHost } from "@/features/chat/session-rotated";

const NEW = "b10e3ff1-0000-4000-8000-000000000002";
const ev = (data: Record<string, unknown>): BridgeEvent => ({ seq: 1, ts: "t", agent: "agent-w", chatId: "c", type: "session_rotated", data });

describe("session_rotated → rotated", () => {
  test("带 to 才映射，缺了不消费", () => {
    expect(translate(ev({ from: "a", to: NEW }), "zh", new Set())).toEqual({ t: "rotated", to: NEW });
    expect(translate(ev({ from: "a" }), "zh", new Set())).toBeNull();
  });
});

function host(active = "agent-w") {
  const log: string[] = [];
  const st = { activeAgent: active, agents: [{ name: "agent-w", contextTokens: 729_000 as number | null }], messages: [] as { id: string; role: "system"; content: string }[] };
  const h: RotationHost = {
    state: () => st as never,
    produce: (f) => f(st as never),
    reload: async () => {
      log.push(`reload ctx=${st.agents[0].contextTokens}`);
      st.messages = []; // 全量重载整体替换视图
    },
    refreshAgents: async () => void log.push(`agents msgs=${st.messages.length}`),
    nextId: () => "m1",
    lang: () => "zh",
  };
  return { h, st, log };
}

describe("settleRotation", () => {
  test("顺序：ctx 先置空（不留旧会话的值）→ 重拉历史 → 提示插在重载之后不被吞 → 刷列表", async () => {
    const { h, st, log } = host();
    await settleRotation(h, NEW);
    expect(log).toEqual(["reload ctx=null", "agents msgs=1"]);
    expect(st.messages.map((m) => [m.role, m.content])).toEqual([["system", "🧹 已清空上下文，新会话 b10e3ff1"]]);
    expect(st.agents[0].contextTokens).toBeNull();
  });

  test("重拉期间切走了 agent → 不往别的会话插提示", async () => {
    const { h, st } = host();
    const reload = h.reload;
    h.reload = async () => {
      await reload();
      st.activeAgent = "agent-other";
    };
    await settleRotation(h, NEW);
    expect(st.messages).toEqual([]);
  });

  test("英文文案", () => expect(rotationNotice(NEW, "en")).toBe("🧹 Context cleared — new session b10e3ff1"));
});
