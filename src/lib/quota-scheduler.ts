/**
 * 订阅额度的查询调度（设计稿 T2b §3 / §6.1）：账户级隔离、单一在途请求、失败分类与冷却、快照存储。
 *
 *   - 同一端点同时只有一个在途请求（网页 / Discord / 后台三处合并）；同一家的端点串行。
 *   - 同一端点两次查询至少隔 60 秒，「刷新」也绕不过；冷却只有 Keychain 被拒 / 端点暂停这两类认「用户主动重试」。
 *   - 401 按凭据内容指纹冷却 30 分钟；403 长冷却；429 账户级、按 Retry-After；网络 / 超时 / 5xx 指数退避加抖动；
 *     404 / 形状不对 / 重定向 / 超大 / 其它 4xx 暂停端点。
 *   - Claude 的 Keychain 只在有人看看板时读（后台原因一律跳过）；被拒 / 超时后只认用户主动重试。
 *   - 开关关掉（onDisabled）：代数 +1，在途结果回来一律丢弃、不入库；请求前后身份变了也丢弃。
 * 单测 tests/quota-scheduler.test.ts（假 fetch / 时钟 / 凭据 / 存储）。
 */

import type { CredErrorCode, CredResult, QuotaCredential, QuotaProvider } from "./quota-credentials.js";
import { getQuota, QUOTA_ENDPOINTS, type FetchErrorCode, type QuotaEndpoint, type QuotaFetch } from "./quota-providers.js";
import { pruneLedger, type ReminderLedger } from "./quota-reminder-rules.js";
import { pruneAccounts, type AccountState, type EndpointHealth, type QuotaState, type QuotaStore, type Snapshots } from "./quota-state.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
export const QUOTA_TIMING = {
  minIntervalMs: MIN,
  /** 看板有人看：每家额度 5 分钟一次；重置明细 30 分钟一次（汇总数已随额度一起来） */
  viewIntervalMs: 5 * MIN,
  detailViewIntervalMs: 30 * MIN,
  /** 没人看：只为快过期提醒查 Codex 重置明细 */
  detailBackgroundIntervalMs: 6 * HOUR,
  /** 两次 tick 间隔超过它 = 睡眠唤醒，立刻重查 */
  wakeGapMs: 15 * MIN,
  authCooldownMs: 30 * MIN,
  forbiddenCooldownMs: 6 * HOUR,
  rateLimitDefaultMs: 15 * MIN,
  pauseMs: 24 * HOUR,
  /** 额度快照超过这个年龄算陈旧；重置明细按后台节奏放宽 */
  usageStaleMs: 10 * MIN,
  detailStaleMs: 7 * HOUR,
} as const;

export type RefreshReason = "view" | "manual" | "background" | "wake" | "user_retry";
export type RefreshResult =
  | { status: "fetched" | "skipped_interval" | "skipped_paused" | "skipped_policy" | "disabled" | "discarded" }
  | { status: "skipped_cooldown"; code: FetchErrorCode | CredErrorCode }
  | { status: "failed"; code: FetchErrorCode | CredErrorCode };

export interface QuotaSchedulerDeps {
  now(): number;
  random(): number;
  fetch: QuotaFetch;
  readCredential(p: QuotaProvider): Promise<CredResult>;
  /** 只读账户标识（不碰 Keychain）→ 账户键；拿不到 null */
  peekAccountKey(p: QuotaProvider): Promise<string | null>;
  confirmCredential(c: QuotaCredential): Promise<boolean>;
  /** HMAC(本机密钥, 账户键 + credit.id) */
  hashCreditId(accountKey: string, rawId: string): string;
  store: QuotaStore;
  isEnabled(): boolean;
}

interface EndpointView<E extends QuotaEndpoint = QuotaEndpoint> {
  snapshot: NonNullable<Snapshots[E]> | null;
  lastCode: FetchErrorCode | null;
  paused: boolean;
  /** 最近一次查询失败、或快照太旧：界面标陈旧，提醒规则不认 */
  stale: boolean;
}

export interface ProviderRemote {
  account: { key: string; identity: "assumed" | "bound"; uncertain: boolean } | null;
  credFailure: { code: CredErrorCode; needsUserRetry: boolean } | null;
  endpoints: { [E in QuotaEndpoint]?: EndpointView<E> };
}
export type RemoteView = Record<QuotaProvider, ProviderRemote>;

