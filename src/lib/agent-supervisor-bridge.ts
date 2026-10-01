/**
 * 监护在 bridge 进程里的那一半（i28-S1）：bridge 自己不处置，只做三件和处置表对得上的事——
 * 1. 60 秒续跑统一计数（api-error-resume.ts 一行调 overloadResumeAllowed）：监护对象同一串撞错最多续 3 次，别的 agent 照旧 1 次；
 *    每次撞错和 bridge 怎么处理记进 state/supervise-overload.json（quota-wall-wiring.ts 一行调 noteOverload），调度服务的监护读它留痕、到上限报派活方；
 * 2. 失败卡要不要推 owner（acp-link.ts）：监护对象被内容策略截断、恢复次数还没用完 → 卡照开但不推 owner（failureCardQuiet）；
 * 3. 恢复后关卡（stop-settle.ts）：开着监护的项目里，agent 下一个正常结束的回合关掉它开着的「回合失败」卡（额度 / 登录卡不动）。
 * 监护名单与调度服务同一个函数（agent-supervisor-scope.ts），开关关着时名单为空，三件事都退回改动前的行为。
 * tests/agent-supervisor-bridge.test.ts。
 */
import type { Database } from "bun:sqlite";
import { listAsks, type Ask } from "./ledger-asks.js";
import { LedgerReader } from "./ledger-read.js";
import { statePath } from "./paths.js";
import { readRegistryAgentsSync } from "./registry.js";
import { readSchedulerConfig, type SchedulerConfig } from "./scheduler-config.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { decide, isCyberPolicy, SUPERVISE_RULES, workKeyOf } from "./agent-supervisor-policy.js";
import { priorAttempts, superviseEvents } from "./agent-supervisor-ledger.js";
import { exemptAgent, readCallRows, readHeld, superviseOn, supervisedAgents, type Supervised } from "./agent-supervisor-scope.js";

/** 名单要读台账、回程簿、押后队列：撞错事件一阵一阵来，缓存这么久 */
const SCOPE_TTL_MS = 10_000;

export interface BridgeView {
  config(): SchedulerConfig | null;
  supervised(now: number): Supervised[];
  db(): Database | null;
}

let reader: LedgerReader | null = null;
let cache: { at: number; list: Supervised[] } | null = null;

/** scheduler.json 读不了（坏了）= 当监护关着：bridge 退回改动前的行为，不因配置坏了改变行为 */
const safeConfig = (): SchedulerConfig | null => {
  try { return readSchedulerConfig(); } catch { return null; /* 坏配置：调度服务自己会报 idle，这里按关着处理 */ }
};

export const productionView: BridgeView = {
  config: safeConfig,
  db: () => (reader ??= new LedgerReader()).get(),
  supervised(now) {
    if (cache && now - cache.at < SCOPE_TTL_MS) return cache.list;
    const config = safeConfig();
    const list = config ? supervisedAgents({ config, registry: readRegistryAgentsSync(), db: this.db(), calls: readCallRows(), held: readHeld(), now }) : [];
    cache = { at: now, list };
    return list;
  },
};

const findBy = (view: BridgeView, now: number, pred: (s: Supervised) => boolean): Supervised | undefined => {
  try { return view.supervised(now).find(pred); } catch (e) {
    console.error(`⚠️ 监护名单读不出来，这次按不在名单处理（行为同改动前）：${(e as Error).message}`);
    return undefined;
  }
};

// ── 1. 60 秒续跑统一计数 ──

/** 每个频道当前这一串撞错已经续了几次（bridge 内存；重启后从 1 数起，最坏多续一次） */
const chains = new Map<string, { used: number; at: number }>();
/** 一串撞错：上一次续跑后这么久内又撞算同一串（与 api-error-resume 的 RESUME_WINDOW_MS 同值） */
const CHAIN_MS = 10 * 60_000;

/**
 * 续过一次又撞了：还能不能再续。监护对象最多 SUPERVISE_RULES.overload.limit 次，其余 1 次（= 改动前「最多一次」）。
 * 只在「续过、窗口内又撞」时调，调一次就记一次续跑。
 */
export function overloadResumeAllowed(cid: string, now: number, view: BridgeView = productionView): boolean {
  const prev = chains.get(cid);
  const used = prev && now - prev.at < CHAIN_MS * SUPERVISE_RULES.overload.limit ? prev.used : 1;
  const limit = findBy(view, now, (s) => s.channelId === cid) ? SUPERVISE_RULES.overload.limit : 1;
  if (used >= limit) {
    chains.delete(cid);
    return false;
  }
  chains.set(cid, { used: used + 1, at: now });
  return true;
}

const OVERLOAD_PATH = statePath("supervise-overload.json");
const KEEP_MS = 24 * 3600_000;
const KEEP_N = 20;

interface OverloadEvent { at: number; error: string; act: string }
export type OverloadFile = Record<string, { agent: string; events: OverloadEvent[] }>;

const isFile = (d: unknown): boolean => !!d && typeof d === "object" && !Array.isArray(d);

export function readOverload(path = OVERLOAD_PATH): OverloadFile {
  const r = readJsonStateSync(path, isFile);
  return r.status === "ok" ? (r.data as OverloadFile) : {};
}

/** 记一次撞错和 bridge 的处理（track = 60 秒后续跑；escalate = 续跑用完；其余照原样）：只记监护对象的，别的 agent 不落盘 */
export function noteOverload(cid: string, agent: string, error: string, act: string, at: number, view: BridgeView = productionView, path = OVERLOAD_PATH): void {
  if (!findBy(view, at, (s) => s.channelId === cid)) return;
  try {
    const all = readOverload(path);
    const prev = all[cid]?.events ?? [];
    const events = [...prev, { at, error: error.slice(0, 300), act }].filter((e) => at - e.at < KEEP_MS).slice(-KEEP_N);
    for (const k of Object.keys(all)) if (!all[k].events.some((e) => at - e.at < KEEP_MS)) delete all[k];
    writeJsonAtomicSync(path, { ...all, [cid]: { agent, events } }, { indent: 0 });
  } catch (e) {
    console.error(`⚠️ 撞错记录没写进监护文件（续跑照常，只是台账少一条）：${(e as Error).message}`);
  }
}

// ── 2. 失败卡要不要推 owner ──

/** 监护对象被内容策略截断、这件活的恢复次数还没用完：卡开成不推 owner 的（监护会同会话发恢复消息）；其余照旧推 */
export function failureCardQuiet(agent: string, message: string, now: number, view: BridgeView = productionView): boolean {
  if (!isCyberPolicy(message)) return false;
  const s = findBy(view, now, (x) => x.agent === agent);
  const db = s && view.db();
  if (!s || !db) return false;
  const d = decide("cyber", priorAttempts(superviseEvents(db, agent, now - KEEP_MS), "cyber", workKeyOf(s.work), now), now, now);
  return d.kind !== "report";
}

// ── 3. 恢复后关卡 ──

/** 正常结束了一轮的 agent：开着监护的项目里，它此前开出、还开着的「回合失败」卡（不含额度 / 登录卡） */
export function cardsToClose(db: Database, agent: string, projectId: string | undefined, before: number, config: SchedulerConfig | null): Ask[] {
  if (!config || exemptAgent(agent) || !superviseOn(config, projectId)) return [];
  return listAsks(db, { fromAgent: agent, source: "codex", states: ["open"] }).filter((a) => a.extra.failure === "error" && a.createdAt <= before);
}
