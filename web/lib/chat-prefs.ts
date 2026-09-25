"use client";
import { createCssPrefStore } from "./css-pref-store";
import { EMPTY_CHAT_PREFS, buildChatCss, isEmptyChatPrefs, normalizeChatPrefs, type ChatPrefs } from "./chat-prefs-parse";

export type { ChatPrefs } from "./chat-prefs-parse";
export { CHAT_DEFAULTS, CHAT_RANGES, EMPTY_CHAT_PREFS, clampPref } from "./chat-prefs-parse";

/**
 * 会话历史区局部设定(owner 2026-09-25 探索分支第 ③ 期)：正文字号 / 行高 / 旁白字号，按设备存，
 * 拖动即生效。纯逻辑在 ./chat-prefs-parse.ts，存储 / 首帧见 ./css-pref-store.ts。
 */
export const STYLE_ID = "cstra-chat-prefs";
export const TEXT_KEY = "cstra_chat_prefs";
export const CSS_KEY = "cstra_chat_prefs_css";

const store = createCssPrefStore<ChatPrefs>({
  textKey: TEXT_KEY,
  cssKey: CSS_KEY,
  styleId: STYLE_ID,
  empty: EMPTY_CHAT_PREFS,
  normalize: normalizeChatPrefs,
  isEmpty: isEmptyChatPrefs,
  build: buildChatCss,
});

export const getChatPrefs = store.get;
export const setChatPrefs = store.set;
export const useChatPrefs = store.useValue;
