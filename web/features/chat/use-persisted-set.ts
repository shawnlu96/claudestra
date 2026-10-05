"use client";
import { useState } from "react";

/**
 * 按设备记住的一组 id（localStorage 存 JSON 数组）：侧栏 project 折叠、派发者折叠共用。
 * 读写失败（隐私模式 / 配额 / 脏数据）一律退回内存态——只是这台设备记不住，不影响侧栏本身。
 */
export function usePersistedSet(key: string): [Set<string>, (id: string) => void, (id: string, on: boolean) => void] {
  const [set, setSet] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const v = JSON.parse(localStorage.getItem(key) || "[]");
      return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
    } catch {
      return new Set(); // 存的不是合法 JSON：当没记过
    }
  });
  // 第三项 put：按值写（已是该值就不动、不写存储），派发者折叠要同时改两个集合时用
  const put = (id: string, on?: boolean) =>
    setSet((prev) => {
      const want = on ?? !prev.has(id);
      if (prev.has(id) === want) return prev;
      const next = new Set(prev);
      if (want) next.add(id);
      else next.delete(id);
      try {
        localStorage.setItem(key, JSON.stringify([...next]));
      } catch {
        /* 隐私模式写不进：本次会话内的内存态照样生效 */
      }
      return next;
    });
  return [set, (id) => put(id), (id, on) => put(id, on)];
}
