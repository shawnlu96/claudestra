"use client";
/**
 * Chat 入口开没开（lib/talk-gate.ts）：侧栏与 /talk 页各挂一次，切机器重读。设置页改完调 announceTalkEnabled，
 * 已挂载的立刻跟上，不用刷新。
 */
import { useEffect, useState } from "react";
import { getSettings } from "@/lib/api/settings";
import { useMachineFp } from "./use-talk";

const listeners = new Set<(on: boolean) => void>();

export function announceTalkEnabled(on: boolean): void {
  for (const l of listeners) l(on);
}

/** null = 还没读到 */
export function useTalkEnabled(): boolean | null {
  const fp = useMachineFp();
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    const set = (v: boolean) => live && setOn(v);
    getSettings()
      .then((s) => set(s.talkEnabled))
      .catch(() => set(false)); // 读不到（老 bridge / 断网）按关：只是少一个入口，Chat 的数据不受影响
    listeners.add(set);
    return () => {
      live = false;
      listeners.delete(set);
    };
  }, [fp]);
  return on;
}
