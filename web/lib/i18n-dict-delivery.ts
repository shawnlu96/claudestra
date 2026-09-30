/** 聊天气泡的送达状态（message-list 的未送达行、features/quota-wall/held-mark.tsx）的字典条目，规则同 lib/i18n-dict.ts；主字典顶在行数上限 */
export const DELIVERY_DICT: Record<string, string> = {
  "未送达": "Not delivered",
  "重新发送": "Resend",
  "押着，送达后出现在对话里": "Held — it shows up in the chat once delivered",
  "排队中 · 等它这一轮结束后送达": "Queued · delivered when its current turn ends",
};
