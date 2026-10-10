/**
 * 执行者带默认做法的 design / scope 提问（i28-ASK2）：PM 拿到通知后 15 分钟没回，按执行者默认做法定，规格末尾追加「自动定」一节。
 * 只有本机 MCP ask、显式 class=design|scope、带 default、blocking=false 的才算（eligible）；blocker / 远端出借单的 ask 永远不自动定——
 * 那是要人的事，自动定 = 绕过人。15 分钟从通知交出去算（extra.handedAt）：通知没投出去的先补投（同一 messageId 幂等），不替没收到的 PM 定。
 * 结案与追加任务同一事务落库，追加按持久化计划只写缺的尾巴（order-ask-default-spec.ts），重复扫描 / 重启不重复追加。
 * 「PM 回过」：网页卡片作答（answered，不在扫描范围），或 PM 用 send_to_agent 回给提问的执行者、正文带 `ask <id>`（recordDefaultPmReply）。
 * bridge 的 ask 到期定时器（ask-expire.ts）每分钟调 sweepAskDefaults。tests/order-ask-default.test.ts。
 *
 * i28-ASK4 测试类扩围：远端出借写单（lend_orders 里 step = write / fix）的提问，执行者填了 files（全在 tests/ 下）和 reason
 * （superseded_assertion / new_test），按同一 15 分钟自动批准——不看问题原文、不看执行者标的 class（design 除外），只看这两个结构化字段；
 * 有一个非 tests/ 文件、没填、PM 先答了都不定。结案、把文件追加进卡的 extra.fileGlobs 同一事务；规格照样追加「自动定」一节；
 * 结论经 deps.tell 发给远端执行者（bridge/ask-default-tell.ts），没发出去下次扫描重发。tests/order-ask-test-scope.test.ts。
 */
import type { Database } from "bun:sqlite";
import type { CallerIdentity } from "./caller-identity.js";
import { answerAsk, getAsk, hasAsksTable, patchAsk, type Ask } from "./ledger-asks.js";
import { getMeta, getTask } from "./ledger-store.js";
import { appendEvent, setTask } from "./ledger-write.js";
import { appendDefaultSpec, prepareDefaultSpec, SpecBusy, SpecReplan, testScopeFiles } from "./order-ask-default-spec.js";
import { askNoticeText } from "./order-ask.js";
import { agentName, isPmParentAsk, pmStandsFor } from "./order-ask-pm-reply.js";
import { ASK_SCOPE_REASONS, type AskScopeReason } from "./order-wire.js";

export const ASK_DEFAULT_MS = 15 * 60_000;
/** 追加连续失败这么多次（每分钟一次）就投递给 PM 一次，之后退避重试（翻倍，最长一小时）：任务一直留着，文件恢复了就补上 */
const APPEND_ALERT_TRIES = 10;
const APPEND_BACKOFF_MAX_MS = 60 * 60_000;

export interface SweepDeps {
  /** 状态变了发 SSE（bridge publishAsk） */
  publish?: (ask: Ask) => void;
  /** 通知没交出去的补投（bridge sendLedgerNotice；同一 messageId 幂等） */
  notify?: (to: string, text: string, messageId: string) => Promise<{ handed: boolean; note: string }>;
  /** 测试类扩围自动批准后把结论发给提问的执行者（远端 worker@peer）；true = 对方收下了 */
  tell?: (a: Ask, text: string) => Promise<boolean>;
}
/** 结论连续这么多次没发给执行者就不再重发，卡上记一条 note 让 PM 自己转告 */
const TELL_TRIES = 10;

const isDefaultAsk = (a: Ask): boolean => a.extra.via === "mcp_ask" && a.blocking === false &&
  (a.extra.class === "design" || a.extra.class === "scope") && typeof a.extra.default === "string" && !!a.extra.default.trim();

/** 远端出借写单（本机台账 lend_orders 那一行的 step）；本机的单 = null */
function lendStepOf(db: Database, orderId: string): string | null {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_orders'").get()) return null;
  return (db.query("SELECT step FROM lend_orders WHERE orderId = ?").get(orderId) as { step: string } | null)?.step ?? null;
}

