/**
 * 人工卡交付后的接手提醒的定时器（RVF-2，规则在 lib/manual-deliver-notice.ts，文档 docs/architecture/manual-deliver-notice.md）。
 * 每 TICK_MS 只读扫一遍等派审的人工卡：交付即通知 PM、N 分钟升级 PM、再 M 分钟开 owner「待你处理」，派审 / 审查后撤销并关卡。
 * 去重落在状态文件，每一步先记再投（没投出去改回去）：bridge 重启、写盘失败都不会重推；一张卡出错只跳过这张卡。
 * 巡检 manual_deliver_no_review 已推过（notifiedAt）或押着（queuedAs）的不再推；两边经 serialMdn 串行，读写状态不会交错。
 * 投递走班子路由同一条路（sendLedgerNotice，action 级：PM 回合中就押到回合结束）；没投出去（不在 registry、路由没起）下一轮再投。
 */
import type { Database } from "bun:sqlite";
import { auditDispatcherTest } from "../lib/ledger-audit.js";
import { LedgerReader } from "../lib/ledger-read.js";
import { getWorkflow } from "../lib/ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "../lib/ledger-stages.js";
import { closeAsk, openAskFull, type Ask } from "../lib/ledger-asks.js";
import { getMeta, getTask, listEvents } from "../lib/ledger-store.js";
import { activeProjectPm } from "../lib/pm-role.js";
import { readRegistryAgentsSync } from "../lib/registry.js";
import {
  escalateText, immediateTarget, MDN_CONFIG_PATH, MDN_STATE_PATH, mdnAuditKey, mdnKey, mdnPm, nextAction, noticeText, ownerCardText,
  pendingDelivery, readMdnConfig, readMdnState, reopenRecord, writeMdnState, type MdnConfig, type MdnRecord, type MdnState, type MdnTeam,
} from "../lib/manual-deliver-notice.js";

const TICK_MS = 60_000;
/** 比巡检首轮（90s）早：重启后先把停机期间跨过 N 的交付记成已升级，巡检读到就 keep 不推 */
const FIRST_DELAY_MS = 60_000;
const MDN_CREATOR = "system:manual-deliver-notice";

export interface OwnerCard {
  project: string;
  taskId: string;
  title: string;
  context: string;
  dedupKey: string;
  /** 这次交付所有 owner 卡共用的 dedupKey 前缀（manual-deliver:<key>#）：还有开着的就认回来，撤销时一并关 */
  prefix: string;
}

export interface MdnDeps {
  reader: Pick<LedgerReader, "get">;
  /** action 级通知；handed = 已送达或已进押后队列 */
  send(to: string, text: string, messageId: string): Promise<{ handed: boolean; note: string }>;
  /** 开 owner「待你处理」，返回 askId；同前缀还有开着的卡（状态文件丢过）就返回那张，不开第二张 */
  openOwnerCard(c: OwnerCard): string;
  /** 撤销：关掉 dedupKey 以 prefix 开头、还开着的 owner 卡；抛错 = 没关掉，下一轮再关 */
  closeOwnerCards(prefix: string, reason: string): void;
  /** registry 里 active 的 agent；不给 / null = 不知道（卡上的 PM 不在岗也不换人） */
  activeAgents?(): ReadonlySet<string> | null;
  managerCmd: string;
  log(msg: string): void;
  now(): number;
  statePath?: string;
  configPath?: string;
}

let chain: Promise<unknown> = Promise.resolve();
/** 提醒与巡检（ledger-audit-service.ts）串行：巡检读状态文件 / 写 audit_findings 时提醒不在半路，反过来也一样，同一次交付不会两边各推一条 */
export function serialMdn<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.then(() => undefined, () => undefined); // 链只管排队：错误由调用方拿到的 p 自己处理
  return p;
}

interface Card {
  task: LedgerTask;
  d: LedgerEvent;
  mode: string | null;
}

