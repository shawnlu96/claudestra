/**
 * 监护的台账留痕（i28-S1）：每次识别、处置都是一条 note 事件（data.op = "supervise"），PM 用 `ledger show` 看得到，看板以后照 data 读。
 * 也是监护的唯一记账处：次数上限、「这一下做过没有」都从这些事件数出来，调度服务重启不丢、不重做。
 * 外部动作前先写 claim（去重键 = 故障键 + 动作 + 阶段），写成了才动手；同一个去重键第二次写是 duplicate，调用方就不再动手——
 * 两轮 pass 撞在一起、崩在动作中间重跑，都不会重启两次、续派两次。动作做完写 done 带结果。
 * 写入只经调度服务身份的 `ledger scheduler-supervise`（manager/ledger-supervise-cmds.ts），这里是它和读取方共用的纯逻辑。
 * tests/agent-supervisor-ledger.test.ts。
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { LedgerError } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { HOUR_MS, RESTART_FAULTS, SUPERVISE_RULES, type FaultKind } from "./agent-supervisor-policy.js";

export type SuperviseStep = "recover" | "resume" | "restart" | "nudge" | "report";
type SupervisePhase = "claim" | "done";
export type SuperviseResult = "ok" | "failed" | "unknown" | "skipped";

export interface SuperviseRecord {
  agent: string;
  project: string;
  /** 调度单的卡号；send_to_agent 请求记项目级（""） */
  target: string;
  sessionId: string;
  fault: FaultKind;
  /** 这一次故障的键（失败卡 id、dead:<agent>:<session>:<首次否定时刻>……）：去重键的主体 */
  faultKey: string;
  /** 在途那件活的键（agent-supervisor-policy.ts workKeyOf） */
  workKey: string;
  step: SuperviseStep;
  phase: SupervisePhase;
  /** 第几次自动处置（report 记已做过几次） */
  attempt: number;
  limit: number;
  result?: SuperviseResult;
  detail?: string;
  /** 失败卡的 ask id（cyber / quota / auth 才有）：bridge 关卡、调度器让开它，都按它认 */
  cardId?: string;
}

const FAULTS = Object.keys(SUPERVISE_RULES) as FaultKind[];
const STEPS: SuperviseStep[] = ["recover", "resume", "restart", "nudge", "report"];
const RESULTS: SuperviseResult[] = ["ok", "failed", "unknown", "skipped"];
/** 键里有 agent 名（历史上有中文名），只挡空白与控制 / 格式字符 */
const KEY_RE = /^[^\s\p{Cc}\p{Cf}]{1,200}$/u;

const superviseDedup = (r: Pick<SuperviseRecord, "faultKey" | "step" | "phase">): string => `supervise:${r.faultKey}:${r.step}:${r.phase}`;

/** CLI 收到的 JSON → 记录；字段不对一律拒（这是调度服务唯一能写的东西，宽进就是开后门） */
export function parseSuperviseRecord(raw: unknown): SuperviseRecord {
  const r = raw as Record<string, unknown> | null;
  const bad = (what: string) => new LedgerError("invalid", `监护记录的 ${what} 不对`);
  if (!r || typeof r !== "object" || Array.isArray(r)) throw bad("格式");
  const str = (k: string, max = 200, empty = false): string => {
    const v = r[k];
    if (typeof v !== "string" || v.length > max || (!empty && !v) || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(v)) throw bad(k);
    return v;
  };
  const int = (k: string): number => {
    const v = r[k];
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 100) throw bad(k);
    return v as number;
  };
  const fault = str("fault") as FaultKind;
  const step = str("step") as SuperviseStep;
  const phase = str("phase") as SupervisePhase;
  if (!FAULTS.includes(fault)) throw bad("fault");
  if (!STEPS.includes(step)) throw bad("step");
  if (phase !== "claim" && phase !== "done") throw bad("phase");
  const faultKey = str("faultKey"), workKey = str("workKey");
  if (!KEY_RE.test(faultKey) || !KEY_RE.test(workKey)) throw bad("faultKey / workKey");
  const result = r.result === undefined ? undefined : (str("result") as SuperviseResult);
  if (result !== undefined && !RESULTS.includes(result)) throw bad("result");
  if (phase === "done" && result === undefined) throw bad("result（done 必须带结果）");
  const cardId = r.cardId === undefined ? undefined : str("cardId", 80);
  return {
    agent: str("agent", 120), project: str("project", 80), target: str("target", 80, true), sessionId: str("sessionId"), fault, faultKey, workKey,
    step, phase, attempt: int("attempt"), limit: int("limit"), ...(result ? { result } : {}),
    ...(r.detail !== undefined ? { detail: str("detail", 600, true) } : {}), ...(cardId ? { cardId } : {}),
  };
}

