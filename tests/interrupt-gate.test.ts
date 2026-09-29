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

function harness(opts: { main?: Main; runtime?: string; probeDelayMs?: number; afterKey?: Main; allow?: boolean; noKeys?: boolean; screens?: string[]; probeSeq?: Main[] } = {}) {
  let clock = 1_790_000_000_000;
  const keys: string[] = [];
  const keyAt: number[] = [];
  const preempted: string[] = [];
  let probes = 0;
  let main: Main = opts.main ?? "busy";
  const deps: InterruptGateDeps = {
    resolve: async () => ({ win: "master:agent-a", runtime: opts.runtime }),
    probe: async () => {
      probes++;
      if (opts.probeDelayMs) await new Promise((r) => setTimeout(r, opts.probeDelayMs));
      if (opts.probeSeq?.length) main = opts.probeSeq.length > 1 ? opts.probeSeq.shift()! : opts.probeSeq[0]!;
      return { main, bg: false };
    },
    interrupt: async (_w, rt) => {
      if (opts.noKeys) return [];
      const k = rt === "codex" ? "Escape" : "C-c";
      keys.push(k);
      keyAt.push(clock);
      main = opts.afterKey ?? "idle"; // 键起作用：主回合停下（afterKey 模拟焦点在浮层、键没起作用）
      return [k];
    },
    ...(opts.allow === undefined ? {} : { allow: () => opts.allow! }),
    onPreempted: (agent) => void preempted.push(agent),
    ...(opts.screens ? { wallWait: async () => paneShowsWallWait(opts.screens!.length > 1 ? opts.screens!.shift()! : opts.screens![0]!) } : {}),
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
  };
  const gate = createInterruptGate(deps, 4_000);
  return {
    gate, keys, keyAt, preempted,
    probes: () => probes,
    setMain: (m: Main) => void (main = m),
    advance: (ms: number) => void (clock += ms),
  };
}

describe("preempt：人类消息抢占", () => {
  test("主回合在跑 → 发一次 C-c、记「已打断」", async () => {
    const h = harness();
    expect((await h.gate.preempt("ch", "agent-a")).fired).toBe(true);
    expect(h.keys).toEqual(["C-c"]);
    expect(h.preempted).toEqual(["agent-a"]);
  });

  test("空闲 / 压缩中 / 认不出画面 → 不打断", async () => {
    for (const m of ["idle", "compacting", "unknown"] as const) {
      const h = harness({ main: m });
      expect((await h.gate.preempt("ch", "agent-a")).fired).toBe(false);
      expect(h.keys).toEqual([]);
    }
  });

  test("Pi 不抢占（消息 steer 进回合）：连画面都不看", async () => {
    const h = harness({ runtime: "pi" });
    expect((await h.gate.preempt("ch", "agent-a")).fired).toBe(false);
    expect(h.probes()).toBe(0);
  });

  test("Codex 来了就打断（owner 09-28 拍板）：主回合在跑发 Esc，空闲不发", async () => {
    const h = harness({ runtime: "codex" });
    expect((await h.gate.preempt("ch", "agent-a")).fired).toBe(true);
    expect(h.keys).toEqual(["Escape"]);
    const idle = harness({ runtime: "codex", main: "idle" });
    expect((await idle.gate.preempt("ch", "agent-a")).fired).toBe(false);
    expect(idle.keys).toEqual([]);
  });

  test("两条人类消息几乎同时到（判忙中间有 await）：只发一次 C-c", async () => {
    const h = harness({ probeDelayMs: 20 });
    const r = await Promise.all([h.gate.preempt("ch", "agent-a"), h.gate.preempt("ch", "agent-a")]);
    expect(r.filter((x) => x.fired).length).toBe(1);
    expect(h.keys).toEqual(["C-c"]);
  });

  test("Discord 入站打断后 400ms 内 deliverToLocal 那道再判：冷却中，不发第二次（画面还像忙也一样）", async () => {
    const h = harness();
    await h.gate.preempt("ch", "agent-a");
    h.advance(400);
    expect((await h.gate.preempt("ch", "agent-a")).fired).toBe(false);
    expect(h.keys).toEqual(["C-c"]);
    h.advance(4_000);
    h.setMain("busy");
    expect((await h.gate.preempt("ch", "agent-a")).fired).toBe(true);
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
        return { main: keys.length ? "idle" : "busy", bg: false }; // 发键之后复核：已停下
      },
      interrupt: async () => (keys.push("C-c"), ["C-c"]),
    });
    const [first, second] = await Promise.allSettled([gate.preempt("ch", "x"), gate.preempt("ch", "x")]);
    expect(first.status).toBe("rejected");
    expect(second).toEqual({ status: "fulfilled", value: { fired: true } });
    expect(keys).toEqual(["C-c"]);
  });
});

