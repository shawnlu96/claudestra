/** 侧栏打磨（UXSIDE1）的本地词条：图例卡的按钮与分组名。不进共享字典（撞键会改掉别处的译文），按 agent-usage-i18n.ts 的做法就地取 */
export const SIDEBAR_POLISH_WORDS: Record<string, string> = {
  "这些标记是什么意思": "What these tags mean",
  "收起图例": "Hide legend",
  "上下文余量": "Context left",
  "卡片阶段": "Card stage",
  "运行状态": "Activity",
};

/** 中文原文即 key；英文缺词回退中文，漏翻不炸界面 */
export const polishWord = (lang: "zh" | "en", s: string): string => (lang === "zh" ? s : (SIDEBAR_POLISH_WORDS[s] ?? s));
