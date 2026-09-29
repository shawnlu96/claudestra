/**
 * 订阅额度的 bridge 接线（设计稿 T2b §1 / §3；库在 src/lib/quota-*.ts）：组调度器、自适应定时器、看板快照、开关。
 *
 *   - 「有人在看」= 最近 90 秒内 GET 过 /api/v1/quota（网页打开看板期间每 60 秒拉一次，这就是心跳）。
 *   - 定时器：有人看 60 秒一次，没人看 5 分钟一次。不能更慢：调度器把两次 tick 间隔超过 15 分钟当成睡眠唤醒、立刻重查。
 *     查什么、多久查一次由调度器自己定（没人看：Codex 重置明细与 Claude 额度 + 重置卡各 6 小时一次，Claude 要读 Keychain——
 *     owner 09-28 已批，缺省开；config.json quotaClaudeBackground=false 单独关掉它；总开关 quotaLive 关则两家后台都停）。
 *   - 从没人看切到有人看：先让两家各查一次（60 秒间隔照样生效），最多等 6 秒再回快照。
 *   - 开关（config.json quotaLive，缺省开）：关 = 先落盘，再让 isEnabled 返回 false，再 onDisabled（在途结果丢弃）。
 * 单测 tests/quota-service.test.ts（假调度器 / 假定时器）。
 */

import { readConfigSync, setQuotaLive } from "../lib/config-store.js";
import { withCodexQuota } from "../lib/codex-usage.js";
import {
  confirmCredential, defaultCredDeps, hmacHex, peekAccountKey, readClaudeCredential, readCodexCredential, type QuotaProvider,
} from "../lib/quota-credentials.js";
import { selectQuotaLayers, type LayerInput, type ProviderEntry, type QuotaSnapshot } from "../lib/quota-layers.js";
import { mergePiEntries, piProviderEntries } from "../lib/quota-pi.js";
import { piPlanEntries } from "../lib/quota-pi-plans.js";
import { QuotaScheduler, type RefreshResult } from "../lib/quota-scheduler.js";
import { fileQuotaStore } from "../lib/quota-state.js";
import { readUsageCacheStale } from "../lib/usage-cache.js";
import { makeVersionCache, probeInstalled } from "../lib/update-hints.js";
import { currentUsageWindow } from "../lib/usage-window.js";
import { machineUsage } from "./machine-usage.js";
import { runReminders, type ReminderSenders } from "./quota-reminders.js";
import { newThreadId, type Delivery, type Envelope } from "./router.js";

export const QUOTA_CADENCE = {
  viewingTickMs: 60_000,
  idleTickMs: 5 * 60_000,
  /** 最近一次 GET 距今不超过它 = 有人在看（网页 60 秒拉一次，留半个周期余量） */
  viewWindowMs: 90_000,
  /** 打开看板时等首查的上限 */
  openWaitMs: 6_000,
} as const;

type SchedulerApi = Pick<QuotaScheduler, "tick" | "refresh" | "refreshResetCredits" | "view" | "health" | "onDisabled" | "withReminders">;

export interface QuotaServiceDeps {
  now(): number;
  /** 调度器由服务来建：它的 isEnabled 必须读服务里的开关 */
  makeScheduler(isEnabled: () => boolean): SchedulerApi;
  readEnabled(): boolean;
  writeEnabled(v: boolean): Promise<void>;
  /** live = 实时读取开着：Pi 接入商的套餐 / 余额也只在这时去查（lib/quota-pi-plans.ts） */
  local(live: boolean): Promise<{ claudeCache: LayerInput["local"]["claudeCache"]; codexRollout: LayerInput["local"]["codexRollout"]; extra: ProviderEntry[] }>;
  /** 每个 tick 之后跑一次提醒（quota-reminders.ts）；开关关着时不跑 */
  afterTick(scheduler: SchedulerApi): Promise<void>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
  log?(msg: string): void;
}

export interface QuotaView {
  enabled: boolean;
  snapshot: QuotaSnapshot;
  health: Awaited<ReturnType<SchedulerApi["health"]>>;
}

