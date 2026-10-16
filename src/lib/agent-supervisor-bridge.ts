/**
 * 监护在 bridge 进程里的那一半（i28-S1）：bridge 自己不处置，只做三件和处置表对得上的事——
 * 1. 60 秒续跑统一计数（api-error-resume.ts 一行调 overloadEscalate）：监护对象同一件活最多续 3 次（落盘计数），别的 agent 照旧 1 次；
 *    次数只在同一件活内累计、回合正常结束后清零、登录失效不占次数（agent-supervisor-count.ts，dispatch-recovery-SUPCNT1）；
 *    每次撞错和 bridge 怎么处理记进 state/supervise-overload.json（quota-wall-wiring.ts 一行调 noteOverload），调度服务的监护读它留痕、到上限报派活方；
 * 2. 失败卡要不要推 owner（acp-link.ts）：监护对象被内容策略截断、恢复次数还没用完 → 卡照开但不推 owner（failureCardQuiet）；
 * 3. 恢复后关卡（stop-settle.ts）：开着监护的项目里，agent 下一个正常结束的回合关掉它开着的「回合失败」卡（额度 / 登录卡不动）。
 * 4. cyber 截断的推卡与收会话关卡（dispatch-recovery-CYBRETRY1，开关 supervise.cyberRetry）：有派活方的会话失败卡一律不推 owner；
 *    agent 被 remove / kill 后关掉它还开着的回合失败卡（stop-settle.ts 模块加载时一行调 armGoneCardSweep，bridge 里每分钟扫一遍）。
 * 监护名单与调度服务同一个函数（agent-supervisor-scope.ts），开关关着时名单为空，三件事都退回改动前的行为。
 * tests/agent-supervisor-bridge.test.ts。
 */
import type { Database } from "bun:sqlite";
import { closeAsk, listAsks, type Ask } from "./ledger-asks.js";
import { LedgerReader } from "./ledger-read.js";
import { statePath } from "./paths.js";
import { normalizeRegistryAgents, readRegistryAgentsSync, REGISTRY_PATH, type RegistryAgent } from "./registry.js";
import { readSchedulerConfig, type SchedulerConfig } from "./scheduler-config.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { isTestProcess } from "./test-guard.js";
import { decide, isAuthFailure, isCyberPolicy, readCyberRetryMode, SUPERVISE_RULES, workKeyOf, type CyberRetryMode } from "./agent-supervisor-policy.js";
import { priorAttempts, superviseEvents } from "./agent-supervisor-ledger.js";
import { clearCounts, countedResumes, countKey, refundAuthGrant, type OverloadFile } from "./agent-supervisor-count.js";
import { exemptAgent, readCallRows, readHeld, superviseOn, supervisedAgents, type Supervised } from "./agent-supervisor-scope.js";

/** 名单要读台账、回程簿、押后队列：撞错事件一阵一阵来，缓存这么久 */
const SCOPE_TTL_MS = 10_000;

export interface BridgeView {
  config(): SchedulerConfig | null;
  supervised(now: number): Supervised[];
  db(): Database | null;
  /** cyber 截断那一节的开关；不给 = off（单测手搭的 view 与改动前一致） */
  cyberMode?(): CyberRetryMode;
  /** 本次真读到的 registry；读不出来 / 没有 = null（不能当成所有 agent 都没了） */
  registry?(): RegistryAgent[] | null;
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
  cyberMode: () => readCyberRetryMode(),
  registry() {
    const r = readJsonStateSync(REGISTRY_PATH);
    return r.status === "ok" ? strictRegistry(r.data) : null;
  },
};

/**
 * 只有结构完好的注册表才能当「谁已经没了」的证据：顶层得有 agents 对象、每个条目都是对象。normalizeRegistryAgents 对坏结构
 * 返回 []（给 bridge 别处兜底用），在这里会被当成所有 agent 都被 remove 了，所以先验结构，坏了返回 null、不扫。
 */
export function strictRegistry(data: unknown): RegistryAgent[] | null {
  const agents = isFile(data) ? (data as { agents?: unknown }).agents : undefined;
  if (!isFile(agents) || !Object.values(agents as Record<string, unknown>).every(isFile)) return null;
  return normalizeRegistryAgents(data);
}

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

export type { OverloadFile };

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

/** 台账里这件活已经记过几次续跑（调度服务按 bridge 的记录补的；bridge 的文件丢了也数得出来）；cleared = 上次清零的时刻，之前的不算 */
function bookedResumes(db: Database | null, agent: string, workKey: string, cleared: number | undefined, now: number): number {
  return db ? countedResumes(superviseEvents(db, agent, now - GRANT_KEEP_MS), workKey, cleared).length : 0;
}

