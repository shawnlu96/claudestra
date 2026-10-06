/**
 * 网页收到 session_rotated（/clear 轮转、Stop 自愈）：ctx 先置空 → 重拉历史 → 历史落地后插「已清空」提示 → 刷 agent 列表（CLR1）。
 */
import { describe, expect, test } from "bun:test";
import { fullLoadHasMore, rotationNotice, toChatMessages } from "@/lib/chat/history-shape";
import { translate, type BridgeEvent } from "@/lib/chat/stream-shape";
import { settleRotation, type RotationHost } from "@/features/chat/session-rotated";

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

  test("重拉回来的历史里已有同一句（CC 在新会话开头记的 /clear）→ 不再插第二条", async () => {
    const { h, st } = host();
    h.reload = async () => void (st.messages = [{ id: "h9", role: "system", content: rotationNotice(NEW, "zh") }]);
    await settleRotation(h, NEW);
    expect(st.messages.map((m) => m.id)).toEqual(["h9"]);
  });

  test("英文文案", () => expect(rotationNotice(NEW, "en")).toBe("🧹 Context cleared — new session b10e3ff1"));
});

describe("刷新后走历史：两个会话接缝处也有「已清空」分隔", () => {
  test("新会话开头那条 /clear 记录 → 同一句提示；别的系统记录照旧", () => {
    const items = [
      { seq: 9, ts: "t1", role: "system" as const, text: "/clear" },
      { seq: 12, ts: "t2", role: "system" as const, text: "/model opus" },
    ];
    expect(toChatMessages(items, { sid: NEW, lang: "zh" }).map((m) => m.content)).toEqual(["🧹 已清空上下文，新会话 b10e3ff1", "/model opus"]);
    expect(toChatMessages(items.slice(0, 1), { sid: NEW, lang: "en" })[0].content).toBe("🧹 Context cleared — new session b10e3ff1");
  });
});

describe("全量加载后能否往上翻（clear 前的记录接得上）", () => {
  test("新会话不满一页、清单里还有更旧的会话 → 仍可往上翻（现场：b10e3ff1 292 条，上一个会话 69d8e0d8）", () => {
    expect(fullLoadHasMore(292, ["b10e3ff1", "69d8e0d8"], "b10e3ff1")).toBe(true);
  });
  test("拿满一页 → 可翻；不满且已是最旧的会话 → 到头了", () => {
    expect(fullLoadHasMore(500, ["only"], "only")).toBe(true);
    expect(fullLoadHasMore(10, ["only"], "only")).toBe(false);
    expect(fullLoadHasMore(10, ["b", "a"], "a")).toBe(false);
  });
});
