/**
 * probeTurnAt 对没有画面判据的 ACP agent：事件态 thinking 时问宿主（AcpTurnLoop.busy）。宿主说闲 = 收成 done、判闲；
 * 宿主说忙 / 不答 = 判忙；查询途中有新活动不收。CC 不走这条（它有画面兜底），也不去问宿主。
 * 场景：Stop 收成 done 后宿主又推来晚于 done 的条目，jsonl-watcher 把事件态点回 thinking。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { __resetEventBusForTest, emitEvent, getAgentStatus, isPostTurnActivity, subscribeEvents } from "../src/bridge/event-bus.js";
import { clearOpenedBy, flushHeld, type FlushDeps } from "../src/bridge/held-flush.js";
import { HeldQueue } from "../src/bridge/held-queue.js";
import type { Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { probeTurnAt } from "../src/bridge/turn-probe.js";
import { agentMsgMustWait } from "../src/lib/turn-state.js";

const AGENT = "agent-rv-x";
const CH = "c-acp";
const status = (s: "thinking" | "done", trigger: string, ts?: string) =>
  emitEvent({ agent: AGENT, chatId: CH, type: "agent_status", data: { status: s, trigger }, ...(ts ? { ts } : {}) });

/** 现场：Stop 收成 done，7 秒后宿主推来子 agent 收尾条目，watcher 把事件态点回 thinking */
function replayIncident(): void {
  status("done", "stop_hook");
  const entryTs = Date.now() + 7_000;
  expect(isPostTurnActivity(AGENT, entryTs, entryTs)).toBe(true); // 晚于 done 的条目确实会被当成回合后活动
  status("thinking", "jsonl_activity");
}

function hostAnswers(v: boolean | null) {
  const calls: string[] = [];
  return { calls, hostBusy: async (ch: string) => (calls.push(ch), v) };
}

beforeEach(() => {
  __resetEventBusForTest();
  clearOpenedBy();
});

