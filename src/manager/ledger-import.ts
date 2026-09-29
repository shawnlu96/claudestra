/**
 * `ledger import <ledger.json> --map <map.json>`：把 PM 手写的老台账（~/.claude-orchestrator/ledger/ledger.json）搬进内置台账（docs 10-ledger §6）。
 * 老数据没有任务 → 事项 / kind / 阶段，这些由映射文件给（PM 核过，放仓库外）；没映射到的原样进 extra，不丢字段。
 * 合成事件一律 imported:true、时间取原时间戳；每一条都带 dedupKey，整份重跑是幂等的。源文件只读不改（改名留给切换当天手动做）。
 * planImport 是纯函数（tests/manager-ledger-import.test.ts 字段对照），applyImport 只调 lib 的写函数。
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Stage, TaskKind } from "../lib/ledger-stages.js";
import { IMPORT_ACTOR } from "../lib/ledger-checks.js";
import { busyAsLedgerError, getMeta, LedgerError } from "../lib/ledger-store.js";
import { appendEvent, createItem, importTask, setMeta, type ImportTaskInput, type NewItem } from "../lib/ledger-write.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import { agentKey } from "./ledger-identity.js";

type Obj = Record<string, unknown>;

interface TaskMapping {
  item?: string | null;
  kind: TaskKind;
  stage: Stage;
  agent?: string | null;
  pm?: string | null;
  /** 不建任务，整条原样挂进这个事项的 extra.skippedTasks */
  skip?: boolean;
  intoItemExtra?: string;
  /** 覆盖源数据的时间点（源里缺、PM 从 log / PR / registry 查到的），同源字段格式 */
  dispatchedAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ImportMap {
  project?: string;
  defaultPm?: string;
  pms?: string[];
  newItems?: (Partial<NewItem> & { id: string; title: string })[];
  tasks: Record<string, TaskMapping>;
  /** 源文件里没有、要补建的任务（如按子任务拆开的 T8a / T8b）；除映射字段外的键（dispatchedAt / reviews / pr …）按源任务处理 */
  extraTasks?: (TaskMapping & { id: string; title: string } & Obj)[];
}

interface PlannedEvent {
  project: string;
  target: string;
  kind: "note" | "decision";
  text: string;
  data: Obj;
  ts: number;
  dedupKey: string;
}

export interface ImportPlan {
  project: string;
  pms?: string[];
  items: { input: NewItem; ts: number }[];
  tasks: ImportTaskInput[];
  events: PlannedEvent[];
  /** 源文件里有、映射里没写的任务 id：有就不导（避免把没核过的阶段写进去） */
  unmapped: string[];
}

/** 老台账的时间戳混着 +0900 与 +09:00 两种写法 */
export function parseTs(v: unknown): number | null {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isFinite(t) ? t : null;
}

function hashKey(prefix: string, ...parts: unknown[]): string {
  return `${prefix}:${createHash("sha1").update(parts.map((p) => String(p ?? "")).join("\u0000")).digest("hex").slice(0, 20)}`;
}

/** 审查结论原文里的「无 P0」「3 个 P1」；没提到的记 null（指标按 0 算） */
export function parseReviewCounts(text: string): { p0: number | null; p1: number | null; p2: number | null } {
  const out = { p0: null, p1: null, p2: null } as { p0: number | null; p1: number | null; p2: number | null };
  for (const k of [0, 1, 2] as const) {
    const n = text.match(new RegExp(`(\\d+)\\s*个\\s*P${k}`));
    if (n) out[`p${k}`] = Number(n[1]);
    else if (new RegExp(`无\\s*P${k}`).test(text)) out[`p${k}`] = 0;
  }
  return out;
}

/** 老 owner 字段：「agent-task-t3」「agent-claudestra（PM）」「待派」/ null */
export function parseOwnerField(owner: unknown): { agent: string | null; pm: string | null } {
  const m = typeof owner === "string" ? owner.match(/^(agent-[\w-]+)/) : null;
  if (!m) return { agent: null, pm: null };
  return { agent: m[1], pm: /（PM）|\(PM\)/.test(String(owner)) ? m[1] : null };
}

const TASK_COLUMNS = ["id", "title", "branch", "pr", "headSHA", "spec", "specRev", "model"];

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** 进过 review 的阶段：导入时 round 至少 1（源里没记 reviews 也一样） */
const REVIEWED: readonly Stage[] = ["review", "fix", "merge", "live", "verified", "done"];

