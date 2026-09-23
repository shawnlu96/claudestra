/**
 * 面板「渲染基准」分区:两把尺子,结果都进事件列表(docs/design-render-perf.md 阶段 0)。
 *   滚动基准:rAF 步进把 #cstra-msgs 匀速滚到底——量滚动 / 光栅化。
 *   侧栏基准:程序化让侧栏宽度来回摆动几秒——量右侧内容的整体重排(owner 2026-09-23
 *            发现拖侧栏是最稳定的掉帧复现;只在 ≥sm 的宽屏有意义)。
 * 两者都用 rAF 逐帧推进,帧间隔就是主线程 + 合成器这一帧的真实开销。
 */
import type GUI from "lil-gui";
import { devEvent } from "./dev-events";
import { formatBench, oscillate, summarizeFrames } from "./bench-stats";

const SCROLLER_ID = "cstra-msgs";
const SIDEBAR_SEL = 'aside[class*="sb-w"]';
const MAX_MS = 12_000;

type Run = { raf: number; t0: number; last: number; gaps: number[]; longTasks: number; po: PerformanceObserver | null };

function snapshot(): Record<string, number> {
  const el = document.getElementById(SCROLLER_ID);
  if (!el) return {};
  return { msgs: el.querySelectorAll("[data-mid]").length, dom: el.getElementsByTagName("*").length, height: Math.round(el.scrollHeight) };
}

/** 通用帧循环:每帧调 step(now, elapsed),step 返回非空字符串表示结束原因。返回停止函数。 */
function runFrames(label: string, step: (now: number, elapsed: number) => string | null, onDone: (line: string) => void): () => void {
  const t0 = performance.now();
  const run: Run = { raf: 0, t0, last: t0, gaps: [], longTasks: 0, po: null };
  const before = snapshot();
  if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
    run.po = new PerformanceObserver((list) => {
      run.longTasks += list.getEntries().length;
    });
    run.po.observe({ entryTypes: ["longtask"] });
  }
  const finish = (why: string) => {
    cancelAnimationFrame(run.raf);
    run.po?.disconnect();
    onDone(formatBench(`${label} ${why}`, summarizeFrames(run.gaps), { ...before, longTasks: run.longTasks, ms: Math.round(performance.now() - t0) }));
  };
  const tick = () => {
    const now = performance.now();
    run.gaps.push(now - run.last);
    const why = step(now, now - run.last);
    run.last = now;
    if (why) return finish(why);
    if (now - t0 > MAX_MS) return finish("超时");
    run.raf = requestAnimationFrame(tick);
  };
  run.raf = requestAnimationFrame(tick);
  return () => finish("手动停止");
}

/** 从当前位置(通常先「滚到顶」)向下匀速滚到底。 */
function startScrollBench(pxPerSec: number, onDone: (line: string) => void): () => void {
  const el = document.getElementById(SCROLLER_ID);
  if (!el) {
    onDone("找不到 #cstra-msgs(不在会话页?)");
    return () => {};
  }
  let y = el.scrollTop;
  return runFrames(`scroll ${pxPerSec}px/s`, (_now, dt) => {
    y += (dt / 1000) * pxPerSec;
    el.scrollTop = y;
    return el.scrollTop + el.clientHeight >= el.scrollHeight - 1 ? "到底" : null;
  }, onDone);
}

/** 侧栏宽度在 240–480px 之间正弦摆动 seconds 秒,结束后恢复原值。 */
function startSidebarBench(seconds: number, onDone: (line: string) => void): () => void {
  const aside = document.querySelector<HTMLElement>(SIDEBAR_SEL);
  if (!aside || window.innerWidth < 640) {
    onDone("侧栏基准需要 ≥640px 的宽屏(手机上侧栏不占宽度)");
    return () => {};
  }
  const original = aside.style.getPropertyValue("--sb-w");
  const restore = () => {
    if (original) aside.style.setProperty("--sb-w", original);
    else aside.style.removeProperty("--sb-w");
  };
  const t0 = performance.now();
  return runFrames(`sidebar ${seconds}s`, (now) => {
    aside.style.setProperty("--sb-w", `${Math.round(oscillate(now - t0, 240, 480, 1500))}px`);
    if (now - t0 >= seconds * 1000) {
      restore();
      return "结束";
    }
    return null;
  }, (line) => {
    restore();
    onDone(line);
  });
}

export function mountBenchSection(gui: GUI): () => void {
  const f = gui.addFolder("渲染基准 / Bench");
  f.close();
  const p = { 滚动速度px每秒: 1200, 侧栏摆动秒数: 4, 结果: "-" };
  f.add(p, "滚动速度px每秒", 300, 4000, 100);
  f.add(p, "侧栏摆动秒数", 2, 10, 1);
  f.add(p, "结果").listen().disable();
  let stop: (() => void) | null = null;
  const done = (line: string) => {
    stop = null;
    p.结果 = line;
    devEvent("bench", line);
  };
  const a = {
    滚到顶: () => {
      const el = document.getElementById(SCROLLER_ID);
      if (el) el.scrollTop = 0;
    },
    开始滚动基准: () => {
      stop?.();
      stop = startScrollBench(p.滚动速度px每秒, done);
    },
    开始侧栏基准: () => {
      stop?.();
      stop = startSidebarBench(p.侧栏摆动秒数, done);
    },
    停止: () => {
      stop?.();
      stop = null;
    },
  };
  for (const k of Object.keys(a) as (keyof typeof a)[]) f.add(a, k);
  return () => {
    stop?.();
    f.destroy();
  };
}