describe("probeTurnAt：ACP 事件态卡 thinking 时以宿主为准", () => {
  test("宿主报空闲：判闲，事件态收成 done（acp_host_idle）", async () => {
    replayIncident();
    const h = hostAnswers(false);
    const t = await probeTurnAt(null, "codex", AGENT, CH, h.hostBusy);
    expect(h.calls).toEqual([CH]);
    expect(t.main).toBe("idle");
    expect(agentMsgMustWait(t)).toBe(false);
    expect(getAgentStatus(AGENT)).toBe("done");
  });

  test("宿主真在回合中：照旧判忙，事件态不动", async () => {
    replayIncident();
    const t = await probeTurnAt(null, "codex", AGENT, CH, hostAnswers(true).hostBusy);
    expect(t.main).toBe("busy");
    expect(getAgentStatus(AGENT)).toBe("thinking");
  });

  test("宿主不答 / 出错（null）：按现有语义判忙", async () => {
    replayIncident();
    const t = await probeTurnAt(null, "codex", AGENT, CH, hostAnswers(null).hostBusy);
    expect(t.main).toBe("busy");
    expect(getAgentStatus(AGENT)).toBe("thinking");
  });

  test("查询途中有新活动（bridge 刚投了消息、点亮新回合）：不收成 done，仍判忙", async () => {
    replayIncident();
    const t = await probeTurnAt(null, "codex", AGENT, CH, async () => {
      status("thinking", "delivery", new Date(Date.now() + 1_000).toISOString());
      return false;
    });
    expect(t.main).toBe("busy");
    expect(getAgentStatus(AGENT)).toBe("thinking");
  });

  test("查询途中的新活动和上一条活动同一毫秒：照样认出，不收成 done", async () => {
    const ts = "2026-10-06T15:00:00.123Z";
    status("done", "stop_hook", "2026-10-06T15:00:00.000Z");
    status("thinking", "jsonl_activity", ts);
    const t = await probeTurnAt(null, "codex", AGENT, CH, async () => {
      status("thinking", "delivery", ts);
      return false;
    });
    expect(t.main).toBe("busy");
    expect(getAgentStatus(AGENT)).toBe("thinking");
  });

  /** 新活动隔 depth 层微任务才发出：1 层落在判定前，2、3 层落在宿主答完到判定之间或判定之后 */
  const later = (depth: number, fn: () => void): void => queueMicrotask(depth > 1 ? () => later(depth - 1, fn) : fn);

  test.each([1, 2, 3])("宿主答完前后排进来的新活动（微任务交错 %i 层）：done 不会落在新活动之后、盖掉新回合", async (depth) => {
    replayIncident();
    const triggers: string[] = [];
    const off = subscribeEvents({ agents: [AGENT] }, (e) => void triggers.push(String(e.data?.trigger)));
    const t = await probeTurnAt(null, "codex", AGENT, CH, async () => {
      later(depth, () => status("thinking", "delivery"));
      return false;
    });
    await Bun.sleep(0);
    off();
    // 新活动在判定前到 = 不收（busy）；在判定后到 = 先 done 再 thinking。两种都不能是「delivery 之后又来 done」
    expect(triggers).toEqual(t.main === "busy" ? ["delivery"] : ["acp_host_idle", "delivery"]);
    expect(getAgentStatus(AGENT)).toBe("thinking");
  });

  test("CC 不问宿主（画面兜底照旧）；不给频道也不问", async () => {
    replayIncident();
    const h = hostAnswers(false);
    expect((await probeTurnAt(null, "claude-code", AGENT, CH, h.hostBusy)).main).toBe("busy");
    expect((await probeTurnAt(null, "codex", AGENT, undefined, h.hostBusy)).main).toBe("busy");
    expect(h.calls).toEqual([]);
  });

  test("事件态已是 done：不问宿主，直接判闲", async () => {
    status("done", "stop_hook");
    const h = hostAnswers(true);
    expect((await probeTurnAt(null, "codex", AGENT, CH, h.hostBusy)).main).toBe("idle");
    expect(h.calls).toEqual([]);
  });
});

describe("押后消息：现场复现后扫描能投出去", () => {
  const ws = { tag: "acp-ws" } as never;
  const to = { kind: "local", agentName: AGENT, channelId: CH, ws } as LocalEndpoint;
  const env = {
    from: { kind: "local", agentName: "agent-scheduler", channelId: "c-s", ws },
    to, intent: "request", content: "LRP-1 r3 审查唤醒",
    meta: { messageId: "m-wake", triggerKind: "agent_tool", ts: "2026-10-06T14:37:58Z", threadId: "thr-wake" },
  } as Envelope;

  function deps(hostBusy: (ch: string) => Promise<boolean | null>) {
    const held = new HeldQueue(null);
    held.set(CH, [{ env, to, heldAt: Date.now() }]);
    const delivered: string[] = [];
    const d: FlushDeps = {
      held,
      compacting: () => false,
      working: async (ch, agent) => agentMsgMustWait(await probeTurnAt(null, "codex", agent, ch, hostBusy)),
      isHumanRequest: () => false,
      client: () => ({ ws }),
      deliver: async (e) => (delivered.push(String(e.content)), { envelope: e, outcome: { kind: "sent" } }),
      touch: () => {},
      settled: async () => true,
    };
    return { held, delivered, d };
  }

  test("宿主空闲：sweep 投出押后的唤醒", async () => {
    replayIncident();
    const h = deps(async () => false);
    await flushHeld(h.d, CH, "sweep");
    expect(h.delivered).toEqual(["LRP-1 r3 审查唤醒"]);
    expect(h.held.get(CH) ?? []).toEqual([]);
  });

  test("宿主真忙：继续押着", async () => {
    replayIncident();
    const h = deps(async () => true);
    await flushHeld(h.d, CH, "sweep");
    expect(h.delivered).toEqual([]);
    expect(h.held.get(CH)?.length).toBe(1);
  });
});