type Stamp = { ts: number; approx: boolean };

/**
 * 三个时间点：映射覆盖 > 源字段 > 推断。推断取「最近一个已知时间」：派发缺 → 开工 / 完成时间；开工缺 → 派发时间；
 * 完成缺 → 源文件的 updatedAt（老台账最后一次落笔）。推断的都标 approx，事件上记 approxTime，别当成真实时刻去算用时。
 */
export function taskTimes(src: Obj, m: TaskMapping, fallback: number): { created: Stamp; started: Stamp; ended: Stamp } {
  const dispatched = parseTs(m.dispatchedAt) ?? parseTs(src.dispatchedAt);
  const started = parseTs(m.startedAt) ?? parseTs(src.startedAt);
  const finished = parseTs(m.finishedAt) ?? parseTs(src.finishedAt);
  const created = dispatched ?? started ?? finished ?? fallback;
  const s = Math.max(started ?? created, created);
  return {
    created: { ts: created, approx: dispatched === null },
    started: { ts: s, approx: started === null },
    ended: { ts: Math.max(finished ?? fallback, s), approx: finished === null },
  };
}

const approxData = (st: Stamp): Obj => (st.approx ? { approxTime: true } : {});

/** 一条老任务 → importTask 输入：行落在映射给的阶段，时间线 spec →（开工）开工阶段 →（完成）最终阶段 */
function planTask(src: Obj, m: TaskMapping, project: string, fallback: number, defaultPm: string | undefined): ImportTaskInput {
  const id = String(src.id);
  const owner = parseOwnerField(src.owner);
  const reviews = Array.isArray(src.reviews) ? src.reviews.map(String) : [];
  const { created, started, ended } = taskTimes(src, m, fallback);
  const extra = Object.fromEntries(Object.entries(src).filter(([k]) => !TASK_COLUMNS.includes(k)));
  const specRev = Number.isInteger(src.specRev) && (src.specRev as number) >= 0 ? (src.specRev as number) : 1;
  const agent = m.agent !== undefined ? m.agent : owner.agent;
  const pm = m.pm ?? owner.pm ?? defaultPm ?? null;
  const task = {
    project, id, title: String(src.title), kind: m.kind, stage: m.stage, round: Math.max(reviews.length, REVIEWED.includes(m.stage) ? 1 : 0), itemId: m.item ?? null,
    agent: agent ? agentKey(agent) : null, pm: pm ? agentKey(pm) : null, branch: str(src.branch), pr: str(src.pr), headSHA: str(src.headSHA),
    spec: str(src.spec), specRev, model: str(src.model), extra,
  };
  const events: ImportTaskInput["events"] = [];
  const words = str(src.owner_words);
  if (words) events.push({ kind: "decision", ts: created.ts, text: words, data: { transcribed: true, ...approxData(created) } });
  const first: Stage = m.kind === "ops" ? "build" : "restate";
  if (m.stage !== "spec") events.push({ kind: "stage", ts: started.ts, data: { from: "spec", to: first, ...approxData(started) } });
  reviews.forEach((text, i) => {
    events.push({ kind: "review", ts: ended.ts, text, data: { round: i + 1, reviewer: null, verdict: null, ...parseReviewCounts(text), ...approxData(ended) } });
  });
  if (src.merge || src.rollbackPoint) {
    events.push({ kind: "deploy", ts: ended.ts, data: { version: str(src.merge), rollbackPoint: str(src.rollbackPoint), ...approxData(ended) } });
  }
  if (m.stage !== "spec" && m.stage !== first) events.push({ kind: "stage", ts: ended.ts, data: { from: first, to: m.stage, ...approxData(ended) } });
  return { task, initialStage: "spec", createdTs: created.ts, createdApprox: created.approx, events };
}

/**
 * 老台账没有事项的创建时间：取「updatedAt、最早一条挂它的 log、最早挂上它的任务的派发时间」里最早的（都没有就取源文件 updatedAt），
 * 一律标 approxTime。取最早是为了时间线不倒序——事项的 log 与任务都不能早于事项本身。
 */