/** 等派审的人工卡：只扫 build / review / fix 的卡，判定交给 pendingDelivery */
function pendingCards(db: Database): Card[] {
  const ids = db.query("SELECT id FROM tasks WHERE stage IN ('build','review','fix') ORDER BY id").all() as { id: string }[];
  const out: Card[] = [];
  for (const { id } of ids) {
    const task = getTask(db, id);
    if (!task) continue;
    const mode = getWorkflow(db, id)?.mode ?? null;
    const d = pendingDelivery(task, listEvents(db, { target: id }), mode);
    if (d) out.push({ task, d, mode });
  }
  return out;
}

/** 巡检已推过（notifiedAt）或已押进押后队列（queuedAs，取那一轮的 lastSeen）的时刻；表还没有 / 读不了 = null（只会多推一次，不会漏） */
function auditTold(db: Database, key: string): number | null {
  try {
    const r = db.query("SELECT notifiedAt, queuedAs, lastSeen FROM audit_findings WHERE key = ?").get(key) as
      { notifiedAt: number | null; queuedAs: string | null; lastSeen: number } | null;
    return r?.notifiedAt ?? (r?.queuedAs ? r.lastSeen : null);
  } catch {
    return null; // 库停在巡检之前的版本：当没推过
  }
}

/** 没投出去的每条消息只记一次日志（PM 不在 registry 时每分钟重试，别刷屏） */
const failedOnce = new Set<string>();
const ownerPrefix = (key: string) => `manual-deliver:${key}#`;
/** 当班 PM；指针坏了 / 读不了按没有（只在名单里找在岗的） */
function onDutyPm(db: Database, project: string): string | null {
  try {
    return activeProjectPm(db, project);
  } catch {
    return null; // activePm 指针不合法：退回名单里找在岗的，不让一张卡卡住
  }
}

interface Step {
  deps: MdnDeps;
  save(rec: MdnRecord): void;
}

/** 先记 next 再投；没投出去改回 prev。记不下来（写盘失败）就抛，什么都不发 */
async function sendStep(s: Step, prev: MdnRecord, next: MdnRecord, to: string, text: string, messageId: string, what: string):
  Promise<{ ok: true } | { ok: false; note: string }> {
  s.save(next);
  const r = await s.deps.send(to, text, messageId).catch((e: Error) => ({ handed: false, note: e.message }));
  if (r.handed) {
    s.deps.log(`📮 人工卡提醒：${what} → ${to}：${r.note}`);
    return { ok: true };
  }
  s.save(prev);
  if (!failedOnce.has(messageId)) s.deps.log(`⚠️ 人工卡提醒：${what} → ${to} 没投出去（${r.note}），之后每轮重试`);
  failedOnce.add(messageId);
  return { ok: false, note: r.note };
}

