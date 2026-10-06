/**
 * bridge 里台账读侧的唯一连接 + 每秒一次的变更推送（docs 10-ledger §2）。读 API（local-api/ledger.ts）、GET /agents 的
 * ledgerTask（agent-info-routes.ts）和 SSE 过滤都经这里，共用同一条只读连接。
 * 轮询懒启动：第一条能读台账的 /api/v1/events 连接建过滤器时起，之后常驻——没人能收 ledger 事件时不查库，
 * 也不用往 bridge.ts（热点在上限）加启动行。单测经 setLedgerFeedForTest 换库路径、换 emit，并手动 tick。
 */
import { askWhoOf, canSeeAsk } from "../lib/ask-access.js";
import { canReadLedger } from "../lib/devices.js";
import { LedgerReader, ledgerFeedTicker } from "../lib/ledger-read.js";
import { settledAskClosuresSince, type SettledAskClosure } from "../lib/order-ask-terminal.js";
import { agentInScope, canRunFleet, type Principal } from "../lib/principals.js";
import { emitEvent, type BridgeEvent } from "./event-bus.js";
import { talkEventAllowed } from "./talk.js";

const TICK_MS = 1000;

let reader = new LedgerReader();
let timer: ReturnType<typeof setInterval> | null = null;
const emitLedgerEvent = (project: string): void => void emitEvent({ agent: "", chatId: "", type: "ledger", data: { project } }, { transient: true });
let emit = emitLedgerEvent;
/** 别的进程（CLI / 调度）随出借单结清关掉的 ask：与 bridge/asks.ts publishAsk 同形的 ask 事件（push / pin 订阅对 decide 的 cancelled 不动作，只要 SSE） */
const emitAskClosure = (c: SettledAskClosure): void => void emitEvent({
  agent: c.fromAgent ?? "", chatId: c.chatId, type: "ask",
  data: { project: c.project, askId: c.askId, state: c.state, fromAgent: c.fromAgent, assignee: c.assignee },
}, { transient: true });
let emitAsk = emitAskClosure;

/** 台账只读连接；库还不存在 → null；打开出错照抛（读 API 回 503） */
export function ledgerDb(): ReturnType<LedgerReader["get"]> {
  return reader.get();
}

/**
 * followup-reliability-ASKT：读已提交的「随出借单结清关闭」事件发 ask SSE（lib/order-ask-terminal.ts）。每拍按 seq 游标读（不看 data_version：
 * 同一拍里多笔提交 / 批量取消都在 seq 之后），逐条发、逐条推进游标——读库出错游标不动、下拍重读；某条 emit 抛了停在它前面、下拍从它重发，
 * 已发的不重复。首次启动（含 bridge 重启）只取基线不补发（网页连上就全量重拉），基线里的关闭记进 seen。
 * 换了库文件（generation 变）：seq 是各库自己的，不能当交界；也不看整份文件的修改时间（一次无关写入不说明里面每条关闭何时写）。
 * 换上来那份里 seen 没有的关闭，满足任一条就是新的、照发：
 * ① 读侧见过它开着——lastOpen = 上次读成功那拍、同一读快照里还开着的 worker 提问（已观察的事实）。写事务在 COMMIT 前取 writtenAt，
 *   可以跨过一拍（读连接看的是提交前的快照，照样读成功）；那拍看见它开着，它之后的关闭不论 writtenAt 多早都在那拍之后提交。
 *   旧路径上它还开着、换上来的库里已关，对看过它开着的订阅者也是一次真实的状态变化，条数以当时开着的为限，不是历史洪泛；
 * ② writtenAt 不早于 lastOldAt（上次读成功那拍「开头取的时刻」）——那拍快照里还没有的提问，若在快照之后才提交开出，关它的写事务
 *   只能在那之后拿锁、取 writtenAt，必晚于 lastOldAt（换上来的库里开、关都在读之后，如迁移后接着写）。
 * 两条都不满足 = 读侧从没见过它开着、关闭也写在上次读之前：备份 / 另一台机器的库里的历史，一条不发、只记 seen。
 * 这一代在读通过之前 lastOldAt / lastOpen 不动，中途 emit 抛了下拍按 seen 只补没发的；读通过才认这一代、之后回到 seq 游标
 */