const usageEndpoint = (p: QuotaProvider): QuotaEndpoint => (p === "claude" ? "claude_usage" : "codex_usage");
const PROVIDERS: QuotaProvider[] = ["claude", "codex"];
const PAUSE_CODES = new Set<FetchErrorCode>(["http_404", "bad_shape", "bad_json", "redirect", "too_large", "http_4xx"]);
const BACKOFF_CODES = new Set<FetchErrorCode>(["timeout", "network", "http_5xx"]);

/** 网络 / 超时 / 5xx 的退避：60s 起翻倍、封顶 1 小时，±20% 抖动 */
export function backoffMs(failures: number, random: number): number {
  const base = Math.min(HOUR, MIN * 2 ** Math.max(0, failures - 1));
  return Math.round(base * (0.8 + 0.4 * random));
}

function freshHealth(): EndpointHealth {
  return { lastCode: null, lastAttemptAt: null, failures: 0, cooldownUntil: null, authFingerprint: null, paused: false };
}

/** 一次失败 → 端点健康（与账户级 429 冷却）怎么变 */
export function applyFailure(
  acct: AccountState,
  h: EndpointHealth,
  out: { code: FetchErrorCode; retryAfterMs?: number },
  ctx: { now: number; fingerprint: string; random: number },
): void {
  h.lastCode = out.code;
  h.failures += 1;
  h.authFingerprint = null;
  h.paused = false;
  if (out.code === "http_401") {
    h.cooldownUntil = ctx.now + QUOTA_TIMING.authCooldownMs;
    h.authFingerprint = ctx.fingerprint;
    acct.uncertain = true;
  } else if (out.code === "http_403") h.cooldownUntil = ctx.now + QUOTA_TIMING.forbiddenCooldownMs;
  else if (out.code === "http_429") {
    h.cooldownUntil = null;
    acct.rateLimitedUntil = ctx.now + (out.retryAfterMs ?? QUOTA_TIMING.rateLimitDefaultMs);
  } else if (BACKOFF_CODES.has(out.code)) h.cooldownUntil = ctx.now + backoffMs(h.failures, ctx.random);
  else if (PAUSE_CODES.has(out.code)) {
    h.paused = true;
    h.cooldownUntil = ctx.now + QUOTA_TIMING.pauseMs;
  }
}

/** 凭据读取失败的冷却：Keychain 被拒 / 超时 / 异常只认用户重试；读不到条目 30 分钟；其它（读文件，便宜）1 分钟 */
function credCooldown(code: CredErrorCode, now: number): number | null {
  if (code === "keychain_denied" || code === "keychain_timeout" || code === "keychain_error") return null;
  if (code === "keychain_missing") return now + QUOTA_TIMING.authCooldownMs;
  if (code === "token_expired") return now + 5 * MIN;
  return now + MIN;
}
/** 这些失败说明「现在不知道是哪个账户」：当前账户清空，不再把旧账户的卡片当成它 */
const ACCOUNT_UNKNOWN = new Set<CredErrorCode>(["no_secret", "auth_missing", "auth_bad_shape", "account_missing", "keychain_missing"]);

type Gate = Exclude<RefreshResult, { status: "fetched" | "failed" | "disabled" | "discarded" }> | null;

/** 端点当前能不能发。fingerprint = null（还没读凭据）时 401 冷却放行，留到读完凭据再比指纹 */
function gate(acct: AccountState, endpoint: QuotaEndpoint, now: number, reason: RefreshReason, fingerprint: string | null): Gate {
  if (acct.rateLimitedUntil !== null && acct.rateLimitedUntil > now) return { status: "skipped_cooldown", code: "http_429" };
  const h = acct.health[endpoint];
  if (!h) return null;
  if (h.paused && reason !== "user_retry" && (h.cooldownUntil ?? Infinity) > now) return { status: "skipped_paused" };
  if (h.lastAttemptAt !== null && now - h.lastAttemptAt < QUOTA_TIMING.minIntervalMs) return { status: "skipped_interval" };
  if (h.paused || h.cooldownUntil === null || h.cooldownUntil <= now || !h.lastCode) return null;
  if (h.lastCode !== "http_401") return { status: "skipped_cooldown", code: h.lastCode };
  return fingerprint !== null && fingerprint === h.authFingerprint ? { status: "skipped_cooldown", code: h.lastCode } : null;
}

export class QuotaScheduler {
  private state: Promise<QuotaState> | null = null;
  private gen = 0;
  private lastTickAt: number | null = null;
  private inflight = new Map<QuotaEndpoint, Promise<RefreshResult>>();
  private chains = new Map<QuotaProvider, Promise<unknown>>();

  constructor(private deps: QuotaSchedulerDeps) {}

