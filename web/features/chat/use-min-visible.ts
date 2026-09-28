import { useEffect, useRef, useState } from "react";

/** 最短亮灯:active 变 truthy 立即亮,变 null 后至少亮满 minMs 才熄——
 *  秒级完成的同步不再「一闪而过等于没亮」(owner 2026-08-08)。 */
export function useMinVisible<T>(active: T | null, minMs = 1200): T | null {
  const [shown, setShown] = useState<T | null>(active);
  const litAtRef = useRef(0);
  useEffect(() => {
    if (active !== null) {
      if (litAtRef.current === 0) litAtRef.current = Date.now();
      setShown(active);
      return;
    }
    const lit = litAtRef.current;
    if (lit === 0) { setShown(null); return; }
    const remain = minMs - (Date.now() - lit);
    if (remain <= 0) { litAtRef.current = 0; setShown(null); return; }
    const t = setTimeout(() => { litAtRef.current = 0; setShown(null); }, remain);
    return () => clearTimeout(t);
  }, [active, minMs]);
  return shown;
}