const isTestFile = (f: unknown): boolean => typeof f === "string" && f.startsWith("tests/") && !f.split("/").some((s) => s === ".." || s === "." || !s);

/** i28-ASK4：远端写单上、files 全在 tests/、reason 合法的提问（ASK2 的本机默认做法提问另走 isDefaultAsk） */
export function isTestScopeAsk(db: Database, a: Ask): boolean {
  const files = a.extra.files;
  if (a.extra.via !== "mcp_ask" || a.blocking === false || a.extra.class === "design" || !a.taskId) return false;
  if (!Array.isArray(files) || !files.length || !files.every(isTestFile)) return false;
  if (!ASK_SCOPE_REASONS.includes(a.extra.reason as AskScopeReason)) return false;
  return ["write", "fix"].includes(lendStepOf(db, String(a.extra.orderId ?? "")) ?? "");
}

const autoAsk = (db: Database, a: Ask): boolean => isDefaultAsk(a) || isTestScopeAsk(db, a);

/** 批准的测试文件追加进卡的 fileGlobs（已在的不重复）；在结案的事务里调 */
function addTestGlobs(db: Database, a: Ask, now: number): void {
  const task = getTask(db, a.taskId as string);
  if (!task) throw new Error(`卡 ${a.taskId} 不在台账里`);
  const cur = Array.isArray(task.extra.fileGlobs) ? task.extra.fileGlobs.filter((g): g is string => typeof g === "string") : [];
  const add = (a.extra.files as string[]).filter((f) => !cur.includes(f));
  if (!add.length) return;
  setTask(db, { actor: "system:ask-default", dedupKey: `ask-default-globs:${a.id}`, now },
    { id: task.id, rev: task.rev, patch: { extra: { ...task.extra, fileGlobs: [...cur, ...add] } } });
}

const tellText = (a: Ask): string => `【自动定】${a.taskId} 你的提问（ask ${a.id}）PM 15 分钟没回，测试类扩围已自动批准：`
  + `${(testScopeFiles(a) ?? []).join("、")} 已追加进本卡范围（fileGlobs），规格末尾追加了「自动定」一节。照常继续，交付报告里写明。`;

/** 结论发给执行者：发出去记 told；连续 TELL_TRIES 次没发出去就停，卡上记 note */
async function tellIfPending(db: Database, id: string, tell: NonNullable<SweepDeps["tell"]>, now: number): Promise<void> {
  const a = getAsk(db, id);
  if (!a || a.extra.tell !== "pending") return;
  const ok = await tell(a, tellText(a)).catch((e: Error) => (console.error(`⚠️ ask ${id} 自动批准的结论没发给执行者：${e.message}`), false));
  if (ok) return void patchAsk(db, id, { extra: { tell: "told", toldAt: now } }, now);
  const tries = (Number(a.extra.tellTries) || 0) + 1;
  patchAsk(db, id, { extra: { tellTries: tries, ...(tries >= TELL_TRIES ? { tell: "failed" } : {}) } }, now);
  if (tries >= TELL_TRIES && a.taskId) {
    appendEvent(db, { actor: "system:ask-default", dedupKey: `ask-default-tell-failed:${a.id}`, now }, { project: a.project, target: a.taskId, kind: "note",
      text: `${a.taskId} 自动批准（ask ${a.id}）的结论连续 ${TELL_TRIES} 次没能发给执行者 ${a.fromAgent}，请 PM 转告：${tellText(a)}`, data: { op: "ask_default_tell_failed", askId: a.id } });
  }
}

/** 15 分钟的起点：通知交出去的时刻；老数据没记就按开出时刻 */
const clockOf = (a: Ask): number => typeof a.extra.handedAt === "number" ? a.extra.handedAt : a.createdAt;

