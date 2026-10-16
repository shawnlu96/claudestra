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
import { getMeta, getTask, listEvents } from "../lib/ledger-store.js";
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
}

export interface MdnDeps {
  reader: Pick<LedgerReader, "get">;
  /** action 级通知；handed = 已送达或已进押后队列 */
  send(to: string, text: string, messageId: string): Promise<{ handed: boolean; note: string }>;
  /** 开 owner「待你处理」，返回 askId */
  openOwnerCard(c: OwnerCard): string;
  /** 撤销：按开卡时的 dedupKey 找卡，还开着才关；抛错 = 没关掉，下一轮再关 */
  closeOwnerCard(dedupKey: string, reason: string): void;
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
async function advance(db: Database, s: Step, c: Card, start: MdnRecord, cfg: MdnConfig, now: number): Promise<void> {
  const { task, d, mode } = c;
  const key = mdnKey(task.project, task.id, d.seq), cmd = s.deps.managerCmd;
  const meta = getMeta(db, task.project);
  const team: MdnTeam = { pms: meta.pms, team: meta.team, isDispatcher: auditDispatcherTest(meta.team?.dispatcher) };
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
      const card = ownerCardText(task, d, mdnPm(task, team), rec, now, cmd), ownerKey = `manual-deliver:${key}#${now}`;
      const prev = rec;
      rec = commit({ ...rec, owner: now, ownerKey }); // 先记再开：开卡后崩溃也不会重开
      try {
        rec = commit({ ...rec, askId: s.deps.openOwnerCard({ project: task.project, taskId: task.id, ...card, dedupKey: ownerKey }) });
      } catch (e) {
        s.save(prev);
        throw e;
      }
      s.deps.log(`📮 人工卡提醒：${task.id} 交付 #${d.seq} 进 owner 待你处理（${rec.askId}）`);
    }
  }
}

/** 不再等派审的记录：开过 owner 卡的先关卡，关掉了才记撤销（没关掉下一轮再来） */
function resolveGone(deps: MdnDeps, state: MdnState, live: ReadonlySet<string>, now: number, save: (key: string, rec: MdnRecord) => void): void {
  for (const [key, rec] of Object.entries(state)) {
    if (live.has(key) || rec.resolvedAt !== undefined) continue;
    try {
      if (rec.ownerKey) deps.closeOwnerCard(rec.ownerKey, "已派审 / 已记审查，或卡不再等审");
      save(key, { ...rec, resolvedAt: now });
    } catch (e) {
      deps.log(`⚠️ 人工卡提醒：${key} 撤销没做完（owner 卡 ${rec.askId ?? "?"}）：${(e as Error).message}，下一轮再来`);
    }
  }
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
    let state = read.state;
    const save = (key: string, rec: MdnRecord) => {
      if (JSON.stringify(state[key]) === JSON.stringify(rec)) return;
      const next = { ...state, [key]: rec };
      writeMdnState(next, now, statePath);
      state = next;
    };
    const live = new Set<string>();
    for (const c of pendingCards(db)) {
      const key = mdnKey(c.task.project, c.task.id, c.d.seq);
      live.add(key);
      try {
        const rec = reopenRecord(state[key] ?? { deliverTs: c.d.ts });
        save(key, rec);
        await advance(db, { deps, save: (r) => save(key, r) }, c, rec, config, now);
      } catch (e) {
        deps.log(`⚠️ 人工卡提醒：${c.task.id} 这一轮没处理完（${(e as Error).message}），不影响别的卡，下一轮再来`);
      }
    }
    resolveGone(deps, state, live, now, save);
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
      closeOwnerCard: (dedupKey, reason) => {
        const db = asks.askDb();
        const row = db.query("SELECT id FROM asks WHERE dedupKey = ?").get(dedupKey) as { id: string } | null;
        const a = row ? store.closeAsk(db, row.id, "cancelled", reason) : null;
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
      serialMdn(tick).catch((e: Error) => console.error(`⚠️ 人工卡提醒出错：${e.message}`)).finally(() => (running = false));
    };
    setTimeout(() => { run(); setInterval(run, TICK_MS).unref?.(); }, FIRST_DELAY_MS).unref?.();
    console.log(`📮 人工卡交付提醒启动（${FIRST_DELAY_MS / 1000}s 后首轮，之后每 ${TICK_MS / 1000}s）`);
  }, (e: Error) => console.error(`⚠️ 人工卡交付提醒没起来：${e.message}`));
}