  private load(): Promise<QuotaState> {
    return (this.state ??= this.deps.store.load());
  }

  private async save(): Promise<void> {
    const st = await this.load();
    const pruned = pruneAccounts(st, this.deps.now());
    st.accounts = pruned.accounts;
    await this.deps.store.save(st);
  }

  refresh(p: QuotaProvider, reason: RefreshReason): Promise<RefreshResult> {
    return this.run(usageEndpoint(p), reason);
  }

  /** Codex 重置明细；失败只动它自己的健康状态，不碰额度快照 */
  refreshResetCredits(reason: RefreshReason): Promise<RefreshResult> {
    return this.run("codex_reset_credits", reason);
  }

  /** 同端点并发调用共用一个 Promise；同一家的不同端点排队串行 */
  private run(endpoint: QuotaEndpoint, reason: RefreshReason): Promise<RefreshResult> {
    if (!this.deps.isEnabled()) return Promise.resolve({ status: "disabled" });
    const hit = this.inflight.get(endpoint);
    if (hit) return hit;
    const p = QUOTA_ENDPOINTS[endpoint].provider;
    const task = (this.chains.get(p) ?? Promise.resolve()).then(() => this.attempt(endpoint, reason));
    const tracked = task.finally(() => {
      if (this.inflight.get(endpoint) === tracked) this.inflight.delete(endpoint);
    });
    this.inflight.set(endpoint, tracked);
    this.chains.set(p, tracked.catch(() => undefined)); // 链上只关心上一个结束了，它的异常已经交给它自己的调用方
    return tracked;
  }

  private account(st: QuotaState, p: QuotaProvider, key: string, now: number): AccountState {
    st.current[p] = key;
    const acct = (st.accounts[key] ??= {
      provider: p,
      identity: p === "claude" ? "assumed" : "bound",
      uncertain: false,
      rateLimitedUntil: null,
      lastSeenAt: now,
      snapshots: {},
      health: {},
    });
    acct.lastSeenAt = now;
    return acct;
  }

  private async credFailure(st: QuotaState, p: QuotaProvider, code: CredErrorCode, now: number): Promise<RefreshResult> {
    st.credHealth[p] = { code, at: now, until: credCooldown(code, now) };
    const cur = st.current[p];
    if (ACCOUNT_UNKNOWN.has(code)) st.current[p] = null;
    else if (cur && st.accounts[cur]) st.accounts[cur].uncertain = true;
    await this.save();
    return { status: "failed", code };
  }

  private async attempt(endpoint: QuotaEndpoint, reason: RefreshReason): Promise<RefreshResult> {
    const gen = this.gen;
    const p = QUOTA_ENDPOINTS[endpoint].provider;
    const live = () => gen === this.gen && this.deps.isEnabled();
    if (!live()) return { status: "disabled" };
    if (p === "claude" && reason === "background") return { status: "skipped_policy" };
    const st = await this.load();
    const now = this.deps.now();
    const ch = st.credHealth[p];
    if (ch && reason !== "user_retry" && (ch.until === null || ch.until > now)) return { status: "skipped_cooldown", code: ch.code };
    // 先按账户标识判一遍：限频 / 冷却中就不去读 Keychain（换了号则按新号判，不被旧号的冷却卡住）
    const peek = await this.deps.peekAccountKey(p);
    // 当前账户以本机登录的标识为准：换回了旧号就立刻切过去，哪怕这次被冷却挡住，也不继续展示上一个号的卡片
    if (peek && st.current[p] !== peek) this.account(st, p, peek, now);
    const pre = peek ? gate(st.accounts[peek], endpoint, now, reason, null) : null;
    if (pre) return pre;
    const cr = await this.deps.readCredential(p);
    if (!live()) return { status: "discarded" };
    if (!cr.ok) return this.credFailure(st, p, cr.code, now);
    delete st.credHealth[p];
    const cred = cr.cred;
    const acct = this.account(st, p, cred.accountKey, now);
    const g = gate(acct, endpoint, now, reason, cred.fingerprint);
    if (g) return g;
    const h = (acct.health[endpoint] ??= freshHealth());
    h.lastAttemptAt = now;
    const out = await getQuota(endpoint, cred, {
      fetch: this.deps.fetch,
      now: this.deps.now,
      hashCreditId: (raw) => this.deps.hashCreditId(cred.accountKey, raw),
    });
    const same = await this.deps.confirmCredential(cred);
    if (!live() || !same) return { status: "discarded" };
    const at = this.deps.now();
    if (out.ok) {
      (acct.snapshots as Record<string, unknown>)[endpoint] = { data: out.data, observedAt: at };
      acct.health[endpoint] = { ...freshHealth(), lastAttemptAt: now };
      acct.uncertain = false;
    } else applyFailure(acct, h, out, { now: at, fingerprint: cred.fingerprint, random: this.deps.random() });
    await this.save();
    return out.ok ? { status: "fetched" } : { status: "failed", code: out.code };
  }

