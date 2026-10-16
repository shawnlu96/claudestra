/**
 * 人工卡交付后的接手提醒的定时器（RVF-2，规则在 lib/manual-deliver-notice.ts，文档 docs/architecture/manual-deliver-notice.md）。
 * 每 TICK_MS 只读扫一遍等派审的人工卡：交付即通知 PM、N 分钟升级 PM、再 M 分钟开 owner「待你处理」，派审 / 审查后撤销并关卡。
 * 去重落在状态文件（每次交付一条记录，做完一步先记再往下）：bridge 重启不重推；巡检已推过 PM 的（audit_findings.notifiedAt）不再推。
 * 首次运行（状态文件不在）把当时已在等的交付全部静默记成做过，上线不一次推一大批；它们由巡检 manual_deliver_no_review 照推 PM。
 * 投递走班子路由同一条路（sendLedgerNotice，action 级：PM 回合中就押到回合结束）；没投出去（不在 registry、路由没起）不记，下一轮再投。
 */
import type { Database } from "bun:sqlite";
import { LedgerReader } from "../lib/ledger-read.js";
import { getWorkflow } from "../lib/ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "../lib/ledger-stages.js";
import { getMeta, getTask, listEvents } from "../lib/ledger-store.js";
import {
  escalateText, immediateTarget, MDN_CONFIG_PATH, MDN_STATE_PATH, mdnAuditKey, mdnKey, mdnPm, nextAction, noticeText, ownerCardText,
  pendingDelivery, readMdnConfig, readMdnState, writeMdnState, type MdnConfig, type MdnRecord, type MdnState,
} from "../lib/manual-deliver-notice.js";

const TICK_MS = 60_000;
/** 同巡检：给 channel-server 重连、班子路由起来留时间 */
const FIRST_DELAY_MS = 90_000;
const MDN_CREATOR = "system:manual-deliver-notice";

export interface OwnerCard {
  project: string;
  taskId: string;
  title: string;
  context: string;
  dedupKey: string;
}

