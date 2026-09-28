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
import { LedgerError } from "../lib/ledger-store.js";
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

/** 一条老任务 → importTask 输入：行落在映射给的阶段，时间线 spec →（startedAt）开工阶段 →（finishedAt / 导入时刻）最终阶段 */
function planTask(src: Obj, m: TaskMapping, project: string, now: number, defaultPm: string | undefined): ImportTaskInput {
  const id = String(src.id);
  const owner = parseOwnerField(src.owner);
  const reviews = Array.isArray(src.reviews) ? src.reviews.map(String) : [];
  const created = parseTs(src.dispatchedAt) ?? parseTs(src.startedAt) ?? parseTs(src.finishedAt) ?? now;
  const started = Math.max(parseTs(src.startedAt) ?? created, created);
  const ended = Math.max(parseTs(src.finishedAt) ?? now, started);
  const extra = Object.fromEntries(Object.entries(src).filter(([k]) => !TASK_COLUMNS.includes(k)));
  const specRev = Number.isInteger(src.specRev) && (src.specRev as number) >= 0 ? (src.specRev as number) : 1;
  const agent = m.agent !== undefined ? m.agent : owner.agent;
  const pm = m.pm ?? owner.pm ?? defaultPm ?? null;
  const task = {
    project, id, title: String(src.title), kind: m.kind, stage: m.stage, round: reviews.length, itemId: m.item ?? null,
    agent: agent ? agentKey(agent) : null, pm: pm ? agentKey(pm) : null, branch: str(src.branch), pr: str(src.pr), headSHA: str(src.headSHA),
    spec: str(src.spec), specRev, model: str(src.model), extra,
  };
  const events: ImportTaskInput["events"] = [];
  const words = str(src.owner_words);
  if (words) events.push({ kind: "decision", ts: created, text: words, data: { transcribed: true } });
  const first: Stage = m.kind === "ops" ? "build" : "restate";
  if (m.stage !== "spec") events.push({ kind: "stage", ts: started, data: { from: "spec", to: first } });
  reviews.forEach((text, i) => events.push({ kind: "review", ts: ended, text, data: { round: i + 1, reviewer: null, verdict: null, ...parseReviewCounts(text) } }));
  if (src.merge || src.rollbackPoint) events.push({ kind: "deploy", ts: ended, data: { version: str(src.merge), rollbackPoint: str(src.rollbackPoint) } });
  if (m.stage !== "spec" && m.stage !== first) events.push({ kind: "stage", ts: ended, data: { from: first, to: m.stage } });
  return { task, initialStage: "spec", createdTs: created, events };
}

function planItems(src: Obj, map: ImportMap, project: string, now: number, skipped: Map<string, Obj>): ImportPlan["items"] {
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
    items.push({ input: input as NewItem, ts: parseTs(it.updatedAt) ?? now });
  }
  for (const n of map.newItems ?? []) items.push({ input: { ...n, project }, ts: now });
  return items;
}

/** 老 log / morning / ownerInbox → note / decision 事件（按时间稳定排序，ts 相同的保持原顺序） */
function planEvents(src: Obj, project: string, now: number, itemIds: Set<string>, taskIds: Set<string>): PlannedEvent[] {
  const out: PlannedEvent[] = [];
  const log = ((src.log as Obj[] | undefined) ?? []).map((e, i) => ({ e, i, ts: parseTs(e.ts) ?? now }));
  log.sort((a, b) => a.ts - b.ts || a.i - b.i);
  for (const { e, ts } of log) {
    const item = str(e.item);
    const target = item && itemIds.has(item) ? item : "";
    out.push({ project, target, kind: "note", text: String(e.text ?? ""), data: { imported: true, ...(item && !target ? { item } : {}) }, ts, dedupKey: hashKey("import:log", e.ts, e.item, e.text) });
  }
  const morning = src.morning as { title?: string; points?: unknown[] } | undefined;
  if (morning) {
    const text = [morning.title ?? "", ...(morning.points ?? []).map((p) => `- ${String(p)}`)].join("\n");
    out.push({ project, target: "", kind: "note", text, data: { imported: true, source: "morning" }, ts: parseTs(src.updatedAt) ?? now, dedupKey: hashKey("import:morning", text) });
  }
  for (const m of (src.ownerInbox as Obj[] | undefined) ?? []) {
    const refs = [...String(m.to ?? "").matchAll(/\bT\d+[a-z0-9-]*\b/gi)].map((x) => x[0]).filter((t) => taskIds.has(t));
    const data = { imported: true, transcribed: true, source: "ownerInbox", status: m.status ?? null, to: m.to ?? null };
    out.push({ project, target: refs.length === 1 ? refs[0] : "", kind: "decision", text: String(m.text ?? ""), data, ts: parseTs(m.ts) ?? now, dedupKey: hashKey("import:inbox", m.ts, m.text) });
  }
  return out;
}

