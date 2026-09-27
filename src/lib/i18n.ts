/**
 * 全局 i18n helper（v1.9.31+）。
 *
 * 用户在 setup 里选了中文/英文，存在 ~/.claude-orchestrator/config.json 的 lang 字段。
 * bridge / launcher / manager / cron 等 daemon 启动时调 `initLang()` 从 config
 * 载一次，后续用 `t(zh, en)` 返回当前语言版本。
 *
 * 为什么不直接每次读 config 文件？—— `t()` 调用高频（bridge 每条消息都会走），
 * 同步读文件太慢。一次载入内存，进程生命周期内都有效。config 变了要重启服务（bridge 的 PUT /settings 写完即 setLangInMemory）。
 *
 * initLang **同步** 读文件（readFileSync）：各入口在模块顶层调用它，同步读保证之后任何
 * t() 都拿到已载入的语言。最初是因为 pm2 fork mode 不支持 top-level await 才这么定；
 * 现在守护进程由 launchd 直跑，这个限制已不存在，同步读只是更简单。
 * Config 文件很小（<1KB），同步读启动期只会跑一次，性能无感。
 */
import { readConfigSync, type AppLang } from "./config-store.js";

let cachedLang: AppLang = "zh";
let loaded = false;

/** daemon 启动时调一次（bridge / launcher / cron / manager），从 config.json 载 lang。同步。 */
export function initLang(): AppLang {
  // 与其它读者同一口径（lib/config-store）：缺失 / 损坏 / lang 非法都落到默认 zh，永不抛
  cachedLang = readConfigSync().lang;
  loaded = true;
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

/**
 * setup 选语言的默认值：CLAUDESTRA_LANG（与 install.sh 同一个开关，它 exec 过来时带着）优先，
 * 其次按 POSIX locale LC_ALL > LC_MESSAGES > LANG 取第一个非空的；zh 开头 → 中文，其余（没设、C、en_US…）→ 英文。
 * daemon 不用它：那边以 config.lang 为准（launchd 注入的 LANG 不代表用户选择）。
 */
export function langFromLocaleEnv(env: Record<string, string | undefined> = process.env): AppLang {
  const forced = (env.CLAUDESTRA_LANG ?? "").trim().toLowerCase();
  if (/^(zh|cn)/.test(forced)) return "zh";
  if (/^en/.test(forced)) return "en";
  const loc = [env.LC_ALL, env.LC_MESSAGES, env.LANG].map((v) => (v ?? "").trim()).find(Boolean) ?? "";
  return /^zh/i.test(loc) ? "zh" : "en";
}

/** debug / log 用：返回一个说明当前语言状态的字符串 */
export function langStatus(): string {
  return `lang=${cachedLang}${loaded ? "" : " (default, not loaded from config)"}`;
}
