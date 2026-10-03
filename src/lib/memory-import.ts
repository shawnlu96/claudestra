/** JSONL import uses the canonical lint/write gates in a disposable snapshot; the source is never written during planning. */
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { vacuumBackup } from "./ledger-backup.js";
import { getMemory, memoryDigest, memoryState, recordMemory, secretHits, type Memory, type MemoryCtx, type MemoryInput } from "./ledger-memory.js";
import { storedOrigin } from "./ledger-origin.js";
import { busyAsLedgerError, getEventByDedup, LedgerError } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { memoryLint } from "./memory-lint.js";
import { cosine } from "./memory-vectors.js";

export const IMPORT_ISSUES = ["format", "redaction", "duplicate", "anchor", "lint"] as const;
type IssueKind = (typeof IMPORT_ISSUES)[number];
interface ImportIssue { line: number; kind: IssueKind; reason: string; duplicateOf?: string }
interface ImportRow { line: number; key: string; input: MemoryInput; memory: Memory; replay: boolean }
export interface ImportPlan { project: string; digest: string; rows: ImportRow[]; issues: ImportIssue[] }
export type ImportVectors = ReadonlyMap<string, Float32Array>;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const importVectorKey = (m: Memory) => JSON.stringify([m.project, m.digest, m.visibility]);
const TABLES = ["ledger_instance", "events", "tasks", "features", "dag_versions", "lend_peers", "memories", "memory_marks"];
const FIELDS = new Set(["kind", "title", "symptom", "rule", "files", "family", "fixable", "feature", "task", "sourceNote", "visibility", "head", "specRev"]);

/** Copy only the tables used by the canonical gates. Unlike SQLite deserialization this also works for WAL source databases. */
function snapshot(source: Database): Database {
  const copy = new Database(":memory:");
  try {
    source.transaction(() => {
      for (const table of TABLES) {
        const schema = source.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | null;
        if (!schema) continue;
        copy.prepare(schema.sql).run();
        const rows = source.query(`SELECT * FROM "${table}"`).values() as SQLQueryBindings[][];
        if (!rows.length) continue;
        const insert = copy.prepare(`INSERT INTO "${table}" VALUES (${rows[0]!.map(() => "?").join(",")})`);
        copy.transaction(() => { for (const row of rows) insert.run(...row); })();
      }
    })();
    // Planning must not call instanceIdSync (which may create a host file).
    if (!storedOrigin(copy)) copy.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'dry0')").run();
    return copy;
  } catch (e) {
    copy.close();
    throw e;
  }
}

function textFields(raw: unknown, prefix = ""): Record<string, string> {
  if (typeof raw === "string") return { [prefix]: raw };
  if (!raw || typeof raw !== "object") return {};
  return Object.assign({}, ...Object.entries(raw).map(([k, v]) => textFields(v, prefix ? `${prefix}.${k}` : k)));
}

function inputOf(db: Database, project: string, raw: unknown): MemoryInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new LedgerError("invalid", "每行要是 JSON 对象");
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some((k) => !FIELDS.has(k))) throw new LedgerError("invalid", "清单有未支持的字段");
  if (r.kind !== "pitfall") throw new LedgerError("invalid", "清单只收 kind = pitfall");
  if (!Array.isArray(r.files) || !r.files.every((f) => typeof f === "string")) throw new LedgerError("invalid", "files 要是字符串数组");
  for (const k of ["feature", "task"]) {
    if (r[k] !== undefined && r[k] !== null && (typeof r[k] !== "string" || !(r[k] as string).trim())) {
      throw new LedgerError("invalid", `${k} 要是非空字符串或 null`);
    }
  }
  const task = r.task ? db.query("SELECT headSHA AS head, specRev, featureId FROM tasks WHERE id = ? AND project = ?").get(r.task as string, project) as
    { head: string | null; specRev: number; featureId: string | null } | null : null;
  if (r.task && !task) throw new LedgerError("not_found", "task 锚点在本项目里不存在");
  if (r.feature && !db.query("SELECT 1 FROM features WHERE id = ? AND project = ?").get(r.feature as string, project)) {
    throw new LedgerError("not_found", "feature 锚点在本项目里不存在");
  }
  if (r.feature && task && r.feature !== task.featureId) throw new LedgerError("not_found", "feature 与 task 锚点不一致");
  return {
    ...r, project, via: "import", authorRole: "pm", featureId: r.feature ?? null, taskId: r.task ?? null,
    ...(r.task ? { head: r.head === undefined ? task?.head : r.head, specRev: r.specRev === undefined ? task?.specRev : r.specRev } : {}),
  } as MemoryInput;
}

