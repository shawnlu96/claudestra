/**
 * 按窗口的执行权（bridge/ctx-boundary-inject.ts withWindow）：自动压缩、手动按钮（injectCompact 自己拿）、批量动作（runOne 整串拿着）
 * 往同一个窗口发键互斥，后到的直接跳过、一个键不按；同一条流程里再进放行。codex r4 P1-1 的两种交错（两个 injectCompact、
 * 批量 runOne 对自动注入）在这里钉死：假终端只收到一条 /compact。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ctxBoundaryTick, resetCtxBoundaryState } from "../src/bridge/ctx-boundary.js";
import { agentTarget, holdsWindow, injectCompact, sweepPendingEcho, withWindow, type InjectDeps } from "../src/bridge/ctx-boundary-inject.js";
import { lpWindowOf } from "../src/bridge/fleet/lp-monitor.js";
import { runOne } from "../src/bridge/fleet/runner.js";
import { normalizeCompactKeep } from "../src/lib/ctx-boundary-policy.js";
import { windowKey } from "../src/lib/tmux-helper.js";
import { agent, harness, MIN, tgt } from "./ctx-boundary-harness.js";

const k = normalizeCompactKeep("保留测试");
if (!k.ok) throw new Error(k.why);
const KEEP = k.keep;
const IDLE = "some output\n❯ \n";
const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "lp", `${name}.ansi`), "utf8");
const neverBusy = (): never => {
  throw new Error("这里不该拿不到执行权");
};

/** 第一次抓屏拿到画面后先停住，等 release()：模拟抓屏返回得晚，别的入口趁这段时间插进来 */
function delayFirstCapture(deps: InjectDeps) {
  let arrive!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((r) => (arrive = r));
  const gate = new Promise<void>((r) => (release = r));
  let first = true;
  const slow: InjectDeps = {
    ...deps,
    capture: async (t) => {
      const p = await deps.capture(t);
      if (first) {
        first = false;
        arrive();
        await gate;
      }
      return p;
    },
  };
  return { slow, arrived, release };
}

/** 替别人拿着窗口，直到 release() */
function holdFor(target: string, who: string) {
  let release!: () => void;
  const done = withWindow(target, who, () => new Promise<void>((r) => (release = r)), neverBusy);
  return { release: () => (release(), done) };
}

beforeEach(() => resetCtxBoundaryState());

