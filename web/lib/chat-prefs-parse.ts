/**
 * 会话历史区局部设定的纯逻辑（无 import，tests/ 直测）：字号 / 行高 / 旁白字号 / 工具字号的范围与拼 CSS。
 * 存储与注入在 lib/chat-prefs.ts。
 *
 * 落点是四个自定义属性，message-list / progress-note / tool-rows 用 var(--chat-*, 默认值) 取；
 * do-md 的 .DOMD-Root 自带 16px 钉值，globals.css 里 .cstra-bubble 的覆盖让它改为继承，
 * 标题 / 行内 / 代码都是 em，所以正文一个字号整段 Markdown 同比缩放。null = 用默认值。
 */
export interface ChatPrefs {
  fontSize: number | null;
  lineHeight: number | null;
  narrSize: number | null;
  toolSize: number | null;
}

export const EMPTY_CHAT_PREFS: ChatPrefs = { fontSize: null, lineHeight: null, narrSize: null, toolSize: null };

/** 与各组件 var() 的兜底值一致（正文：本人气泡 14.5 / AI 与 peer 的 Markdown 16）；改这里必须同步那边 */
export const CHAT_DEFAULTS = { fontSize: 14.5, lineHeight: 1.6, narrSize: 13.5, toolSize: 12 } as const;

export const CHAT_RANGES = {
  fontSize: { min: 12, max: 18, step: 0.5 },
  lineHeight: { min: 1.3, max: 2, step: 0.05 },
  narrSize: { min: 11, max: 16, step: 0.5 },
  toolSize: { min: 10, max: 15, step: 0.5 },
} as const;

type Key = keyof ChatPrefs;
const KEYS: Key[] = ["fontSize", "lineHeight", "narrSize", "toolSize"];
const VAR: Record<Key, string> = {
  fontSize: "--chat-font-size",
  lineHeight: "--chat-line-height",
  narrSize: "--chat-narr-size",
  toolSize: "--chat-tool-size",
};

/** 夹到范围内并按步长取整；非数字 → null（用默认） */
export function clampPref(key: Key, v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  const r = CHAT_RANGES[key];
  const clamped = Math.min(r.max, Math.max(r.min, n));
  return Math.round(Math.round(clamped / r.step) * r.step * 100) / 100; // 0.05 步长会带出 1.7000000000000002
}

export function normalizeChatPrefs(raw: unknown): ChatPrefs {
  const j = (raw ?? {}) as Partial<Record<Key, unknown>>;
  const out = { ...EMPTY_CHAT_PREFS };
  for (const k of KEYS) out[k] = clampPref(k, j[k]);
  return out;
}

export function isEmptyChatPrefs(p: ChatPrefs): boolean {
  return KEYS.every((k) => p[k] === null);
}

/** 浮点步长会带出 1.7000000000000002 这类尾巴，按 2 位小数收掉 */
const fmt = (n: number) => String(Math.round(n * 100) / 100);

export function buildChatCss(p: ChatPrefs): string {
  const decls: string[] = [];
  for (const k of KEYS) {
    const v = p[k];
    if (v === null) continue;
    decls.push(`${VAR[k]}:${fmt(v)}${k === "lineHeight" ? "" : "px"}`);
  }
  return decls.length ? `:root{${decls.join(";")}}` : "";
}
