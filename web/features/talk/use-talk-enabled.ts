"use client";
/**
 * Chat 入口开没开（lib/talk-gate.ts）：侧栏与 /talk 页各挂一次，切机器重读。设置页改完调 announceTalkEnabled，
 * 已挂载的立刻跟上，不用刷新。
 */
import { useEffect, useState } from "react";
import { getSettings } from "@/lib/api/settings";
import { talkOnFor } from "@/lib/talk-gate";
import { useMachineFp } from "./use-talk";

const listeners = new Set<(on: boolean) => void>();

/** 设置页改完调：已挂载的（都在当前这台机器上）立刻跟上 */
export function announceTalkEnabled(on: boolean): void {
  for (const l of listeners) l(on);
}

/** null = 当前这台机器的还没读到（切机器时不沿用上一台的，lib/talk-gate.ts talkOnFor） */
export function useTalkEnabled(): boolean | null {
  const fp = useMachineFp();
  const [rec, setRec] = useState<{ fp: string | null; on: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    const set = (on: boolean) => live && setRec({ fp, on });
    getSettings()
      .then((s) => set(s.talkEnabled))
      .catch(() => set(false)); // 读不到（老 bridge / 断网）按关：只是少一个入口，Chat 的数据不受影响
    listeners.add(set);
    return () => {
      live = false;
      listeners.delete(set);
    };
  }, [fp]);
  return talkOnFor(rec, fp);
}
