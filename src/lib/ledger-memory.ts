/**
 * 项目记忆的写入与读取（设计稿 docs/design/project-memory.md §1）。表在 ledger-memory-schema.ts，状态折叠在 ledger-memory-fold.ts。
 * 每次写（记忆一行 / mark 一行）在同一个 IMMEDIATE 事务里另追加一条 events.kind = 'memory'（data = {memoryId, kind, mark?}），
 * 事件只做时间线与审计、不复制正文。事件直接按 ledger-asks.ts 的写法插（带 origin / originSeq），不走 ledger-tx：记忆不推阶段。
 * 这里只核结构、长度、锚点与脱敏；谁能写哪种记忆 / mark（身份取 verified 会话）、memoryLint 的防噪规则在工具层（M2）。
 *
 * 脱敏分两类：命中密钥 / 令牌 / IP / 个人信息形状的（dispatch-redact 的规则加任何 IP）→ 拒绝写入，哪儿都不落（本机库也会被备份、同步），
 * 所有调用方给的文本字段（含 project、锚点、actor、dedupKey 等元数据）都过这道闸，报错只说字段位置不带原文；
 * 不是密钥但不该出主场的内部内容（本项目 feature 标题、DAG 节点标题、出借 peer 名、调用方给的词）→ 记忆照写、visibility 降为 home
 * （只在本机，不进共享同步），结果里带 homeReason；mark 没有自己的 visibility、随记忆走，所以 team 记忆上 reason 含内部名字的 mark 拒写。
 */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { redactForPeer } from "./dispatch-redact.js";
import { busyAsLedgerError, LedgerError, toEvent } from "./ledger-store.js";
import { ledgerOrigin, ORIGIN_VALUES, originArgs } from "./ledger-origin.js";
import type { LedgerEvent } from "./ledger-stages.js";
import {
  MEMORY_AUTHOR_ROLES, MEMORY_KINDS, MEMORY_MARKS, MEMORY_VIAS, MEMORY_VISIBILITIES,
  type MemoryAuthorRole, type MemoryKind, type MemoryMarkKind, type MemoryVia, type MemoryVisibility,
} from "./ledger-memory-schema.js";
import { memoryStatus, type FoldMark, type MemorySourceRef, type MemoryState } from "./ledger-memory-fold.js";

/** 写入时过的脱敏规则版本；规则改了加一，同步上传前按它判要不要重过（§7） */
const MEMORY_REDACTION_VERSION = 1;
const MEMORY_EVENT_KIND = "memory";

const MEMORY_LIMITS = { title: 80, summary: 600, decision: 600, symptom: 300, rule: 300, sourceNote: 200, reason: 300, files: 20, file: 200 } as const;
const FAMILY_RE = /^[\w.-]{1,64}$/;

type PitfallBody = { symptom: string; rule: string };

export interface Memory {
  id: string;
  origin: string;
  originSeq: number;
  project: string;
  kind: MemoryKind;
  featureId: string | null;
  nodeKey: string | null;
  taskId: string | null;
  files: string[];
  family: string | null;
  title: string;
  /** 坑 = {symptom, rule}；总结 / 决定 = 原文 */
  body: string | PitfallBody;
  fixable: boolean | null;
  sources: MemorySourceRef[];
  sourceNote: string | null;
  via: MemoryVia;
  author: string;
  authorRole: MemoryAuthorRole;
  head: string | null;
  specRev: number | null;
  visibility: MemoryVisibility;
  redactionVersion: number;
  digest: string;
  createdAt: number;
}

export interface MemoryMark extends FoldMark {
  actor: string;
  reason: string | null;
  source: MemorySourceRef | null;
}

export interface MemoryCtx {
  /** 写入者代号（agent 名 / peer:<代号> / scheduler）；身份推导在调用方 */
  actor: string;
  now?: number;
}

