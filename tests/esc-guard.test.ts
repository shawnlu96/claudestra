/**
 * lib/esc-guard.ts：同一窗口两次 Esc 实际落地 ≥1200ms（CC 连按两次 = Rewind）。窗口按 #{window_id} 认，
 * 大总管的 `master:0`（打断、抓取）和 `master:=master`（取消 AUQ）是同一个窗口；跨进程靠锁 + 共享时刻。
 * 回归：T13a 对抗式 P2-3、T13b 第 4 轮新 P2-1。
 */
import { describe, expect, spyOn, test } from "bun:test";
import { createEscGuard, ESC_DOUBLE_TAP_MS, type EscGuardDeps } from "../src/lib/esc-guard.js";
import { windowKey } from "../src/lib/tmux-target.js";

/** 假时钟：sleep 推进时间；send 本身耗时 sendMs（模拟负载高时 tmux 慢） */
function world(opts: { ids?: Record<string, string>; sendMs?: number; noLock?: boolean; idError?: boolean; lostLock?: boolean } = {}) {
  let clock = 1_000_000;
  const sent: { target: string; at: number }[] = [];
  const shared = new Map<string, number>();
  const held = new Set<string>();
  const deps: EscGuardDeps = {
    windowId: async (t) => {
      if (opts.idError) throw new Error("tmux 超时");
      return opts.ids?.[t] ?? null;
    },
    lock: async (key) => {
      if (opts.noLock) return null;
      while (held.has(key)) await new Promise((r) => setTimeout(r, 1));
      held.add(key);
      return { release: () => void held.delete(key), held: () => !opts.lostLock };
    },
    readShared: (k) => shared.get(k) ?? 0,
    writeShared: (k, at) => void shared.set(k, at),
    send: async (target) => {
      clock += opts.sendMs ?? 0;
      sent.push({ target, at: clock });
    },
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
  };
  return { deps, sent, shared, advance: (ms: number) => void (clock += ms) };
}
const gaps = (sent: { at: number }[]) => sent.slice(1).map((s, i) => s.at - sent[i].at);

describe("同一窗口的不同写法", () => {
  test("大总管：先按 master:0 发（打断），马上按 windowTarget(\"master\") 发（取消 AUQ）→ 第二发等够 1.2 秒", async () => {
    const w = world({ ids: { "master:0": "@1", "master:=master": "@1" } });
    const esc = createEscGuard(w.deps);
    await esc("master:0");
    await esc("master:=master");
    expect(w.sent.map((s) => s.target)).toEqual(["master:0", "master:=master"]);
    expect(gaps(w.sent)[0]).toBeGreaterThanOrEqual(ESC_DOUBLE_TAP_MS);
  });
  test("@id 与名字写法也归到同一个窗口", async () => {
    const w = world({ ids: { "master:=agent-x": "@7", "@7": "@7" } });
    const esc = createEscGuard(w.deps);
    await Promise.all([esc("master:=agent-x"), esc("@7")]);
    expect(gaps(w.sent)[0]).toBeGreaterThanOrEqual(ESC_DOUBLE_TAP_MS);
  });
  test("解析不出窗口 id（窗口不在）：退回 windowKey，master:=x 与 master:x 仍算同一个", async () => {
    const w = world();
    const esc = createEscGuard(w.deps);
    await Promise.all([esc("master:=agent-x"), esc("master:agent-x")]);
    expect(gaps(w.sent)[0]).toBeGreaterThanOrEqual(ESC_DOUBLE_TAP_MS);
  });
  test("解析不出窗口 id 时，大总管的 master:0 与 windowTarget(\"master\") 也归到同一个键", async () => {
    expect(windowKey("master:0")).toBe(windowKey("master:=master"));
    const w = world();
    const esc = createEscGuard(w.deps);
    await Promise.all([esc("master:0"), esc("master:=master")]);
    expect(gaps(w.sent)[0]).toBeGreaterThanOrEqual(ESC_DOUBLE_TAP_MS);
  });
  test("不同窗口互不等待", async () => {
    const w = world({ ids: { "master:=a": "@1", "master:=b": "@2" } });
    const esc = createEscGuard(w.deps);
    await Promise.all([esc("master:=a"), esc("master:=b")]);
    expect(gaps(w.sent)[0]).toBe(0);
  });
});

describe("按「发完」计时", () => {
  test("tmux 调用很慢（900ms）：下一发从上一发落地算起，不从预定时刻算", async () => {
    const w = world({ ids: { t: "@1" }, sendMs: 900 });
    const esc = createEscGuard(w.deps);
    await Promise.all([esc("t"), esc("t"), esc("t")]);
    for (const g of gaps(w.sent)) expect(g).toBeGreaterThanOrEqual(ESC_DOUBLE_TAP_MS);
  });
  test("另一个进程（manager 子进程）刚发过：看共享时刻，照样等", async () => {
    const w = world({ ids: { t: "@1" } });
    w.shared.set("@1", 1_000_000 - 200);
    const esc = createEscGuard(w.deps);
    await esc("t");
    expect(w.sent[0].at - (1_000_000 - 200)).toBeGreaterThanOrEqual(ESC_DOUBLE_TAP_MS);
  });
  test("隔得够久就不等", async () => {
    const w = world({ ids: { t: "@1" } });
    const esc = createEscGuard(w.deps);
    await esc("t");
    w.advance(5_000);
    const before = w.sent[0].at + 5_000;
    await esc("t");
    expect(w.sent[1].at).toBe(before);
  });
  test("发键失败（strict）照样记时、放锁，错误抛给调用方", async () => {
    const w = world({ ids: { t: "@1" } });
    w.deps.send = async () => { throw new Error("tmux gone"); };
    const esc = createEscGuard(w.deps);
    await expect(esc("t", { strict: true })).rejects.toThrow("tmux gone");
    expect(w.shared.get("@1")).toBeGreaterThan(0);
    w.deps.send = async (target) => void w.sent.push({ target, at: w.deps.now() });
    await esc("t"); // 锁已放：不会卡住
    expect(w.sent.length).toBe(1);
  });
});