/**
 * 回合以 API 错误结束：这次是升级（true）还是到点续跑（false；网络类按退避）。api-error-resume.ts noteApiError 一行调它。
 * 不在监护名单：同改动前——续过、窗口内又撞就升级。监护对象：同一件活（同一会话）一共最多续 SUPERVISE_RULES.overload.limit 次，
 * 次数落盘（bridge 重启、隔了很久再撞都接着数），用完以后一直升级，换了活才从头数；按批出去的算，被额度闸撤掉的也算（宁可少续）。
 * 这件活是哪一件以台账为准（名单有缓存，刚领新单时还是旧单，不能拿旧单的次数判新单）；回合正常结束后从头数（clearOverloadCount）。
 * error = 这一次的错误码。是登录失效：不走 3 次这条线、不批次数——上一次撞的也是登录失效、为它续过（同一件活、同一会话，authMark）、
 * 窗口内又撞才升级，否则续一次。不是登录失效：只看这件活的续跑次数，之前撞过登录失效不影响。没给 error：按不是登录失效判。
 * 网络类错误也按这 3 次（另有 api-error-resume 的退避与连败上限，先到哪个算哪个）。落盘失败 = 数不住：按改动前升级。
 */
export function overloadEscalate(cid: string, now: number, prev: { resumedAt?: number } | undefined, windowMs: number,
  view: BridgeView = productionView, path = OVERLOAD_PATH, error?: string): boolean {
  const recent = prev?.resumedAt !== undefined && now - prev.resumedAt < windowMs;
  const s = findBy(view, now, (x) => x.channelId === cid);
  if (!s) return recent;
  if (prev && prev.resumedAt === undefined) return false; // 上一次批的续跑还没发出去：同一次，不另算
  try {
    const all = readOverload(path);
    const db = view.db();
    const workKey = countKey(db, s);
    const key = `${workKey}@${s.sessionId}`;
    if (error !== undefined && isAuthFailure(error)) return recent && all[cid]?.auth?.key === key;
    const cleared = all[cid]?.cleared;
    const mine = all[cid]?.grant?.key === key ? all[cid].grant.used : 0;
    const used = Math.max(mine, bookedResumes(db, s.agent, workKey, cleared, now));
    if (used >= SUPERVISE_RULES.overload.limit) return true;
    writeOverload(path, { ...all, [cid]: { ...all[cid], agent: s.agent, events: all[cid]?.events ?? [], grant: { key, used: used + 1, at: now } } }, now);
    return false;
  } catch (e) {
    console.error(`⚠️ 续跑次数记不住，这次按改动前升级：${(e as Error).message}`);
    return true;
  }
}

/**
 * 回合正常结束（Stop、没有 API 错误）：这个 agent 批过的续跑次数清零并记下时刻，之后再撞从第 1 次数。上次清零后没撞过就不写盘。
 * 清不掉只记日志：次数留着，最坏比该续的少续几次。
 */
function clearOverloadCount(agent: string, now: number, path = OVERLOAD_PATH): void {
  try {
    const all = readOverload(path);
    if (clearCounts(all, agent, now)) writeOverload(path, all, now);
  } catch (e) {
    console.error(`⚠️ ${agent} 的续跑次数没清掉（照旧接着数）：${(e as Error).message}`);
  }
}

/**
 * 记一次撞错和 bridge 的处理（track = 到点续跑，网络类按退避；escalate = 续跑用完；其余照原样）：只记监护对象的，别的 agent 不落盘。
 * 登录失效（401）：入口没拿到错误码时刚为这次批的续跑次数退回去，不计进这件活的 3 次；为它续了就留下标记（哪件活、哪个会话），
 * 入口下一次撞的还是登录失效时凭它升级。这一次不是登录失效、或没续：标记去掉。
 */