export interface MemoryInput {
  project: string;
  kind: MemoryKind;
  title: string;
  /** 总结 / 决定的正文 */
  body?: string;
  /** 坑的两段 */
  symptom?: string;
  rule?: string;
  featureId?: string | null;
  nodeKey?: string | null;
  taskId?: string | null;
  files?: string[];
  family?: string | null;
  /** 坑必填，其它不许给 */
  fixable?: boolean;
  sources?: MemorySourceRef[];
  sourceNote?: string | null;
  via: MemoryVia;
  authorRole: MemoryAuthorRole;
  head?: string | null;
  specRev?: number | null;
  /** 默认 team；内部内容命中时降为 home */
  visibility?: MemoryVisibility;
  /** 决定索引行（via = decision_index）的来源 decision 事件：id = `<origin>-d<originSeq>`，重放 / 多机生成同一行 */
  decisionOf?: { origin: string; originSeq: number };
  /** 调用方额外认定为内部内容的词（如 peers.json 里的 peer 名），命中即 home */
  internalTerms?: readonly string[];
}

export interface MemoryWrite {
  memory: Memory;
  /** 重放命中（同 id 同 digest）时为 null：不再追加事件 */
  event: LedgerEvent | null;
  duplicate: boolean;
  /** 降为 home 的原因（只说命中了哪类，不带原文） */
  homeReason: string | null;
}

export interface MarkInput {
  memoryId: string;
  mark: MemoryMarkKind;
  taskId?: string | null;
  /** supersede 指向的新记忆 id */
  by?: string | null;
  reason?: string | null;
  /** 触发它的事件；带 dedupKey 的自动 mark 必填 */
  source?: MemorySourceRef | null;
  /** 自动 mark 用 `auto:<mark>:<memoryId>:<taskId>:<来源事件>`：多处观察到同一件事只记一条 */
  dedupKey?: string | null;
  /** 调用方额外认定为内部内容的词；team 记忆上 reason 命中即拒 */
  internalTerms?: readonly string[];
}

export interface MarkWrite {
  mark: MemoryMark;
  event: LedgerEvent | null;
  duplicate: boolean;
}

type Row = Record<string, unknown>;

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const invalid = (msg: string): never => {
  throw new LedgerError("invalid", msg);
};

function text(field: string, v: unknown, max: number, required = true): string | null {
  if (v === undefined || v === null || v === "") {
    if (required) invalid(`${field} 必填`);
    return null;
  }
  if (typeof v !== "string") return invalid(`${field} 要是字符串`);
  if (!v.trim()) return invalid(`${field} 不能全是空白`);
  if (bytes(v) > max) invalid(`${field} 超过 ${max} 字节（${bytes(v)}），不截断，请改短`);
  return v;
}

function oneOf<T extends string>(field: string, v: unknown, xs: readonly T[]): T {
  if (!xs.includes(v as T)) invalid(`${field} 只能是 ${xs.join(" / ")}`);
  return v as T;
}

function sourceRef(field: string, v: unknown): MemorySourceRef {
  const o = v as Record<string, unknown> | null;
  const posInt = (n: unknown) => Number.isInteger(n) && (n as number) >= 1;
  if (o && typeof o === "object" && Object.keys(o).length === 2 && typeof o.origin === "string" && /^[0-9a-z]{4}$/.test(o.origin) && posInt(o.originSeq)) {
    return { origin: o.origin, originSeq: o.originSeq as number };
  }
  if (o && typeof o === "object" && Object.keys(o).length === 1 && posInt(o.seq)) return { seq: o.seq as number };
  return invalid(`${field} 要是 {origin, originSeq} 或 {seq}`);
}

/** 仓库相对路径或 glob：不许绝对路径、家目录、`..` 跳出仓库 */
function repoPath(field: string, v: unknown): string {
  const p = text(field, v, MEMORY_LIMITS.file) as string;
  if (/^[~/\\]/.test(p) || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).includes("..") || /\s/.test(p)) invalid(`${field} 要是仓库相对路径或 glob`);
  return p;
}

// ── 脱敏 ──

const H = "[0-9a-f]{1,4}";
/**
 * IPv6 各种压缩位置（全写、头 / 中 / 尾压缩）。前面不能贴着字母数字或「十六进制位 + 冒号」（免得从地址中间起匹配、把 `Vec::new`
 * 这类代码当地址），后面不能贴着字母数字或「冒号 + 十六进制位」（句末冒号照认）；单独的 `::` 不算
 */