  /** 开关关掉：在途请求回来一律丢弃（不入库、不触发提醒），排队的也不再发 */
  onDisabled(): void {
    this.gen++;
    this.inflight.clear();
  }

  private async due(endpoint: QuotaEndpoint, interval: number, now: number): Promise<boolean> {
    const st = await this.load();
    const key = st.current[QUOTA_ENDPOINTS[endpoint].provider];
    const acct = key ? st.accounts[key] : undefined;
    const last = Math.max(acct?.snapshots[endpoint]?.observedAt ?? -Infinity, acct?.health[endpoint]?.lastAttemptAt ?? -Infinity);
    return now - last >= interval;
  }

  /** 定时器每次调一次（T2b-2 起定时器）。有人看 → 两家额度 + 明细；没人看 → 只查 Codex 重置明细 */
  async tick(opts: { viewing: boolean }): Promise<void> {
    const now = this.deps.now();
    const wake = this.lastTickAt !== null && now - this.lastTickAt > QUOTA_TIMING.wakeGapMs;
    this.lastTickAt = now;
    if (!this.deps.isEnabled()) return;
    const T = QUOTA_TIMING;
    if (opts.viewing) {
      for (const p of PROVIDERS) if (wake || (await this.due(usageEndpoint(p), T.viewIntervalMs, now))) await this.refresh(p, wake ? "wake" : "view");
      if (wake || (await this.due("codex_reset_credits", T.detailViewIntervalMs, now))) await this.refreshResetCredits(wake ? "wake" : "view");
    } else if (wake || (await this.due("codex_reset_credits", T.detailBackgroundIntervalMs, now))) {
      await this.refreshResetCredits(wake ? "wake" : "background");
    }
  }

  /** 给选层用的只读视图：只含每家当前账户的数据；开关关着时不给远程数据 */
  async view(): Promise<RemoteView> {
    const st = await this.load();
    const now = this.deps.now();
    const out = {} as RemoteView;
    for (const p of PROVIDERS) {
      const key = st.current[p];
      const acct = key && this.deps.isEnabled() ? st.accounts[key] : undefined;
      const ch = st.credHealth[p];
      const endpoints: ProviderRemote["endpoints"] = {};
      for (const e of Object.keys(QUOTA_ENDPOINTS) as QuotaEndpoint[]) {
        if (QUOTA_ENDPOINTS[e].provider !== p || !acct) continue;
        const snap = acct.snapshots[e] ?? null;
        const h = acct.health[e];
        const maxAge = e === "codex_reset_credits" ? QUOTA_TIMING.detailStaleMs : QUOTA_TIMING.usageStaleMs;
        const stale = !snap || !!h?.lastCode || acct.uncertain || now - snap.observedAt > maxAge;
        (endpoints as Record<string, EndpointView>)[e] = { snapshot: snap, lastCode: h?.lastCode ?? null, paused: !!h?.paused, stale };
      }
      out[p] = {
        account: acct && key ? { key, identity: acct.identity, uncertain: acct.uncertain } : null,
        credFailure: ch ? { code: ch.code, needsUserRetry: ch.until === null } : null,
        endpoints,
      };
    }
    return out;
  }

  /** doctor 用：各端点是否暂停、最近错误码（不含任何秘密） */
  async health(): Promise<Partial<Record<QuotaEndpoint, { paused: boolean; lastCode: FetchErrorCode | null }>>> {
    const v = await this.view();
    const out: Partial<Record<QuotaEndpoint, { paused: boolean; lastCode: FetchErrorCode | null }>> = {};
    for (const p of PROVIDERS) {
      for (const [e, ev] of Object.entries(v[p].endpoints)) out[e as QuotaEndpoint] = { paused: ev.paused, lastCode: ev.lastCode };
    }
    return out;
  }

  /** 提醒账本的读改写（T2b-2 的投递方用）：改完顺手清理并落盘，重启后去重仍有效 */
  async withReminders(fn: (ledger: ReminderLedger, view: RemoteView) => ReminderLedger): Promise<ReminderLedger> {
    const st = await this.load();
    st.reminders = pruneLedger(fn(st.reminders, await this.view()), this.deps.now());
    await this.save();
    return st.reminders;
  }
}
