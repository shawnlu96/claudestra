/**
 * 运行时配置存储
 *
 * 存储路径：~/.claude-orchestrator/config.json
 * 区别于 .env（安装期常量）：这里放运行时可变的开关。
 */

import { STATE_DIR, CONFIG_PATH as STATE_CONFIG_PATH } from "./paths.js";
import { readJsonState, readJsonStateSync, reportCorrupt, writeJsonStateGuarded, type StateRead } from "./state-file.js";

const CONFIG_DIR = STATE_DIR;
const CONFIG_PATH = STATE_CONFIG_PATH;

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
   *  阈值(tokens,0=关闭常规自动触发;缺省用 stats-dashboard 的默认 400K)。
   *  v2.21.3+ emergency:93% 救命线独立开关(缺省 true)——常规线关了它也在,
   *  只在快撞 CC 的 ~967K 裸压时兜底触发一次(owner 2026-09-03)。 */
  autoCompact?: { idleHours?: number; window?: number; emergency?: boolean };
  /** v2.23+ 归档保留天数（缺省 90；0 = 永不自动清理）。归档目录里的条目超过
   *  这个天数就由每日兜底清掉——归档是"可找回的过期会话"，不是永久仓库。 */
  archiveRetentionDays?: number;
}

/** 归档保留天数缺省值（设置里可改） */
export const DEFAULT_ARCHIVE_RETENTION_DAYS = 90;

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
      (typeof raw.autoCompact.idleHours === "number" ||
        typeof raw.autoCompact.window === "number" ||
        typeof raw.autoCompact.emergency === "boolean")
        ? {
            ...(typeof raw.autoCompact.idleHours === "number" ? { idleHours: raw.autoCompact.idleHours } : {}),
            ...(typeof raw.autoCompact.window === "number" ? { window: raw.autoCompact.window } : {}),
            ...(typeof raw.autoCompact.emergency === "boolean" ? { emergency: raw.autoCompact.emergency } : {}),
          }
        : base.autoCompact,
  };
}

function defaults(): AppConfig {
  return { ...DEFAULT_CONFIG, autoUpdate: { ...DEFAULT_CONFIG.autoUpdate } };
}

/**
 * config.json 坏了（半写 / 手改坏）时的安全默认：自动更新全部**关**。
 * 以前坏文件回落到 DEFAULT_CONFIG（自动更新全开），用户关掉的自动更新会被静默重新打开
 * （2026-09 审查 D7-4）。其余字段仍取默认值。
 */
export function safeConfigOnCorrupt(): AppConfig {
  return { ...DEFAULT_CONFIG, autoUpdate: { claudestra: false, claudeCode: false } };
}

// 常驻进程（bridge / launcher）运行中文件被写坏时，继续用上次成功读到的内容
let lastGoodRaw: unknown;

/** 读结果 → 配置（纯逻辑：不存在 → 默认；损坏 → 留痕 + 上次成功值 / 安全默认；正常 → 合并） */
function fromRead(r: StateRead): AppConfig {
  if (r.status === "ok") {
    lastGoodRaw = r.data;
    return merge(defaults(), r.data);
  }
  if (r.status === "missing") return defaults();
  reportCorrupt(CONFIG_PATH, r.error, "config");
  return lastGoodRaw !== undefined ? merge(defaults(), lastGoodRaw) : safeConfigOnCorrupt();
}

export async function readConfig(): Promise<AppConfig> {
  return fromRead(await readJsonState(CONFIG_PATH));
}

/** 同步读取配置（bridge 等不方便 await 的场景）。 */
export function readConfigSync(): AppConfig {
  return fromRead(readJsonStateSync(CONFIG_PATH));
}

/**
 * 原子写（tmp + rename，lib/state-file）。磁盘上的 config.json 已损坏时拒写并备份
 * `<file>.corrupt-<ts>`：set* 是读改写，读到的是安全默认，照写就会把其余设置一并抹掉。
 */
export async function writeConfig(cfg: AppConfig): Promise<void> {
  await writeJsonStateGuarded(CONFIG_PATH, cfg);
}

/** 设置归档保留天数（0 = 永不自动清理） */
export async function setArchiveRetention(days: number): Promise<AppConfig> {
  const cfg = await readConfig();
  const n = Number.isFinite(days) && days >= 0 ? Math.floor(days) : DEFAULT_ARCHIVE_RETENTION_DAYS;
  cfg.archiveRetentionDays = n;
  await writeConfig(cfg);
  return cfg;
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
export async function setAutoCompact(patch: { window?: number; idleHours?: number; emergency?: boolean }): Promise<AppConfig> {
  const cfg = await readConfig();
  cfg.autoCompact = {
    ...cfg.autoCompact,
    ...(typeof patch.window === "number" ? { window: patch.window } : {}),
    ...(typeof patch.idleHours === "number" ? { idleHours: patch.idleHours } : {}),
    ...(typeof patch.emergency === "boolean" ? { emergency: patch.emergency } : {}),
  };
  await writeConfig(cfg);
  return cfg;
}

export { CONFIG_PATH, DEFAULT_CONFIG };
