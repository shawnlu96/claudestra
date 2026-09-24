/**
 * 「该重启 / 该 pi update」提示的关闭记录（横幅 ✕ 与侧栏 ⬆ 共用）。
 *
 * 存 localStorage：只放在组件 state 里的话，关 B 会让 A 的横幅复活、刷新一次全部复活。
 * key 带版本号——装了**更新的**版本会重新提示；「Pi 可更新」只按最新版本号记，
 * 关一次覆盖所有 Pi 会话（`pi update` 是整机的事，不是某个会话的事）。
 * 本文件被根目录 bun test 编译（root tsconfig 没有 dom lib），localStorage 从 globalThis 取。
 */
import type { UpdateHint } from "@/lib/chat/agents";

export const UPDATE_HINT_DISMISS_KEY = "cstra_update_hint_dismissed";
const MAX_KEYS = 100; // 每个新版本一条，封顶防 localStorage 无限长

export function updateHintKey(agent: string, hint: UpdateHint): string {
  return hint.kind === "pi-update" ? `pi-update:${hint.latest}` : `${agent}:${hint.kind}:${hint.installed}`;
}

type Storage = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const store = () => (globalThis as unknown as { localStorage?: Storage }).localStorage;

const EMPTY: ReadonlySet<string> = new Set();
let dismissed: ReadonlySet<string> | null = null;
const listeners = new Set<() => void>();

/** useSyncExternalStore 的快照：引用只在关闭时换新（React 靠引用判变） */
export function getDismissedHints(): ReadonlySet<string> {
  if (dismissed) return dismissed;
  let keys: unknown = [];
  try {
    keys = JSON.parse(store()?.getItem(UPDATE_HINT_DISMISS_KEY) || "[]");
  } catch {
    /* 隐私模式禁用存储 / 内容损坏：当作都没关过，最坏只是提示再出现一次 */
  }
  dismissed = new Set(Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : []);
  return dismissed;
}
export function getDismissedHintsServer(): ReadonlySet<string> {
  return EMPTY;
}
export function subscribeDismissedHints(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function dismissUpdateHint(key: string): void {
  const next = [...getDismissedHints()].filter((k) => k !== key).concat(key).slice(-MAX_KEYS);
  dismissed = new Set(next);
  try {
    store()?.setItem(UPDATE_HINT_DISMISS_KEY, JSON.stringify(next));
  } catch {
    /* 存不进（隐私模式/配额满）：本页内照样关掉，只是刷新后会再提示 */
  }
  for (const l of listeners) l();
}

/** 测试用：丢掉内存里的缓存，下次从存储重读 */
export function resetDismissedHintsCache(): void {
  dismissed = null;
}