/** A receipt binds frozen content; current task membership and write gates cannot invalidate an earlier successful import. */
function replayOf(db: Database, project: string, key: string, raw: unknown): Pick<ImportRow, "input" | "memory"> | null {
  const event = getEventByDedup(db, key);
  if (!event) return null;
  const id = event.data.memoryId;
  const m = typeof id === "string" ? getMemory(db, id) : null;
  if (!m || event.project !== project || m.project !== project || m.kind !== "pitfall" || m.via !== "import"
    || event.kind !== "note" || event.target !== "" || event.data.op !== "memory_import" || Object.keys(event.data).length !== 2
    || !raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LedgerError("dedup_mismatch", "导入幂等键已被别的项目或动作占用");
  }
  const r = raw as Record<string, unknown>;
  const body = m.body as { symptom: string; rule: string };
  const fields: Record<string, unknown> = {
    kind: m.kind, title: m.title, symptom: body.symptom, rule: body.rule, files: m.files, family: m.family,
    fixable: m.fixable, feature: m.featureId, task: m.taskId, sourceNote: m.sourceNote,
    visibility: m.visibility, head: m.head, specRev: m.specRev,
  };
  const matches = Object.entries(r).every(([field, value]) => {
    if (!Object.hasOwn(fields, field)) return false;
    if (field === "feature" && value === null) return !!m.taskId || m.featureId === null;
    if (field === "visibility" && (value == null || value === "team")) return true; // Original team inputs may have been downgraded to home.
    if (field === "files") return Array.isArray(value) && JSON.stringify(value) === JSON.stringify(m.files);
    if (field === "family" || field === "head" || field === "sourceNote") value = value === "" ? null : value;
    return value === fields[field];
  });
  if (!matches || r.kind !== m.kind || r.fixable !== m.fixable || (r.task ?? null) !== m.taskId
    || (r.family === "" ? null : r.family ?? null) !== m.family || (r.sourceNote ?? null) !== m.sourceNote
    || (!m.taskId && (r.feature ?? null) !== m.featureId) || !Array.isArray(r.files)
    || m.digest !== memoryDigest(r.title as string, JSON.stringify({ symptom: r.symptom, rule: r.rule }), r.files as string[])) {
    throw new LedgerError("dedup_mismatch", "导入回执与冻结记忆的原内容或绑定不一致");
  }
  return { memory: m, input: {
    project, kind: "pitfall", title: m.title, symptom: body.symptom, rule: body.rule, files: m.files,
    family: m.family, fixable: m.fixable!, featureId: m.featureId, taskId: m.taskId, sourceNote: m.sourceNote,
    head: m.head, specRev: m.specRev, visibility: m.visibility, via: "import", authorRole: "pm",
  } };
}

/** A project-level audit receipt carries the row hash; memory contents and their timeline event remain append-only. */
function writeRow(db: Database, ctx: MemoryCtx, key: string, input: MemoryInput): Memory {
  const w = recordMemory(db, ctx, input);
  if (!w.event) throw new LedgerError("invalid", "导入行没有写入事件");
  appendEvent(db, { ...ctx, dedupKey: key }, { project: input.project, target: "", kind: "note",
    data: { op: "memory_import", memoryId: w.memory.id } });
  return w.memory;
}

