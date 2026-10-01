/**
 * 执行者带默认做法的 design / scope 提问（i28-ASK2）：PM 拿到通知后 15 分钟没回，按执行者默认做法定，规格末尾追加「自动定」一节。
 * 只有本机 MCP ask、显式 class=design|scope、带 default、blocking=false 的才算（eligible）；blocker / 远端出借单的 ask 永远不自动定——
 * 那是要人的事，自动定 = 绕过人。15 分钟从通知交出去算（extra.handedAt）：通知没投出去的先补投（同一 messageId 幂等），不替没收到的 PM 定。
 * 结案与追加任务同一事务落库，追加按持久化计划只写缺的尾巴（order-ask-default-spec.ts），重复扫描 / 重启不重复追加。
 * 「PM 回过」：网页卡片作答（answered，不在扫描范围），或 PM 用 send_to_agent 回给提问的执行者、正文带 `ask <id>`（recordDefaultPmReply）。
 * bridge 的 ask 到期定时器（ask-expire.ts）每分钟调 sweepAskDefaults。tests/order-ask-default.test.ts。
 */
import type { Database } from "bun:sqlite";
import type { CallerIdentity } from "./caller-identity.js";
import { answerAsk, getAsk, hasAsksTable, patchAsk, type Ask } from "./ledger-asks.js";
import { getMeta, getTask } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { appendDefaultSpec, prepareDefaultSpec, SpecBusy, SpecReplan } from "./order-ask-default-spec.js";
import { askNoticeText } from "./order-ask.js";

export const ASK_DEFAULT_MS = 15 * 60_000;
/** 追加连续失败这么多次（每分钟一次）就投递给 PM 一次，之后退避重试（翻倍，最长一小时）：任务一直留着，文件恢复了就补上 */
const APPEND_ALERT_TRIES = 10;
const APPEND_BACKOFF_MAX_MS = 60 * 60_000;

export interface SweepDeps {
  /** 状态变了发 SSE（bridge publishAsk） */
  publish?: (ask: Ask) => void;
  /** 通知没交出去的补投（bridge sendLedgerNotice；同一 messageId 幂等） */
  notify?: (to: string, text: string, messageId: string) => Promise<{ handed: boolean; note: string }>;
}

const isDefaultAsk = (a: Ask): boolean => a.extra.via === "mcp_ask" && a.blocking === false &&
  (a.extra.class === "design" || a.extra.class === "scope") && typeof a.extra.default === "string" && !!a.extra.default.trim();

/** 15 分钟的起点：通知交出去的时刻；老数据没记就按开出时刻 */
const clockOf = (a: Ask): number => typeof a.extra.handedAt === "number" ? a.extra.handedAt : a.createdAt;

async function renotify(db: Database, a: Ask, notify: NonNullable<SweepDeps["notify"]>, now: number): Promise<void> {
  if (!a.taskId || !a.assignee || !a.fromAgent) return;
  const text = askNoticeText({ taskId: a.taskId, orderId: String(a.extra.orderId ?? ""), from: a.fromAgent, askId: a.id, question: a.body,
    options: Array.isArray(a.extra.options) ? a.extra.options.map(String) : [], default: String(a.extra.default), class: a.extra.class as "design" | "scope" });
  const sent = await notify(a.assignee, text, `ledger-ask:${a.id}`);
  if (sent.handed) patchAsk(db, a.id, { extra: { notice: "handed", handedAt: now } }, now);
}

/** 到点就结案并在同一事务里留下追加任务；返回需要（继续）追加的那条 */
function closeIfDue(db: Database, id: string, now: number): Ask | null {
  return db.transaction(() => {
    const cur = getAsk(db, id);
    if (!cur || !isDefaultAsk(cur)) return null;
    if (cur.state === "open" && cur.extra.notice === "handed" && clockOf(cur) + ASK_DEFAULT_MS <= now) {
      answerAsk(db, id, { choices: [], labels: [], text: "按执行者默认做法定", principal: "system:ask-default", via: "terminal", at: now, final: true });
      patchAsk(db, id, { extra: { defaultAppend: "pending", defaultAt: now } }, now);
    }
    const a = getAsk(db, id);
    return a && a.state === "answered" && a.extra.defaultAppend === "pending" ? a : null;
  }).immediate();
}

const failText = (a: Ask, why: string): string => `${a.taskId ?? a.project} 自动定（ask ${a.id}）连续 ${APPEND_ALERT_TRIES} 次没能追加进规格：`
  + `${why.slice(0, 300)}。已按执行者默认做法结案；追加任务还在，之后退避重试（最长每小时一次），修好规格文件就会补上，也可以直接手动写进规格。`;

/** 追加失败：计数、退避；计划作废的重新计划；排在同一规格前一条后面的（SpecBusy）不计次。任务永远保持 pending，不设终态 */
function appendFailed(db: Database, a: Ask, e: Error, now: number): void {
  if (e instanceof SpecBusy) return;
  const tries = (Number(a.extra.defaultAppendTries) || 0) + 1;
  const replan = e instanceof SpecReplan ? { defaultAppendPlan: null } : {};
  const wait = tries < APPEND_ALERT_TRIES ? 0 : Math.min(APPEND_BACKOFF_MAX_MS, 60_000 * 2 ** (tries - APPEND_ALERT_TRIES));
  patchAsk(db, a.id, { extra: { defaultAppendTries: tries, defaultAppendNextAt: now + wait, defaultAppendError: e.message.slice(0, 1000), ...replan } }, now);
  if (tries === APPEND_ALERT_TRIES && a.taskId) {
    appendEvent(db, { actor: "system:ask-default", dedupKey: `ask-default-failed:${a.id}`, now }, { project: a.project, target: a.taskId, kind: "note",
      text: failText(a, e.message), data: { op: "ask_default_append_failed", askId: a.id, error: e.message.slice(0, 1000) } });
  }
}