async function renotify(db: Database, a: Ask, notify: NonNullable<SweepDeps["notify"]>, now: number): Promise<void> {
  if (!a.taskId || !a.assignee || !a.fromAgent) return;
  const text = askNoticeText({ taskId: a.taskId, orderId: String(a.extra.orderId ?? ""), from: a.fromAgent, askId: a.id, question: a.body,
    options: Array.isArray(a.extra.options) ? a.extra.options.map(String) : [], ...(a.extra.default ? { default: String(a.extra.default) } : {}),
    class: a.extra.class as "design" | "scope" | "blocker" });
  const sent = await notify(a.assignee, text, `ledger-ask:${a.id}`);
  if (sent.handed) patchAsk(db, a.id, { extra: { notice: "handed", handedAt: now } }, now);
}

/** 到点就结案并在同一事务里留下追加任务；返回需要（继续）追加的那条 */
function closeIfDue(db: Database, id: string, now: number): Ask | null {
  return db.transaction(() => {
    const cur = getAsk(db, id);
    if (!cur) return null;
    const scope = cur.state === "open" && isTestScopeAsk(db, cur);
    if (!scope && !isDefaultAsk(cur) && cur.extra.autoScope !== true) return null;
    if (cur.state === "open" && cur.extra.notice === "handed" && clockOf(cur) + ASK_DEFAULT_MS <= now) {
      if (scope) addTestGlobs(db, cur, now);
      answerAsk(db, id, { choices: [], labels: [], text: scope ? "测试类扩围自动批准（文件全在 tests/）" : "按执行者默认做法定",
        principal: "system:ask-default", via: "terminal", at: now, final: true });
      patchAsk(db, id, { extra: { defaultAppend: "pending", defaultAt: now, ...(scope ? { autoScope: true, tell: "pending" } : {}) } }, now);
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

/**
 * 到了次数线就真正投递给 PM（同一 messageId 幂等）；投出去才记 alerted，没投出去下次扫描再投。
 * 永不抛出：告警失败只记日志，不能挡住本次追加（规格「PM 定 第 3 轮」2）。
 */
async function alertPm(db: Database, id: string, notify: SweepDeps["notify"], now: number): Promise<void> {
  try {
    const a = getAsk(db, id);
    if (!notify || !a?.assignee || a.extra.defaultAppendAlerted || (Number(a.extra.defaultAppendTries) || 0) < APPEND_ALERT_TRIES) return;
    const sent = await notify(a.assignee, failText(a, String(a.extra.defaultAppendError ?? "")), `ask-default-failed:${a.id}`);
    if (sent.handed) patchAsk(db, a.id, { extra: { defaultAppendAlerted: true } }, now);
  } catch (e) {
    console.error(`⚠️ ask ${id} 追加失败的 PM 告警没发出去（下次扫描再发，追加照常进行）：${(e as Error).message}`);
  }
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
    OR (state = 'open' AND json_extract(extra, '$.via') = 'mcp_ask' AND json_extract(extra, '$.files') IS NOT NULL)
    OR (state = 'answered' AND (json_extract(extra, '$.defaultAppend') = 'pending' OR json_extract(extra, '$.tell') = 'pending'))`).all() as { id: string }[];
  let count = 0;
  for (const { id } of rows) {
    try {
      const open = getAsk(db, id);
      if (deps.notify && open?.state === "open" && autoAsk(db, open) && open.extra.notice !== "handed") await renotify(db, open, deps.notify, now);
      const a = closeIfDue(db, id, now);
      if (deps.tell) await tellIfPending(db, id, deps.tell, now);
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

/**
 * PM 用 send_to_agent 回了：发送方是 bridge 验证过的身份、是这张卡的 PM，目标是提问的执行者（ask 开出时已按当前的单核过），
 * 正文带 `ask <id>`，才把那一条记成「PM 已回复」。认的提问：autoAsk 两类，加上执行者问本卡 PM 的 decide（ASKPM1，order-ask-pm-reply.ts）。
 * 没带 id 不关任何 ask。在投递成功之后调；永不抛出，不连累消息本身。
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
        if (!a || a.state !== "open" || !(autoAsk(db, a) || isPmParentAsk(db, a, who.agent as string)) || agentName(a.fromAgent) !== agentName(target)) continue;
        const task = a.taskId ? getTask(db, a.taskId) : null;
        if (!task || !pmStandsFor(db, task.project, task.pm ?? getMeta(db, task.project).pms[0] ?? null, who.agent as string)) continue;
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

