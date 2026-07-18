import { readWebConfig } from "./web-config";

/**
 * 服务端语言（BFF 生成用户可见文案时用）。单用户部署——语言偏好是全局的:
 * 前端 setLang 落盘 web-config.json,这里读取。
 *
 * 分工(与前端字典的边界):
 * - **固定串**服务端保持中文,前端渲染点 t() 兜底翻译(单一事实源在字典);
 * - **带变量串**前端整串匹配不了,才由服务端按偏好用 st() 双写生成。
 *
 * 3s 缓存:切语言到服务端文案生效最多迟 3s,换来热路径零 IO。
 */

export type ServerLang = "zh" | "en";

let cache: { lang: ServerLang; at: number } | null = null;

export async function serverLang(): Promise<ServerLang> {
  if (cache && Date.now() - cache.at < 3000) return cache.lang;
  const cfg = await readWebConfig();
  const lang: ServerLang = cfg.lang === "en" ? "en" : "zh";
  cache = { lang, at: Date.now() };
  return lang;
}

/** 双写选择器:st(中文, 英文)。 */
export async function st(zh: string, en: string): Promise<string> {
  return (await serverLang()) === "en" ? en : zh;
}
