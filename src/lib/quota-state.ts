/**
 * 订阅额度的持久状态（~/.claude-orchestrator/quota-state.json，0600）：按 HMAC 账户键隔离的快照、
 * 端点健康与冷却、凭据读取的冷却、提醒去重账本。
 *
 * 只存 HMAC 过的键和白名单 DTO：没有 token、原始账户 id、credit 原始 id、email。
 * 这份文件是缓存 + 去重账本：整份坏了就报一次、按空重来（不备份；代价最多是一条重复提醒），
 * 局部坏了（某个账户 / 某条快照形状不对）只丢那一块。不拒写——拒写会让调度永远存不下冷却，
 * 反而更频繁地打接口。单测在 tests/quota-scheduler.test.ts / tests/quota-state.test.ts。
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
  /** 401 冷却期间最近一次「读凭据比指纹」的时刻：看板开着也按看板节奏核对，不每个 tick 读 Keychain */
  credCheckedAt?: number | null;
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
  /** internal = 调度自身出错（spawn 抛错、写盘失败等），也挂冷却 */
  code: CredErrorCode | "internal";
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
  return { v: 1, current: {}, accounts: Object.create(null), credHealth: {}, reminders: emptyLedger() };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function isQuotaState(v: unknown): v is QuotaState {
  if (!isObj(v) || v.v !== 1 || !isObj(v.current) || !isObj(v.accounts) || !isObj(v.credHealth)) return false;
  const r = v.reminders;
  return isObj(r) && isObj(r.credits) && isObj(r.exhausted) && Array.isArray(r.outbox);
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOrNull = (v: unknown) => v === null || num(v);
const strOrNull = (v: unknown) => v === null || typeof v === "string";
const PROVIDERS = new Set(["claude", "codex"]);
const ENDPOINTS = new Set(["claude_usage", "codex_usage", "codex_reset_credits"]);
/** 原型链上的名字当键会让 st.accounts[key] 取到 Object.prototype，读回时一律丢掉 */
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
const safeKey = (k: unknown): k is string => typeof k === "string" && k.length > 0 && k.length <= 128 && !RESERVED.has(k);
const keep = <T>(o: unknown, ok: (k: string, v: unknown) => boolean): Record<string, T> =>
  isObj(o) ? (Object.fromEntries(Object.entries(o).filter(([k, v]) => safeKey(k) && ok(k, v))) as Record<string, T>) : {};

function validHealth(h: unknown): boolean {
  if (!isObj(h)) return false;
  const base = strOrNull(h.lastCode) && numOrNull(h.lastAttemptAt) && num(h.failures) && numOrNull(h.cooldownUntil);
  return base && strOrNull(h.authFingerprint) && typeof h.paused === "boolean" && (h.credCheckedAt === undefined || numOrNull(h.credCheckedAt));
}

/** 快照只查到选层会用到的深度：窗口有 id / usedPct，credit 有 key / expiresAtMs */
function validSnapshot(endpoint: string, s: unknown): boolean {
  if (!isObj(s) || !num(s.observedAt) || !isObj(s.data)) return false;
  if (endpoint === "codex_reset_credits") {
    const cs = s.data.credits;
    return Array.isArray(cs) && cs.every((c) => isObj(c) && typeof c.key === "string" && num(c.expiresAtMs));
  }
  const ws = s.data.windows;
  return Array.isArray(ws) && ws.every((w) => isObj(w) && typeof w.id === "string" && num(w.usedPct));
}

function normalizeAccount(a: unknown): AccountState | null {
  if (!isObj(a) || !PROVIDERS.has(a.provider as string) || (a.identity !== "assumed" && a.identity !== "bound")) return null;
  if (typeof a.uncertain !== "boolean" || !numOrNull(a.rateLimitedUntil) || !num(a.lastSeenAt)) return null;
  return {
    provider: a.provider as QuotaProvider,
    identity: a.identity,
    uncertain: a.uncertain,
    rateLimitedUntil: a.rateLimitedUntil as number | null,
    lastSeenAt: a.lastSeenAt,
    snapshots: keep(a.snapshots, (e, s) => ENDPOINTS.has(e) && validSnapshot(e, s)),
    health: keep(a.health, (e, h) => ENDPOINTS.has(e) && validHealth(h)),
  };
}

function validNotice(n: unknown): boolean {
  if (!isObj(n) || typeof n.id !== "string" || !num(n.createdAt) || typeof n.accountKey !== "string" || !isObj(n.channels)) return false;
  const ch = n.channels;
  return ["push", "discord"].every((c) => isObj(ch[c]) && typeof ch[c].status === "string" && num(ch[c].attempts));
}

/** 从磁盘读回的状态逐层过一遍：形状不对的那一块丢掉，其余照用（外层不对就整份按空） */
export function normalizeQuotaState(v: unknown): QuotaState {
  if (!isQuotaState(v)) return emptyQuotaState();
  const accounts: Record<string, AccountState> = Object.create(null);
  for (const [k, a] of Object.entries(v.accounts)) {
    const n = safeKey(k) ? normalizeAccount(a) : null;
    if (n) accounts[k] = n;
  }
  const r = v.reminders as unknown as Record<string, unknown>;
  return {
    v: 1,
    current: keep(v.current, (p, k) => PROVIDERS.has(p) && (k === null || safeKey(k))),
    accounts,
    credHealth: keep(v.credHealth, (p, c) => PROVIDERS.has(p) && isObj(c) && typeof c.code === "string" && num(c.at) && numOrNull(c.until)),
    reminders: {
      credits: keep(r.credits, (_k, c) => isObj(c) && num(c.expiresAtMs) && Array.isArray(c.coveredH) && c.coveredH.every(num)),
      exhausted: keep(r.exhausted, (_k, at) => num(at)),
      outbox: (r.outbox as unknown[]).filter(validNotice) as ReminderLedger["outbox"],
    },
  };
}

export interface QuotaStore {
  load(): Promise<QuotaState>;
  save(s: QuotaState): Promise<void>;
}

/** 不是当前账户、30 天没见过的账户整块丢掉，文件不无限长 */
const ACCOUNT_TTL_MS = 30 * 24 * 3600_000;

export function pruneAccounts(s: QuotaState, now: number): QuotaState {
  const current = new Set(Object.values(s.current).filter((k): k is string => !!k));
  const accounts: Record<string, AccountState> = Object.create(null);
  for (const [k, a] of Object.entries(s.accounts)) if (current.has(k) || now - a.lastSeenAt < ACCOUNT_TTL_MS) accounts[k] = a;
  return { ...s, accounts };
}

export function fileQuotaStore(path: string = QUOTA_STATE_PATH): QuotaStore {
  return {
    async load() {
      const r = await readJsonState(path, isQuotaState);
      if (r.status === "ok") return normalizeQuotaState(r.data);
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
    load: async () => (data ? normalizeQuotaState(structuredClone(data)) : emptyQuotaState()),
    save: async (s: QuotaState) => {
      data = structuredClone(s);
      store.saved++;
    },
    peek: () => data,
  };
  return store;
}
