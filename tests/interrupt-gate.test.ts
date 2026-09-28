/**
 * lib/interrupt-gate.ts：所有打断键的唯一出口。空闲的 CC 在短窗内收到两次 C-c 会退出，所以
 * 两条同时到的人类消息、Discord 入站 + deliverToLocal 两道抢占、停止按钮双击，都只能发一次键。
 */
import { describe, expect, test } from "bun:test";
import { createInterruptGate, type InterruptGateDeps } from "../src/lib/interrupt-gate.js";
import type { TurnState } from "../src/lib/turn-state.js";
import { paneShowsWallWait } from "../src/lib/quota-wall-text.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixture = (f: string) => readFileSync(join(import.meta.dir, "fixtures/quota-wall", `${f}.txt`), "utf8");

type Main = TurnState["main"];

function harness(opts: { main?: Main; runtime?: string; probeDelayMs?: number; screens?: string[] } = {}) {
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
    onPreempted: (agent) => void preempted.push(agent),
    ...(opts.screens ? { wallWait: async () => paneShowsWallWait(opts.screens!.length > 1 ? opts.screens!.shift()! : opts.screens![0]!) } : {}),
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
  test("人要停就发键，不看画面判据：判成空闲 / 认不出（API 重试行、新文案）也发 C-c", async () => {
    for (const m of ["idle", "unknown", "busy"] as const) {
      const h = harness({ main: m });
      expect((await h.gate.manual("ch", "w", undefined)).keys).toEqual(["C-c"]);
      expect(h.probes()).toBe(0);
    }
  });

  test("双击：1.5s 内第二下去重，不发键（空闲 CC 连按两次 C-c 是退出键）", async () => {
    const h = harness();
    const r = await Promise.all([h.gate.manual("ch", "w", undefined), h.gate.manual("ch", "w", undefined)]);
    expect(h.keys).toEqual(["C-c"]);
    expect(r.filter((x) => x.deduped).length).toBe(1);
    h.advance(1_600);
    expect((await h.gate.manual("ch", "w", undefined)).keys).toEqual(["C-c"]);
  });

  test("自动抢占之后 2s 点停止：不被 4s 抢占冷却吞掉，照发；1s 内才去重", async () => {
    const h = harness();
    await h.gate.preempt("ch", "agent-a");
    h.advance(1_000);
    expect((await h.gate.manual("ch", "w", undefined)).deduped).toBe(true);
    h.advance(1_000);
    expect((await h.gate.manual("ch", "w", undefined)).keys).toEqual(["C-c"]);
    expect(h.keys).toEqual(["C-c", "C-c"]);
  });

  test("刚手动停过：4s 内人类消息不再自动抢占", async () => {
    const h = harness();
    await h.gate.manual("ch", "w", undefined);
    h.advance(2_000);
    expect(await h.gate.preempt("ch", "agent-a")).toBe(false);
    expect(h.keys).toEqual(["C-c"]);
  });

  test("抢占 + 停止按钮 + API 三路同时到：只发一次键", async () => {
    const h = harness({ probeDelayMs: 10 });
    await Promise.all([h.gate.preempt("ch", "agent-a"), h.gate.manual("ch", "w", undefined), h.gate.manual("ch", "w", undefined)]);
    expect(h.keys).toEqual(["C-c"]);
  });

  test("Codex 交给运行时（它自己只在忙时发 Esc）", async () => {
    const h = harness({ main: "idle" });
    expect((await h.gate.manual("ch", "w", "codex")).keys).toEqual(["Escape"]);
  });
});

function stubDeps(): InterruptGateDeps {
  return {
    resolve: async () => ({ win: "w" }), probe: async () => ({ main: "busy", bg: false }), interrupt: async () => ["C-c"],
    onPreempted: () => undefined, sleep: async () => undefined,
  };
}

describe("preempt：停在额度菜单 / 撞墙倒计时一个键都不发（T24 PM 口径：Discord 入站和 deliverToLocal 共用这一道）", () => {
  test("真实菜单、倒计时、带假输入框、窄窗口折行的画面：判忙也不发键", async () => {
    for (const f of ["menu-5-items", "menu-on-credits", "menu-no-lp", "walled", "walled-channel", "menu-fakebox", "walled-fakebox", "menu-narrow60"]) {
      const h = harness({ main: "busy", screens: [fixture(f)] });
      expect([f, await h.gate.preempt("ch", "agent-a")]).toEqual([f, false]);
      expect([f, h.keys]).toEqual([f, []]);
    }
  });

  test("判忙那一刻还没有菜单、300ms 后复核时弹出来了：不发键", async () => {
    const h = harness({ main: "busy", screens: [fixture("busy-queued"), fixture("menu-5-items")] });
    expect(await h.gate.preempt("ch", "agent-a")).toBe(false);
    expect(h.keys).toEqual([]);
  });

  test("真在跑的画面照常抢占", async () => {
    const h = harness({ main: "busy", screens: [fixture("busy-queued")] });
    expect(await h.gate.preempt("ch", "agent-a")).toBe(true);
    expect(h.keys).toEqual(["C-c"]);
  });
});