const IPV6 = [
  `(?:${H}:){7}${H}`,
  `(?:${H}:){1,7}:`,
  ...[1, 2, 3, 4, 5, 6].map((k) => `(?:${H}:){1,${7 - k}}(?::${H}){1,${k}}`),
  `:(?::${H}){1,7}`,
].join("|");
/** 任何 IP（含公网）：dispatch-redact 只遮内网段，记忆会进共享台账，公网地址也不该落（同 shared-ledger-scrub 的口径） */
const ANY_IP = new RegExp(`\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b|(?<![0-9a-z_]|[0-9a-f]:)(?:${IPV6})(?![0-9a-z_]|:[0-9a-f])`, "i");

/** 命中密钥 / 地址 / 个人信息形状的字段名（只报位置）；空 = 没命中 */
function secretHits(fields: Record<string, unknown>): string[] {
  return Object.entries(fields).filter(([, v]) => typeof v === "string" && !!v && (redactForPeer(v as string).count > 0 || ANY_IP.test(v as string))).map(([k]) => k);
}

/** 本项目的内部名字：feature 标题、各 feature 当前 DAG 版本的节点标题，加本机出借 peer 名（表在才查） */
function internalNames(db: Database, project: string): string[] {
  const names: string[] = [];
  const has = (t: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  if (has("features")) {
    const rows = db
      .query("SELECT f.title, v.nodes FROM features f LEFT JOIN dag_versions v ON v.featureId = f.id AND v.version = f.currentVersion WHERE f.project = ?")
      .all(project) as { title: string; nodes: string | null }[];
    for (const r of rows) {
      names.push(r.title);
      for (const n of (r.nodes ? (JSON.parse(r.nodes) as { oneLine?: unknown }[]) : [])) if (typeof n.oneLine === "string") names.push(n.oneLine);
    }
  }
  if (has("lend_peers")) names.push(...(db.query("SELECT peer FROM lend_peers").all() as { peer: string }[]).map((r) => r.peer));
  return names;
}

/** 不该出主场的内部内容：命中就返回原因（不带原文）；太短的名字（< 3 字符）不比，免得误伤 */
function internalHit(haystack: string, names: readonly string[]): boolean {
  const h = haystack.toLowerCase();
  return names.some((n) => n.trim().length >= 3 && h.includes(n.trim().toLowerCase()));
}

// ── 行映射 ──

const parseArr = <T>(s: unknown): T[] => (typeof s === "string" && s ? (JSON.parse(s) as T[]) : []);

function toMemory(r: Row): Memory {
  const kind = r.kind as MemoryKind;
  return {
    ...(r as unknown as Memory),
    files: parseArr<string>(r.files),
    sources: parseArr<MemorySourceRef>(r.sources),
    body: kind === "pitfall" ? (JSON.parse(String(r.body)) as PitfallBody) : String(r.body),
    fixable: r.fixable === null || r.fixable === undefined ? null : r.fixable === 1,
  };
}

function toMark(r: Row): MemoryMark {
  const { byId, source, ...rest } = r;
  return { ...(rest as unknown as MemoryMark), by: (byId ?? null) as string | null, source: typeof source === "string" ? (JSON.parse(source) as MemorySourceRef) : null };
}

// ── 读 ──

export function getMemory(db: Database, id: string): Memory | null {
  const r = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Row | null;
  return r ? toMemory(r) : null;
}

/** 一条记忆的 marks，按折叠用的全序 */
export function listMarks(db: Database, memoryId: string): MemoryMark[] {
  return (db.prepare("SELECT * FROM memory_marks WHERE memoryId = ? ORDER BY ts, origin, originSeq").all(memoryId) as Row[]).map(toMark);
}

export function memoryState(db: Database, id: string): (MemoryState & { memory: Memory }) | null {
  const memory = getMemory(db, id);
  return memory ? { memory, ...memoryStatus(memory, listMarks(db, id)) } : null;
}

// ── 写 ──

/** sha256 of JSON [title, body, files]：判重 / 同步校验（§7）。用 JSON 数组拼而不是直接相接，免得 "ab"+"c" 与 "a"+"bc" 撞 */
export function memoryDigest(title: string, body: string, files: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([title, body, files])).digest("hex");
}

function insertMemoryEvent(db: Database, ctx: MemoryCtx, project: string, target: string, data: Record<string, unknown>, now: number): LedgerEvent {
  const r = db
    .prepare(`INSERT INTO events (ts, actor, project, target, kind, text, data, origin, originSeq) VALUES (?, ?, ?, ?, ?, '', ?, ${ORIGIN_VALUES}) RETURNING *`)
    .get(now, ctx.actor, project, target, MEMORY_EVENT_KIND, JSON.stringify(data), ...originArgs(db));
  return toEvent(r as Row);
}