export interface MdnDeps {
  reader: Pick<LedgerReader, "get">;
  /** action 级通知；handed = 已送达或已进押后队列 */
  send(to: string, text: string, messageId: string): Promise<{ handed: boolean; note: string }>;
  /** 开 owner「待你处理」，返回 askId（dedupKey 撞上已有的返回那条） */
  openOwnerCard(c: OwnerCard): string;
  /** 撤销：还开着才关 */
  closeOwnerCard(askId: string, reason: string): void;
  managerCmd: string;
  log(msg: string): void;
  now(): number;
  statePath?: string;
  configPath?: string;
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

/** 巡检已推过 PM 的时刻；表还没有 / 读不了 = null（只会多推一次，不会漏） */
function auditNotified(db: Database, key: string): number | null {
  try {
    const r = db.query("SELECT notifiedAt FROM audit_findings WHERE key = ?").get(key) as { notifiedAt: number | null } | null;
    return r?.notifiedAt ?? null;
  } catch {
    return null; // 库停在巡检之前的版本：当没推过
  }
}

/** 一次交付往下走到做不动为止；返回新记录（投递没成功就停在那一步，下一轮再来） */
async function advance(db: Database, deps: MdnDeps, c: Card, rec0: MdnRecord, cfg: MdnConfig, now: number): Promise<MdnRecord> {
  const { task, d, mode } = c;
  const key = mdnKey(task.project, task.id, d.seq);
  const team = getMeta(db, task.project);
  let rec = rec0;
  for (let action = nextAction(rec, now, cfg); action; action = nextAction(rec, now, cfg)) {
    if (action === "notify-late") rec = { ...rec, notified: now };
    else if (action === "notify") {
      const to = immediateTarget(task, d, team);
      if (to && !(await sent(deps, to, noticeText(task, d, mode, cfg, deps.managerCmd), `mdn-${key}-notify`, `${task.id} 交付通知`))) return rec;
      rec = { ...rec, notified: now };
    } else if (action === "pm") {
      const told = auditNotified(db, mdnAuditKey(task.project, task.id, d.seq));
      const pm = mdnPm(task, team);
      if (told === null && pm && !(await sent(deps, pm, escalateText(task, d, now, cfg, deps.managerCmd), `mdn-${key}-pm`, `${task.id} 升级`))) return rec;
      if (told === null && !pm) deps.log(`⚠️ 人工卡提醒：${task.id} 找不到 PM，直接等 owner 那一级`);
      rec = { ...rec, pm: told ?? now };
    } else {
      const card = ownerCardText(task, d, mdnPm(task, team), rec, now, deps.managerCmd);
      const askId = deps.openOwnerCard({ project: task.project, taskId: task.id, ...card, dedupKey: `manual-deliver:${key}` });
      deps.log(`📮 人工卡提醒：${task.id} 交付 #${d.seq} 进 owner 待你处理（${askId}）`);
      rec = { ...rec, owner: now, askId };
    }
  }
  return rec;
}

/** 没投出去的每条消息只记一次日志（PM 不在 registry 时每分钟重试，别刷屏） */
const failedOnce = new Set<string>();
async function sent(deps: MdnDeps, to: string, text: string, messageId: string, what: string): Promise<boolean> {
  const r = await deps.send(to, text, messageId).catch((e: Error) => ({ handed: false, note: e.message }));
  if (r.handed) deps.log(`📮 人工卡提醒：${what} → ${to}：${r.note}`);
  else if (!failedOnce.has(messageId)) deps.log(`⚠️ 人工卡提醒：${what} → ${to} 没投出去（${r.note}），之后每轮重试`);
  if (!r.handed) failedOnce.add(messageId);
  return r.handed;
}

/** 不再等派审的记录：记撤销时刻，开过 owner 卡的关掉 */
function resolveGone(deps: MdnDeps, state: MdnState, live: ReadonlySet<string>, now: number): MdnState {
  const out: MdnState = {};
  for (const [key, rec] of Object.entries(state)) {
    if (live.has(key) || rec.resolvedAt !== undefined) { out[key] = rec; continue; }
    if (rec.askId) {
      try { deps.closeOwnerCard(rec.askId, "已派审 / 已记审查，或卡不再等审"); }
      catch (e) { deps.log(`⚠️ 人工卡提醒：${key} 的 owner 卡 ${rec.askId} 没关掉：${(e as Error).message}`); }
    }
    out[key] = { ...rec, resolvedAt: now };
  }
  return out;
}

export function manualDeliverTicker(deps: MdnDeps): () => Promise<void> {
  const statePath = deps.statePath ?? MDN_STATE_PATH, configPath = deps.configPath ?? MDN_CONFIG_PATH;
  let lastErr = "";
  const once = (msg: string) => { if (msg && msg !== lastErr) deps.log(`⚠️ 人工卡提醒：${msg}`); lastErr = msg; };
  return async () => {
    const db = deps.reader.get();
    if (!db) return;
    const now = deps.now();
    const { config, error } = readMdnConfig(configPath);
    const read = readMdnState(statePath);
    once(error ?? (read.error ? `状态文件读不了，按空处理：${read.error}` : ""));
    const cards = pendingCards(db);
    let state = read.state;
    if (read.missing) {
      state = Object.fromEntries(cards.map((c) => [mdnKey(c.task.project, c.task.id, c.d.seq),
        { deliverTs: c.d.ts, notified: now, pm: now, owner: now } satisfies MdnRecord]));
      if (cards.length) deps.log(`📮 人工卡提醒首次运行：${cards.length} 次已在等的交付记成做过（由巡检照推 PM）`);
    }
    const live = new Set<string>();
    for (const c of cards) {
      const key = mdnKey(c.task.project, c.task.id, c.d.seq);
      live.add(key);
      state = { ...state, [key]: await advance(db, deps, c, state[key] ?? { deliverTs: c.d.ts }, config, now) };
    }
    state = resolveGone(deps, state, live, now);
    if (read.missing || JSON.stringify(state) !== JSON.stringify(read.state)) writeMdnState(state, now, statePath);
  };
}

let started = false;

/** bridge 启动时调一次（ledger-audit-service.ts startLedgerAudit 里接线）；投递与 ask 的实现按需加载，单测只测 ticker */
export function startManualDeliverNotice(managerCmd: string): void {
  if (started) return;
  started = true;
  void Promise.all([import("./team-router.js"), import("./asks.js"), import("../lib/ledger-asks.js")]).then(([router, asks, store]) => {
    const tick = manualDeliverTicker({
      reader: new LedgerReader(),
      send: (to, text, messageId) => router.sendLedgerNotice({ to, text, messageId, pmLevel: "action" }),
      openOwnerCard: (c) => asks.createAsk({
        source: "system", createdBy: MDN_CREATOR, kind: "owner_action", project: c.project, taskId: c.taskId, title: c.title, context: c.context,
        options: [{ type: "buttons", buttons: [{ id: "mdn_ack", label: "知道了", style: "secondary" }] }], allowText: true, blocking: false, dedupKey: c.dedupKey,
      }).id,
      closeOwnerCard: (id, reason) => {
        const a = store.closeAsk(asks.askDb(), id, "cancelled", reason);
        if (a) asks.publishAsk(a);
      },
      managerCmd,
      log: (m) => console.log(m),
      now: Date.now,
    });
    let running = false;
    const run = () => {
      if (running) return; // 上一轮还在投（押后探测会等）：跳过，别并发改同一份状态文件
      running = true;
      tick().catch((e: Error) => console.error(`⚠️ 人工卡提醒出错：${e.message}`)).finally(() => (running = false));
    };
    setTimeout(() => { run(); setInterval(run, TICK_MS).unref?.(); }, FIRST_DELAY_MS).unref?.();
    console.log(`📮 人工卡交付提醒启动（${FIRST_DELAY_MS / 1000}s 后首轮，之后每 ${TICK_MS / 1000}s）`);
  }, (e: Error) => console.error(`⚠️ 人工卡交付提醒没起来：${e.message}`));
}
