/**
 * 漂移分级（纯函数）：旧锁（已提交）对新锁（新 CLI 生成）→ 红 / 黄 / 候选。
 * 红：新锁本身不兼容（project.ts 的 compat、method 表），或我们读的字段类型变了 / 没了、封闭枚举增减，
 *     或出站构造的对象里新增必填、可选变必填、我们发的分支没了。必须先改适配器。
 * 黄：其余投影差异（新增可选字段、开放联合新成员、只改描述）和出站闭包里我们不构造的部分变化。要过真实组合验证。
 * 候选：投影、闭包、method 表都没变，只有全量指纹变了。tests/codex-adapter-schema.test.ts 用合成变异锁住这些判定。
 */
import { canon, compat, type Defs, type PNode, type Projection } from "./project.ts";

interface MethodRow {
  /** 我们登记的定义名（USED） */
  params: string;
  /** schema 里这个 method 实际挂的 params 定义；method 不存在为 null */
  schemaParams: string | null;
  result?: string;
  resultExists?: boolean;
}
export interface Methods {
  client: Record<string, MethodRow>;
  server: Record<string, MethodRow>;
  notifications: Record<string, MethodRow>;
  /** 我们发的通知 → schema 里还有没有 */
  clientNotifications: Record<string, boolean>;
  allNotifications: string[];
  allServerRequests: string[];
}
interface LockMeta {
  cliVersion: string;
  schemaFullSha256: string;
  [k: string]: unknown;
}
export interface LockSet {
  lock: LockMeta;
  inbound: Projection;
  outbound: { roots: Record<string, string>; defs: Defs; sends: Projection };
  methods: Methods;
}

export type Level = "none" | "candidate" | "yellow" | "red";
export interface Finding {
  level: Exclude<Level, "none">;
  where: string;
  why: string;
}
const RANK: Record<Level, number> = { none: 0, candidate: 1, yellow: 2, red: 3 };
type Push = (level: Finding["level"], where: string, why: string) => void;

/** method 表自洽：我们用的 method 都在、params 挂的定义没换、result 定义存在 */
export function methodProblems(m: Methods): string[] {
  const out: string[] = [];
  for (const [group, rows] of [["client", m.client], ["server", m.server], ["notification", m.notifications]] as const) {
    for (const [name, r] of Object.entries(rows)) {
      if (r.schemaParams === null) out.push(`${group} ${name}：schema 里没有这个 method`);
      else if (r.schemaParams !== r.params) out.push(`${group} ${name}：params 定义从 ${r.params} 换成了 ${r.schemaParams}`);
      if (r.resultExists === false) out.push(`${group} ${name}：result 定义 ${r.result} 不存在`);
    }
  }
  for (const [name, ok] of Object.entries(m.clientNotifications)) if (!ok) out.push(`client notification ${name}：schema 里没有了`);
  return out;
}

const FIELDS = ["types", "nullable", "required", "values", "limits", "keys", "members", "discriminator", "ref", "closed"] as const;
const same = (a: unknown, b: unknown) => canon(a ?? null) === canon(b ?? null);
const changed = (x: PNode, y: PNode) => FIELDS.filter((k) => !same(x[k], y[k]));

function inboundNode(x: PNode, y: PNode, where: string, push: Push): void {
  const diff = changed(x, y);
  if (diff.includes("types")) push("red", where, `类型变了：${x.types} → ${y.types}`);
  if ((x.closed || y.closed) && !same(x.members ?? x.values, y.members ?? y.values)) push("red", where, `封闭枚举变了：${x.members ?? x.values} → ${y.members ?? y.values}`);
  const rest = diff.filter((k) => k !== "types");
  if (rest.length) push("yellow", where, `变化：${rest.join("、")}`);
}

function outboundNode(x: PNode, y: PNode, where: string, push: Push): void {
  const diff = changed(x, y);
  if (diff.includes("types")) push("red", where, `类型变了：${x.types} → ${y.types}`);
  for (const [k, req] of Object.entries(y.keys ?? {})) {
    const was = x.keys?.[k];
    if (req && was === undefined) push("red", where, `新增必填字段 ${k}`);
    else if (req && was === false) push("red", where, `${k} 从可选变成必填`);
    else if (!req && was === undefined) push("yellow", where, `新增可选字段 ${k}`);
  }
  const rest = diff.filter((k) => k !== "types" && k !== "keys");
  const removed = Object.keys(x.keys ?? {}).filter((k) => y.keys?.[k] === undefined);
  if (rest.length || removed.length) push("yellow", where, `变化：${[...rest, ...removed.map((k) => `删了 ${k}`)].join("、")}`);
}

function diffProjection(a: Projection, b: Projection, label: string, push: Push, node: typeof inboundNode): void {
  for (const def of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const pa = a[def] ?? {};
    const pb = b[def] ?? {};
    for (const path of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
      const where = `${label} ${def} ${path || "(根)"}`;
      const x = pa[path];
      const y = pb[path];
      if (!x || x.missing) push("yellow", where, "投影里多了这条路径（我们的 schema 变了）");
      else if (!y || y.missing) push("red", where, "我们用到的字段或分支没了");
      else node(x, y, where, push);
    }
  }
}

/** 去掉注释性的 description / title（只去字符串值，属性名叫 description 的保留） */
function stripDocs(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripDocs);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v).filter(([k, x]) => !((k === "description" || k === "title") && typeof x === "string")).map(([k, x]) => [k, stripDocs(x)]));
}

function diffClosure(a: Defs, b: Defs, push: Push): void {
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (same(a[name], b[name])) continue;
    const why = !a[name] ? "闭包里新增了这个定义" : !b[name] ? "闭包里删掉了这个定义" : same(stripDocs(a[name]), stripDocs(b[name])) ? "只改了描述文字" : "定义变了";
    push("yellow", `出站闭包 ${name}`, why);
  }
}

function diffList(a: string[], b: string[], where: string, push: Push): void {
  const added = b.filter((x) => !a.includes(x));
  const removed = a.filter((x) => !b.includes(x));
  if (added.length) push("yellow", where, `新增：${added.join("、")}`);
  if (removed.length) push("yellow", where, `删除：${removed.join("、")}`);
}

export function classify(old: LockSet, next: LockSet): { level: Level; findings: Finding[] } {
  const findings: Finding[] = [];
  const push: Push = (level, where, why) => void findings.push({ level, where, why });
  for (const p of compat(next.inbound, "in")) push("red", "入站兼容", p);
  for (const p of compat(next.outbound.sends, "out")) push("red", "出站兼容", p);
  for (const p of methodProblems(next.methods)) push("red", "method 表", p);
  diffProjection(old.inbound, next.inbound, "入站", push, inboundNode);
  diffProjection(old.outbound.sends, next.outbound.sends, "出站", push, outboundNode);
  diffClosure(old.outbound.defs, next.outbound.defs, push);
  diffList(old.methods.allNotifications, next.methods.allNotifications, "通知 method（开放联合）", push);
  diffList(old.methods.allServerRequests, next.methods.allServerRequests, "反向请求 method（没登记的回 -32601）", push);
  if (!findings.length && old.lock.schemaFullSha256 !== next.lock.schemaFullSha256) push("candidate", "全量指纹", "投影、出站闭包、method 表都没变");
  const level = findings.reduce<Level>((l, f) => (RANK[f.level] > RANK[l] ? f.level : l), "none");
  return { level, findings };
}