function settledAskTicker(): (at: number) => void {
  let seq: number | null = null;
  let gen = -1;
  let lastOldAt = 0;
  let lastOpen = new Set<string>();
  const seen = new Set<string>();
  let failing = false;
  return (at) => {
    try {
      const db = reader.get();
      if (!db) return;
      if (seq === null) {
        const base = settledAskClosuresSince(db, 0);
        for (const c of base.closures) seen.add(c.askId);
        seq = base.lastSeq;
        if (base.openAskIds) lastOpen = new Set(base.openAskIds);
        gen = reader.generation;
      }
      const swapped = reader.generation !== gen;
      const r = settledAskClosuresSince(db, swapped ? 0 : seq);
      for (const c of r.closures) {
        if (swapped && (seen.has(c.askId) || (!lastOpen.has(c.askId) && c.writtenAt < lastOldAt))) {
          seen.add(c.askId);
          continue;
        }
        emitAsk(c);
        seen.add(c.askId);
        if (!swapped) seq = c.seq;
      }
      seq = r.lastSeq;
      gen = reader.generation;
      if (r.openAskIds) { // 读不到 asks 的那拍什么都没看见：两条边界都不推进
        lastOldAt = at;
        lastOpen = new Set(r.openAskIds);
      }
      if (failing) console.log("📒 出借单结清关问的推送检测恢复");
      failing = false;
    } catch (e) {
      if (!failing) console.log(`⚠️ 出借单结清关问的推送检测出错（恢复前不再重复报）: ${(e as Error).message}`);
      failing = true;
    }
  };
}

function makeTick(): () => void {
  const ledgerTick = ledgerFeedTicker({ reader, emit: (p) => emit(p), log: (m) => console.log(m) });
  const askTick = settledAskTicker();
  return () => {
    const at = Date.now(); // 本拍任何一次核文件身份之前
    ledgerTick();
    askTick(at);
  };
}

/** 起每秒一次的 data_version 轮询（幂等） */
function ensureLedgerFeed(): void {
  if (timer) return;
  const tick = makeTick();
  tick();
  timer = setInterval(tick, TICK_MS);
  timer.unref?.(); // 不单独撑住进程：bridge 有别的常驻句柄，单测跑完能正常退出
}

/**
 * /api/v1/events 的逐条过滤：ledger 事件只给 canReadLedger；ask 事件按 lib/ask-access.ts canSeeAsk（和列表、推送同一个判定：
 * 指给自己的 guest 也收得到）；talk 事件只给房间成员；其余照旧按 agentInScope（"*" 不含 master、peer 永不含 master）。
 * 能读台账、或明确订 types=ask 的连接顺带把轮询起起来。types（?types=ask,ledger）：只要这几类——侧栏「待你处理」开一条只收 ask 的轻量流，不背全量工具事件。
 */
export function sseEventAllow(principal: Principal, types?: string[]): (evt: BridgeEvent) => boolean {
  const ledger = canReadLedger(principal);
  const onlyTypes = types?.length ? new Set(types) : null;
  // 明确订 types=ask 的连接也要起（侧栏「待你处理」流；能看指给自己的 ask 的非台账身份同样要）：结清关问的 ask 事件靠这条轮询发，逐条仍按 canSeeAsk 过滤。
  // 不带 types 的非台账连接照旧不起
  if (ledger || (!principal.disabled && !!onlyTypes?.has("ask"))) ensureLedgerFeed();
  return (evt) => {
    if (onlyTypes && !onlyTypes.has(evt.type)) return false;
    if (evt.type === "ledger") return ledger;
    if (evt.type === "low_priority") return canRunFleet(principal); // 和 /agents 的 lowPriority 字段、批量管理同一道门：只给 owner 的全权设备
    if (evt.type === "talk") return talkEventAllowed(principal, evt.data);
    if (evt.type === "ask") return canSeeAsk(principal, askWhoOf(evt.data, evt.agent));
    return agentInScope(principal, evt.agent);
  };
}

/** 单测：换库路径（和 emit / emitAsk，不给 = 真发到 event-bus），返回手动 tick；传 undefined 还原并停掉轮询 */
export function setLedgerFeedForTest(t: { path: string; emit?: (project: string) => void; emitAsk?: (c: SettledAskClosure) => void } | undefined): (() => void) | null {
  if (timer) clearInterval(timer);
  timer = null;
  reader.close();
  reader = new LedgerReader(t?.path);
  emit = t?.emit ?? emitLedgerEvent;
  emitAsk = t?.emitAsk ?? emitAskClosure;
  return t ? makeTick() : null;
}
