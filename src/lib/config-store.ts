/**
 * 运行时配置存储
 *
 * 存储路径：~/.claude-orchestrator/config.json
 * 区别于 .env（安装期常量）：这里放运行时可变的开关。
 */

import { normalizeCompactKeep } from "./ctx-boundary-policy.js";
import { CONFIG_PATH as STATE_CONFIG_PATH } from "./paths.js";
import { readJsonState, readJsonStateSync, reportCorrupt, type StateRead } from "./state-file.js";

import { readAutoUpdateValue as autoUpdateValue } from "./floka-config/values.js";
import { configView, writeCompatibleConfig } from "./floka-config/store.js";
import { retryConfigWrite } from "./floka-config/retry.js";
import type { ConfigConflict } from "./floka-config/values.js";
const CONFIG_PATH = STATE_CONFIG_PATH;

export type AppLang = "zh" | "en";

export type UpdateChannel = "release" | "beta";

export interface AppConfig {
  /** Read diagnostics only; non-enumerable and never persisted by a setter. */
  readonly configConflicts?: readonly ConfigConflict[];
  autoUpdate: {
    claudestra: boolean; floka?: boolean;
    claudeCode: boolean;
    /** Codex（npm 全局）：缺省（不写）= 关，别的安装不会被突然动到；开了由 launcher 轮询，兼容且全员空闲才升（lib/codex-auto-update.ts） */
    codex?: boolean;
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
  autoCompact?: {
    cardWorkers?: "on" | "observe" | "off";
    idleHours?: number;
    window?: number;
    emergency?: boolean;
    /** 上下文边界自动注入总开关，缺省关（先 manager ctx-boundary dry-run 看结果再 on）；关着时面板照常显示、手动按钮照常能用 */
    inject?: boolean;
    /** 按项目 / 名字模式的上下文边界（lib/ctx-boundary-policy.ts 解析和校验）。这里原样保留：set* 是读改写，
     *  在这里过滤就会把 owner 写错的条目悄悄抹掉，而不是在面板上报出来 */
    policies?: unknown;
  };
  /** v2.23+ 归档保留天数（缺省 90；0 = 永不自动清理）。归档目录里的条目超过
   *  这个天数就由每日兜底清掉——归档是"可找回的过期会话"，不是永久仓库。 */
  archiveRetentionDays?: number;
  /** Codex 子线程自动归档（缺省关）：开了以后每日扫描把 CODEX_SUB_IDLE_DAYS 天没写的子线程收进 archive/archived/，
   *  那里的文件到 archiveRetentionDays 就被删掉，等于「7 + 90 天」后永久删除，所以要每家 owner 自己开（lib/unmanaged-archive.ts） */
  autoArchiveCodexSubs?: boolean;
  /** 语音转写用的 Groq API key（bridge/local-api：PUT /api/v1/settings 写、GET 只回尾四位提示；env GROQ_API_KEY 兜底）。
   *  以前在 web BFF 的 ~/.claude-orchestrator/web/config.json，manager migrate-web-state 搬过来。 */
  groqApiKey?: string;
  /** 订阅额度：从订阅接口读取实时额度（缺省开；关了只用本机缓存，bridge 不读 Keychain / auth.json）。bridge/quota-service.ts */
  quotaLive?: boolean;
  /** 没人看看板时也在后台读 Claude 的 Keychain、查 Claude 额度与重置卡（6 小时一次），让 Claude 的快过期提醒也能后台触发。
   *  缺省开（owner 09-28 批准；设计稿 T2b §3 / §5 原定只在看板打开时读）；false 单独关掉。每个 tick 现读，改完不用重启 */
  quotaClaudeBackground?: boolean;
  /** 批量管理（bridge/fleet）：compactKeep 覆盖 /compact 的默认保留清单（lib/fleet-plan.ts DEFAULT_COMPACT_KEEP）；
   *  callers = 除大总管和台账 PM 外还能调 fleet MCP 工具的 agent（管全部，lib/fleet-caller.ts） */
  fleet?: { compactKeep?: string; callers?: string[] };
  /** 推送不带正文：Web Push / APNs 只发「Claudestra · 有新消息」（lib/push-redact.ts）。缺省关；派发器每条现读，改完不用重启 */
  pushNoContent?: boolean;
  /** 全部待你处理都推：Web Push / APNs 加推「待你处理」时不看卡没卡活（lib/ask-push.ts）。缺省关——回复本身已经推过一次，
   *  打开后带按钮的回复会响两次（回复一次、待你处理一次）；派发器每条现读，改完不用重启 */
  pushAllAsks?: boolean;
  /** 网页的 Chat（人与人，/talk）入口：缺省关——侧栏不出「工作台 | Chat」切换，/talk 跳回 /chat。只收界面，talk API 与数据照旧（T50） */
  talkEnabled?: boolean;
  /** 网页新版整页宿主（nav/v2-host.tsx）：缺省开；false = 回到五入口旧布局。全局一份，PUT /settings 要 manage */
  navV2?: boolean;
  /** Ordinary messages can request non-preempting delivery; disabling affects new requests only. */
  steer?: Record<string, unknown> & { queueWhenBusy?: boolean };
  /** 严格模式：经中继打开的页面不能加入加密邀请（bridge/peer-relay-strict.ts）。缺省关 = 允许；每次加入现读 */
  peerRelayJoinStrict?: boolean;
  /** bridge 存活探测开关（lib/bridge-watchdog.ts，缺省 on；observe / off 要显式设置）；launcher 每轮现读 */
  bridgeWatchdog?: "on" | "observe" | "off";
  bridgeWatchdogDiag?: "on" | "observe" | "off"; // 卡住时抓现场，缺省 on（lib/bridge-watchdog-diag.ts）
  bridgeWatchdogOob?: "on" | "observe" | "off"; // 卡住 / 恢复的带外通知，缺省 on（lib/bridge-watchdog-oob.ts）
  /** 设备 cookie 随使用续发（bridge/device-cookie-renew.ts，缺省 observe = 只记「会续发」）；每次续发判断现读 */
  deviceCookieRenew?: "on" | "observe" | "off";
  /** Jev（TypeSafe System One）API key：PUT /api/v1/settings 写、GET 只回尾四位；env TYPESAFE_API_KEY 兜底（lib/jev.ts） */
  jevApiKey?: string;
  /** Chat Guard（bridge/chat-guard.ts）：mode 缺省 on（没配 Jev key 时自然不生效）；blockAt 缺省 0.85 */
  chatGuard?: { mode?: "off" | "on"; blockAt?: number };
  /** 入站路由（bridge/inbound-route.ts）：目标忙时新消息由 Jev 判打断 / 排队 / 合并。缺省 off；observe 只记日志；每 2 秒现读，改完不用重启 */
  inboundRoute?: { mode?: "off" | "observe" | "on" };
  /** floka 改名的分项开关；state = 状态根迁移维护档位（lib/state-maintenance），只认 off / observe / on，缺省和未知值按 off。
   *  其余子键原样保留：set* 是读改写，在这里过滤会把别的分项抹掉 */
  rename?: Record<string, unknown> & { state?: unknown };
}

export type RenameStateMode = "off" | "observe" | "on";

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
  return configView(raw, {
    autoUpdate: {
      claudestra: autoUpdateValue(au, base.autoUpdate.claudestra),
      claudeCode: typeof au.claudeCode === "boolean" ? au.claudeCode : base.autoUpdate.claudeCode,
      ...(typeof au.codex === "boolean" ? { codex: au.codex } : {}),
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
    autoCompact: mergeAutoCompact(raw?.autoCompact) ?? base.autoCompact,
    // 以前漏在这里：任何 set*（读→改→写）都会把磁盘上的 archiveRetentionDays 抹掉
    ...(typeof raw.archiveRetentionDays === "number" ? { archiveRetentionDays: raw.archiveRetentionDays } : {}),
    ...(typeof raw.autoArchiveCodexSubs === "boolean" ? { autoArchiveCodexSubs: raw.autoArchiveCodexSubs } : {}),
    ...(typeof raw.groqApiKey === "string" && raw.groqApiKey ? { groqApiKey: raw.groqApiKey } : {}),
    ...(typeof raw.quotaLive === "boolean" ? { quotaLive: raw.quotaLive } : {}),
    ...(typeof raw.quotaClaudeBackground === "boolean" ? { quotaClaudeBackground: raw.quotaClaudeBackground } : {}),
    ...(typeof raw.pushNoContent === "boolean" ? { pushNoContent: raw.pushNoContent } : {}),
    ...(typeof raw.pushAllAsks === "boolean" ? { pushAllAsks: raw.pushAllAsks } : {}),
    // 批量管理（bridge/fleet）：白名单带 compactKeep 和 callers；漏在这里读不到，任何 set* 还会把它抹掉
    ...fleetOf(raw.fleet),
    ...(raw.steer && typeof raw.steer === "object" && !Array.isArray(raw.steer) ? { steer: { ...raw.steer } } : {}),
    ...(typeof raw.talkEnabled === "boolean" ? { talkEnabled: raw.talkEnabled } : {}),
    ...(typeof raw.navV2 === "boolean" ? { navV2: raw.navV2 } : {}),
    ...(typeof raw.peerRelayJoinStrict === "boolean" ? { peerRelayJoinStrict: raw.peerRelayJoinStrict } : {}),
    ...(raw.bridgeWatchdog === "on" || raw.bridgeWatchdog === "observe" || raw.bridgeWatchdog === "off" ? { bridgeWatchdog: raw.bridgeWatchdog } : {}),
    ...(raw.bridgeWatchdogDiag === "on" || raw.bridgeWatchdogDiag === "observe" || raw.bridgeWatchdogDiag === "off" ? { bridgeWatchdogDiag: raw.bridgeWatchdogDiag } : {}),
    ...(raw.bridgeWatchdogOob === "on" || raw.bridgeWatchdogOob === "observe" || raw.bridgeWatchdogOob === "off" ? { bridgeWatchdogOob: raw.bridgeWatchdogOob } : {}),
    ...(raw.deviceCookieRenew === "on" || raw.deviceCookieRenew === "observe" || raw.deviceCookieRenew === "off" ? { deviceCookieRenew: raw.deviceCookieRenew } : {}),
    ...(typeof raw.jevApiKey === "string" && raw.jevApiKey ? { jevApiKey: raw.jevApiKey } : {}),
    ...(raw.inboundRoute?.mode === "observe" || raw.inboundRoute?.mode === "on" || raw.inboundRoute?.mode === "off" ? { inboundRoute: { mode: raw.inboundRoute.mode } } : {}),
    ...(raw.rename && typeof raw.rename === "object" && !Array.isArray(raw.rename) ? { rename: { ...raw.rename } } : {}),
    ...(raw.chatGuard && typeof raw.chatGuard === "object"
      ? {
          chatGuard: {
            ...(raw.chatGuard.mode === "off" || raw.chatGuard.mode === "on" ? { mode: raw.chatGuard.mode } : {}),
            ...(typeof raw.chatGuard.blockAt === "number" ? { blockAt: raw.chatGuard.blockAt } : {}),
          },
        }
      : {}),
  });
}

function mergeAutoCompact(ac: any): AppConfig["autoCompact"] | undefined {
  if (!ac || typeof ac !== "object") return undefined;
  const out: NonNullable<AppConfig["autoCompact"]> = {
    ...(typeof ac.idleHours === "number" ? { idleHours: ac.idleHours } : {}),
    ...(typeof ac.window === "number" ? { window: ac.window } : {}),
    ...(typeof ac.emergency === "boolean" ? { emergency: ac.emergency } : {}),
    ...(typeof ac.inject === "boolean" ? { inject: ac.inject } : {}),
    ...(ac.cardWorkers === "on" || ac.cardWorkers === "observe" || ac.cardWorkers === "off" ? { cardWorkers: ac.cardWorkers } : {}),
    ...(ac.policies !== undefined ? { policies: ac.policies } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

/**
 * 白名单式读 fleet：新加字段要加在这里，否则读出来是 undefined，而且任何 set*（读→改→写）都会把它从磁盘上抹掉。
 * compactKeep 和上下文边界的 keep 同一个入口 normalizeCompactKeep，不合格当没配；存原文（多行照收），敲之前再取它规范好的那一行
 */
function fleetOf(f: unknown): Pick<AppConfig, "fleet"> {
  if (!f || typeof f !== "object") return {};
  const { compactKeep, callers } = f as Record<string, unknown>;
  const list = Array.isArray(callers) ? callers.filter((c): c is string => typeof c === "string" && c.trim() !== "") : null;
  const keepOk = typeof compactKeep === "string" && normalizeCompactKeep(compactKeep).ok;
  const fleet = { ...(keepOk ? { compactKeep } : {}), ...(list ? { callers: list } : {}) };
  return Object.keys(fleet).length ? { fleet } : {};
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
  // 订阅额度的两个开关同口径：坏文件时不读凭据（owner 关掉的「读 Keychain」不能因为文件坏了被静默打开）；
  // 推送同理取保守的一边：owner 打开的「不带正文」不能因为文件坏了被静默关掉
  return { ...DEFAULT_CONFIG, autoUpdate: { claudestra: false, claudeCode: false }, quotaLive: false, quotaClaudeBackground: false, pushNoContent: true };
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

/**
 * 磁盘上的 config.json 此刻是否损坏（不是「不存在」）。自动写者（用量看板）据此暂停：
 * 坏文件时 writeConfig 必然被拒，照常「建频道 → 存 id」就会每轮再建一个频道。
 */
export function isConfigCorrupt(): boolean {
  return readJsonStateSync(CONFIG_PATH).status === "corrupt";
}

/** 同步读取配置（bridge 等不方便 await 的场景）。 */
export function readConfigSync(): AppConfig {
  return fromRead(readJsonStateSync(CONFIG_PATH));
}

/**
 * 原子写（tmp + rename，lib/state-file）。磁盘上的 config.json 已损坏时拒写并备份
 * `<file>.corrupt-<ts>`：set* 是读改写，读到的是安全默认，照写就会把其余设置一并抹掉。
 * 0600：里面有 API key（Groq / Jev），不给本机其他用户读；rename 覆盖后旧文件的 0644 也随之收紧。
 */
export async function writeConfig(cfg: AppConfig): Promise<void> {
  await writeCompatibleConfig(CONFIG_PATH, cfg);
}

/** Replay only the requested edit, so concurrent unrelated settings survive the single retry. */
function editConfig(edit: (cfg: AppConfig) => void): Promise<AppConfig> {
  return retryConfigWrite(async () => {
    const cfg = await readConfig();
    edit(cfg);
    await writeConfig(cfg);
    return cfg;
  });
}

/** 设置归档保留天数（0 = 永不自动清理） */
export async function setArchiveRetention(days: number): Promise<AppConfig> {
  return editConfig(cfg => {
    const n = Number.isFinite(days) && days >= 0 ? Math.floor(days) : DEFAULT_ARCHIVE_RETENTION_DAYS;
    cfg.archiveRetentionDays = n;
  });
}

/** Codex 子线程自动归档开关（manager codex-sub-archive on|off） */
export async function setAutoArchiveCodexSubs(enabled: boolean): Promise<AppConfig> {
  return editConfig(cfg => { cfg.autoArchiveCodexSubs = enabled; });
}

export async function setUpdateChannel(channel: UpdateChannel): Promise<AppConfig> {
  return editConfig(cfg => { cfg.autoUpdate.channel = channel; });
}

export async function setAutoUpdate(target: "claudestra" | "floka" | "claudeCode" | "codex", enabled: boolean): Promise<AppConfig> {
  return editConfig(cfg => { cfg.autoUpdate[target === "floka" ? "claudestra" : target] = enabled; });
}

export async function setLang(lang: AppLang): Promise<AppConfig> {
  return editConfig(cfg => { cfg.lang = lang; });
}

export async function setStatsDashboard(channelId: string, messageId: string): Promise<AppConfig> {
  return editConfig(cfg => { cfg.statsDashboard = { channelId, messageId }; });
}

export async function setAutoCompactIdleHours(hours: number): Promise<AppConfig> {
  return editConfig(cfg => { cfg.autoCompact = { ...cfg.autoCompact, idleHours: hours }; });
}

/** v2.20.2+ 设置界面写入口:一次可改阈值/闲置时长任意子集。 */
export async function setAutoCompact(patch: { window?: number; idleHours?: number; emergency?: boolean; inject?: boolean }): Promise<AppConfig> {
  return editConfig(cfg => {
    cfg.autoCompact = {
      ...cfg.autoCompact,
      ...(typeof patch.window === "number" ? { window: patch.window } : {}),
      ...(typeof patch.idleHours === "number" ? { idleHours: patch.idleHours } : {}),
      ...(typeof patch.emergency === "boolean" ? { emergency: patch.emergency } : {}),
      ...(typeof patch.inject === "boolean" ? { inject: patch.inject } : {}),
    };
  });
}

export async function setQuotaLive(enabled: boolean): Promise<AppConfig> {
  return editConfig(cfg => { cfg.quotaLive = enabled; });
}

export async function setPushNoContent(enabled: boolean): Promise<AppConfig> {
  return editConfig(cfg => { cfg.pushNoContent = enabled; });
}

export async function setPushAllAsks(enabled: boolean): Promise<AppConfig> {
  return editConfig(cfg => { cfg.pushAllAsks = enabled; });
}

export async function setTalkEnabled(enabled: boolean): Promise<AppConfig> {
  return editConfig(cfg => { cfg.talkEnabled = enabled; });
}

export async function setNavV2(enabled: boolean): Promise<AppConfig> {
  return editConfig(cfg => { cfg.navV2 = enabled; });
}

export async function setPeerRelayJoinStrict(enabled: boolean): Promise<AppConfig> {
  return editConfig(cfg => { cfg.peerRelayJoinStrict = enabled; });
}

/** 空串 = 清除 */
export async function setGroqApiKey(key: string): Promise<AppConfig> {
  return editConfig(cfg => {
    if (key) cfg.groqApiKey = key;
    else delete cfg.groqApiKey;
  });
}

/** 空串 = 清除（Jev / TypeSafe） */
export async function setJevApiKey(key: string): Promise<AppConfig> {
  return editConfig(cfg => {
    if (key) cfg.jevApiKey = key;
    else delete cfg.jevApiKey;
  });
}

/** Chat Guard 开关 / 阈值（设置 → 安全） */
export async function setChatGuard(patch: { mode?: "off" | "on"; blockAt?: number }): Promise<AppConfig> {
  return editConfig(cfg => { cfg.chatGuard = { ...cfg.chatGuard, ...patch }; });
}

/**
 * manager migrate-web-state：把旧 web config.json 的 groqApiKey / lang 搬进来，**只补缺**——bridge 这边已经设过的不覆盖
 * （lang 有缺省值，所以按磁盘上的原始 JSON 判「设过没有」，不能看合并后的配置）。返回哪几项真的搬了。
 */
export async function adoptWebSettings(web: { groqApiKey?: unknown; lang?: unknown }): Promise<{ groqApiKey: boolean; lang: boolean }> {
  return retryConfigWrite(async () => {
    const r = await readJsonState(CONFIG_PATH);
    if (r.status === "corrupt") throw new Error(`${CONFIG_PATH} 已损坏，先修好再迁移: ${r.error}`);
    const raw = (r.status === "ok" && r.data && typeof r.data === "object" ? r.data : {}) as Record<string, unknown>;
    const cfg = merge(defaults(), raw);
    const takeKey = typeof web.groqApiKey === "string" && !!web.groqApiKey && typeof raw.groqApiKey !== "string";
    const takeLang = (web.lang === "zh" || web.lang === "en") && raw.lang !== "zh" && raw.lang !== "en";
    if (takeKey) cfg.groqApiKey = web.groqApiKey as string;
    if (takeLang) cfg.lang = web.lang as AppLang;
    if (takeKey || takeLang) await writeConfig(cfg);
    return { groqApiKey: takeKey, lang: takeLang };
  });
}

export async function setInboundRouteMode(mode: "off" | "observe" | "on"): Promise<AppConfig> {
  return editConfig(cfg => { cfg.inboundRoute = { mode }; });
}

/** rename.state 的生效档位：缺省、未知值、坏文件一律 off（打错字不能变成执行） */
export function renameStateMode(cfg: AppConfig = readConfigSync()): RenameStateMode {
  const v = cfg.rename?.state;
  return v === "observe" || v === "on" ? v : "off";
}

/** 受控写入：只由 manager state-maintenance mode（核过单次授权与角色）调用；切档本身不触发任何迁移 */
export async function setRenameStateMode(mode: RenameStateMode): Promise<AppConfig> {
  return editConfig(cfg => { cfg.rename = { ...cfg.rename, state: mode }; });
}

export { CONFIG_PATH, DEFAULT_CONFIG };

export async function setSteerQueueWhenBusy(enabled: boolean): Promise<AppConfig> {
  return editConfig(cfg => { cfg.steer = { ...cfg.steer, queueWhenBusy: enabled }; });
}
