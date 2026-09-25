/**
 * 会话历史区局部设定的纯逻辑（无 import，tests/ 直测）：字号 / 行高 / 旁白字号的范围与拼 CSS。
 * 存储与注入在 lib/chat-prefs.ts。
 *
 * 落点是三个自定义属性，message-list.tsx 的气泡 / 旁白用 var(--chat-*, 默认值) 取；do-md 里标题、
 * 行内元素、代码全是 em / 相对变量，所以只调气泡一个字号整段 Markdown 同比缩放。null = 用默认值。
 */
export interface ChatPrefs {
  fontSize: number | null;
  lineHeight: number | null;
  narrSize: number | null;
}

export const EMPTY_CHAT_PREFS: ChatPrefs = { fontSize: null, lineHeight: null, narrSize: null };

/** 与 message-list.tsx 里 var() 的兜底值一致；改这里必须同步那边 */
export const CHAT_DEFAULTS = { fontSize: 14.5, lineHeight: 1.6, narrSize: 13.5 } as const;

export const CHAT_RANGES = {
  fontSize: { min: 12, max: 18, step: 0.5 },
  lineHeight: { min: 1.3, max: 2, step: 0.05 },
  narrSize: { min: 11, max: 16, step: 0.5 },
} as const;

type Key = keyof ChatPrefs;

/** 夹到范围内并按步长取整；非数字 → null（用默认） */
export function clampPref(key: Key, v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  const r = CHAT_RANGES[key];
  const clamped = Math.min(r.max, Math.max(r.min, n));
  return Math.round((Math.round(clamped / r.step) * r.step) * 100) / 100; // 0.05 步长会带出 1.7000000000000002
}

export function normalizeChatPrefs(raw: unknown): ChatPrefs {
  const j = (raw ?? {}) as Partial<Record<Key, unknown>>;
  return {
    fontSize: clampPref("fontSize", j.fontSize),
    lineHeight: clampPref("lineHeight", j.lineHeight),
    narrSize: clampPref("narrSize", j.narrSize),
  };
}

export function isEmptyChatPrefs(p: ChatPrefs): boolean {
  return p.fontSize === null && p.lineHeight === null && p.narrSize === null;
}

/** 浮点步长会带出 1.7000000000000002 这类尾巴，按 2 位小数收掉 */
const fmt = (n: number) => String(Math.round(n * 100) / 100);

export function buildChatCss(p: ChatPrefs): string {
  const decls: string[] = [];
  if (p.fontSize !== null) decls.push(`--chat-font-size:${fmt(p.fontSize)}px`);
  if (p.lineHeight !== null) decls.push(`--chat-line-height:${fmt(p.lineHeight)}`);
  if (p.narrSize !== null) decls.push(`--chat-narr-size:${fmt(p.narrSize)}px`);
  return decls.length ? `:root{${decls.join(";")}}` : "";
}
