/**
 * lib/esc-guard.ts：同一窗口两次 Esc 实际落地 ≥1200ms（CC 连按两次 = Rewind）。窗口按 #{window_id} 认，
 * 大总管的 `master:0`（打断、抓取）和 `master:=master`（取消 AUQ）是同一个窗口；跨进程靠锁 + 共享时刻。
 * 回归：T13a 对抗式 P2-3、T13b 第 4 轮新 P2-1。
 */
import { describe, expect, test } from "bun:test";
import { createEscGuard, ESC_DOUBLE_TAP_MS, type EscGuardDeps } from "../src/lib/esc-guard.js";
import { windowKey } from "../src/lib/tmux-target.js";

/** 假时钟：sleep 推进时间；send 本身耗时 sendMs（模拟负载高时 tmux 慢） */
function world(opts: { ids?: Record<string, string>; sendMs?: number } = {}) {
  let clock = 1_000_000;
  const sent: { target: string; at: number }[] = [];
  const shared = new Map<string, number>();
  const held = new Set<string>();
  const deps: EscGuardDeps = {
    windowId: async (t) => opts.ids?.[t] ?? null,
    lock: async (key) => {
      while (held.has(key)) await new Promise((r) => setTimeout(r, 1));
      held.add(key);
      return { release: () => void held.delete(key) };
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