/** 到了次数线就真正投递给 PM（同一 messageId 幂等）；投出去才记 alerted，没投出去下次扫描再投 */
async function alertPm(db: Database, id: string, notify: SweepDeps["notify"], now: number): Promise<void> {
  const a = getAsk(db, id);
  if (!notify || !a?.assignee || a.extra.defaultAppendAlerted || (Number(a.extra.defaultAppendTries) || 0) < APPEND_ALERT_TRIES) return;
  const sent = await notify(a.assignee, failText(a, String(a.extra.defaultAppendError ?? "")), `ask-default-failed:${a.id}`);
  if (sent.handed) patchAsk(db, a.id, { extra: { defaultAppendAlerted: true } }, now);
}

function appendOnce(db: Database, id: string, now: number): boolean {
  db.transaction(() => prepareDefaultSpec(db, getAsk(db, id) as Ask)).immediate();
  // SQLite serializes append/recovery with other asks on the same spec; no await inside the critical section.
  return db.transaction(() => {
    const cur = getAsk(db, id) as Ask;
    if (cur.extra.defaultAppend !== "pending") return false;
    appendDefaultSpec(cur);
    patchAsk(db, id, { extra: { defaultAppend: "done" } }, now);
    return true;
  }).immediate();
}

/** bridge 每分钟调一次。永不抛出：单条出错打日志，下次扫描重试 */
export async function sweepAskDefaults(db: Database, now = Date.now(), deps: SweepDeps = {}): Promise<number> {
  if (!hasAsksTable(db)) return 0;
  const rows = db.query(`SELECT id FROM asks WHERE (state = 'open' AND blocking = 0 AND json_extract(extra, '$.via') = 'mcp_ask')
    OR (state = 'answered' AND json_extract(extra, '$.defaultAppend') = 'pending')`).all() as { id: string }[];
  let count = 0;
  for (const { id } of rows) {
    try {
      const open = getAsk(db, id);
      if (deps.notify && open?.state === "open" && isDefaultAsk(open) && open.extra.notice !== "handed") await renotify(db, open, deps.notify, now);
      const a = closeIfDue(db, id, now);
      if (!a) continue;
      await alertPm(db, id, deps.notify, now);
      if (Number(a.extra.defaultAppendNextAt) > now) continue;
      try {
        if (!appendOnce(db, id, now)) continue;
      } catch (e) {
        appendFailed(db, a, e as Error, now);
        await alertPm(db, id, deps.notify, now);
        console.error(`⚠️ ask ${id} 自动定追加未完成（第 ${(Number(a.extra.defaultAppendTries) || 0) + 1} 次）：${(e as Error).message}`);
        deps.publish?.(getAsk(db, id) as Ask);
        continue;
      }
      deps.publish?.(getAsk(db, id) as Ask);
      count++;
    } catch (e) {
      console.error(`⚠️ ask ${id} 自动定扫描出错，下次扫描重试：${(e as Error).message}`);
    }
  }
  return count;
}

const agentName = (s: string | null): string | null => s && (s.startsWith("agent-") || s === "master" ? s : `agent-${s}`);

/**
 * PM 用 send_to_agent 回了：发送方是 bridge 验证过的身份、是这张卡的 PM，目标是提问的执行者（ask 开出时已按当前的单核过），
 * 正文带 `ask <id>`，才把那一条记成「PM 已回复」。没带 id 不关任何 ask。在投递成功之后调；永不抛出，不连累消息本身。
 */
export function recordDefaultPmReply(dbOf: () => Database | null, who: Pick<CallerIdentity, "verified" | "agent">,
  target: unknown, body: unknown, now = Date.now()): string[] {
  try {
    if (!who.verified || !who.agent || typeof target !== "string" || typeof body !== "string") return [];
    const ids = new Set([...body.matchAll(/\bask (ask_[A-Za-z0-9]+)\b/g)].map((m) => m[1]));
    const db = ids.size ? dbOf() : null;
    if (!db || !hasAsksTable(db)) return [];
    return db.transaction(() => {
      const closed: string[] = [];
      for (const id of ids) {
        const a = getAsk(db, id);
        if (!a || a.state !== "open" || !isDefaultAsk(a) || agentName(a.fromAgent) !== agentName(target)) continue;
        const task = a.taskId ? getTask(db, a.taskId) : null;
        if (!task || agentName(task.pm ?? getMeta(db, task.project).pms[0] ?? null) !== agentName(who.agent)) continue;
        answerAsk(db, a.id, { choices: [], labels: ["PM 已回复"], text: body, principal: who.agent as string, via: "terminal", at: now, final: true });
        closed.push(a.id);
      }
      return closed;
    }).immediate();
  } catch (e) {
    console.error(`⚠️ 记录 PM 对默认做法提问的答复失败（消息已照常投递；没关掉的到点会按默认定）：${(e as Error).message}`);
    return [];
  }
}

