"use client";
import { useEffect, useRef, useState } from "react";

/** Measure the mounting area, not the viewport: T58 embeds this in a narrower middle pane. */
export function useTeamWidth() {
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(1, Math.floor(entry.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}