const STEP_WORD: Record<SuperviseStep, string> = { recover: "发恢复消息", resume: "续跑", restart: "重启", nudge: "补发接着做", report: "报派活方" };

function superviseText(r: SuperviseRecord): string {
  const n = r.limit ? `（第 ${r.attempt}/${r.limit} 次）` : "";
  const what = `监护：${r.agent} ${r.fault}，${STEP_WORD[r.step]}${n}`;
  const tail = r.phase === "claim" ? "开始" : `→ ${r.result}`;
  return `${what} ${tail}${r.detail ? `：${r.detail}` : ""}`.slice(0, 600);
}

/** 写一条；duplicate = 同一去重键已经写过（调用方据此不再动手） */
export function recordSupervise(db: Database, ctx: Omit<WriteCtx, "dedupKey">, rec: SuperviseRecord): { duplicate: boolean; seq: number } {
  const data = { op: "supervise", ...rec };
  const r = appendEvent(db, { ...ctx, dedupKey: superviseDedup(rec) }, { project: rec.project, target: rec.target, kind: "note", text: superviseText(rec), data });
  return { duplicate: r.duplicate, seq: r.event.seq };
}

export interface SuperviseEvent extends SuperviseRecord {
  ts: number;
  seq: number;
}

/** 这个 agent 的监护事件（since 之后，升序） */
export function superviseEvents(db: Database, agent: string, since = 0): SuperviseEvent[] {
  const rows = db.query(`SELECT seq, ts, data FROM events WHERE kind = 'note' AND ts >= ? AND json_extract(data, '$.op') = 'supervise'
    AND json_extract(data, '$.agent') = ? ORDER BY seq`).all(since, agent) as { seq: number; ts: number; data: string }[];
  return rows.map((r) => ({ ...(JSON.parse(r.data) as SuperviseRecord), ts: r.ts, seq: r.seq }));
}

/** 某个故障键、某一步是否已认领 / 已完成 */
export function stepState(events: readonly SuperviseEvent[], faultKey: string, step: SuperviseStep): { claim?: SuperviseEvent; done?: SuperviseEvent } {
  const mine = events.filter((e) => e.faultKey === faultKey && e.step === step);
  return { claim: mine.find((e) => e.phase === "claim"), done: mine.find((e) => e.phase === "done") };
}

/**
 * 之前每次自动处置的时刻（认领那一刻算一次，不管结果：做到一半崩了也算，宁可少做不能多做；只有重启认领后核下来没动手的 skipped 不算）。按处置表的计数范围筛：
 * work = 同一件活的同一类故障；hour = 这个 agent 最近一小时（重启额度宿主死、卡住共用）。
 */
export function priorAttempts(events: readonly SuperviseEvent[], kind: FaultKind, workKey: string, now: number): number[] {
  const rule = SUPERVISE_RULES[kind];
  const kinds = RESTART_FAULTS.includes(kind) ? RESTART_FAULTS : [kind];
  const step = rule.action;
  const skipped = new Set(step === "restart" ? events.filter((e) => e.phase === "done" && e.step === step && e.result === "skipped").map((e) => e.faultKey) : []);
  return events.filter((e) => e.phase === "claim" && e.step === step && kinds.includes(e.fault) && !skipped.has(e.faultKey) &&
    (rule.scope === "hour" ? now - e.ts < HOUR_MS : e.workKey === workKey)).map((e) => e.ts);
}

/**
 * 重启的故障键锚在这个 agent 上一次重启认领的事件序号上（不看时间窗，全量查）：同一时刻两轮 pass 算出同一个键，第二个认领撞去重；
 * 认领一写下锚就变，下一次重启自然是新键。用时刻当键挡不住并发（两边的时刻不同）。
 */
export function restartKey(db: Database, agent: string): string {
  const r = db.query(`SELECT MAX(seq) AS seq FROM events WHERE kind = 'note' AND json_extract(data, '$.op') = 'supervise'
    AND json_extract(data, '$.agent') = ? AND json_extract(data, '$.step') = 'restart' AND json_extract(data, '$.phase') = 'claim'`).get(agent) as { seq: number | null };
  return `restart:${agent}:after${r.seq ?? 0}`;
}
