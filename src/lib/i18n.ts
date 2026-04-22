/**
 * 全局 i18n helper（v1.9.31+）。
 *
 * 用户在 setup 里选了中文/英文，存在 ~/.claude-orchestrator/config.json 的 lang 字段。
 * bridge / launcher / manager / cron 等 daemon 启动时调 `initLang()` 从 config
 * 载一次，后续用 `t(zh, en)` 返回当前语言版本。
 *
 * 为什么不直接每次读 config 文件？—— `t()` 调用高频（bridge 每条消息都会走），
 * 同步读文件太慢。一次载入内存，进程生命周期内都有效。config 变了要重启服务。
 */
import { readConfig, type AppLang } from "./config-store.js";

let cachedLang: AppLang = "zh";
let loaded = false;

/** daemon 启动时调一次（bridge / launcher / cron / manager），从 config.json 载 lang */
export async function initLang(): Promise<AppLang> {
  try {
    const cfg = await readConfig();
    cachedLang = cfg.lang;
    loaded = true;
  } catch {
    // config 读失败就用默认
    cachedLang = "zh";
    loaded = true;
  }
  return cachedLang;
}

/** 同步获取当前语言。initLang() 没调过就返回默认中文。 */
export function getLang(): AppLang {
  return cachedLang;
}

/** setup 里用户选完语言后，直接同步设置到内存（不等 initLang）。 */
export function setLangInMemory(lang: AppLang): void {
  cachedLang = lang;
  loaded = true;
}

/**
 * 按当前语言返回中/英字符串。用法：`t("中文", "English")`。
 * 比如 `t("💭 思考中...", "💭 Thinking...")`。
 */
export function t(zh: string, en: string): string {
  return cachedLang === "en" ? en : zh;
}

/** debug / log 用：返回一个说明当前语言状态的字符串 */
export function langStatus(): string {
  return `lang=${cachedLang}${loaded ? "" : " (default, not loaded from config)"}`;
}