export function noteOverload(cid: string, agent: string, error: string, act: string, at: number, view: BridgeView = productionView, path = OVERLOAD_PATH): void {
  const s = findBy(view, at, (x) => x.channelId === cid);
  if (!s) return;
  try {
    const all = readOverload(path);
    const { auth: _was, grant: had, ...rest } = all[cid] ?? { agent, events: [] };
    const events = [...rest.events, { at, error: error.slice(0, 300), act }].filter((e) => at - e.at < KEEP_MS).slice(-KEEP_N);
    const isAuth = isAuthFailure(error);
    const grant = isAuth ? refundAuthGrant(had, at) : had;
    const auth = isAuth && act === "track" ? { key: `${countKey(view.db(), s)}@${s.sessionId}`, at } : undefined;
    writeOverload(path, { ...all, [cid]: { ...rest, agent, events, ...(grant ? { grant } : {}), ...(auth ? { auth } : {}) } }, at);
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
  const d = decide("cyber", priorAttempts(superviseEvents(db, agent, now - KEEP_MS), "cyber", workKeyOf(s.work), now), now, now, modeOf(view));
  return d.kind !== "report";
}

// ── 3. 恢复后关卡 ──

/**
 * 正常结束了一轮的 agent：开着监护的项目里，它此前开出、还开着的「回合失败」卡（不含额度 / 登录卡）。
 * 投递结果不明的卡（extra.deliveryUnknown）不关：下一轮正常不代表那条可能执行过、没重发的消息有人看过了，只能由人结。
 * stop-settle.ts 在每个正常结束的回合调它一次，所以这件活的续跑次数也在这里清零（SUPCNT1 PM 定 2；与关不关卡、有没有卡无关）
 */
export function cardsToClose(db: Database, agent: string, projectId: string | undefined, before: number, config: SchedulerConfig | null,
  path = OVERLOAD_PATH): Ask[] {
  clearOverloadCount(agent, before, path);
  for (const cb of turnOkListeners) {
    try { cb(agent, before); } catch (e) { console.error(`⚠️ ${agent} 正常结束的回合没通知到续跑计数（网络类连败按 10 分钟窗口清）：${(e as Error).message}`); }
  }
  if (!config || exemptAgent(agent) || !superviseOn(config, projectId)) return [];
  return listAsks(db, { fromAgent: agent, source: "codex", states: ["open"] })
    .filter((a) => a.extra.failure === "error" && a.extra.deliveryUnknown !== true && a.createdAt <= before);
}

/** 正常结束了一轮的 agent（cardsToClose 每个正常结束的回合调一次）：quota-wall-wiring 据此把网络类连败清零（api-error-resume noteTurnOk） */
const turnOkListeners: ((agent: string, at: number) => void)[] = [];
export const onTurnOk = (cb: (agent: string, at: number) => void): void => void turnOkListeners.push(cb);

// ── 4. cyber 截断：推不推 owner、会话收掉后关卡（dispatch-recovery-CYBRETRY1） ──

export { readCyberRetryMode, type CyberRetryMode };

/** view 不带开关 = off（单测手搭的 view 与改动前一致）；失败卡的次数判定（failureCardQuiet → decide）也按它选新旧规则 */
const modeOf = (view: BridgeView): CyberRetryMode => {
  try { return view.cyberMode?.() ?? "off"; } catch { return "observe"; /* 读开关出错：只记日志、行为照旧 */ }
};

/** 这个会话（不给会话 = 这个 agent）一天内开过几张 cyber 回合失败卡：没有派活方的会话就拿它当这件活已截断的次数 */
function priorCyberCards(db: Database, agent: string, sessionId: string | undefined, now: number): number {
  return listAsks(db, { fromAgent: agent, source: "codex" }).filter((a) => a.extra.failure === "error" && now - a.createdAt < KEEP_MS &&
    (!sessionId || a.extra.sessionId === sessionId) && isCyberPolicy(`${a.title}\n${a.context}`)).length;
}

/** 没有派活方（owner 自己开的会话）：开着监护的项目里，截断次数还没到上限就不推；读不出来照旧推 */
function ownerSessionQuiet(agent: string, sessionId: string | undefined, now: number, view: BridgeView): boolean {
  try {
    const config = view.config();
    const db = view.db();
    const row = view.registry?.()?.find((a) => a.name === agent);
    if (!config || !db || !row || exemptAgent(agent) || !superviseOn(config, row.projectId)) return false;
    return priorCyberCards(db, agent, sessionId, now) < SUPERVISE_RULES.cyber.limit;
  } catch (e) {
    console.error(`⚠️ 数不出 ${agent} 的截断次数，这张卡照旧推 owner：${(e as Error).message}`);
    return false;
  }
}

/**
 * acp-link 回合失败卡的判定（PM 定 2）。被内容策略截断时：会话有派活方（在监护名单里 = 调度器的单或回程还挂着的请求，
 * 或派单会话由派活方接手）→ 一律不推 owner，次数用完也交派活方（监护的 report 路径）；没有派活方 → 这个会话截断满上限后的下一次才推。
 * 不是 cyber 或开关 off：与改动前逐字一样（failureCardQuiet || dispatched，短路也一样）；observe：照改动前返回，新旧不同就记一条「本该」。
 */
export function cyberFailureCardQuiet(agent: string, message: string, now: number, at: { sessionId?: string }, dispatched: () => boolean,
  view: BridgeView = productionView): boolean {
  const supervisorQuiet = failureCardQuiet(agent, message, now, view);
  const before = supervisorQuiet || dispatched();
  const mode = modeOf(view);
  if (before || mode === "off" || !isCyberPolicy(message)) return before; // 改动前已经不推的，新规则也不推
  const hasCaller = !!findBy(view, now, (x) => x.agent === agent);
  const want = hasCaller || ownerSessionQuiet(agent, at.sessionId, now, view);
  if (!want) return false;
  const why = hasCaller ? "有派活方，交派活方" : `owner 自己的会话，截断还没满 ${SUPERVISE_RULES.cyber.limit} 次`;
  if (mode === "observe") return console.log(`👀 [cyberRetry observe] ${agent} 的回合失败卡本该不推 owner（${why}），这次照旧推`), false;
  console.log(`🔕 ${agent} 被内容策略截断，回合失败卡不推 owner（${why}）`);
  return true;
}

/** 被 remove（registry 里没了）或 kill（status stopped）的 agent 开出、还开着的回合失败卡；额度 / 登录卡、投递不明的不算，master / 出借 worker 不管 */
function goneAgentCards(db: Database, registry: RegistryAgent[], config: SchedulerConfig | null): Ask[] {
  if (!config) return [];
  const live = new Set(registry.filter((a) => a.status !== "stopped").map((a) => a.name));
  return listAsks(db, { source: "codex", states: ["open"] }).filter((a) => !!a.fromAgent && !live.has(a.fromAgent) && !exemptAgent(a.fromAgent) &&
    superviseOn(config, a.project) && a.extra.failure === "error" && a.extra.deliveryUnknown !== true);
}

/** observe 下每张卡只记一次「本该关」 */
const observedGone = new Set<string>();

/**
 * 会话收掉后关卡（PM 定 3）：扫一遍已被 remove / kill 的 agent 留下的回合失败卡（bridge 里由 armGoneCardSweep 每分钟调一次）。
 * on 关卡并发布；observe 只记「本该关」；off 什么都不做。registry 读不出来或结构坏了不扫（不能当所有人都没了）。出错只记日志：最坏卡多开一会儿。
 */
export function closeGoneAgentCards(db: Database, publish: (a: Ask) => void, now = Date.now(), view: BridgeView = productionView): { closed: string[]; observed: string[] } {
  const out = { closed: [] as string[], observed: [] as string[] };
  try {
    const mode = modeOf(view);
    const registry = mode === "off" ? null : view.registry?.();
    if (!registry) return out;
    for (const a of goneAgentCards(db, registry, view.config())) {
      if (mode === "observe") {
        if (observedGone.size > 1000) observedGone.clear();
        if (!observedGone.has(a.id)) observedGone.add(a.id), console.log(`👀 [cyberRetry observe] ${a.fromAgent} 已收掉，回合失败卡 ${a.id} 本该关，这次照旧留着`);
        out.observed.push(a.id);
        continue;
      }
      const c = closeAsk(db, a.id, "cancelled", "agent 已被 remove / kill：会话收掉了", now, { sessionGoneAt: now });
      if (c) publish(c), out.closed.push(c.id), console.log(`🧹 ${a.fromAgent} 已收掉，关掉它的回合失败卡 ${a.id}`);
    }
  } catch (e) {
    console.error(`⚠️ 关已收掉会话的回合失败卡出错（卡留着，owner 可手动关）：${(e as Error).message}`);
  }
  return out;
}

/** 收会话关卡多久扫一遍：remove / kill 之后最多这么久卡就关了 */
const GONE_SWEEP_MS = 60_000;
let goneSweep: { wired: boolean; timer: ReturnType<typeof setInterval> | null } = { wired: false, timer: null };

/**
 * bridge 加载 stop-settle.ts 时一行调它：起一个周期扫（unref，不拦进程退出），不依赖别的会话正常结束一轮——最后一个会话被收掉、
 * 其余都空闲也照样关。重复调只起一个。测试进程只记「接上了」、不起计时器（单测用 start 注入假计时器）。
 */
export function armGoneCardSweep(db: () => Database | null, publish: (a: Ask) => void,
  start: ((tick: () => void, ms: number) => ReturnType<typeof setInterval>) | null = isTestProcess() ? null : (t, ms) => setInterval(t, ms),
  view: BridgeView = productionView): void {
  goneSweep.wired = true;
  if (goneSweep.timer || !start) return;
  goneSweep.timer = start(() => {
    try {
      const d = db();
      if (d) closeGoneAgentCards(d, publish, Date.now(), view);
    } catch (e) {
      console.error(`⚠️ 收会话关卡的周期扫出错（下一分钟再扫）：${(e as Error).message}`);
    }
  }, GONE_SWEEP_MS);
  (goneSweep.timer as { unref?: () => void }).unref?.();
}

/** 单测看接线、复位 */
export function goneSweepState(): { wired: boolean; running: boolean } {
  return { wired: goneSweep.wired, running: goneSweep.timer !== null };
}
export function resetGoneSweepForTest(): void {
  if (goneSweep.timer) clearInterval(goneSweep.timer);
  goneSweep = { wired: false, timer: null };
}

/** 退避到点后再等监护认领的宽限：过了还没认领，auto tick 照旧退人工（PM 补 13:3x 第 2 条） */
const HOLD_GRACE_MS = 2 * 60_000;
/** observe 下每张卡只记一次「本该让开」 */
const observedHolds = new Set<string>();

/** 恢复认领那件活（order:<意图>）仍是派给这个 agent 的最新一单：同会话换了单就不再拿旧活的次数与退避让开；请求类的活不归 auto tick */
function currentOrder(db: Database, agent: string, workKey: string): boolean {
  if (!workKey.startsWith("order:")) return false;
  try {
    const row = db.query(`SELECT id FROM scheduler_intents WHERE recipient = ? AND action IN ('dispatch','review')
      ORDER BY createdAt DESC, rowid DESC LIMIT 1`).get(agent) as { id: string } | null;
    return !!row && `order:${row.id}` === workKey;
  } catch { return false; /* 没有调度表：不让开 */ }
}

/**
 * 自动流程让开（agent-supervisor-hold.ts 在新卡还没有恢复认领时一行调它）：这张卡所在会话、当前这一单已经恢复过（不拿该 agent 别的会话 / 别的单的认领推断）、
 * 这张 cyber 卡比上一次恢复认领晚开、
 * 次数还没用满、下一次恢复的到点时间加 2 分钟宽限还没过 → 当成监护还在管，auto tick 不退人工；宽限过了监护仍没认领就照旧退人工。
 * 计次与退避就是监护用的那份 decide（新规则）：在 now - 宽限 这一刻它还是 wait，等价于 now < 到点 + 宽限；次数用满是 report。
 * 上一次恢复消息确定没发出去、不是 cyber 卡、没恢复过（第 1 次由监护当轮认领）都不让开；额度 / 登录卡不是回合失败卡，走不到这里；
 * MODELX 让路在 withSupervisorHold 里先判。开关 off 直接 false（与改动前一样）；observe 只记「本该让开」、返回 false。
 */
export function cyberBackoffHolds(db: Database, agent: string, card: Ask, now = Date.now(), mode: CyberRetryMode = readCyberRetryMode()): boolean {
  if (mode === "off" || !isCyberPolicy(`${card.title}\n${card.context}`)) return false;
  const events = superviseEvents(db, agent, now - KEEP_MS);
  const sessionId = card.extra.sessionId;
  if (typeof sessionId !== "string" || !sessionId) return false; // 认不出卡是哪个会话的：不让开（改动前行为）
  const last = events.filter((e) => e.fault === "cyber" && e.step === "recover" && e.phase === "claim" && e.sessionId === sessionId).at(-1);
  if (!last || card.createdAt < last.ts || !currentOrder(db, agent, last.workKey)) return false;
  const done = events.find((e) => e.faultKey === last.faultKey && e.step === "recover" && e.phase === "done");
  if (done?.result === "failed") return false;
  const d = decide("cyber", priorAttempts(events, "cyber", last.workKey, now), card.createdAt, now - HOLD_GRACE_MS, "on");
  if (d.kind !== "wait") return false;
  if (mode === "on") return true;
  if (observedHolds.size > 1000) observedHolds.clear();
  if (!observedHolds.has(card.id)) observedHolds.add(card.id), console.log(`👀 [cyberRetry observe] ${agent} 的 cyber 卡 ${card.id} 在第 ${d.attempt} 次恢复的退避里，auto tick 本该让开，这次照旧`);
  return false;
}