function planItems(src: Obj, map: ImportMap, project: string, fallback: number, skipped: Map<string, Obj>, firstSeen: Map<string, number>): ImportPlan["items"] {
  const created = (id: string, updatedAt: unknown) => Math.min(parseTs(updatedAt) ?? Infinity, firstSeen.get(id) ?? Infinity);
  const tsOf = (id: string, updatedAt: unknown) => (Number.isFinite(created(id, updatedAt)) ? created(id, updatedAt) : fallback);
  const items: ImportPlan["items"] = [];
  for (const it of (src.items as Obj[] | undefined) ?? []) {
    const { id, title, status, priority, oneLine, next, ask, trial, ...rest } = it;
    const extra: Obj = { ...rest };
    if (trial && typeof trial === "object") extra.trial = Object.fromEntries(Object.entries(trial as Obj).filter(([k]) => k !== "tasks"));
    const sk = [...skipped].filter(([, s]) => s.__into === id).map(([tid, s]) => [tid, Object.fromEntries(Object.entries(s).filter(([k]) => k !== "__into"))]);
    if (sk.length) extra.skippedTasks = Object.fromEntries(sk);
    const input = {
      project, id: String(id), title: String(title), status, priority: String(priority ?? ""),
      oneLine: String(oneLine ?? ""), next: String(next ?? ""), ownerWords: String(ask ?? ""), extra,
    };
    items.push({ input: input as NewItem, ts: tsOf(String(id), it.updatedAt) });
  }
  for (const n of map.newItems ?? []) items.push({ input: { ...n, project }, ts: tsOf(n.id, undefined) });
  return items;
}

/** 老 log / morning / ownerInbox → note / decision 事件（按时间稳定排序，ts 相同的保持原顺序）；缺时间的取源文件 updatedAt 并标 approxTime */
function planEvents(src: Obj, project: string, now: number, itemIds: Set<string>, taskIds: Set<string>): PlannedEvent[] {
  const approx = (v: unknown): Obj => (parseTs(v) === null ? { approxTime: true } : {});
  const out: PlannedEvent[] = [];
  const log = ((src.log as Obj[] | undefined) ?? []).map((e, i) => ({ e, i, ts: parseTs(e.ts) ?? now }));
  log.sort((a, b) => a.ts - b.ts || a.i - b.i);
  for (const { e, ts } of log) {
    const item = str(e.item);
    const target = item && itemIds.has(item) ? item : "";
    const data = { imported: true, ...(item && !target ? { item } : {}), ...approx(e.ts) };
    out.push({ project, target, kind: "note", text: String(e.text ?? ""), data, ts, dedupKey: hashKey("import:log", e.ts, e.item, e.text) });
  }
  const morning = src.morning as { title?: string; points?: unknown[] } | undefined;
  if (morning) {
    const text = [morning.title ?? "", ...(morning.points ?? []).map((p) => `- ${String(p)}`)].join("\n");
    out.push({ project, target: "", kind: "note", text, data: { imported: true, source: "morning" }, ts: parseTs(src.updatedAt) ?? now, dedupKey: hashKey("import:morning", text) });
  }
  for (const m of (src.ownerInbox as Obj[] | undefined) ?? []) {
    const refs = [...String(m.to ?? "").matchAll(/\bT\d+[a-z0-9-]*\b/gi)].map((x) => x[0]).filter((t) => taskIds.has(t));
    const data = { imported: true, transcribed: true, source: "ownerInbox", status: m.status ?? null, to: m.to ?? null, ...approx(m.ts) };
    out.push({ project, target: refs.length === 1 ? refs[0] : "", kind: "decision", text: String(m.text ?? ""), data, ts: parseTs(m.ts) ?? now, dedupKey: hashKey("import:inbox", m.ts, m.text) });
  }
  return out;
}