function requireOrigin(db: Database): string {
  const o = ledgerOrigin(db);
  if (!o) throw new LedgerError("invalid", "取不到本机前缀（instance-id），记忆要带全局 id，先修好 instance-id 再写");
  return o;
}

/** 锚点：taskId 有值时 featureId 取卡当时的 featureId（给了不一致就拒）；featureId 要在本项目；nodeKey 要有 featureId */
function anchors(db: Database, input: MemoryInput): { featureId: string | null; nodeKey: string | null; taskId: string | null } {
  const taskId = text("taskId", input.taskId, 200, false);
  let featureId = text("featureId", input.featureId, 200, false);
  const nodeKey = text("nodeKey", input.nodeKey, 64, false);
  if (taskId) {
    const t = db.prepare("SELECT project, featureId FROM tasks WHERE id = ?").get(taskId) as { project: string; featureId: string | null } | null;
    if (!t || t.project !== input.project) throw new LedgerError("not_found", `项目 ${input.project} 里没有卡 ${taskId}`);
    if (featureId && featureId !== t.featureId) invalid(`featureId 与卡 ${taskId} 当前的 feature 不一致`);
    featureId = t.featureId ?? null;
  } else if (featureId) {
    const f = db.prepare("SELECT project FROM features WHERE id = ?").get(featureId) as { project: string } | null;
    if (!f || f.project !== input.project) throw new LedgerError("not_found", `项目 ${input.project} 里没有 feature ${featureId}`);
  }
  if (nodeKey && !featureId) invalid("nodeKey 要和 featureId 一起给");
  return { featureId, nodeKey, taskId };
}

function memoryBody(input: MemoryInput): string {
  if (input.kind === "pitfall") {
    if (input.body !== undefined) invalid("坑的正文分 symptom / rule 两段给，不收 body");
    const symptom = text("symptom", input.symptom, MEMORY_LIMITS.symptom) as string;
    const rule = text("rule", input.rule, MEMORY_LIMITS.rule) as string;
    return JSON.stringify({ symptom, rule });
  }
  if (input.symptom !== undefined || input.rule !== undefined) invalid("symptom / rule 只给坑用");
  return text("body", input.body, input.kind === "summary" ? MEMORY_LIMITS.summary : MEMORY_LIMITS.decision) as string;
}

/**
 * 写一条记忆 + 一条 memory 事件。id = `<本机前缀>-m<本机序号>`；决定索引行 id 由来源事件定，同 id 同 digest 幂等（duplicate），
 * 同 id 不同 digest 报 dedup_mismatch（同步时的「同键不同 digest 隔离」本机也一样）。
 */