function inspectRow(db: Database, ctx: MemoryCtx, project: string, raw: string, line: number, vectors: ImportVectors): ImportRow | ImportIssue {
  const key = `import:${hash(raw)}`;
  try {
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return { line, kind: "format", reason: "不是合法 JSON（不回显原文）" }; }
    const prev = replayOf(db, project, key, value);
    if (prev) return { line, key, ...prev, replay: true };
    const hits = secretHits(textFields(value));
    if (hits.length) return { line, kind: "redaction", reason: `命中字段位置：${hits.join(", ")}` };
    const input = inputOf(db, project, value);
    const lint = memoryLint(db, input);
    if (!lint.ok) {
      const kind = lint.rule === 6 ? "redaction" : lint.rule === 7 ? "duplicate" : lint.rule === 8 ? "format" : "lint";
      return { line, kind, reason: lint.error, ...(lint.duplicateOf ? { duplicateOf: lint.duplicateOf } : {}) };
    }
    // Validate canonical structure/anchors and determine visibility before looking up a vector.
    return db.transaction(() => {
      const memory = writeRow(db, ctx, key, input);
      const vec = vectors.get(importVectorKey(memory));
      if (vec) {
        for (const r of db.query("SELECT id FROM memories WHERE project = ? AND id <> ?").all(project, memory.id) as { id: string }[]) {
          const other = getMemory(db, r.id)!;
          const status = memoryState(db, r.id)?.status;
          if (status === "retracted" || status === "superseded") continue;
          const v = vectors.get(importVectorKey(other));
          if (v && cosine(vec, v) >= 0.92) throw new LedgerError("conflict", `语义重复：与 ${other.id} 余弦 ≥0.92`, { duplicateOf: other.id });
        }
      }
      return { line, key, input, memory, replay: false };
    })();
  } catch (e) {
    const kind = e instanceof LedgerError && e.code === "not_found" ? "anchor"
      : e instanceof LedgerError && (e.code === "conflict" || e.code === "dedup_mismatch") ? "duplicate" : "format";
    return { line, kind, reason: e instanceof LedgerError ? e.message : "字段结构不合法",
      ...(e instanceof LedgerError && typeof e.current?.duplicateOf === "string" ? { duplicateOf: e.current.duplicateOf } : {}) };
  }
}

export function planMemoryImport(db: Database, ctx: MemoryCtx, project: string, raw: string, vectors: ImportVectors = new Map()): ImportPlan {
  const copy = snapshot(db);
  try {
    const plan: ImportPlan = { project, digest: hash(raw), rows: [], issues: [] };
    const seen = new Set<string>();
    raw.split(/\r?\n/).forEach((text, i) => {
      if (!text.trim()) return;
      const key = hash(text);
      if (seen.has(key)) { plan.issues.push({ line: i + 1, kind: "duplicate", reason: "与清单前面的行完全重复" }); return; }
      seen.add(key);
      const r = inspectRow(copy, ctx, project, text, i + 1, vectors);
      if ("kind" in r) {
        const earlier = r.duplicateOf && plan.rows.find((row) => !row.replay && row.memory.id === r.duplicateOf);
        if (earlier) r.reason = `与清单行 ${earlier.line} 重复（内容 / family 与文件 / 语义近邻）`;
        plan.issues.push(r);
      }
      else plan.rows.push(r);
    });
    return plan;
  } finally { copy.close(); }
}

export function applyMemoryImport(db: Database, ctx: MemoryCtx, project: string, raw: string, vectors: ImportVectors = new Map(), authorize?: () => void) {
  const first = planMemoryImport(db, ctx, project, raw, vectors);
  const clean = (p: ImportPlan) => {
    if (p.issues.length) throw new LedgerError("invalid", "清单有问题，整批不写；先跑 --dry-run", { issues: p.issues });
  };
  clean(first);
  if (!first.rows.some((r) => !r.replay)) return { backup: null, imported: [], replayed: first.rows.map((r) => r.memory.id) };
  if (!db.filename || db.filename === ":memory:") throw new LedgerError("invalid", "内存库无法备份，不导入");
  const now = ctx.now ?? Date.now();
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const dest = join(dirname(db.filename), "backups", `${basename(db.filename)}.pre-memory-import-${stamp}-${first.digest.slice(0, 12)}-${randomBytes(4).toString("hex")}.bak`);
  const backup = vacuumBackup(db, dest, "记忆导入前备份失败", "未导入，库保持原样", false);
  return busyAsLedgerError("导入记忆", () => db.transaction(() => {
    // The backup can take time: the CLI must recheck PM membership under the same write lock as the rows.
    authorize?.();
    const plan = planMemoryImport(db, ctx, project, raw, vectors);
    clean(plan);
    const imported: string[] = [], replayed: string[] = [];
    for (const r of plan.rows) {
      if (r.replay) replayed.push(r.memory.id);
      else imported.push(writeRow(db, { ...ctx, now }, r.key, r.input).id);
    }
    return { backup, imported, replayed };
  }).immediate());
}
