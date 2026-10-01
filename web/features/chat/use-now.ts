import { useEffect, useState } from "react";

/** 每 ms 毫秒刷新一次的「现在」；ms=0 不起定时器（没有在跑的东西时不白白重渲染）。时钟只放在显示它的最小组件里 */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ms) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
