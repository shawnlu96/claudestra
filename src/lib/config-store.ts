/**
 * 运行时配置存储
 *
 * 存储路径：~/.claude-orchestrator/config.json
 * 区别于 .env（安装期常量）：这里放运行时可变的开关。
 */

import { existsSync } from "fs";
import { mkdir } from "fs/promises";

const HOME = process.env.HOME || "";
const CONFIG_DIR = `${HOME}/.claude-orchestrator`;
const CONFIG_PATH = `${CONFIG_DIR}/config.json`;

export type AppLang = "zh" | "en";

export interface AppConfig {
  autoUpdate: {
    claudestra: boolean;
    claudeCode: boolean;
  };
  /** 用户在 setup 里选的默认语言，贯穿整个 app（Discord 消息 / 通知 / 日志）。v1.9.31+ */
  lang: AppLang;
}

const DEFAULT_CONFIG: AppConfig = {
  autoUpdate: {
    claudestra: true,
    claudeCode: true,
  },
  lang: "zh",
};

function merge(base: AppConfig, raw: any): AppConfig {
  if (!raw || typeof raw !== "object") return base;
  const au = raw.autoUpdate || {};
  return {
    autoUpdate: {
      claudestra: typeof au.claudestra === "boolean" ? au.claudestra : base.autoUpdate.claudestra,
      claudeCode: typeof au.claudeCode === "boolean" ? au.claudeCode : base.autoUpdate.claudeCode,
    },
    lang: raw.lang === "en" || raw.lang === "zh" ? raw.lang : base.lang,
  };
}

export async function readConfig(): Promise<AppConfig> {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG, autoUpdate: { ...DEFAULT_CONFIG.autoUpdate } };
  try {
    const raw = await Bun.file(CONFIG_PATH).json();
    return merge(DEFAULT_CONFIG, raw);
  } catch {
    return { ...DEFAULT_CONFIG, autoUpdate: { ...DEFAULT_CONFIG.autoUpdate } };
  }
}

export async function writeConfig(cfg: AppConfig): Promise<void> {
  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true });
  }
  await Bun.write(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

export async function setAutoUpdate(target: "claudestra" | "claudeCode", enabled: boolean): Promise<AppConfig> {
  const cfg = await readConfig();
  cfg.autoUpdate[target] = enabled;
  await writeConfig(cfg);
  return cfg;
}

export async function setLang(lang: AppLang): Promise<AppConfig> {
  const cfg = await readConfig();
  cfg.lang = lang;
  await writeConfig(cfg);
  return cfg;
}

export { CONFIG_PATH, DEFAULT_CONFIG };
