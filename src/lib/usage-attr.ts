/**
 * token 账（T95）的归属：每一轮算到哪张卡、哪一步、第几轮、哪个 feature；答不上来的记「未归属」并写明原因（basis）。
 * 只读台账（ledger.sqlite），只写 usage 库 turns 表的 attr_* 列：原始用量不动，规则改了整体重算一遍即可。
 * 规则与优先级见 docs/architecture/token-usage.md「归属」一节，单测 tests/usage-attr.test.ts。
 */
import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { STAGE_STEPS, STAGES, type Stage, type StepName } from "./ledger-stages.js";
import { stepAtStage, stepsOf, type TaskStep } from "./ledger-steps.js";
import { UNOWNED } from "./usage-store.js";

/**
 * 判的依据。session / step 有卡；其余是未归属的原因：
 * coordination = PM / 大总管（协调开销，不摊到卡上）；overlap = 同一时刻挂着多张卡的窗口（不猜）；
 * outside_window = 台账里当过执行者，但这一刻不在任何一步的窗口里；not_in_ledger = 台账里从没当过执行者；unowned = 会话不属于任何 agent；
 * executor_lost = 只落在一张卡上，但这一刻别的卡有一段执行者被同轮改派覆盖、事件里也找不回来（说不准是不是重叠，不归）
 */
const ATTR_BASES = ["session", "step", "coordination", "overlap", "outside_window", "not_in_ledger", "unowned", "executor_lost"] as const;
type AttrBasis = (typeof ATTR_BASES)[number];

interface Attribution {
  task: string | null;
  step: string | null;
  round: number | null;
  feature: string | null;
  item: string | null;
  basis: AttrBasis;
}

interface TaskInfo {
  id: string;
  featureId: string | null;
  itemId: string | null;
}

/** 某张卡某一步的一段时间：[start, end)，executor 是这段时间里这一步的本机执行者；null = 被覆盖了、找不回来是谁 */
interface Window {
  task: TaskInfo;
  start: number;
  end: number;
  step: string;
  round: number;
  executor: string | null;
}

interface Exec {
  at: number;
  executor: string | null;
  kind: string;
}

/**
 * 一个步骤行（同一步同一轮）和它的执行者时间线。同轮改派会覆盖行上的执行者、保留 createdAt，谁在什么时候接的只在派发事件
 * （events kind=step op=assign，不可变）里：按事件切。没有派发事件的行（交付时补的）和推出来的，一直是行上那个人；
 * 行比第一条派发事件早（补的行后来又被改派）：那一段原来是谁已被覆盖，记 null。
 */
interface Entry {
  row: TaskStep;
  from: number;
  execs: Exec[];
}

interface AttrLedger {
  /** 执行者 → 它的窗口（按开始时间） */
  byAgent: Map<string, Window[]>;
  /** 卡 → 它的全部窗口（调度绑定的会话按卡找当时是哪一步） */
  byTask: Map<string, Window[]>;
  tasks: Map<string, TaskInfo>;
  /** 调度引擎绑定的会话 → 卡与角色 */
  sessions: Map<string, { taskId: string; role: string }>;
  managers: Set<string>;
  executors: Set<string>;
  /** 执行者找不回来的窗口 */
  lost: Window[];
}

/** 每个阶段自己的那一步（记进归属的 step）；spec 是 PM 写规格，verified / done / cancelled 没人干活，都不开窗口 */
const OWN_STEP: Partial<Record<Stage, StepName>> = { restate: "restate", build: "write", review: "review", fix: "fix", merge: "merge", live: "verify" };
/** 步骤行常在推阶段的同一个事务里、紧挨着阶段事件写（修完交付时才补派「修」那一行）：这么近的算这一段的 */
const LATE_ROW_MS = 1_000;