describe("拿不到锁（对抗式第 3 轮 P2-1：负载 107 时 7 路并发，第 6、7 发间隔 2ms 开出 Rewind）", () => {
  test("同一进程里按窗口排队，不会两发同时出去", async () => {
    const w = world({ ids: { t: "@1" }, sendMs: 300 });
    const esc = createEscGuard(w.deps);
    await Promise.all(Array.from({ length: 7 }, () => esc("t")));
    expect(w.sent.length).toBe(7);
    for (const g of gaps(w.sent)) expect(g).toBeGreaterThanOrEqual(ESC_DOUBLE_TAP_MS);
  });
  test("等不到锁就不发（fail-closed）：有告警；strict（打断键、取消 AUQ、wedge、按键面板）抛错如实回报，其余只告警", async () => {
    const w = world({ ids: { t: "@1" }, noLock: true });
    const esc = createEscGuard(w.deps);
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(esc("t", { strict: true })).rejects.toThrow("等不到窗口锁");
      await esc("t");
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0][0])).toContain("Esc 没发");
    } finally {
      warn.mockRestore();
    }
    expect(w.sent).toEqual([]);
    expect(w.shared.get("@1")).toBeUndefined(); // 没发就不记时
  });
  test("lastSentAt：按同一个窗口身份读最后一次发完的时刻（认出会话记录里的打断是程序发的键）", async () => {
    const w = world({ ids: { "master:0": "@1", "master:=master": "@1" } });
    const esc = createEscGuard(w.deps);
    expect(await esc.lastSentAt("master:0")).toBe(0);
    await esc("master:=master");
    expect(await esc.lastSentAt("master:0")).toBe(w.sent[0].at);
  });
});

describe("查窗口 id 出错（wf2 esc-keys-1）", () => {
  test("不退回另一个键去发：strict 报错、非 strict 只告警，一个键都不发", async () => {
    const w = world({ idError: true });
    const esc = createEscGuard(w.deps);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    await expect(esc("master:=a", { strict: true })).rejects.toThrow(/查不到窗口 id/);
    await esc("master:=a");
    warn.mockRestore();
    expect(w.sent).toEqual([]);
  });
  test("keyOf（程序敲字记录用）照旧退回 windowKey", async () => {
    const w = world({ idError: true });
    const esc = createEscGuard(w.deps);
    expect(await esc.keyOf("master:=a")).toBe(windowKey("master:=a"));
  });
});

describe("持锁进程被暂停过、锁已被回收（T13e r1 P1-2）", () => {
  test("发之前核对锁不再是自己的：不发，strict 抛错如实回报", async () => {
    const w = world({ lostLock: true });
    const esc = createEscGuard(w.deps);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    await expect(esc("master:agent-x", { strict: true })).rejects.toThrow("锁被当过期回收");
    await esc("master:agent-x");
    warn.mockRestore();
    expect(w.sent).toEqual([]);
    expect(w.shared.size).toBe(0); // 没发不记「发完」：之后真人按的 Esc 不会被认成程序发的（T13e r2 P2-3）
    expect(await esc.lastSentAt("master:agent-x")).toBe(0);
  });
});

describe("调用方的画面闸（gate）与非 Esc 键的同一把锁（T41a 对抗式 r1 P1-3：先查画面、再等锁 / 节流，等的时候弹出来的框挡不住）", () => {
  test("gate 在拿锁、等完双击节流、blocked 之后才跑，紧挨着发；gate 抛错 = 不发、错误原样给调用方", async () => {
    const w = world({ ids: { t: "@1" } });
    const esc = createEscGuard(w.deps);
    await esc("t");
    const order: string[] = [];
    const lock = w.deps.lock;
    w.deps.lock = async (k) => (order.push("lock"), lock(k));
    w.deps.sleep = async (ms) => void (order.push("throttle"), w.advance(ms));
    w.deps.blocked = async () => (order.push("blocked"), null);
    await esc("t", { strict: true, gate: async () => void order.push(`gate@${w.deps.now()}`) });
    expect(order).toEqual(["lock", "throttle", "blocked", `gate@${w.sent[1]!.at}`]);
    await expect(esc("t", { strict: true, gate: async () => { throw new Error("窗口停在额度菜单上"); } })).rejects.toThrow("额度菜单");
    expect(w.sent.length).toBe(2);
  });
  test("locked：非 Esc 的键拿同一个窗口的锁；Esc 还拿着锁（等节流）时排在后面，不会插进 Esc 的查画面和发键之间", async () => {
    const w = world({ ids: { a: "@1", b: "@1" } });
    const esc = createEscGuard(w.deps);
    await esc("a");
    const order: string[] = [];
    await Promise.all([
      esc("a", { gate: async () => void order.push("esc-gate") }).then(() => order.push("esc-sent")),
      esc.locked("b", async () => void order.push("key")),
    ]);
    expect(order).toEqual(["esc-gate", "esc-sent", "key"]);
  });
  test("locked 拿不到锁：fn 不跑，抛错", async () => {
    const w = world({ ids: { t: "@1" }, noLock: true });
    let ran = false;
    await expect(createEscGuard(w.deps).locked("t", async () => void (ran = true))).rejects.toThrow("等不到窗口锁");
    expect(ran).toBe(false);
  });
});