export function planImport(src: Obj, map: ImportMap, project: string, now: number): ImportPlan {
  const fallback = parseTs(src.updatedAt) ?? now;
  const srcTasks = ((src.items as Obj[] | undefined) ?? []).flatMap((it) => ((it.trial as Obj | undefined)?.tasks as Obj[] | undefined) ?? []);
  const unmapped = srcTasks.map((t) => String(t.id)).filter((id) => !map.tasks[id]);
  const skipped = new Map<string, Obj>();
  const tasks: ImportTaskInput[] = [];
  for (const t of srcTasks) {
    const m = map.tasks[String(t.id)];
    if (!m) continue;
    if (m.skip) skipped.set(String(t.id), { ...t, __into: m.intoItemExtra });
    else tasks.push(planTask(t, m, project, fallback, map.defaultPm));
  }
  for (const x of map.extraTasks ?? []) {
    const { item: _i, kind: _k, stage: _s, agent: _a, pm: _p, skip: _x, intoItemExtra: _e, ...rest } = x;
    tasks.push(planTask(rest, x, project, fallback, map.defaultPm));
  }
  const itemIds = new Set([...((src.items as Obj[] | undefined) ?? []).map((i) => String(i.id)), ...(map.newItems ?? []).map((n) => n.id)]);
  for (const t of tasks) {
    if (t.task.itemId && !itemIds.has(t.task.itemId)) throw new LedgerError("invalid", `任务 ${t.task.id} 映射到的事项 ${t.task.itemId} 不存在（源文件和 newItems 里都没有）`);
  }
  const events = planEvents(src, project, fallback, itemIds, new Set(tasks.map((t) => t.task.id)));
  settleTimeline(tasks, events);
  const firstSeen = new Map<string, number>();
  const seen = (id: string | null | undefined, ts: number) => void (id && firstSeen.set(id, Math.min(firstSeen.get(id) ?? Infinity, ts)));
  for (const e of events) seen(e.target, e.ts);
  for (const t of tasks) seen(t.task.itemId, t.createdTs);
  const items = planItems(src, map, project, fallback, skipped, firstSeen);
  return { project, ...(map.pms ? { pms: map.pms.map(agentKey) } : {}), items, tasks, events, unmapped };
}

/**
 * 建任务要排在挂到它身上的决定之前（ownerInbox 的要求常早于派发）：任务的创建时间取 min(派发, 最早的决定)，被提前的标 approxTime。
 * 定完时间再算指纹，重跑时拿它判断时间线有没有变。
 */
function settleTimeline(tasks: ImportTaskInput[], events: PlannedEvent[]): void {
  for (const t of tasks) {
    const earliest = Math.min(...events.filter((e) => e.target === t.task.id).map((e) => e.ts));
    if (earliest < t.createdTs) {
      t.createdTs = earliest;
      t.createdApprox = true;
    }
    t.fingerprint = hashKey("timeline", JSON.stringify({ c: t.createdTs, a: !!t.createdApprox, e: t.events }));
  }
}

type Tally = { created: number; duplicate: number };

/** 变化检测的字段；createdTs / fingerprint 覆盖时间点与合成事件（映射里改了时间，重跑也要报出来） */
const ITEM_DRIFT = ["title", "status", "priority", "oneLine", "next", "ownerWords", "extra", "createdTs"];
const TASK_DRIFT = ["itemId", "kind", "stage", "round", "agent", "pm", "title", "branch", "pr", "headSHA", "spec", "specRev", "model", "extra", "fingerprint"];

/** dedup 命中但值变了（改了映射后重跑）：列出字段，不能静默沿用库里的旧值 */
function driftOf(what: string, planned: Obj, row: Obj, fields: string[]): string | null {
  const diff = fields.filter((f) => JSON.stringify(planned[f] ?? null) !== JSON.stringify(row[f] ?? null));
  return diff.length ? `${what}（${diff.join(", ")}）` : null;
}

/** 出错时带上是哪一条，映射写错了能直接定位 */
function step<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof LedgerError) throw new LedgerError(e.code, `${what}：${e.message}`, e.current);
    throw e;
  }
}

/**
 * PM 名单：import 是 owner 专用的一次性迁移，只在名单为空时写；已有名单就拒绝（改名单走 meta --pms 提案 + owner 确认 + team-apply）。
 * 重跑同一份映射（名单已经一样）照常幂等，不报错。
 */
function importPms(db: Database, project: string, pms: string[]): void {
  const cur = getMeta(db, project).pms;
  if (JSON.stringify(cur) === JSON.stringify(pms)) return;
  if (cur.length) {
    throw new LedgerError("conflict", `项目 ${project} 已有 PM 名单（${cur.join("、")}）：ledger import 只在名单为空时写入；改名单用 ledger meta --pms 提议，owner 在界面上确认后由 team-apply 写入`);
  }
  setMeta(db, { actor: IMPORT_ACTOR, dedupKey: hashKey("import:pms", project, pms.join(",")) }, { project, key: "pms", value: pms });
}