describe("preempt stop：停字", () => {
  test("Pi 平时不抢占，停字照样发 C-c；Codex 发 Esc", async () => {
    const pi = harness({ runtime: "pi" });
    expect((await pi.gate.preempt("ch", "agent-a", { stop: true })).fired).toBe(true);
    expect(pi.keys).toEqual(["C-c"]);
    const cx = harness({ runtime: "codex" });
    expect((await cx.gate.preempt("ch", "agent-a", { stop: true })).fired).toBe(true);
    expect(cx.keys).toEqual(["Escape"]);
  });

  test("刚抢占完 1s 就说「停」：不被 4s 冷却吞掉，也不丢——等够 1.5s 最小间隔再发", async () => {
    const slept: number[] = [];
    const gate = createInterruptGate({
      ...stubDeps(),
      probe: async () => ({ main: slept.length ? "idle" : "busy", bg: false }),
      sleep: async (ms) => void slept.push(ms),
      now: () => 1_000_000 + (slept.length ? 1_000 : 0),
    }, 4_000);
    await gate.preempt("ch", "agent-a");
    slept.length = 0;
    const r = await gate.preempt("ch", "agent-a", { stop: true });
    expect(slept[0]).toBeGreaterThan(0); // 先等够间隔
    expect(r.fired || r.why === "not_busy").toBe(true);
  });

  test("抢占后马上说「停」：键落在插话那条开的回合上——离抢占的键至少 1.2s（收尾）+ 1.5s（最小间隔）", async () => {
    const h = harness();
    await h.gate.preempt("ch", "agent-a");
    h.setMain("busy"); // 插话那条投出去、开了新一回合
    expect((await h.gate.preempt("ch", "agent-a", { stop: true })).fired).toBe(true);
    expect(h.keyAt[1] - h.keyAt[0]).toBeGreaterThanOrEqual(1_200 + 1_500);
  });

  test("停字：画面忙 → 发键；本来空闲 → not_busy（调用方据此写「你刚才没有在跑的回合」）", async () => {
    const busy = harness();
    expect(await busy.gate.preempt("ch", "a", { stop: true })).toEqual({ fired: true });
    expect(await harness({ main: "idle" }).gate.preempt("ch", "a", { stop: true })).toEqual({ fired: false, why: "not_busy" });
  });

  test("判据失效（unknown）也发键；确认空闲 / 压缩中不发", async () => {
    expect((await harness({ main: "unknown" }).gate.preempt("ch", "a", { stop: true })).fired).toBe(true);
    for (const m of ["idle", "compacting"] as const) {
      const h = harness({ main: m });
      expect((await h.gate.preempt("ch", "a", { stop: true })).fired).toBe(false);
      expect(h.keys).toEqual([]);
    }
  });
});

