/**
 * 台账相关的 i18n 词条（features/chat/ledger-stage.ts 等），由 i18n-dict.ts 的 DICT 一行合入。维护规则同 i18n-dict.ts 文件头。
 * 阶段短名（「开发」「验证」…）不在这里：短词做全局 key 容易撞键，放在 ledger-stage.ts 的 STAGE_DEFS 里按语言取。
 */
export const LEDGER_DICT: Record<string, string> = {
  "{id} · {state} · 第 {n} 轮": "{id} · {state} · round {n}",
};
