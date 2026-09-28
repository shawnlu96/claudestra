/**
 * lib/interrupt-gate.ts：所有打断键的唯一出口。空闲的 CC 在短窗内收到两次 C-c 会退出，所以
 * 两条同时到的人类消息、Discord 入站 + deliverToLocal 两道抢占、停止按钮双击，都只能发一次键。
 */
import { describe, expect, test } from "bun:test";
import { createInterruptGate, type InterruptGateDeps } from "../src/lib/interrupt-gate.js";
import type { TurnState } from "../src/lib/turn-state.js";

type Main = TurnState["main"];

function harness(opts: { main?: Main; runtime?: string; probeDelayMs?: number } = {}) {
  let clock = 1_790_000_000_000;
  const keys: string[] = [];
  const preempted: string[] = [];
  let probes = 0;
  let main: Main = opts.main ?? "busy";
  const deps: InterruptGateDeps = {
    resolve: async () => ({ win: "master:agent-a", runtime: opts.runtime }),
    probe: async () => {
      probes++;
      if (opts.probeDelayMs) await new Promise((r) => setTimeout(r, opts.probeDelayMs));
      return { main, bg: false };
    },
    interrupt: async (_w, rt) => {
      const k = rt === "codex" ? "Escape" : "C-c";
      keys.push(k);
      return [k];
    },
    escape: async () => void keys.push("Escape"),
    onPreempted: (agent) => void preempted.push(agent),
    sleep: async () => undefined,
    now: () => clock,
  };
  const gate = createInterruptGate(deps, 4_000);
  return {
    gate, keys, preempted,
    probes: () => probes,
    setMain: (m: Main) => void (main = m),
    advance: (ms: number) => void (clock += ms),
  };
}

describe("preempt：人类消息抢占", () => {
  test("主回合在跑 → 发一次 C-c、记「已打断」", async () => {
    const h = harness();
    expect(await h.gate.preempt("ch", "agent-a")).toBe(true);
    expect(h.keys).toEqual(["C-c"]);
    expect(h.preempted).toEqual(["agent-a"]);
  });

  test("空闲 / 压缩中 / 认不出画面 → 不打断", async () => {
    for (const m of ["idle", "compacting", "unknown"] as const) {
      const h = harness({ main: m });
      expect(await h.gate.preempt("ch", "agent-a")).toBe(false);
      expect(h.keys).toEqual([]);
    }
  });

  test("Pi / Codex 不抢占：连画面都不看", async () => {
    for (const runtime of ["pi", "codex"]) {
      const h = harness({ runtime });
      expect(await h.gate.preempt("ch", "agent-a")).toBe(false);
      expect(h.probes()).toBe(0);
    }
  });

  test("两条人类消息几乎同时到（判忙中间有 await）：只发一次 C-c", async () => {
    const h = harness({ probeDelayMs: 20 });
    const r = await Promise.all([h.gate.preempt("ch", "agent-a"), h.gate.preempt("ch", "agent-a")]);
    expect(r.filter(Boolean).length).toBe(1);
    expect(h.keys).toEqual(["C-c"]);
  });

  test("Discord 入站打断后 400ms 内 deliverToLocal 那道再判：冷却中，不发第二次（画面还像忙也一样）", async () => {
    const h = harness();
    await h.gate.preempt("ch", "agent-a");
    h.advance(400);
    expect(await h.gate.preempt("ch", "agent-a")).toBe(false);
    expect(h.keys).toEqual(["C-c"]);
    h.advance(4_000);
    expect(await h.gate.preempt("ch", "agent-a")).toBe(true);
  });

  test("不同频道互不影响", async () => {
    const h = harness();
    await Promise.all([h.gate.preempt("a", "agent-a"), h.gate.preempt("b", "agent-b")]);
    expect(h.keys).toEqual(["C-c", "C-c"]);
  });

  test("前一个出错不卡住同频道后面的", async () => {
    let n = 0;
    const keys: string[] = [];
    const gate = createInterruptGate({
      ...stubDeps(),
      probe: async () => {
        if (n++ === 0) throw new Error("tmux gone");
        return { main: "busy", bg: false };
      },
      interrupt: async () => (keys.push("C-c"), ["C-c"]),
    });
    const [first, second] = await Promise.allSettled([gate.preempt("ch", "x"), gate.preempt("ch", "x")]);
    expect(first.status).toBe("rejected");
    expect(second).toEqual({ status: "fulfilled", value: true });
    expect(keys).toEqual(["C-c"]);
  });
});

describe("manual：停止按钮 / /interrupt / API", () => {
  test("CC 主回合空闲：一个键都不发（空闲时连按两次 C-c 是退出键），也不占冷却", async () => {
    const h = harness({ main: "idle" });
    expect(await h.gate.manual("ch", "agent-a", "w", undefined)).toEqual({ keys: [] });
    h.setMain("busy");
    expect((await h.gate.manual("ch", "agent-a", "w", undefined)).keys).toEqual(["C-c"]);
  });

  test("认不出画面（弹窗盖住 / 文案变了）：只发 Esc", async () => {
    const h = harness({ main: "unknown" });
    expect((await h.gate.manual("ch", "agent-a", "w", undefined)).keys).toEqual(["Escape"]);
    expect(h.keys).toEqual(["Escape"]);
  });

  test("双击：第二下在冷却内去重，不发键", async () => {
    const h = harness();
    const r = await Promise.all([h.gate.manual("ch", "a", "w", undefined), h.gate.manual("ch", "a", "w", undefined)]);
    expect(h.keys).toEqual(["C-c"]);
    expect(r.filter((x) => x.deduped).length).toBe(1);
  });

  test("刚被人类消息抢占过：手动打断也在同一个冷却里", async () => {
    const h = harness();
    await h.gate.preempt("ch", "agent-a");
    h.advance(1_000);
    expect((await h.gate.manual("ch", "agent-a", "w", undefined)).deduped).toBe(true);
    expect(h.keys).toEqual(["C-c"]);
  });

  test("Codex / Pi 交给运行时（不看 CC 画面）", async () => {
    const h = harness({ main: "idle" });
    expect((await h.gate.manual("ch", "a", "w", "codex")).keys).toEqual(["Escape"]);
    expect(h.probes()).toBe(0);
  });
});

function stubDeps(): InterruptGateDeps {
  return {
    resolve: async () => ({ win: "w" }), probe: async () => ({ main: "busy", bg: false }), interrupt: async () => ["C-c"],
    escape: async () => undefined, onPreempted: () => undefined, sleep: async () => undefined,
  };
}