export function createQuotaService(d: QuotaServiceDeps) {
  const log = d.log ?? ((m: string) => console.error(m));
  let enabled = d.readEnabled();
  const scheduler = d.makeScheduler(() => enabled);
  let lastViewedAt: number | null = null;
  let timer: unknown = null;
  let running = false;

  const viewing = () => lastViewedAt !== null && d.now() - lastViewedAt < QUOTA_CADENCE.viewWindowMs;

  /** 总开关现读（手改 config.json、文件坏了按关）：由开变关时同样让在途结果作废 */
  function syncEnabled(): void {
    const v = d.readEnabled();
    if (v === enabled) return;
    enabled = v;
    if (!v) scheduler.onDisabled();
  }

  async function tickOnce(): Promise<void> {
    syncEnabled();
    try {
      await scheduler.tick({ viewing: viewing() });
      if (enabled) await d.afterTick(scheduler);
    } catch (e) {
      // 调度器自己兜底不抛；这里接住的是提醒投递的意外，下一个 tick 会重试未送达的渠道
      log(`[quota] tick 后续出错：${(e as Error)?.name ?? "unknown"}`);
    }
  }

  function schedule(): void {
    if (!running) return;
    if (timer !== null) d.clearTimer(timer);
    timer = d.setTimer(() => {
      timer = null;
      void tickOnce().finally(schedule);
    }, viewing() ? QUOTA_CADENCE.viewingTickMs : QUOTA_CADENCE.idleTickMs);
  }

  async function snapshot(): Promise<QuotaView> {
    syncEnabled();
    const wasViewing = viewing();
    lastViewedAt = d.now();
    if (!wasViewing) {
      schedule(); // 从慢节奏切到 60 秒
      if (enabled) {
        let t: unknown = null;
        const first = Promise.all([scheduler.refresh("claude", "view"), scheduler.refresh("codex", "view")]);
        await Promise.race([first, new Promise<void>((r) => (t = d.setTimer(r, QUOTA_CADENCE.openWaitMs)))]);
        d.clearTimer(t);
      }
    }
    const [remote, local, health] = await Promise.all([
      enabled ? scheduler.view() : Promise.resolve(null),
      d.local(enabled),
      enabled ? scheduler.health() : Promise.resolve({}),
    ]);
    const now = d.now();
    const snap = selectQuotaLayers({ now, enabled, remote, local: { claudeCache: local.claudeCache, codexRollout: local.codexRollout }, extra: local.extra });
    return { enabled, snapshot: snap, health };
  }

  async function retry(p: QuotaProvider): Promise<RefreshResult> {
    if (!enabled) return { status: "disabled" };
    lastViewedAt = d.now();
    // Codex 两个端点共用同家 60 秒间隔，一次只能重试一个：额度正常、只有重置明细坏了（暂停 / 报错）才重试明细
    if (p === "codex") {
      const h = await scheduler.health();
      const detailBad = !!(h.codex_reset_credits?.paused || h.codex_reset_credits?.lastCode);
      const usageBad = !!(h.codex_usage?.paused || h.codex_usage?.lastCode);
      if (detailBad && !usageBad) return scheduler.refreshResetCredits("user_retry");
    }
    return scheduler.refresh(p, "user_retry");
  }

  async function setEnabled(v: boolean): Promise<void> {
    await d.writeEnabled(v);
    enabled = v;
    if (!v) scheduler.onDisabled();
  }

  return {
    snapshot,
    retry,
    setEnabled,
    isEnabled: () => enabled,
    isViewing: viewing,
    start(): void {
      if (running) return;
      running = true;
      schedule();
    },
    stop(): void {
      running = false;
      if (timer !== null) d.clearTimer(timer);
      timer = null;
    },
  };
}

export type QuotaService = ReturnType<typeof createQuotaService>;

/**
 * 本机实际装的 Claude Code 版本（按登录 shell 的 PATH 解析，与 agent 跑的是同一个 claude；launcher 体检同口径）：
 * 拼 Claude 请求的客户端身份头。6 小时重探一次赶上自动升级；探不到返回 null，请求不带身份头。
 */