describe("窗口执行权", () => {
  test("两个入口同时注入同一个窗口：后到的直接跳过、不敲键；前一个做完后 15 分钟守卫接着挡；别的窗口不受影响", async () => {
    const h = harness([]);
    const t = tgt("agent-x");
    const d = delayFirstCapture(h.deps);
    const first = injectCompact(t, { action: "compact", keep: KEEP }, d.slow);
    await d.arrived;
    const second = await injectCompact(t, { action: "compact", keep: KEEP }, h.deps);
    expect(second).toMatchObject({ status: "skipped", reason: "busy", text: "另一次压缩注入正在操作这个窗口，这次没敲" });
    expect(h.sent).toEqual([]);
    expect(await injectCompact(tgt("agent-y"), { action: "compact", keep: KEEP }, h.deps)).toMatchObject({ status: "executed" });
    d.release();
    expect(await first).toMatchObject({ status: "executed" });
    expect(await injectCompact(t, { action: "compact", keep: KEEP }, h.deps)).toMatchObject({ status: "skipped", reason: "recent" });
    expect(h.sent.filter((s) => s.target === t.target)).toEqual([{ target: t.target, line: `/compact ${KEEP}` }]);
  });

  test("批量动作整串拿着窗口：它的压缩还没敲完时，自动注入被挡；批量照常做完，只敲一次", async () => {
    const h = harness([]);
    const t = tgt("agent-x");
    const d = delayFirstCapture(h.deps);
    const noKey = async () => {
      throw new Error("批量这边不该自己发键");
    };
    const fleet = runOne({ kind: "compact" }, "agent-x", t.target, {
      io: { capture: async () => (h.sent.length ? fx("compacting") : fx("lp-on-interrupted")), sendLine: noKey, erase: noKey, escape: noKey, sleep: async () => {} },
      keep: KEEP,
      deliverText: async () => ({ ok: true, queued: false }),
      compactedRecently: async () => false,
      compact: (_a, action, keep) => injectCompact(t, { action, keep }, d.slow),
    });
    await d.arrived;
    const auto = await injectCompact(t, { action: "compact", keep: KEEP }, h.deps);
    expect(auto).toMatchObject({ status: "skipped", reason: "busy", text: "批量动作正在操作这个窗口，这次没敲" });
    d.release();
    expect(await fleet).toEqual({ agent: "agent-x", outcome: "done", detail: "已开始压缩" });
    expect(h.sent).toEqual([{ target: t.target, line: `/compact ${KEEP}` }]);
  });

  test("自动压缩一轮碰上批量正拿着窗口：这轮不抓屏不注入、记一行日志，放掉后下一轮照常", async () => {
    const h = harness([]);
    const a = agent({ ctx: 210_000, convTs: h.now - 4 * MIN });
    h.deps.agents = async () => [a];
    const held = holdFor(a.target, "批量动作");
    expect(await ctxBoundaryTick(h.deps)).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.logs).toContain(`🧭 上下文边界 跳过 ${a.name}：批量动作正在操作这个窗口`);
    await held.release();
    expect((await ctxBoundaryTick(h.deps))[0]?.inject?.status).toBe("executed");
  });

  test("批量正拿着窗口时它自己跳过：自动压缩 / 手动按钮拿着，批量不发键", async () => {
    const held = holdFor("master:=agent-x", "自动压缩");
    const r = await runOne({ kind: "lp-on" }, "agent-x", "master:=agent-x", {
      io: { capture: async () => neverBusy(), sendLine: neverBusy, erase: neverBusy, escape: neverBusy, sleep: async () => {} },
      keep: KEEP,
      deliverText: async () => ({ ok: true, queued: false }),
      compactedRecently: async () => false,
      compact: async () => neverBusy(),
    });
    expect(r).toEqual({ agent: "agent-x", outcome: "skipped", detail: "自动压缩正在操作这个窗口，没发" });
    await held.release();
  });

  test("同一条流程里再进直接放行；调用方没拿着窗口时它给的画面不算、锁里重抓", async () => {
    const h = harness([]);
    const t = tgt("agent-x");
    const stale = await h.deps.capture(t.target);
    h.win(t.target).pane = "Do you want to proceed?\n[menu]";
    expect(await injectCompact(t, { action: "compact", pane: stale }, h.deps)).toMatchObject({ status: "skipped", reason: "menu" });
    h.win(t.target).pane = IDLE;
    const r = await withWindow(t.target, "自动压缩", async () => injectCompact(t, { action: "compact", pane: await h.deps.capture(t.target) }, h.deps), neverBusy);
    expect(r).toMatchObject({ status: "executed" });
  });

  test("放掉之后遗留的回调不算拿着：别人拿着时它照样被挡", async () => {
    const t = "master:=agent-x";
    let go!: () => void;
    const gate = new Promise<void>((r) => (go = r));
    let later!: Promise<string>;
    await withWindow(t, "批量动作", async () => {
      expect(holdsWindow(t)).toBe(true);
      later = (async () => {
        await gate;
        return withWindow(t, "遗留回调", async () => "进来了", (who) => who);
      })();
    }, neverBusy);
    expect(holdsWindow(t)).toBe(false);
    const other = holdFor(t, "自动压缩");
    go();
    expect(await later).toBe("自动压缩");
    await other.release();
  });

  test("删上次留下的字也要拿窗口：别人拿着就留到下一轮", async () => {
    const h = harness([]);
    const t = tgt("agent-x");
    const w = h.win(t.target);
    w.onType = (win) => void (win.pane = "Do you want to proceed?\n[menu]");
    expect(await injectCompact(t, { action: "compact", keep: KEEP }, h.deps)).toMatchObject({ status: "failed", leftover: true });
    w.onType = undefined;
    w.pane = IDLE;
    const left = w.box;
    expect(left).toBe(`/compact ${KEEP}`);
    const held = holdFor(t.target, "批量动作");
    await sweepPendingEcho(h.deps, h.deps.log);
    expect(w.box).toBe(left);
    await held.release();
    await sweepPendingEcho(h.deps, h.deps.log);
    expect(w.box).toBe("");
  });

  test("批量和注入器认的是同一个窗口（大总管的 master:0 和 master:=master 也是）", () => {
    for (const n of ["agent-x", "master"]) expect(windowKey(lpWindowOf(n))).toBe(windowKey(agentTarget(n)));
    expect(windowKey("master:0")).toBe(windowKey("master:=master"));
  });
});