export function recordMemory(db: Database, ctx: MemoryCtx, input: MemoryInput): MemoryWrite {
  const project = text("project", input.project, 200) as string;
  const kind = oneOf("kind", input.kind, MEMORY_KINDS);
  const via = oneOf("via", input.via, MEMORY_VIAS);
  const authorRole = oneOf("authorRole", input.authorRole, MEMORY_AUTHOR_ROLES);
  const title = text("title", input.title, MEMORY_LIMITS.title) as string;
  const body = memoryBody(input);
  const files = input.files ?? [];
  if (!Array.isArray(files) || files.length > MEMORY_LIMITS.files) invalid(`files 要是数组、最多 ${MEMORY_LIMITS.files} 项`);
  files.forEach((f, i) => repoPath(`files[${i}]`, f));
  if (new Set(files).size !== files.length) invalid("files 有重复项");
  const family = text("family", input.family, 64, false);
  if (family && !FAMILY_RE.test(family)) invalid("family 只能是 [\\w.-]{1,64}");
  if ((kind === "pitfall") !== (input.fixable !== undefined)) invalid(kind === "pitfall" ? "坑要给 fixable（能被某张卡修掉 = true，规矩 / 环境特性 = false）" : "fixable 只给坑用");
  if (input.fixable !== undefined && typeof input.fixable !== "boolean") invalid("fixable 要是布尔");
  if (!Array.isArray(input.sources ?? [])) invalid("sources 要是数组");
  const sources = (input.sources ?? []).map((s, i) => sourceRef(`sources[${i}]`, s));
  const sourceNote = text("sourceNote", input.sourceNote, MEMORY_LIMITS.sourceNote, false);
  if (via === "import" && !sources.length && !sourceNote) invalid("导入的记忆没有来源事件时要写 sourceNote（出处）");
  const head = text("head", input.head, 64, false);
  const specRev = input.specRev ?? null;
  if (specRev !== null && (!Number.isInteger(specRev) || specRev < 1)) invalid("specRev 要是正整数");
  if (input.taskId && (kind === "summary" || kind === "pitfall") && (!head || specRev === null)) invalid("锚在卡上的总结 / 坑要给 head 与 specRev（截至哪版代码）");
  if (kind === "summary" && !input.taskId) invalid("总结要锚在卡上（taskId）");
  if ((via === "decision_index") !== (input.decisionOf !== undefined)) invalid("decisionOf 与 via = decision_index 要一起给");
  if (via === "decision_index" && kind !== "decision") invalid("decision_index 只写决定");
  const decisionOf = input.decisionOf ? (sourceRef("decisionOf", input.decisionOf) as { origin: string; originSeq: number }) : null;
  if (input.decisionOf && !decisionOf?.origin) invalid("decisionOf 要是 {origin, originSeq}");
  let visibility = oneOf("visibility", input.visibility ?? "team", MEMORY_VISIBILITIES);

  const secret = secretHits({
    actor: ctx.actor, project, title, body, family, sourceNote, head, featureId: input.featureId, nodeKey: input.nodeKey, taskId: input.taskId,
    ...Object.fromEntries(files.map((f, i) => [`files[${i}]`, f])),
  });
  if (secret.length) invalid(`脱敏闸命中（密钥 / 地址 / 个人信息形状），拒绝写入：${secret.join(", ")}`);
  const digest = memoryDigest(title, body, files);

  return busyAsLedgerError("写记忆", () =>
    db.transaction((): MemoryWrite => {
      const anchor = anchors(db, input);
      let homeReason: string | null = null;
      if (visibility === "team" && internalHit([title, body, sourceNote ?? "", ...files].join("\n"), [...internalNames(db, project), ...(input.internalTerms ?? [])])) {
        visibility = "home";
        homeReason = "含本项目内部名字（feature / 节点标题、peer 名等），只留在本机";
      }
      let origin: string;
      let originSeq: number;
      let id: string;
      if (decisionOf) {
        ({ origin, originSeq } = decisionOf);
        id = `${origin}-d${originSeq}`;
        const prev = getMemory(db, id);
        if (prev) {
          if (prev.digest !== digest) throw new LedgerError("dedup_mismatch", `记忆 ${id} 已在且内容不同（digest 对不上）`, { id, digest: prev.digest });
          return { memory: prev, event: null, duplicate: true, homeReason: null };
        }
      } else {
        origin = requireOrigin(db);
        originSeq = (db.prepare("SELECT COALESCE(MAX(originSeq), 0) + 1 AS n FROM memories WHERE origin = ? AND via <> 'decision_index'").get(origin) as { n: number }).n;
        id = `${origin}-m${originSeq}`;
      }
      const now = ctx.now ?? Date.now();
      db.prepare(
        `INSERT INTO memories (id, origin, originSeq, project, kind, featureId, nodeKey, taskId, files, family, title, body, fixable, sources, sourceNote,
          via, author, authorRole, head, specRev, visibility, redactionVersion, digest, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, origin, originSeq, project, kind, anchor.featureId, anchor.nodeKey, anchor.taskId, JSON.stringify(files), family, title, body,
        input.fixable === undefined ? null : input.fixable ? 1 : 0, JSON.stringify(sources), sourceNote, via, ctx.actor, authorRole, head, specRev,
        visibility, MEMORY_REDACTION_VERSION, digest, now);
      const event = insertMemoryEvent(db, ctx, project, anchor.taskId ?? anchor.featureId ?? "", { memoryId: id, kind }, now);
      return { memory: getMemory(db, id) as Memory, event, duplicate: false, homeReason };
    }).immediate(),
  );
}

/**
 * 给记忆追加一条 mark + 一条 memory 事件。只核结构与「这种 mark 对这条记忆有没有意义」（修复类只给 fixable 坑、supersede 指向别的已有记忆）；
 * 状态对不上（如 open 上打 fixed）照记不拒，由折叠决定生效与否——同步来的 mark 到达顺序不定，写入时按本机状态拒会让两端分叉。
 * dedupKey 命中：同一记忆同一 mark 同一卡 → duplicate；否则 dedup_mismatch。
 */
export function markMemory(db: Database, ctx: MemoryCtx, input: MarkInput): MarkWrite {
  const memoryId = text("memoryId", input.memoryId, 200) as string;
  const mark = oneOf("mark", input.mark, MEMORY_MARKS);
  const taskId = text("taskId", input.taskId, 200, false);
  const by = text("by", input.by, 200, false);
  const reason = text("reason", input.reason, MEMORY_LIMITS.reason, mark === "dispute" || mark === "retract");
  const source = input.source ? sourceRef("source", input.source) : null;
  const dedupKey = text("dedupKey", input.dedupKey, 300, false);
  if (dedupKey && !source) invalid("带 dedupKey 的自动 mark 要给 source（触发它的事件）");
  if ((mark === "link_fix" || mark === "fixed" || mark === "reopen") && !taskId) invalid(`${mark} 要给 taskId（修它的卡）`);
  if ((mark === "supersede") !== !!by) invalid("by 只给 supersede、supersede 必须给 by");
  if (by === memoryId) invalid("不能 supersede 成自己");
  const secret = secretHits({ actor: ctx.actor, memoryId, taskId, by, reason, dedupKey });
  if (secret.length) invalid(`脱敏闸命中（密钥 / 地址 / 个人信息形状），拒绝写入：${secret.join(", ")}`);

  return busyAsLedgerError("写记忆标记", () =>
    db.transaction((): MarkWrite => {
      if (dedupKey) {
        const prev = db.prepare("SELECT * FROM memory_marks WHERE dedupKey = ?").get(dedupKey) as Row | null;
        if (prev) {
          const p = toMark(prev);
          if (p.memoryId !== memoryId || p.mark !== mark || p.taskId !== taskId) throw new LedgerError("dedup_mismatch", `dedupKey ${dedupKey} 已用于记忆 ${p.memoryId} 的 ${p.mark}`);
          return { mark: p, event: null, duplicate: true };
        }
      }
      const memory = getMemory(db, memoryId);
      if (!memory) throw new LedgerError("not_found", `没有记忆 ${memoryId}`);
      const fixMark = mark === "link_fix" || mark === "unlink_fix" || mark === "fixed" || mark === "reopen";
      if (fixMark && !(memory.kind === "pitfall" && memory.fixable)) invalid(`${mark} 只对 fixable 的坑有意义，${memoryId} 不是`);
      if (by && !getMemory(db, by)) throw new LedgerError("not_found", `没有记忆 ${by}（supersede 要指向已写入的新记忆）`);
      if (taskId && !db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(taskId)) throw new LedgerError("not_found", `没有卡 ${taskId}`);
      if (reason && memory.visibility === "team" && internalHit(reason, [...internalNames(db, memory.project), ...(input.internalTerms ?? [])])) {
        invalid("reason 含本项目内部名字（feature / 节点标题、peer 名等），mark 随 team 记忆共享，拒绝写入：去掉后重写");
      }
      const origin = requireOrigin(db);
      const originSeq = (db.prepare("SELECT COALESCE(MAX(originSeq), 0) + 1 AS n FROM memory_marks WHERE origin = ?").get(origin) as { n: number }).n;
      const now = ctx.now ?? Date.now();
      db.prepare("INSERT INTO memory_marks (origin, originSeq, memoryId, ts, actor, mark, taskId, byId, reason, source, dedupKey) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(origin, originSeq, memoryId, now, ctx.actor, mark, taskId, by, reason, source ? JSON.stringify(source) : null, dedupKey);
      const event = insertMemoryEvent(db, ctx, memory.project, memory.taskId ?? memory.featureId ?? "", { memoryId, kind: memory.kind, mark }, now);
      const row = db.prepare("SELECT * FROM memory_marks WHERE origin = ? AND originSeq = ?").get(origin, originSeq) as Row;
      return { mark: toMark(row), event, duplicate: false };
    }).immediate(),
  );
}
