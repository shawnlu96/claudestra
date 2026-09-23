/**
 * 开发者面板的采样 hook:stats.js 三格、rAF 帧间隔、输入延迟、long task、折叠态徽章文案。
 * 只被 dev-overlay.tsx(动态加载)引用,stats.js 不进普通用户的 bundle。
 *
 * 为什么不只用 stats.js:这项目历史上的卡顿是 React 提交突发(#185)和合成器卡住
 * (横滑 2 秒),不是 JS 帧率。stats.js 只看主线程 rAF;这里同时量最大帧间隔(合成器
 * 卡住时 rAF 也会迟到)、输入到下一帧(Safari 没有 Event Timing → pointerdown→双 rAF 手测)、
 * long task(Safari 没有 longtask API → null,面板显示 n/a)。
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import Stats from "stats.js";
import { allCounters, bumpCounter } from "./dev-events";

export type Meters = { fps: Stats; ms: Stats; gap: Stats; gapPanel: Stats.Panel };

/** 三个实例并排(单实例只能点击轮换,手机上想一眼看全)。 */
export function createMeters(): Meters {
  const fps = new Stats();
  fps.showPanel(0);
  const ms = new Stats();
  ms.showPanel(1);
  const gap = new Stats();
  const gapPanel = gap.addPanel(new Stats.Panel("gap", "#f8a", "#211"));
  gap.showPanel(3);
  for (const s of [fps, ms, gap]) s.dom.style.cssText = "position:relative;cursor:default;opacity:.95";
  return { fps, ms, gap, gapPanel };
}

/** 本组件只在客户端动态加载(ssr:false),lazy initializer 里建 DOM 是安全的。 */
export function useMeters(): Meters {
  const [m] = useState(createMeters);
  useEffect(() => {
    return () => {
      for (const s of [m.fps, m.ms, m.gap]) s.dom.remove();
    };
  }, [m]);
  return m;
}

/** rAF 循环:喂 stats.js,并记每秒最大帧间隔(ms)。读方读完要自己清零。 */
export function useFrameGap(m: Meters): RefObject<number> {
  const maxGapRef = useRef(0);
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      const gap = now - last;
      last = now;
      if (gap > maxGapRef.current) maxGapRef.current = gap;
      m.fps.update();
      m.ms.update();
      m.gapPanel.update(gap, 200);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [m]);
  return maxGapRef;
}

/** pointerdown / keydown → 双 rAF 的延迟,记每秒最大值。 */
export function useInputLag(): RefObject<number> {
  const ref = useRef(0);
  useEffect(() => {
    const onInput = () => {
      const t0 = performance.now();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const d = performance.now() - t0;
          if (d > ref.current) ref.current = d;
        })
      );
    };
    window.addEventListener("pointerdown", onInput, true);
    window.addEventListener("keydown", onInput, true);
    return () => {
      window.removeEventListener("pointerdown", onInput, true);
      window.removeEventListener("keydown", onInput, true);
    };
  }, []);
  return ref;
}

/** long task 计数(计数器 longtask / longtask200);不支持的浏览器保持 null。 */
export function useLongTasks(): RefObject<number | null> {
  const ref = useRef<number | null>(null);
  useEffect(() => {
    if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes("longtask")) return;
    ref.current = 0;
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        ref.current = (ref.current ?? 0) + 1;
        bumpCounter("longtask");
        if (e.duration >= 200) bumpCounter("longtask200");
      }
    });
    po.observe({ entryTypes: ["longtask"] });
    return () => po.disconnect();
  }, []);
  return ref;
}

/** 折叠态徽章文案,每秒刷新:fps · 最大帧间隔 · 提交突发次数。 */
export function useBadgeText(active: boolean, maxGapRef: RefObject<number>): string {
  const [badge, setBadge] = useState("dev");
  useEffect(() => {
    if (!active) return;
    let frames = 0;
    let raf = 0;
    const count = () => {
      frames++;
      raf = requestAnimationFrame(count);
    };
    raf = requestAnimationFrame(count);
    const timer = window.setInterval(() => {
      setBadge(`${frames}fps · gap ${Math.round(maxGapRef.current)}ms · burst ${allCounters()["commit-burst"] ?? 0}`);
      frames = 0;
      maxGapRef.current = 0;
    }, 1000);
    return () => {
      clearInterval(timer);
      cancelAnimationFrame(raf);
    };
  }, [active, maxGapRef]);
  return badge;
}
