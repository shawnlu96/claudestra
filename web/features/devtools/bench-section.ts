/**
 * 面板「渲染基准」分区:一键把消息列表从顶滚到底,记帧间隔分布,结果进事件列表。
 * 是 docs/design-render-perf.md 阶段 0 的量具——改渲染前后用同一把尺子。
 *
 * 滚动用 rAF 步进(不是 scrollTo smooth):每帧按经过时间推进 scrollTop,帧间隔就是
 * 主线程 + 合成器在这一帧的真实开销;吸底 / 上滑退出吸底等既有逻辑照常响应,所以
 * 跑之前列表会退出吸底(等于用户上滑),跑完不自动回底。
 */
import type GUI from "lil-gui";
import { devEvent } from "./dev-events";
import { formatBench, summarizeFrames } from "./bench-stats";

const SCROLLER_ID = "cstra-msgs";
const MAX_MS = 12_000;

type Run = { raf: number; t0: number; last: number; y: number; gaps: number[]; longTasks: number; po: PerformanceObserver | null };

function snapshot(el: HTMLElement): Record<string, number> {
  return {
    msgs: el.querySelectorAll("[data-mid]").length,
    dom: el.getElementsByTagName("*").length,
    height: Math.round(el.scrollHeight),
    vh: Math.round(el.clientHeight),
  };
}

function observeLongTasks(run: Run): void {
  if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes("longtask")) return;
  run.po = new PerformanceObserver((list) => {
    run.longTasks += list.getEntries().length;
  });
  run.po.observe({ entryTypes: ["longtask"] });
}

/** 从当前位置(通常先手动滚到顶)向下匀速滚到底。返回停止函数。 */
function startScrollBench(pxPerSec: number, onDone: (line: string) => void): () => void {
  const el = document.getElementById(SCROLLER_ID);
  if (!el) {
    onDone("[bench] 找不到 #cstra-msgs(不在会话页?)");
    return () => {};
  }
  const t0 = performance.now();
  const run: Run = { raf: 0, t0, last: t0, y: el.scrollTop, gaps: [], longTasks: 0, po: null };
  const before = snapshot(el);
  observeLongTasks(run);
  const finish = (why: string) => {
    cancelAnimationFrame(run.raf);
    run.po?.disconnect();
    const s = summarizeFrames(run.gaps);
    onDone(formatBench(`scroll ${pxPerSec}px/s ${why}`, s, { ...before, longTasks: run.longTasks, ms: Math.round(performance.now() - t0) }));
  };
  const tick = () => {
    const now = performance.now();
    run.gaps.push(now - run.last);
    run.y += ((now - run.last) / 1000) * pxPerSec;
    run.last = now;
    el.scrollTop = run.y;
    const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    if (atEnd) return finish("到底");
    if (now - t0 > MAX_MS) return finish("超时");
    run.raf = requestAnimationFrame(tick);
  };
  run.raf = requestAnimationFrame(tick);
  return () => finish("手动停止");
}

export function mountBenchSection(gui: GUI): () => void {
  const f = gui.addFolder("渲染基准 / Bench");
  f.close();
  const p = { 速度px每秒: 1200, 结果: "-" };
  f.add(p, "速度px每秒", 300, 4000, 100);
  f.add(p, "结果").listen().disable();
  let stop: (() => void) | null = null;
  const a = {
    滚到顶: () => {
      const el = document.getElementById(SCROLLER_ID);
      if (el) el.scrollTop = 0;
    },
    开始滚动基准: () => {
      stop?.();
      stop = startScrollBench(p.速度px每秒, (line) => {
        stop = null;
        p.结果 = line.replace(/^\[bench\] /, "");
        devEvent("bench", line.replace(/^\[bench\] /, ""));
      });
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
