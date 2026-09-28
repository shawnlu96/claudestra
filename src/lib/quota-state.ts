/**
 * 订阅额度的持久状态（~/.claude-orchestrator/quota-state.json，0600）：按 HMAC 账户键隔离的快照、
 * 端点健康与冷却、凭据读取的冷却、提醒去重账本。
 *
 * 只存 HMAC 过的键和白名单 DTO：没有 token、原始账户 id、credit 原始 id、email。
 * 这份文件是缓存 + 去重账本，坏了就备份报一次、按空重来（代价最多是一条重复提醒），不拒写——
 * 拒写会让调度永远存不下冷却，反而更频繁地打接口。单测在 tests/quota-scheduler.test.ts。
 */

import { statePath } from "./paths.js";
import type { CredErrorCode, QuotaProvider } from "./quota-credentials.js";
import type { DtoMap, FetchErrorCode, QuotaEndpoint } from "./quota-providers.js";
import { emptyLedger, type ReminderLedger } from "./quota-reminder-rules.js";
import { readJsonState, reportCorrupt, writeJsonAtomic } from "./state-file.js";

const QUOTA_STATE_PATH = statePath("quota-state.json");

export interface EndpointHealth {
  lastCode: FetchErrorCode | null;
  lastAttemptAt: number | null;
  /** 连续失败次数（退避指数） */
  failures: number;
  cooldownUntil: number | null;
  /** 401 冷却绑定的凭据指纹：指纹变了立刻可重试 */
  authFingerprint: string | null;
  /** 404 / 形状不对 / 重定向等：暂停，doctor 报；到 cooldownUntil 或用户主动重试才恢复 */
  paused: boolean;
}

export type Snapshots = { [E in QuotaEndpoint]?: { data: DtoMap[E]; observedAt: number } };

export interface AccountState {
  provider: QuotaProvider;
  identity: "assumed" | "bound";
  /** 401、Keychain 被拒 / 超时、请求期间换号：账户不确定，数据只能标陈旧、不出提醒 */
  uncertain: boolean;
  /** 429 是账户级限频：同一账户的所有端点一起等 */
  rateLimitedUntil: number | null;
  lastSeenAt: number;
  snapshots: Snapshots;
  health: Partial<Record<QuotaEndpoint, EndpointHealth>>;
}

interface CredHealth {
  code: CredErrorCode;
  at: number;
  /** null = 只认用户主动重试（Keychain 被拒 / 超时：不能每开一次看板就弹一次框） */
  until: number | null;
}

export interface QuotaState {
  v: 1;
  /** 每家当前账户键；null = 凭据缺一方，账户未知 */
  current: Partial<Record<QuotaProvider, string | null>>;
  accounts: Record<string, AccountState>;
  credHealth: Partial<Record<QuotaProvider, CredHealth>>;
  reminders: ReminderLedger;
}

export function emptyQuotaState(): QuotaState {
  return { v: 1, current: {}, accounts: {}, credHealth: {}, reminders: emptyLedger() };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function isQuotaState(v: unknown): v is QuotaState {
  if (!isObj(v) || v.v !== 1 || !isObj(v.current) || !isObj(v.accounts) || !isObj(v.credHealth)) return false;
  const r = v.reminders;
  return isObj(r) && isObj(r.credits) && isObj(r.exhausted) && Array.isArray(r.outbox);
}

export interface QuotaStore {
  load(): Promise<QuotaState>;
  save(s: QuotaState): Promise<void>;
}

/** 不是当前账户、30 天没见过的账户整块丢掉，文件不无限长 */
const ACCOUNT_TTL_MS = 30 * 24 * 3600_000;

export function pruneAccounts(s: QuotaState, now: number): QuotaState {
  const current = new Set(Object.values(s.current).filter((k): k is string => !!k));
  const accounts = Object.fromEntries(Object.entries(s.accounts).filter(([k, a]) => current.has(k) || now - a.lastSeenAt < ACCOUNT_TTL_MS));
  return { ...s, accounts };
}

export function fileQuotaStore(path: string = QUOTA_STATE_PATH): QuotaStore {
  return {
    async load() {
      const r = await readJsonState(path, isQuotaState);
      if (r.status === "ok") return r.data as QuotaState;
      if (r.status === "corrupt") reportCorrupt(path, r.error, "quota", false);
      return emptyQuotaState();
    },
    save: (s) => writeJsonAtomic(path, s, { mode: 0o600 }),
  };
}

/** 测试与沙箱用：存取都深拷贝，行为等同落盘再读回 */
export function memoryQuotaStore(init?: QuotaState): QuotaStore & { saved: number; peek(): QuotaState | null } {
  let data: QuotaState | null = init ? structuredClone(init) : null;
  const store = {
    saved: 0,
    load: async () => (data ? structuredClone(data) : emptyQuotaState()),
    save: async (s: QuotaState) => {
      data = structuredClone(s);
      store.saved++;
    },
    peek: () => data,
  };
  return store;
}
