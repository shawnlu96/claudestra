"use client";
import { useLayoutEffect, useRef, type ReactNode } from "react";

const HEIGHT = "--cstra-quota-notice-height";
const SAFE_TOP = "--cstra-quota-pane-safe-top";

/** Body collaboration sheets cannot inherit the flow row's reserved space; publish its measured height to them. */
export function QuotaWarningSlot({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    const shell = slot?.closest<HTMLElement>("#cstra-shell");
    if (!slot || !shell) return;
    const root = document.documentElement.style;
    const pane = shell.style;
    const oldHeight = root.getPropertyValue(HEIGHT), oldSafe = pane.getPropertyValue(SAFE_TOP);
    const heightPriority = root.getPropertyPriority(HEIGHT), safePriority = pane.getPropertyPriority(SAFE_TOP);
    const measure = () => {
      const height = slot.getBoundingClientRect().height;
      root.setProperty(HEIGHT, `${height}px`);
      // The row already owns the notch padding. Other pages and body modals keep their own safe area.
      if (height > 0) pane.setProperty(SAFE_TOP, "0px");
      else pane.removeProperty(SAFE_TOP);
    };
    measure();
    const observer = new ResizeObserver(measure);
    // Border-box also reports native safe-area padding changes, which leave the content box unchanged.
    observer.observe(slot, { box: "border-box" });
    return () => {
      observer.disconnect();
      if (oldHeight) root.setProperty(HEIGHT, oldHeight, heightPriority);
      else root.removeProperty(HEIGHT);
      if (oldSafe) pane.setProperty(SAFE_TOP, oldSafe, safePriority);
      else pane.removeProperty(SAFE_TOP);
    };
  }, []);
  return <div ref={ref} className="shrink-0 [&:not(:empty)]:pt-[env(safe-area-inset-top)]">{children}</div>;
}
