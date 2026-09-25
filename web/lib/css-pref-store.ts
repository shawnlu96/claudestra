"use client";
import { useSyncExternalStore } from "react";

/**
 * 「按设备存的外观偏好 → 运行时注入一段 CSS」的通用外壳（主题变量 / 字体共用）。
 * localStorage 存两份：原始偏好(textKey，设置面板回填)和预生成的 CSS(cssKey)；
 * cssKey 由 layout.tsx 的首帧内联脚本直接读出注入，避免暗色 / 自定义字体先闪一帧默认值——
 * 所以 build 必须是纯函数，脚本那边不再算一遍。
 */
export interface CssPrefStore<T> {
  get(): T;
  /** 保存 + 立即生效；isEmpty(next) 为真 = 恢复默认（清存储、摘掉 style）。 */
  set(next: T): void;
  /** 订阅当前值（设置面板用）。SSR 恒为 empty。 */
  useValue(): T;
}

export function createCssPrefStore<T>(opt: {
  textKey: string;
  cssKey: string;
  styleId: string;
  empty: T;
  /** 把 localStorage 里的 JSON 收成合法形状（字段缺失 / 类型不对时补默认） */
  normalize: (raw: unknown) => T;
  isEmpty: (v: T) => boolean;
  build: (v: T) => string;
}): CssPrefStore<T> {
  const read = (): T => {
    try {
      const raw = localStorage.getItem(opt.textKey);
      return raw ? opt.normalize(JSON.parse(raw)) : opt.empty;
    } catch {
      return opt.empty; // 隐私模式或损坏的存储：按未设置处理，页面照常渲染
    }
  };
  let current: T = typeof window !== "undefined" ? read() : opt.empty;
  const subs = new Set<() => void>();

  const applyCss = (css: string) => {
    let el = document.getElementById(opt.styleId) as HTMLStyleElement | null;
    if (!css) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement("style");
      el.id = opt.styleId;
      document.head.appendChild(el); // 排在所有样式表之后：不在任何 @layer 里，且同特异性时后者赢
    }
    el.textContent = css;
  };

  return {
    get: () => current,
    set(next) {
      current = next;
      const css = opt.isEmpty(next) ? "" : opt.build(next);
      try {
        if (!css) {
          localStorage.removeItem(opt.textKey);
          localStorage.removeItem(opt.cssKey);
        } else {
          localStorage.setItem(opt.textKey, JSON.stringify(next));
          localStorage.setItem(opt.cssKey, css);
        }
      } catch {
        /* 隐私模式：本次会话内仍生效，只是刷新后丢 */
      }
      applyCss(css);
      subs.forEach((f) => f());
    },
    useValue() {
      return useSyncExternalStore(
        (cb) => {
          subs.add(cb);
          return () => subs.delete(cb);
        },
        () => current,
        () => opt.empty,
      );
    },
  };
}
