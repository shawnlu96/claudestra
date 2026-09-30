/**
 * 订阅额度的查询调度（设计稿 T2b §3 / §6.1）：账户级隔离、单一在途请求、失败分类与冷却、快照存储。
 *
 *   - 同一端点同时只有一个在途请求（网页 / Discord / 后台三处合并）；同一家的端点串行。
 *   - 同一家（同账户）两次查询至少隔 60 秒，「刷新」也绕不过；Keychain 被拒 / 端点暂停 / 401 核对节奏认「用户主动重试」。
 *   - 401 按凭据内容指纹冷却 30 分钟，冷却期间按看板节奏（5 分钟）读一次凭据核对指纹，不是每个 tick 都读；403 长冷却；429 账户级、按 Retry-After；网络 / 超时 / 5xx 指数退避加抖动；
 *     404 / 形状不对 / 重定向 / 超大 / 其它 4xx 暂停端点。
 *   - Claude 的 Keychain 只在有人看看板时读（后台原因一律跳过）；被拒 / 超时后只认用户主动重试。
 *   - 开关关掉（onDisabled）：代数 +1，在途结果回来一律丢弃、不入库；请求前后身份变了也丢弃。
 *   - 调度自身出错（spawn 抛错、写盘失败）不冒泡：记成固定错误码 internal 并冷却 5 分钟。
 * 单测 tests/quota-scheduler.test.ts（假 fetch / 时钟 / 凭据 / 存储）。
 */

import type { CredErrorCode, CredResult, QuotaCredential, QuotaProvider } from "./quota-credentials.js";
import { claudeClientHeaders, getQuota, QUOTA_ENDPOINTS, type FetchErrorCode, type QuotaEndpoint, type QuotaFetch } from "./quota-providers.js";
import { pruneLedger, type ReminderLedger } from "./quota-reminder-rules.js";
import { pruneAccounts, type AccountState, type QuotaState, type QuotaStore, type Snapshots } from "./quota-state.js";

import {
  ACCOUNT_UNKNOWN, applyFailure, credBlocked, credCooldown, freshHealth, gate, MIN, QUOTA_TIMING,
  type RefreshReason, type RefreshResult,
} from "./quota-policy.js";

export { applyFailure, backoffMs, QUOTA_TIMING, type RefreshReason, type RefreshResult } from "./quota-policy.js";

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
  /** 没人看时也查 Claude（要读 Keychain）：开时与 Codex 明细同一 6 小时后台节奏。不传 = 关（库的缺省保守；bridge 按配置传，缺省开） */
  claudeBackground?(): boolean;
  /** 本机实际装的 Claude Code 版本（拼客户端身份头，不带就看不到重置卡）；探不到 null，这时一个身份头都不带 */
  claudeClientVersion?(): Promise<string | null>;
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
  credFailure: { code: CredErrorCode | "internal"; needsUserRetry: boolean } | null;
  endpoints: { [E in QuotaEndpoint]?: EndpointView<E> };
}
export type RemoteView = Record<QuotaProvider, ProviderRemote>;

const usageEndpoint = (p: QuotaProvider): QuotaEndpoint => (p === "claude" ? "claude_usage" : "codex_usage");
const PROVIDERS: QuotaProvider[] = ["claude", "codex"];
/**
 * 持久状态 → 选层用的只读视图（纯函数）：调度器的 view() 与只读取数方（lib/ai-quota.ts，不起调度器、不碰凭据）共用。
 * enabled = false 时不给账户数据，与看板开关同一口径。
 */