export function planImport(src: Obj, map: ImportMap, project: string, now: number): ImportPlan {
  const srcTasks = ((src.items as Obj[] | undefined) ?? []).flatMap((it) => ((it.trial as Obj | undefined)?.tasks as Obj[] | undefined) ?? []);
  const unmapped = srcTasks.map((t) => String(t.id)).filter((id) => !map.tasks[id]);
  const skipped = new Map<string, Obj>();
  const tasks: ImportTaskInput[] = [];
  for (const t of srcTasks) {
    const m = map.tasks[String(t.id)];
    if (!m) continue;
    if (m.skip) skipped.set(String(t.id), { ...t, __into: m.intoItemExtra });
    else tasks.push(planTask(t, m, project, now, map.defaultPm));
  }
  for (const x of map.extraTasks ?? []) {
    const { item: _i, kind: _k, stage: _s, agent: _a, pm: _p, skip: _x, intoItemExtra: _e, ...rest } = x;
    tasks.push(planTask(rest, x, project, now, map.defaultPm));
  }
  const items = planItems(src, map, project, now, skipped);
  const itemIds = new Set(items.map((i) => i.input.id));
  for (const t of tasks) {
    if (t.task.itemId && !itemIds.has(t.task.itemId)) throw new LedgerError("invalid", `任务 ${t.task.id} 映射到的事项 ${t.task.itemId} 不存在（源文件和 newItems 里都没有）`);
  }
  const events = planEvents(src, project, now, itemIds, new Set(tasks.map((t) => t.task.id)));
  return { project, ...(map.pms ? { pms: map.pms.map(agentKey) } : {}), items, tasks, events, unmapped };
}

type Tally = { created: number; duplicate: number };

/** 顺序：PM 名单 → 事项 → 任务（依赖事项）→ 事件（目标要先存在）；全用 owner 身份，dedupKey 让重跑只返回 duplicate */
export function applyImport(db: Database, plan: ImportPlan): Record<string, Tally> {
  const tally = (): Tally => ({ created: 0, duplicate: 0 });
  const out = { items: tally(), tasks: tally(), events: tally() };
  const bump = (t: Tally, dup: boolean) => void (dup ? t.duplicate++ : t.created++);
  if (plan.pms) setMeta(db, { actor: "owner", dedupKey: hashKey("import:pms", plan.project, plan.pms.join(",")) }, { project: plan.project, key: "pms", value: plan.pms });
  for (const { input, ts } of plan.items) bump(out.items, createItem(db, { actor: "owner", now: ts, dedupKey: `import:item:${plan.project}:${input.id}` }, input).duplicate);
  for (const t of plan.tasks) bump(out.tasks, importTask(db, { actor: "owner", dedupKey: `import:task:${t.task.id}` }, t).duplicate);
  for (const e of plan.events) {
    const r = appendEvent(db, { actor: "owner", now: e.ts, dedupKey: e.dedupKey }, { project: e.project, target: e.target, kind: e.kind, text: e.text, data: e.data });
    bump(out.events, r.duplicate);
  }
  return out;
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
  if (c.p.bools.has("dry-run")) return { ok: true, dryRun: true, project, planned: counts };
  return { ok: true, project, planned: counts, result: applyImport(c.db, plan) };
}
