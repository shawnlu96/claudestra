import { useSyncExternalStore } from "react";
import { activeAnswered, subscribeAnswered, type Answered } from "./answer-cooldown";

/** 刚答的那一笔（淡出中 / 防连点中），没有就是 null（answer-cooldown.ts） */
export function useJustAnswered(): Answered | null {
  return useSyncExternalStore(subscribeAnswered, activeAnswered, () => null);
}