export function remoteViewOf(st: QuotaState, now: number, enabled: boolean): RemoteView {
  const out = {} as RemoteView;
  for (const p of PROVIDERS) {
    const key = st.current[p];
    const acct = key && enabled ? st.accounts[key] : undefined;
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

export class QuotaScheduler {
  private state: Promise<QuotaState> | null = null;
  private gen = 0;
  private lastTickAt: number | null = null;
  private inflight = new Map<QuotaEndpoint, Promise<RefreshResult>>();
  private chains = new Map<QuotaProvider, Promise<unknown>>();
  private saving: Promise<void> = Promise.resolve();
  private lastWritten: string | null = null;

  constructor(private deps: QuotaSchedulerDeps) {}

  private load(): Promise<QuotaState> {
    // 读失败不缓存那个被拒的 Promise：下次再读，而不是永久失明
    return (this.state ??= this.deps.store.load().catch((e) => {
      this.state = null;
      throw e;
    }));
  }

  private async writeState(): Promise<void> {
    const st = await this.load();
    st.accounts = pruneAccounts(st, this.deps.now()).accounts;
    // 内容没变就不写：每个 tick 都会走一遍提醒账本的读改写，整份重写 quota-state.json 纯属磨盘
    const text = JSON.stringify(st);
    if (text === this.lastWritten) return;
    await this.deps.store.save(st);
    this.lastWritten = text;
  }

  /** 两家的链并发时，写盘排成一条：tmp+rename 乱序会让旧状态盖掉新状态 */
  private save(): Promise<void> {
    const next = this.saving.then(() => this.writeState(), () => this.writeState());
    this.saving = next.catch(() => undefined); // 失败已经由这次 save 的调用方收到，链上只管排队
    return next;
  }

  refresh(p: QuotaProvider, reason: RefreshReason): Promise<RefreshResult> {
    return this.run(usageEndpoint(p), reason);
  }

  /** Codex 重置明细；失败只动它自己的健康状态，不碰额度快照 */
  refreshResetCredits(reason: RefreshReason): Promise<RefreshResult> {
    return this.run("codex_reset_credits", reason);
  }

  /**
   * 同端点并发调用共用一个 Promise；同一家的不同端点排队串行。
   * 用户主动重试并进了一个被挡掉（skipped_*）的普通查询时，再单独跑一次，重试按钮不白按。
   */
  private run(endpoint: QuotaEndpoint, reason: RefreshReason, join = true): Promise<RefreshResult> {
    if (!this.deps.isEnabled()) return Promise.resolve({ status: "disabled" });
    const hit = join ? this.inflight.get(endpoint) : undefined;
    if (hit && reason === "user_retry") return hit.then((r) => (r.status.startsWith("skipped_") ? this.run(endpoint, reason, false) : r));
    if (hit) return hit;
    const p = QUOTA_ENDPOINTS[endpoint].provider;
    const task = (this.chains.get(p) ?? Promise.resolve()).then(() => this.attempt(endpoint, reason).catch((e) => this.internalFailure(p, e)));
    const tracked = task.finally(() => {
      if (this.inflight.get(endpoint) === tracked) this.inflight.delete(endpoint);
    });
    this.inflight.set(endpoint, tracked);
    this.chains.set(p, tracked.catch(() => undefined)); // 链上只关心上一个结束了，它的异常已经交给它自己的调用方
    return tracked;
  }

  /** 调度自身出错：只记固定错误码（异常原文可能带路径 / 环境），冷却 5 分钟，不冒泡 */
  private async internalFailure(p: QuotaProvider, e: unknown): Promise<RefreshResult> {
    const errno = (e as NodeJS.ErrnoException | null)?.code;
    console.error(`[quota] ${p} 查询内部出错（${typeof errno === "string" ? errno : "unknown"}），冷却 5 分钟`);
    const now = this.deps.now();
    try {
      const st = await this.load();
      st.credHealth[p] = { code: "internal", at: now, until: now + 5 * MIN };
      await this.save();
    } catch {
      console.error(`[quota] ${p} 冷却写盘失败，只在本进程内生效`); // 状态已改在内存里，重启前冷却照样有效
    }
    return { status: "failed", code: "internal" };
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

  private async credFailure(st: QuotaState, p: QuotaProvider, code: CredErrorCode, now: number, endpoint: QuotaEndpoint): Promise<RefreshResult> {
    const prev = st.credHealth[p];
    st.credHealth[p] = { code, at: now, until: credCooldown(code, now), count: prev?.code === code ? (prev.count ?? 1) + 1 : 1 };
    const cur = st.current[p];
    // 凭据失败也算一次尝试：同账户 60 秒最小间隔照样生效
    if (cur && st.accounts[cur]) (st.accounts[cur].health[endpoint] ??= freshHealth()).lastAttemptAt = now;
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
    if (p === "claude" && reason === "background" && !this.deps.claudeBackground?.()) return { status: "skipped_policy" };
    const st = await this.load();
    const now = this.deps.now();
    const blocked = credBlocked(st.credHealth[p], reason, now);
    if (blocked) return blocked;
    // 先按账户标识判一遍：限频 / 冷却中就不去读 Keychain（换了号则按新号判，不被旧号的冷却卡住）
    const peek = await this.deps.peekAccountKey(p);
    // 当前账户以本机登录的标识为准：换回了旧号就立刻切过去，哪怕这次被冷却挡住，也不继续展示上一个号的卡片
    if (peek && st.current[p] !== peek) this.account(st, p, peek, now);
    const pre = peek ? gate(st.accounts[peek], endpoint, now, reason, null) : null;
    if (pre) return pre;
    const cr = await this.deps.readCredential(p);
    if (!live()) return { status: "discarded" };
    if (!cr.ok) return this.credFailure(st, p, cr.code, now, endpoint);
    delete st.credHealth[p];
    const cred = cr.cred;
    const acct = this.account(st, p, cred.accountKey, now);
    const g = gate(acct, endpoint, now, reason, cred.fingerprint);
    const h = (acct.health[endpoint] ??= freshHealth());
    if (g) {
      if (g.status === "skipped_cooldown" && g.code === "http_401") {
        h.credCheckedAt = now;
        await this.save();
      }
      return g;
    }
    h.lastAttemptAt = now;
    const version = p === "claude" ? ((await this.deps.claudeClientVersion?.().catch(() => null)) ?? null) : null; // 探测失败 = 不带身份头，不挡请求
    const out = await getQuota(endpoint, cred, {
      fetch: this.deps.fetch,
      now: this.deps.now,
      hashCreditId: (raw) => this.deps.hashCreditId(cred.accountKey, raw),
      clientHeaders: claudeClientHeaders(version),
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

  /** 超期多久（ms）：负数 = 还没到期；从没查过 = Infinity */
  private async overdue(endpoint: QuotaEndpoint, interval: number, now: number): Promise<number> {
    const st = await this.load();
    const key = st.current[QUOTA_ENDPOINTS[endpoint].provider];
    const acct = key ? st.accounts[key] : undefined;
    const h = acct?.health[endpoint];
    const last = Math.max(acct?.snapshots[endpoint]?.observedAt ?? -Infinity, h?.lastAttemptAt ?? -Infinity, h?.credCheckedAt ?? -Infinity);
    return last > now ? Infinity : now - last - interval; // 时钟拨回：记录在未来，按到期算，不停查到时钟追上
  }

  /**
   * Codex 的两个端点共用同家 60 秒间隔：一个 tick 只跑超期最久的那个，另一个下个 tick 再轮到。
   * 固定先查额度的话，定时器间隔 ≥ 5 分钟时明细每次都紧跟着撞上间隔，永远拉不到。
   */
  private async tickCodex(plan: [QuotaEndpoint, number][], reason: RefreshReason, wake: boolean, now: number): Promise<void> {
    let best: { e: QuotaEndpoint; by: number } | null = null;
    for (const [e, interval] of plan) {
      const by = await this.overdue(e, interval, now);
      if ((wake || by >= 0) && (!best || by > best.by)) best = { e, by };
    }
    if (best) await this.run(best.e, reason);
  }

  /**
   * Claude 后台：只按「上次后台尝试」的 6 小时节奏读 Keychain，成功失败都算一次——凭据坏着（过期 / 缺条目）时
   * 成功、请求、核对三个时刻都不更新，按它们判就会每个 tick 都读。睡眠唤醒不额外读（owner 批的是 6 小时一次）。
   */
  private async tickClaudeBackground(now: number): Promise<void> {
    if (!this.deps.claudeBackground?.()) return;
    const st = await this.load();
    const last = st.bgAttemptAt?.claude ?? -Infinity;
    if (last > now) {
      // 时钟前跳后又拨回：上次尝试记在未来，按「现在」重置，6 小时后照常读（不停读到时钟追上）
      st.bgAttemptAt = { ...st.bgAttemptAt, claude: now };
      await this.save();
      return;
    }
    if (now - last < QUOTA_TIMING.detailBackgroundIntervalMs) return;
    st.bgAttemptAt = { ...st.bgAttemptAt, claude: now };
    await this.save();
    await this.refresh("claude", "background");
  }

  /** 定时器每次调一次。有人看 → 两家额度 + 明细；没人看 → Codex 重置明细（Claude 只在 claudeBackground 开时也查）。自己兜底，不向定时器抛 */
  async tick(opts: { viewing: boolean }): Promise<void> {
    const now = this.deps.now();
    const wake = this.lastTickAt !== null && now - this.lastTickAt > QUOTA_TIMING.wakeGapMs;
    this.lastTickAt = now;
    if (!this.deps.isEnabled()) return;
    const T = QUOTA_TIMING;
    try {
      if (opts.viewing) {
        const reason = wake ? "wake" : "view";
        if (wake || (await this.overdue("claude_usage", T.viewIntervalMs, now)) >= 0) await this.refresh("claude", reason);
        await this.tickCodex([["codex_usage", T.viewIntervalMs], ["codex_reset_credits", T.detailViewIntervalMs]], reason, wake, now);
      } else {
        await this.tickClaudeBackground(now);
        await this.tickCodex([["codex_reset_credits", T.detailBackgroundIntervalMs]], wake ? "wake" : "background", wake, now);
      }
    } catch (e) {
      const errno = (e as NodeJS.ErrnoException | null)?.code;
      console.error(`[quota] tick 出错（${typeof errno === "string" ? errno : "unknown"}），等下一个 tick`);
    }
  }

  /** 给选层用的只读视图：只含每家当前账户的数据；开关关着时不给远程数据 */
  async view(): Promise<RemoteView> {
    return remoteViewOf(await this.load(), this.deps.now(), this.deps.isEnabled());
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