const CC_VERSION = { key: "quota:installed:claude", ttl: 6 * 60 * 60_000, load: () => probeInstalled("claude") };
const ccVersions = makeVersionCache();
async function claudeClientVersion(): Promise<string | null> {
  await ccVersions.refresh([CC_VERSION]);
  return ccVersions.get(CC_VERSION.key) ?? null;
}

/** 生产依赖：真凭据、真 fetch、quota-state.json、config.json */
function productionScheduler(isEnabled: () => boolean): QuotaScheduler {
  const cred = defaultCredDeps();
  return new QuotaScheduler({
    now: Date.now,
    random: Math.random,
    fetch: (url, init) => fetch(url, init),
    readCredential: (p) => (p === "claude" ? readClaudeCredential(cred) : readCodexCredential(cred)),
    peekAccountKey: (p) => peekAccountKey(p, cred),
    confirmCredential: (c) => confirmCredential(c, cred),
    hashCreditId: (acct, raw) => {
      const secret = cred.secret();
      // 能走到解析 = 凭据已读成功 = 密钥已派生；真缺了就让调度器记成 internal，不拿明文 id 凑数
      if (!secret) throw new Error("quota secret unavailable");
      return hmacHex(secret, acct, raw);
    },
    store: fileQuotaStore(),
    isEnabled,
    claudeBackground: () => readConfigSync().quotaClaudeBackground !== false,
    claudeClientVersion,
  });
}

async function productionLocal(live: boolean) {
  const [rollout, machine, plans] = await Promise.all([
    withCodexQuota({ agents: [] }).then((s) => s.quotas[0] ?? null),
    machineUsage(currentUsageWindow()),
    live ? piPlanEntries({ fetch: (url, init) => fetch(url, init), now: Date.now }) : Promise.resolve([]),
  ]);
  const m = machine && !("unavailable" in machine) ? machine : null;
  return { claudeCache: readUsageCacheStale(), codexRollout: rollout, extra: mergePiEntries(plans, piProviderEntries(m)) };
}

let service: QuotaService | null = null;

/** 提醒的 Discord 渠道：#control 一条（与 notifyMaster 同一种信封，但把送没送到返回给提醒账本） */
export function controlChannelSender(deliver: (env: Envelope) => Promise<Delivery>, channelId = process.env.CONTROL_CHANNEL_ID || "") {
  return async (content: string): Promise<boolean> => {
    if (!channelId) return true; // 没配 #control：这个渠道不存在，不是失败（重试也不会变好）
    const userId = (process.env.ALLOWED_USER_IDS || "").split(",")[0]?.trim() || "";
    const r = await deliver({
      from: { kind: "bridge", label: "quota-reminder" },
      to: { kind: "user", userId, channelId },
      intent: "notification",
      content,
      meta: { messageId: `quota_${Date.now()}`, triggerKind: "bridge_synth", ts: new Date().toISOString(), threadId: newThreadId() },
    });
    return r.outcome.kind === "sent";
  };
}

/** bridge 启动时调一次（http-peer.ts 的 initHttpPeer，与推送同处） */
export function startQuotaService(senders: ReminderSenders): QuotaService {
  if (service) return service;
  const afterTick: QuotaServiceDeps["afterTick"] = (sch) => runReminders(sch, senders, Date.now());
  void claudeClientVersion(); // 预热：打开看板的第一次查询就能带上身份头（探测失败只是这一轮不带，makeVersionCache 自己记日志）
  service = createQuotaService({
    now: Date.now,
    makeScheduler: productionScheduler,
    readEnabled: () => readConfigSync().quotaLive !== false, // 缺省开；文件坏了 safeConfigOnCorrupt 给 false
    writeEnabled: async (v) => void (await setQuotaLive(v)),
    local: productionLocal,
    afterTick,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  service.start();
  return service;
}

/** local-api 用；还没启动（单测 / 沙箱早期）= null，路由回 503 */
export function quotaService(): QuotaService | null {
  return service;
}

/** 单测注入；生产不调 */
export function setQuotaServiceForTest(s: QuotaService | null): void {
  service = s;
}