/** 一次交付往下走到做不动为止；每一步都经 save 落盘 */
async function advance(db: Database, s: Step, c: Card, start: MdnRecord, cfg: MdnConfig, now: number, active: ReadonlySet<string> | null): Promise<void> {
  const { task, d, mode } = c;
  const key = mdnKey(task.project, task.id, d.seq), cmd = s.deps.managerCmd;
  const meta = getMeta(db, task.project);
  const team: MdnTeam = { pms: meta.pms, team: meta.team, isDispatcher: auditDispatcherTest(meta.team?.dispatcher),
    ...(active ? { alive: (n: string) => active.has(n), onDuty: onDutyPm(db, task.project) } : {}) };
  const commit = (r: MdnRecord) => (s.save(r), r);
  let rec = start;
  for (let action = nextAction(rec, now, cfg); action; action = nextAction(rec, now, cfg)) {
    if (action === "notify-late") rec = commit({ ...rec, notified: now });
    else if (action === "notify") {
      const to = immediateTarget(task, d, team), next = { ...rec, notified: now };
      if (!to) rec = commit(next);
      else if ((await sendStep(s, rec, next, to, noticeText(task, d, mode, cfg, cmd), `mdn-${key}-notify`, `${task.id} 交付通知`)).ok) rec = next;
      else return;
    } else if (action === "pm") {
      const told = auditTold(db, mdnAuditKey(task.project, task.id, d.seq));
      if (told !== null) { rec = commit({ ...rec, pm: told }); continue; }
      const pm = mdnPm(task, team);
      const r = pm ? await sendStep(s, rec, { ...rec, pm: now }, pm, escalateText(task, d, now, cfg, cmd), `mdn-${key}-pm`, `${task.id} 升级`)
        : { ok: false as const, note: "项目没有 PM" };
      if (r.ok) { rec = { ...rec, pm: now }; continue; }
      if (rec.pmFail?.note !== r.note) commit({ ...rec, pmFail: { at: rec.pmFail?.at ?? now, note: r.note } });
      return; // 下一轮重试升级；第一次没送到满 M 分钟就进 owner
    } else {
      // 意图和完成分开落盘：先记意图（owner + ownerKey），开好再写回 askId。中途退出 / 开卡抛错时意图留着，
      // 下一轮按前缀对账——卡已开就认回来，没开就用同一个 dedupKey 重开（tests/manual-deliver-notice.test.ts「验收追加 4」）
      const ownerKey = rec.ownerKey ?? `manual-deliver:${key}#${now}`;
      if (rec.owner === undefined || rec.ownerKey === undefined) rec = commit({ ...rec, owner: rec.owner ?? now, ownerKey });
      const card = ownerCardText(task, d, mdnPm(task, team), rec, now, cmd);
      rec = commit({ ...rec, askId: s.deps.openOwnerCard({ project: task.project, taskId: task.id, ...card, dedupKey: ownerKey, prefix: ownerPrefix(key) }) });
      s.deps.log(`📮 人工卡提醒：${task.id} 交付 #${d.seq} 进 owner 待你处理（${rec.askId}）`);
    }
  }
}

type Throttled = (key: string, e: unknown, msg: string) => void;

/** 不再等派审的记录：这次交付的 owner 卡（按前缀，含状态文件丢过时留下的）先关，关掉了才记撤销（没关掉下一轮再来） */
function resolveGone(deps: MdnDeps, state: MdnState, live: ReadonlySet<string>, now: number, save: (key: string, rec: MdnRecord) => void, warn: Throttled): void {
  for (const [key, rec] of Object.entries(state)) {
    if (live.has(key) || rec.resolvedAt !== undefined) continue;
    try {
      deps.closeOwnerCards(ownerPrefix(key), "已派审 / 已记审查，或卡不再等审");
      save(key, { ...rec, resolvedAt: now });
    } catch (e) {
      warn(key, e, `${key} 撤销没做完（owner 卡 ${rec.askId ?? "?"}）`);
    }
  }
}

/** 逐卡出错日志按「卡 + 错误类型」每小时一条（磁盘满时每分钟每卡一行会刷屏） */
const LOG_EVERY_MS = 3_600_000;
function throttledWarn(deps: MdnDeps): Throttled {
  const last = new Map<string, number>();
  return (key, e, msg) => {
    const err = e instanceof Error ? e : new Error(String(e));
    const id = `${key}|${err.name}|${err.message.slice(0, 80)}`, now = deps.now();
    if (now - (last.get(id) ?? -Infinity) < LOG_EVERY_MS) return;
    last.set(id, now);
    deps.log(`⚠️ 人工卡提醒：${msg}：${err.message}，下一轮再来（同类错误一小时内不再打）`);
  };
}

