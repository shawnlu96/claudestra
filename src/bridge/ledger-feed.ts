/**
 * bridge 里台账读侧的唯一连接 + 每秒一次的变更推送（docs 10-ledger §2）。读 API（local-api/ledger.ts）、GET /agents 的
 * ledgerTask（agent-info-routes.ts）和 SSE 过滤都经这里，共用同一条只读连接。
 * 轮询懒启动：第一条能读台账的 /api/v1/events 连接建过滤器时起，之后常驻——没人能收 ledger 事件时不查库，
 * 也不用往 bridge.ts（热点在上限）加启动行。单测经 setLedgerFeedForTest 换库路径、换 emit，并手动 tick。
 */
import { askWhoOf, canSeeAsk } from "../lib/ask-access.js";
import { canReadLedger } from "../lib/devices.js";
import { LedgerReader, ledgerFeedTicker } from "../lib/ledger-read.js";
import { agentInScope, type Principal } from "../lib/principals.js";
import { emitEvent, type BridgeEvent } from "./event-bus.js";
import { talkEventAllowed } from "./talk.js";

const TICK_MS = 1000;

let reader = new LedgerReader();
let timer: ReturnType<typeof setInterval> | null = null;
const emitLedgerEvent = (project: string): void => void emitEvent({ agent: "", chatId: "", type: "ledger", data: { project } }, { transient: true });
let emit = emitLedgerEvent;

/** 台账只读连接；库还不存在 → null；打开出错照抛（读 API 回 503） */
export function ledgerDb(): ReturnType<LedgerReader["get"]> {
  return reader.get();
}

function makeTick(): () => void {
  return ledgerFeedTicker({ reader, emit: (p) => emit(p), log: (m) => console.log(m) });
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
 * 能读台账的连接顺带把轮询起起来。types（?types=ask,ledger）：只要这几类——侧栏「待你处理」开一条只收 ask 的轻量流，不背全量工具事件。
 */
export function sseEventAllow(principal: Principal, types?: string[]): (evt: BridgeEvent) => boolean {
  const ledger = canReadLedger(principal);
  if (ledger) ensureLedgerFeed();
  const onlyTypes = types?.length ? new Set(types) : null;
  return (evt) => {
    if (onlyTypes && !onlyTypes.has(evt.type)) return false;
    if (evt.type === "ledger") return ledger;
    if (evt.type === "talk") return talkEventAllowed(principal, evt.data);
    if (evt.type === "ask") return canSeeAsk(principal, askWhoOf(evt.data, evt.agent));
    return agentInScope(principal, evt.agent);
  };
}

/** 单测：换库路径（和 emit，不给 = 真发到 event-bus），返回手动 tick；传 undefined 还原并停掉轮询 */
export function setLedgerFeedForTest(t: { path: string; emit?: (project: string) => void } | undefined): (() => void) | null {
  if (timer) clearInterval(timer);
  timer = null;
  reader.close();
  reader = new LedgerReader(t?.path);
  emit = t?.emit ?? emitLedgerEvent;
  return t ? makeTick() : null;
}
