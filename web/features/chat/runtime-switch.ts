"use client";
import { useEffect, type RefObject } from "react";

/** 切换器弹层：点面板外 / 按 Esc 关闭（Pi、Codex 两个切换器共用同一套交互） */
export function useDismiss(open: boolean, close: () => void, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close, ref]);
}

/** POST 一次切换；成功返回 null，失败返回给用户看的错误（fallback 是没拿到服务端文案时的兜底） */
export async function postRuntimeSwitch(url: string, body: Record<string, unknown>, fallback: string): Promise<string | null> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = (await res.json().catch(() => ({}) /* 回包不是 JSON（代理错误页之类）：按空处理，用状态码报错 */)) as { error?: string };
    return res.ok ? null : j.error || fallback;
  } catch {
    return fallback;
  }
}