export function manualDeliverTicker(deps: MdnDeps): () => Promise<void> {
  const statePath = deps.statePath ?? MDN_STATE_PATH, configPath = deps.configPath ?? MDN_CONFIG_PATH;
  let lastErr = "";
  const once = (msg: string) => { if (msg && msg !== lastErr) deps.log(`⚠️ 人工卡提醒：${msg}`); lastErr = msg; };
  const warn = throttledWarn(deps);
  return async () => {
    const db = deps.reader.get();
    if (!db) return;
    const now = deps.now();
    const { config, error } = readMdnConfig(configPath);
    const read = readMdnState(statePath);
    once(error ?? (read.error ? `状态文件读不了，按空处理：${read.error}` : ""));
    let state = read.state;
    const save = (key: string, rec: MdnRecord) => {
      if (JSON.stringify(state[key]) === JSON.stringify(rec)) return;
      const next = { ...state, [key]: rec };
      writeMdnState(next, now, statePath);
      state = next;
    };
    const live = new Set<string>(), active = deps.activeAgents?.() ?? null;
    for (const c of pendingCards(db)) {
      const key = mdnKey(c.task.project, c.task.id, c.d.seq);
      live.add(key);
      try {
        const rec = reopenRecord(state[key] ?? { deliverTs: c.d.ts });
        save(key, rec);
        await advance(db, { deps, save: (r) => save(key, r) }, c, rec, config, now, active);
      } catch (e) {
        warn(key, e, `${c.task.id} 这一轮没处理完（不影响别的卡）`);
      }
    }
    resolveGone(deps, state, live, now, save, warn);
  };
}

/** 这次交付还开着的 owner 卡：dedupKey 以 prefix 开头（按前缀比较，不用 LIKE：卡号 / 项目名里可能有 _ %） */
const openByPrefix = (db: Database, prefix: string): { id: string }[] =>
  db.query("SELECT id FROM asks WHERE state = 'open' AND substr(dedupKey, 1, length(?1)) = ?1 ORDER BY createdAt").all(prefix) as { id: string }[];

/** owner 卡的开 / 关（真 asks 库）；publish = 推给网页（bridge/asks.ts publishAsk） */
export function ownerCardPort(db: () => Database, publish: (a: Ask) => void): Pick<MdnDeps, "openOwnerCard" | "closeOwnerCards"> {
  return {
    openOwnerCard: (c) => {
      const open = openByPrefix(db(), c.prefix)[0];
      if (open) return open.id;
      const r = openAskFull(db(), {
        source: "system", createdBy: MDN_CREATOR, kind: "owner_action", project: c.project, taskId: c.taskId, title: c.title, context: c.context,
        options: [{ type: "buttons", buttons: [{ id: "mdn_ack", label: "知道了", style: "secondary" }] }], allowText: true, blocking: false, dedupKey: c.dedupKey,
      });
      if (!r.existed) publish(r.ask);
      return r.ask.id;
    },
    closeOwnerCards: (prefix, reason) => {
      for (const { id } of openByPrefix(db(), prefix)) {
        const a = closeAsk(db(), id, "cancelled", reason);
        if (a) publish(a);
      }
    },
  };
}

let started = false;

/** bridge 启动时调一次（ledger-audit-service.ts startLedgerAudit 里接线）；投递与 ask 的实现按需加载，单测只测 ticker */
export function startManualDeliverNotice(managerCmd: string): void {
  if (started) return;
  started = true;
  void Promise.all([import("./team-router.js"), import("./asks.js")]).then(([router, asks]) => {
    const tick = manualDeliverTicker({
      reader: new LedgerReader(),
      send: (to, text, messageId) => router.sendLedgerNotice({ to, text, messageId, pmLevel: "action" }),
      ...ownerCardPort(asks.askDb, asks.publishAsk),
      activeAgents: () => new Set(readRegistryAgentsSync().filter((a) => a.status === "active").map((a) => a.name)),
      managerCmd,
      log: (m) => console.log(m),
      now: Date.now,
    });
    let running = false;
    const run = () => {
      if (running) return; // 上一轮还在投（押后探测会等）：跳过，别并发改同一份状态文件
      running = true;
      serialMdn(tick).catch((e: Error) => console.error(`⚠️ 人工卡提醒出错：${e.message}`)).finally(() => (running = false));
    };
    setTimeout(() => { run(); setInterval(run, TICK_MS).unref?.(); }, FIRST_DELAY_MS).unref?.();
    console.log(`📮 人工卡交付提醒启动（${FIRST_DELAY_MS / 1000}s 后首轮，之后每 ${TICK_MS / 1000}s）`);
  }, (e: Error) => console.error(`⚠️ 人工卡交付提醒没起来：${e.message}`));
}