describe("preempt：打没打断要以键和画面为准", () => {
  test("一个键都没发（Codex 空闲时不发 Esc）→ 不算打断，不记已打断", async () => {
    const h = harness({ noKeys: true });
    expect(await h.gate.preempt("ch", "a")).toEqual({ fired: false, why: "no_keys" });
    expect(h.preempted).toEqual([]);
  });
  test("发了键画面仍在忙（焦点在浮层 / copy-mode）→ ineffective，调用方不能说「你被打断了」", async () => {
    const h = harness({ afterKey: "busy" });
    expect(await h.gate.preempt("ch", "a")).toEqual({ fired: false, why: "ineffective" });
  });
  test("Codex 的忙闲来自 hook：发键后不复核画面（打断回报可能晚到）", async () => {
    const h = harness({ runtime: "codex", afterKey: "busy" });
    expect(await h.gate.preempt("ch", "a")).toEqual({ fired: true });
  });
  test("allow 说不行（Codex channel-server 不会打字投递 / 上次 Stop 后已抢占过）→ 不看画面、不发键", async () => {
    const h = harness({ allow: false });
    expect(await h.gate.preempt("ch", "a")).toEqual({ fired: false, why: "not_allowed" });
    expect(h.probes()).toBe(0);
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

  test("停在额度菜单（含 34 列折行）/ 撞墙倒计时上：谁按停止都一个键不发，回 wall（adv3 P2-4：Esc 会取消 owner 排好的自动续跑）", async () => {
    for (const f of ["walled", "menu-no-lp", "menu-narrow34", "menu-narrow34-credits-first"]) {
      const h = harness({ screens: [fixture(f)] });
      expect([f, await h.gate.manual("ch", "w", undefined)]).toEqual([f, { keys: [], wall: true }]);
      expect(h.keys).toEqual([]);
    }
  });

  test("双击：1.5s 内第二下去重，不发键（两次键挨太近：CC 双 Esc 开 Rewind、Codex 双 Esc 回溯遮罩）", async () => {
    const h = harness();
    const r = await Promise.all([h.gate.manual("ch", "w", undefined), h.gate.manual("ch", "w", undefined)]);
    expect(h.keys).toEqual(["C-c"]);
    expect(r.filter((x) => x.deduped).length).toBe(1);
    h.advance(1_600);
    expect((await h.gate.manual("ch", "w", undefined)).keys).toEqual(["C-c"]);
  });

  test("自动抢占之后马上点停止：不去重、不被 4s 抢占冷却吞掉，等够最小间隔照发（要停的是插话刚开的回合）", async () => {
    const h = harness();
    await h.gate.preempt("ch", "agent-a");
    expect((await h.gate.manual("ch", "w", undefined)).keys).toEqual(["C-c"]);
    expect(h.keys).toEqual(["C-c", "C-c"]);
    expect(h.keyAt[1] - h.keyAt[0]).toBeGreaterThanOrEqual(1_200 + 1_500); // 插话那条投出去（收尾 1.2s）之后再过最小间隔
  });

  test("刚手动停过：4s 内人类消息不再自动抢占", async () => {
    const h = harness();
    await h.gate.manual("ch", "w", undefined);
    h.advance(2_000);
    expect((await h.gate.preempt("ch", "agent-a")).fired).toBe(false);
    expect(h.keys).toEqual(["C-c"]);
  });

  test("抢占 + 停止按钮 + API 三路同时到：抢占一下、停止一下（等插话投出去再隔够 1.5s），第二个停止去重", async () => {
    const h = harness({ probeDelayMs: 10 });
    const r = await Promise.all([h.gate.preempt("ch", "agent-a"), h.gate.manual("ch", "w", undefined), h.gate.manual("ch", "w", undefined)]);
    expect(h.keys).toEqual(["C-c", "C-c"]);
    expect(h.keyAt[1] - h.keyAt[0]).toBeGreaterThanOrEqual(1_200 + 1_500);
    expect((r[2] as { deduped?: true }).deduped).toBe(true);
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
      expect([f, await h.gate.preempt("ch", "agent-a")]).toEqual([f, { fired: false, why: "wall_wait" }]);
      expect([f, h.keys]).toEqual([f, []]);
    }
  });

  test("判忙那一刻还没有菜单、300ms 后复核时弹出来了：不发键", async () => {
    const h = harness({ main: "busy", screens: [fixture("busy-queued"), fixture("menu-5-items")] });
    expect(await h.gate.preempt("ch", "agent-a")).toEqual({ fired: false, why: "wall_wait" });
    expect(h.keys).toEqual([]);
  });

  test("判忙之后 300ms 复核时回合已经结束（撞墙那一下 spinner 没了、菜单还没画出来）：不发键（wf2 keys-screens-2 → keys-screens-3）", async () => {
    const h = harness({ screens: [fixture("busy-queued")], probeSeq: ["busy", "idle"] });
    expect(await h.gate.preempt("ch", "agent-a")).toEqual({ fired: false, why: "not_busy" });
    expect(h.keys).toEqual([]);
  });

  test("停字在额度菜单上也不发键，如实回 wall_wait", async () => {
    const h = harness({ main: "busy", screens: [fixture("menu-5-items")] });
    expect(await h.gate.preempt("ch", "agent-a", { stop: true })).toEqual({ fired: false, why: "wall_wait" });
    expect(h.keys).toEqual([]);
  });

  test("真在跑的画面照常抢占（复核时仍在跑）", async () => {
    const h = harness({ main: "busy", screens: [fixture("busy-queued")], probeSeq: ["busy", "busy", "idle"] });
    expect(await h.gate.preempt("ch", "agent-a")).toEqual({ fired: true });
    expect(h.keys).toEqual(["C-c"]);
  });
});
