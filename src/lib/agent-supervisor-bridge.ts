/**
 * 监护在 bridge 进程里的那一半（i28-S1）：bridge 自己不处置，只做三件和处置表对得上的事——
 * 1. 60 秒续跑统一计数（api-error-resume.ts 一行调 overloadEscalate）：监护对象同一件活最多续 3 次（落盘计数），别的 agent 照旧 1 次；
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

const OVERLOAD_PATH = statePath("supervise-overload.json");
const KEEP_MS = 24 * 3600_000;
const KEEP_N = 20;
/** 批过的续跑次数留这么久（在途的活很少拖过一周；再久了还有台账里的续跑记录兜底） */
const GRANT_KEEP_MS = 7 * 24 * 3600_000;

interface OverloadEvent { at: number; error: string; act: string }
/** grant = 这个频道当前这件活（key = 活 @ 会话）批过几次续跑 */
export type OverloadFile = Record<string, { agent: string; events: OverloadEvent[]; grant?: { key: string; used: number; at: number } }>;

const isFile = (d: unknown): boolean => !!d && typeof d === "object" && !Array.isArray(d);

export function readOverload(path = OVERLOAD_PATH): OverloadFile {
  const r = readJsonStateSync(path, isFile);
  return r.status === "ok" ? (r.data as OverloadFile) : {};
}

/** 只留近期的：撞错留一天，批过的次数留一周 */
function writeOverload(path: string, all: OverloadFile, at: number): void {
  for (const k of Object.keys(all)) {
    const e = all[k];
    if (!e.events.some((x) => at - x.at < KEEP_MS) && !(e.grant && at - e.grant.at < GRANT_KEEP_MS)) delete all[k];
  }
  writeJsonAtomicSync(path, all, { indent: 0 });
}

/** 台账里这件活已经记过几次续跑（调度服务按 bridge 的记录补的；bridge 的文件丢了也数得出来） */
function bookedResumes(view: BridgeView, s: Supervised, now: number): number {
  const db = view.db();
  if (!db) return 0;
  const wk = workKeyOf(s.work);
  return superviseEvents(db, s.agent, now - GRANT_KEEP_MS).filter((e) => e.fault === "overload" && e.step === "resume" && e.phase === "done" && e.workKey === wk).length;
}

/**
 * 回合以 API 错误结束：这次是升级（true）还是 60 秒后续跑（false）。api-error-resume.ts noteApiError 一行调它。
 * 不在监护名单：同改动前——续过、窗口内又撞就升级。监护对象：同一件活（同一会话）一共最多续 SUPERVISE_RULES.overload.limit 次，
 * 次数落盘（bridge 重启、隔了很久再撞都接着数），用完以后一直升级，换了活才从头数；按批出去的算，被额度闸撤掉的也算（宁可少续）。
 * 落盘失败 = 数不住：按改动前升级。
 */
export function overloadEscalate(cid: string, now: number, prev: { resumedAt?: number } | undefined, windowMs: number,
  view: BridgeView = productionView, path = OVERLOAD_PATH): boolean {
  const recent = prev?.resumedAt !== undefined && now - prev.resumedAt < windowMs;
  const s = findBy(view, now, (x) => x.channelId === cid);
  if (!s) return recent;
  if (prev && prev.resumedAt === undefined) return false; // 上一次批的续跑还没发出去：同一次，不另算
  try {
    const all = readOverload(path);
    const key = `${workKeyOf(s.work)}@${s.sessionId}`;
    const mine = all[cid]?.grant?.key === key ? all[cid].grant!.used : 0;
    const used = Math.max(mine, bookedResumes(view, s, now));
    if (used >= SUPERVISE_RULES.overload.limit) return true;
    writeOverload(path, { ...all, [cid]: { agent: s.agent, events: all[cid]?.events ?? [], grant: { key, used: used + 1, at: now } } }, now);
    return false;
  } catch (e) {
    console.error(`⚠️ 续跑次数记不住，这次按改动前升级：${(e as Error).message}`);
    return true;
  }
}

/** 记一次撞错和 bridge 的处理（track = 60 秒后续跑；escalate = 续跑用完；其余照原样）：只记监护对象的，别的 agent 不落盘 */
export function noteOverload(cid: string, agent: string, error: string, act: string, at: number, view: BridgeView = productionView, path = OVERLOAD_PATH): void {
  if (!findBy(view, at, (s) => s.channelId === cid)) return;
  try {
    const all = readOverload(path);
    const prev = all[cid]?.events ?? [];
    const events = [...prev, { at, error: error.slice(0, 300), act }].filter((e) => at - e.at < KEEP_MS).slice(-KEEP_N);
    writeOverload(path, { ...all, [cid]: { ...all[cid], agent, events } }, at);
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
