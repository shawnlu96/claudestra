/**
 * 更新提示横幅与侧栏 ⬆ 的 i18n 词条(update-hint-banner.tsx;拆段拼接,空格对齐语序),由 i18n-dict.ts 的 DICT 一行合入。维护规则同 i18n-dict.ts 文件头。
 */
export const UPDATE_DICT: Record<string, string> = {
  "可更新（已装": "is available (installed:",
  "已装好，本会话还在": "is installed; this session still runs",
  "——重启后生效": "— restart to apply",
  "回合结束后再重启": "Restart after the current turn ends",
  "重启失败": "Restart failed",
  "）": ")",
  "更新并重启": "Update & restart",
  "更新失败": "Update failed",
  "更新中…": "Updating…",
  "Pi 可更新": "Pi update available",
  "Codex 可更新": "Codex update available",
  "（不是 npm 全局安装，请用原来的方式更新）": " (not a global npm install — update it the way you installed it)",
  "（ACP 适配器只配套": " (the ACP adapter only pairs with",
  "，等适配器升级后再更新）": "; wait for an adapter upgrade before updating)",
  "，重启前先对齐版本）": "; align the versions before restarting)",
  "重启后生效新版本": "Restart to run the new version",
  "这个版本不再提示": "Don't remind me about this version",
};