/** 顺序：PM 名单 → 事项 → 任务（依赖事项）→ 事件（目标要先存在）；身份一律 IMPORT_ACTOR（事件自动带 imported） */
function applyAll(db: Database, plan: ImportPlan): Record<string, Tally> {
  const tally = (): Tally => ({ created: 0, duplicate: 0 });
  const out = { items: tally(), tasks: tally(), events: tally() };
  const bump = (t: Tally, dup: boolean) => void (dup ? t.duplicate++ : t.created++);
  const drift: string[] = [];
  const actor = IMPORT_ACTOR;
  if (plan.pms) importPms(db, plan.project, plan.pms);
  for (const { input, ts } of plan.items) {
    const r = step(`事项 ${input.id}`, () => createItem(db, { actor, now: ts, approxTime: true, dedupKey: `import:item:${plan.project}:${input.id}` }, input));
    bump(out.items, r.duplicate);
    const planned = { status: "todo", priority: "", oneLine: "", next: "", ownerWords: "", extra: {}, ...input, createdTs: ts };
    const d = r.duplicate && driftOf(`事项 ${input.id}`, planned, { ...r.row, createdTs: r.event.ts } as never, ITEM_DRIFT);
    if (d) drift.push(d);
  }
  for (const t of plan.tasks) {
    const r = step(`任务 ${t.task.id}`, () => importTask(db, { actor, dedupKey: `import:task:${t.task.id}` }, t));
    bump(out.tasks, r.duplicate);
    const planned = { ...t.task, fingerprint: t.fingerprint };
    const d = r.duplicate && driftOf(`任务 ${t.task.id}`, planned as never, { ...r.row, fingerprint: r.event.data.fingerprint } as never, TASK_DRIFT);
    if (d) drift.push(d);
  }
  for (const e of plan.events) {
    const r = step(`事件 ${e.dedupKey}`, () => appendEvent(db, { actor, now: e.ts, dedupKey: e.dedupKey }, { project: e.project, target: e.target, kind: e.kind, text: e.text, data: e.data }));
    bump(out.events, r.duplicate);
  }
  if (drift.length) throw new LedgerError("conflict", `这些已导入过、但这次的值不同（改了映射？）：${drift.join("；")}。整批已回滚；要改请用 item-set / task-set / stage，或换新库重导`);
  return out;
}

class DryRunRollback {
  constructor(readonly result: Record<string, Tally>) {}
}

/**
 * 整批一个事务（lib 各写函数的事务嵌套成 savepoint）：半路任何一条失败都整体回滚，不留半截数据。
 * dry-run 跑完全一样的写入与校验再回滚——只跑 planImport 查不出库里才有的校验（kind 与阶段不配等）。
 */
export function applyImport(db: Database, plan: ImportPlan, dryRun = false): Record<string, Tally> {
  try {
    return busyAsLedgerError("导入", () =>
      db.transaction(() => {
        const r = applyAll(db, plan);
        if (dryRun) throw new DryRunRollback(r);
        return r;
      }).immediate(),
    );
  } catch (e) {
    if (e instanceof DryRunRollback) return e.result; // 故意抛出来回滚的，结果照常返回
    throw e;
  }
}

function readJson(path: string, what: string): Obj {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Obj;
  } catch (e) {
    throw new LedgerError("invalid", `${what} ${path} 读不了：${(e as Error).message}`);
  }
}

export function importCmd(c: LedgerCli): Result {
  if (c.deps.actor !== "owner") throw new LedgerError("forbidden", "只有 owner（终端）能导入台账");
  const file = c.p.pos[1];
  if (!file) throw new LedgerError("invalid", "import <ledger.json> --map <map.json> [--dry-run]");
  const src = readJson(file, "老台账");
  const map = readJson(c.need("map"), "映射文件") as unknown as ImportMap;
  const project = c.p.flags.project ?? map.project ?? c.project();
  if (!c.deps.projectIds.includes(project)) throw new LedgerError("not_found", `projects.json 里没有项目 ${project}`);
  const plan = planImport(src, map, project, c.deps.now());
  if (plan.unmapped.length) throw new LedgerError("invalid", `映射文件没覆盖这些任务：${plan.unmapped.join(", ")}（每个都要给 item / kind / stage，或 skip）`);
  const counts = { items: plan.items.length, tasks: plan.tasks.length, events: plan.events.length + plan.tasks.reduce((s, t) => s + t.events.length + 1, 0) };
  const dryRun = c.p.bools.has("dry-run");
  return { ok: true, project, ...(dryRun ? { dryRun: true } : {}), planned: counts, result: applyImport(c.db, plan, dryRun) };
}