const isStage = (v: unknown): v is Stage => (STAGES as readonly unknown[]).includes(v);
const hasTable = (db: Database, t: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const json = (v: unknown): Record<string, any> => {
  try {
    const o = JSON.parse(String(v ?? "{}"));
    return o && typeof o === "object" ? o : {};
  } catch {
    return {}; // 台账的 JSON 列只由台账写入层写；坏一行按空对象读，这张卡少算一段窗口，不挡住别的卡
  }
};

/** 只读打开台账；没有库（新装、沙箱）返回 null，归属整体跳过 */
export function openLedgerReadonly(path: string): Database | null {
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  db.exec("PRAGMA busy_timeout = 10000");
  return db;
}

/** 阶段时间线：[起, 止) 一段一个阶段。blocked 按它之前的阶段算（卡住期间来回问答还是那一步的事）；最后一段开到现在 */
function stageSegments(created: number, moves: { ts: number; from: Stage; to: Stage; round: number }[]) {
  const segs: { start: number; end: number; stage: Stage; round: number }[] = [];
  let start = created, stage: Stage | null = moves[0]?.from ?? null, round = 0;
  for (const m of moves) {
    if (stage) segs.push({ start, end: m.ts, stage, round });
    start = m.ts;
    stage = m.to === "blocked" ? m.from : m.to;
    round = m.round;
  }
  if (stage) segs.push({ start, end: Number.POSITIVE_INFINITY, stage, round });
  return segs.filter((s) => s.end > s.start);
}

type Seg = { start: number; end: number; stage: Stage; round: number };

function entriesOf(steps: TaskStep[], assigns: Map<string, Exec[]> | undefined): Entry[] {
  return steps.map((row) => {
    const ev = row.derived ? [] : assigns?.get(`${row.step}#${row.round}`) ?? [];
    if (!ev.length) return { row, from: row.createdAt, execs: [{ at: row.createdAt, executor: row.executor, kind: row.executorKind }] };
    const lost = ev[0].at > row.createdAt + LATE_ROW_MS ? [{ at: row.createdAt, executor: null, kind: "agent" }] : [];
    return { row, from: Math.min(row.createdAt, ev[0].at), execs: [...lost, ...ev] };
  });
}

const execAt = (e: Entry, t: number): Exec => e.execs.filter((x) => x.at <= t).pop() ?? e.execs[0];

/**
 * 一段阶段切成若干窗口：在每个派人 / 改派时刻重新挑这一刻在干活的那一步——和台账同一条规则（stepAtStage：审查阶段按 currentReview
 * 取轮次大的、同轮终审优先；其余按 STAGE_STEPS 的退路顺序），挑中的派给了别的实例或人就没有本机窗口。
 * 段开始时某一步还没派过人、到推出这一段时才补的行（「修」常常修完交付时才补派），从段开始就算它的；段中途派的从派的那一刻算。
 */
function windowsOf(task: TaskInfo, seg: Seg, entries: Entry[]): Window[] {
  const own = OWN_STEP[seg.stage];
  if (!own) return [];
  const eff = new Map<Entry, number>();
  for (const name of STAGE_STEPS[seg.stage] ?? []) {
    const mine = entries.filter((e) => e.row.step === name && e.from <= seg.end + LATE_ROW_MS).sort((a, b) => a.from - b.from);
    const late = mine.length > 0 && !mine.some((e) => e.from <= seg.start) && mine[0].from >= seg.end - LATE_ROW_MS;
    mine.forEach((e, i) => eff.set(e, late && i === 0 ? seg.start : e.from));
  }
  const cuts = new Set([seg.start]);
  for (const [e, at] of eff) for (const t of [at, ...e.execs.map((x) => x.at)]) if (t > seg.start && t < seg.end) cuts.add(t);
  const pts = [...cuts].sort((a, b) => a - b);
  const out: Window[] = [];
  pts.forEach((p, i) => {
    const now = new Map<TaskStep, Exec>();
    for (const [e, at] of eff) if (at <= p) now.set(e.row, execAt(e, p));
    const cur = stepAtStage([...now.keys()], { stage: seg.stage, stageBefore: null });
    const x = cur && now.get(cur);
    if (!cur || !x || (x.executor !== null && x.kind !== "agent")) return;
    const w = win(task, p, pts[i + 1] ?? seg.end, own, cur, x.executor, seg.round);
    const last = out[out.length - 1];
    if (last && last.end === w.start && last.executor === w.executor && last.step === w.step && last.round === w.round) last.end = w.end;
    else out.push(w);
  });
  return out;
}

function win(task: TaskInfo, start: number, end: number, own: StepName, row: TaskStep, executor: string | null, taskRound: number): Window {
  const step = own === "review" && row.step === "final_review" ? "final_review" : own;
  return { task, start, end, step, round: row.step === step ? row.round : taskRound, executor };
}

/** 读台账里判归属要用的全部东西（一趟几千行事件，毫秒级） */
function readAttrLedger(db: Database): AttrLedger {
  const out: AttrLedger = {
    byAgent: new Map(), byTask: new Map(), tasks: new Map(), sessions: new Map(), managers: new Set(["master"]), executors: new Set(), lost: [],
  };
  for (const r of db.query("SELECT value FROM meta WHERE key = 'pms'").all() as { value: string }[]) {
    const pms = json(`{"pms":${r.value}}`).pms; // meta.value 是 JSON 数组：包一层再走同一个容错解析
    if (Array.isArray(pms)) for (const p of pms) if (typeof p === "string") out.managers.add(p);
  }
  const moves = new Map<string, { ts: number; from: Stage; to: Stage; round: number }[]>();
  for (const e of db.query("SELECT target, ts, data FROM events WHERE kind = 'stage' ORDER BY seq").all() as { target: string; ts: number; data: string }[]) {
    const d = json(e.data);
    if (!isStage(d.from) || !isStage(d.to)) continue;
    (moves.get(e.target) ?? moves.set(e.target, []).get(e.target)!).push({ ts: e.ts, from: d.from, to: d.to, round: Number(d.round) || 0 });
  }
  const assigns = new Map<string, Map<string, Exec[]>>();
  for (const e of db.query("SELECT target, ts, data FROM events WHERE kind = 'step' ORDER BY seq").all() as { target: string; ts: number; data: string }[]) {
    const d = json(e.data);
    if (d.op !== "assign" || typeof d.executor !== "string") continue;
    if (d.executorKind === "agent") out.executors.add(d.executor);
    const byKey = assigns.get(e.target) ?? assigns.set(e.target, new Map()).get(e.target)!;
    const key = `${d.step}#${Number(d.round) || 0}`;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push({ at: e.ts, executor: d.executor, kind: String(d.executorKind) });
  }
  for (const r of db.query("SELECT * FROM tasks").all() as Record<string, any>[]) {
    if (typeof r.pm === "string" && r.pm) out.managers.add(r.pm);
    const task: TaskInfo = { id: r.id, featureId: r.featureId ?? null, itemId: r.itemId ?? null };
    out.tasks.set(task.id, task);
    const steps = stepsOf(db, { ...r, extra: json(r.extra) } as Parameters<typeof stepsOf>[1]);
    for (const s of steps) if (s.executorKind === "agent") out.executors.add(s.executor);
    const entries = entriesOf(steps, assigns.get(task.id));
    const wins = stageSegments(r.createdAt, moves.get(task.id) ?? []).flatMap((seg) => windowsOf(task, seg, entries));
    out.byTask.set(task.id, wins);
    for (const w of wins) {
      if (w.executor === null) out.lost.push(w);
      else (out.byAgent.get(w.executor) ?? out.byAgent.set(w.executor, []).get(w.executor)!).push(w);
    }
  }
  for (const ws of out.byAgent.values()) ws.sort((a, b) => a.start - b.start);
  if (hasTable(db, "scheduler_sessions")) {
    for (const s of db.query("SELECT taskId, role, sessionId FROM scheduler_sessions").all() as { taskId: string; role: string; sessionId: string }[]) {
      out.sessions.set(s.sessionId, { taskId: s.taskId, role: s.role });
    }
  }
  return out;
}

const REVIEW_STEPS = new Set(["review", "final_review"]);
const AUTHOR_STEPS = new Set(["restate", "write", "fix"]);
const none = (basis: AttrBasis): Attribution => ({ task: null, step: null, round: null, feature: null, item: null, basis });
const onTask = (t: TaskInfo, basis: AttrBasis, step: string | null, round: number | null): Attribution =>
  ({ task: t.id, step, round, feature: t.featureId, item: t.itemId, basis });

/**
 * 一轮归到哪里，按轮的开始时间判。优先级：调度引擎绑定的会话 > PM / 大总管（协调开销）> 步骤窗口。
 * 一轮只落一张卡：同一时刻窗口里有两张以上的卡就记 overlap，不挑其中一张。
 */
function attributeTurn(l: AttrLedger, t: { agent: string; sessionId: string; startedAt: number }): Attribution {
  const bound = l.sessions.get(t.sessionId);
  const bt = bound ? l.tasks.get(bound.taskId) : undefined;
  if (bound && bt) {
    // 绑定的会话整条属于这张卡；步骤看这一刻卡在哪一步，和会话的角色（写 / 审）对得上才记
    const w = (l.byTask.get(bt.id) ?? []).find((x) => x.start <= t.startedAt && t.startedAt < x.end);
    const fits = w && (bound.role === "reviewer" ? REVIEW_STEPS.has(w.step) : AUTHOR_STEPS.has(w.step));
    return onTask(bt, "session", fits ? w.step : null, fits ? w.round : null);
  }
  if (t.agent === UNOWNED) return none("unowned");
  if (l.managers.has(t.agent)) return none("coordination");
  const hits = (l.byAgent.get(t.agent) ?? []).filter((w) => w.start <= t.startedAt && t.startedAt < w.end);
  const tasks = new Set(hits.map((w) => w.task.id));
  if (tasks.size > 1) return none("overlap");
  const at = (w: Window) => w.start <= t.startedAt && t.startedAt < w.end;
  if (hits.length && l.lost.some((w) => w.task.id !== hits[0].task.id && at(w))) return none("executor_lost");
  if (hits.length) return onTask(hits[0].task, "step", hits[0].step, hits[0].round);
  return none(l.executors.has(t.agent) ? "outside_window" : "not_in_ledger");
}

export interface AttrResult {
  turns: number;
  changed: number;
  byBasis: Partial<Record<AttrBasis, number>>;
}

const ATTR_COLS = "attr_task, attr_step, attr_round, attr_feature, attr_item, attr_basis";

/** 整体重算 usage 库里全部轮的归属，只写变了的行；只动 attr_* 列 */
export function attributeTurns(usage: Database, ledger: Database): AttrResult {
  const l = readAttrLedger(ledger);
  const rows = usage.query(`SELECT turn_id, agent, session_id, started_at, ${ATTR_COLS} FROM turns`).all() as Record<string, any>[];
  const set = usage.prepare(`UPDATE turns SET attr_task = ?, attr_step = ?, attr_round = ?, attr_feature = ?, attr_item = ?, attr_basis = ? WHERE turn_id = ?`);
  const res: AttrResult = { turns: rows.length, changed: 0, byBasis: {} };
  usage.transaction(() => {
    for (const r of rows) {
      const a = attributeTurn(l, { agent: r.agent, sessionId: r.session_id, startedAt: r.started_at });
      res.byBasis[a.basis] = (res.byBasis[a.basis] ?? 0) + 1;
      const next = [a.task, a.step, a.round, a.feature, a.item, a.basis];
      const prev = [r.attr_task, r.attr_step, r.attr_round, r.attr_feature, r.attr_item, r.attr_basis];
      if (next.every((v, i) => v === prev[i])) continue;
      set.run(...next, r.turn_id);
      res.changed++;
    }
  })();
  return res;
}

/** 只读打开台账算一遍再关上；没有台账返回 null */
export function attributeFromPath(usage: Database, ledgerPath: string): AttrResult | null {
  const ledger = openLedgerReadonly(ledgerPath);
  if (!ledger) return null;
  try {
    return attributeTurns(usage, ledger);
  } finally {
    ledger.close();
  }
}

/**
 * `usage by-feature <名字或 id>` 找 feature：先按 id（全 id、或本机前缀后的 slug）精确找，找不到再按标题包含找；事项（还没迁进 feature 的卡挂在事项上）同样两步。
 * 标题命中不止一个就报出来让人挑，不替人选。返回的 ids 给 usageByFeature。
 */
export function resolveFeatureIds(ledger: Database, q: string): { ids: string[]; labels: string[] } | { ambiguous: string[] } | null {
  const feats = hasTable(ledger, "features") ? ledger.query("SELECT id, title FROM features").all() as { id: string; title: string }[] : [];
  const items = ledger.query("SELECT id, title FROM items").all() as { id: string; title: string }[];
  const all = [...feats.map((f) => ({ ...f, slugHit: f.id.endsWith(`-${q}`) })), ...items.map((i) => ({ ...i, slugHit: false }))];
  const exact = all.filter((x) => x.id === q || x.slugHit);
  const hits = exact.length ? exact : all.filter((x) => x.title.includes(q));
  if (!hits.length) return null;
  const labels = hits.map((x) => `${x.id} ${x.title}`);
  return hits.length > 1 && !exact.length ? { ambiguous: labels } : { ids: hits.map((x) => x.id), labels };
}
