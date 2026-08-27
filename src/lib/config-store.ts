/**
 * 运行时配置存储
 *
 * 存储路径：~/.claude-orchestrator/config.json
 * 区别于 .env（安装期常量）：这里放运行时可变的开关。
 */

import { existsSync, readFileSync } from "fs";
import { mkdir, rename } from "fs/promises";

const HOME = process.env.HOME || "";
const CONFIG_DIR = `${HOME}/.claude-orchestrator`;
const CONFIG_PATH = `${CONFIG_DIR}/config.json`;

export type AppLang = "zh" | "en";

export type UpdateChannel = "release" | "beta";

export interface AppConfig {
  autoUpdate: {
    claudestra: boolean;
    claudeCode: boolean;
    /** v2.17 更新通道:release=只跟正式版(默认);beta=紧跟 origin/main 的
     *  每个 commit(未经 release 验证,尝鲜/急修场景自担风险)。 */
    channel?: UpdateChannel;
  };
  /** 用户在 setup 里选的默认语言，贯穿整个 app（Discord 消息 / 通知 / 日志）。v1.9.31+ */
  lang: AppLang;
  /** v2.4.25+ 只读用量看板频道 + 常驻消息 id（stats-dashboard 用）。 */
  statsDashboard?: { channelId: string; messageId: string };
  /** v2.20.1+ auto save-compact 闲置门槛（小时,0=超线即触发)与 v2.20.2+ 上下文
   *  阈值(tokens,0=关闭自动触发;缺省用 stats-dashboard 的默认 400K)。 */
  autoCompact?: { idleHours?: number; window?: number };
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
      channel: au.channel === "beta" ? "beta" : "release",
    },
    lang: raw.lang === "en" || raw.lang === "zh" ? raw.lang : base.lang,
    statsDashboard:
      raw.statsDashboard && typeof raw.statsDashboard.channelId === "string"
        ? {
            channelId: raw.statsDashboard.channelId,
            messageId: String(raw.statsDashboard.messageId || ""),
          }
        : base.statsDashboard,
    autoCompact:
      raw?.autoCompact &&
      (typeof raw.autoCompact.idleHours === "number" || typeof raw.autoCompact.window === "number")
        ? {
            ...(typeof raw.autoCompact.idleHours === "number" ? { idleHours: raw.autoCompact.idleHours } : {}),
            ...(typeof raw.autoCompact.window === "number" ? { window: raw.autoCompact.window } : {}),
          }
        : base.autoCompact,
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

/** 同步读取配置（bridge 等不方便 await 的场景）。 */
export function readConfigSync(): AppConfig {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG, autoUpdate: { ...DEFAULT_CONFIG.autoUpdate } };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return merge(DEFAULT_CONFIG, raw);
  } catch {
    return { ...DEFAULT_CONFIG, autoUpdate: { ...DEFAULT_CONFIG.autoUpdate } };
  }
}

export async function writeConfig(cfg: AppConfig): Promise<void> {
  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true });
  }
  // 原子写：临时文件 + rename。直接覆盖写在进程被重启/断电时会留下截断的 JSON，
  // 下次读取失败就静默回落到 DEFAULT_CONFIG —— 用户关掉的自动更新会自己变回开着。
  const tmp = `${CONFIG_PATH}.tmp.${process.pid}`;
  await Bun.write(tmp, JSON.stringify(cfg, null, 2));
  await rename(tmp, CONFIG_PATH);
}

export async function setUpdateChannel(channel: UpdateChannel): Promise<AppConfig> {
  const cfg = await readConfig();
  cfg.autoUpdate.channel = channel;
  await writeConfig(cfg);
  return cfg;
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

export async function setStatsDashboard(channelId: string, messageId: string): Promise<AppConfig> {
  const cfg = await readConfig();
  cfg.statsDashboard = { channelId, messageId };
  await writeConfig(cfg);
  return cfg;
}

export async function setAutoCompactIdleHours(hours: number): Promise<AppConfig> {
  const cfg = await readConfig();
  cfg.autoCompact = { ...cfg.autoCompact, idleHours: hours };
  await writeConfig(cfg);
  return cfg;
}

/** v2.20.2+ 设置界面写入口:一次可改阈值/闲置时长任意子集。 */
export async function setAutoCompact(patch: { window?: number; idleHours?: number }): Promise<AppConfig> {
  const cfg = await readConfig();
  cfg.autoCompact = {
    ...cfg.autoCompact,
    ...(typeof patch.window === "number" ? { window: patch.window } : {}),
    ...(typeof patch.idleHours === "number" ? { idleHours: patch.idleHours } : {}),
  };
  await writeConfig(cfg);
  return cfg;
}

export { CONFIG_PATH, DEFAULT_CONFIG };
