/**
 * 投影：拿我们的 schema（zod 转出的 JSON Schema）逐条路径去 codex 的 JSON Schema 里找对应节点，记下对方在这条路径上的形状。
 * 只看我们读 / 发的路径，所以 codex 改了我们不碰的地方，投影不变。纯函数，lock.ts 生成锁、drift.ts 分级、测试离线对照都用它。
 * 路径写法：`turn.id`、数组元素 `input[]`、判别分支 `sandboxPolicy<type=readOnly>`；根是空串。
 */

type Json = any;
export type Defs = Record<string, Json>;

/** 我们这一侧在这条路径上的约定：in 方向是「我们收什么」，out 方向是「我们会发什么」 */
export interface OursDesc {
  required: boolean;
  nullable: boolean;
  types: string[];
  values?: string[];
  /** 判别分支里的判别字段：值由分支决定，不算我们声明的枚举 */
  disc?: true;
}

/** 投影里的一个节点：codex 一侧的形状 + 我们一侧的约定 */
export interface PNode {
  missing?: true;
  ref?: string;
  types?: string[];
  nullable?: boolean;
  required?: boolean;
  /** 字符串字面量的全集（枚举、const、外部标签式联合的标签） */
  values?: string[];
  /** 对象的全部键 → 是否必有（判别联合不记，记 members） */
  keys?: Record<string, boolean>;
  discriminator?: string;
  members?: string[];
  /** 登记为封闭的枚举 / 联合（USED.closed） */
  closed?: true;
  ours: OursDesc;
}
export type Projection = Record<string, Record<string, PNode>>;

type Seg = { prop: string } | { items: true } | { key: string; value: string };
interface View {
  node: Json;
  ref?: string;
  nullable: boolean;
}
interface ObjView {
  props: Record<string, Json>;
  required: Set<string>;
  disc?: { key: string; values: string[] };
}

/** 键按字典序排好的深拷贝：锁文件的哈希和 diff 都基于它，生成两次必须逐字节相同 */
export function sortKeys(v: Json): Json {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
}
export const canon = (v: Json) => JSON.stringify(sortKeys(v));

const uniq = (xs: string[]) => [...new Set(xs)].sort();
const isNull = (a: Json) => a && typeof a === "object" && a.type === "null";
const refName = (ref: string) => ref.replace(/^#\/definitions\//, "");

/** 顺着 $ref / 单元素 allOf / anyOf[X,null] / type:[t,"null"] 走到实体节点，记下最后一个 ref 和可空 */
function resolve(defs: Defs, start: Json): View {
  let node = start;
  let ref: string | undefined;
  let nullable = false;
  for (let hops = 0; hops < 64; hops++) {
    if (node === true || node === undefined || node === null) return { node: {}, ref, nullable };
    if (typeof node.$ref === "string") {
      ref = refName(node.$ref);
      node = defs[ref];
      if (node === undefined) throw new Error(`schema 里找不到定义 ${ref}`);
    } else if (Array.isArray(node.allOf) && node.allOf.length === 1 && !node.properties && !node.oneOf) node = node.allOf[0];
    else if (Array.isArray(node.anyOf) && node.anyOf.some(isNull)) {
      nullable = true;
      const rest = node.anyOf.filter((a: Json) => !isNull(a));
      node = rest.length === 1 ? rest[0] : { ...node, anyOf: rest };
    } else if (Array.isArray(node.type) && node.type.includes("null")) {
      nullable = true;
      const t = node.type.filter((x: string) => x !== "null");
      node = { ...node, type: t.length === 1 ? t[0] : t };
    } else return { node, ref, nullable: nullable || node.type === "null" };
  }
  throw new Error("$ref 链过长");
}

const alts = (n: Json): Json[] | null => (Array.isArray(n.oneOf) ? n.oneOf : Array.isArray(n.anyOf) ? n.anyOf : null);
const isAny = (n: Json) => !n.type && !n.enum && n.const === undefined && !n.properties && !alts(n) && !n.not && !n.$ref;
const literalType = (v: unknown) => (typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v);

function typesOf(defs: Defs, n: Json): string[] {
  if (n.not) return [];
  if (typeof n.type === "string") return n.type === "null" ? [] : [n.type];
  if (Array.isArray(n.type)) return uniq(n.type.filter((t: string) => t !== "null"));
  const as = alts(n);
  if (as) return uniq(as.flatMap((a) => typesOf(defs, resolve(defs, a).node)));
  if (Array.isArray(n.enum)) return uniq(n.enum.map(literalType));
  if (n.const !== undefined) return [literalType(n.const)];
  return n.properties ? ["object"] : ["any"];
}

/** 外部标签式成员 `{ "granular": {...} }`：只有一个必有键、不收别的键、键下面是对象 */
function tagOf(defs: Defs, m: Json): string | undefined {
  const keys = Object.keys(m.properties ?? {});
  if (m.additionalProperties !== false || keys.length !== 1 || m.required?.[0] !== keys[0]) return undefined;
  return typesOf(defs, resolve(defs, m.properties[keys[0]!]).node).includes("object") ? keys[0] : undefined;
}

/** 字面量全集；有成员既不是字面量也不是标签（比如按 type 判别的对象）就不算枚举 */
function valuesOf(defs: Defs, n: Json): string[] | undefined {
  if (Array.isArray(n.enum)) return uniq(n.enum.map(String));
  if (n.const !== undefined) return [String(n.const)];
  const as = alts(n);
  if (!as) return undefined;
  const out: string[] = [];
  for (const a of as) {
    const m = resolve(defs, a).node;
    const v = valuesOf(defs, m) ?? (tagOf(defs, m) ? [tagOf(defs, m)!] : undefined);
    if (!v) return undefined;
    out.push(...v);
  }
  return uniq(out);
}

/** 成员都是对象的联合：每个成员都有、且各自只有一个字面量值的键就是判别字段 */
function discOf(defs: Defs, members: Json[]): ObjView["disc"] {
  const first = members[0]?.properties ?? {};
  for (const key of Object.keys(first)) {
    const vals = members.map((m) => (m.properties?.[key] === undefined ? undefined : valuesOf(defs, resolve(defs, m.properties[key]).node)));
    if (vals.every((v) => v?.length === 1)) return { key, values: uniq(vals.map((v) => v![0]!)) };
  }
  return undefined;
}

/** 对象视图：自身的 properties，加上「成员全是对象」的联合合并后的键（只在所有成员都必有时算必有） */
function objectView(defs: Defs, n: Json): ObjView | null {
  const as = alts(n);
  const members = as ? as.map((a) => resolve(defs, a).node) : [];
  const allObjects = members.length > 0 && members.every((m) => m.properties);
  if (!n.properties && !allObjects) return null;
  const props: Record<string, Json> = {};
  const required = new Set<string>(n.required ?? []);
  if (allObjects) {
    for (const m of members) for (const [k, v] of Object.entries(m.properties)) props[k] = props[k] === undefined || JSON.stringify(props[k]) === JSON.stringify(v) ? v : { anyOf: [props[k], v] };
    for (const k of Object.keys(props)) if (members.every((m) => (m.required ?? []).includes(k))) required.add(k);
  }
  Object.assign(props, n.properties ?? {});
  return { props, required, disc: allObjects ? discOf(defs, members) : undefined };
}

/** 按路径在 codex 的 schema 里往下走；走不通（字段没了、分支没了、不是数组）返回 null */
function navigate(defs: Defs, root: string, segs: Seg[]): { view: View; required: boolean } | null {
  let view = resolve(defs, { $ref: `#/definitions/${root}` });
  let required = true;
  for (const s of segs) {
    if ("prop" in s) {
      const ov = objectView(defs, view.node);
      if (!ov || ov.props[s.prop] === undefined) return null;
      required = ov.required.has(s.prop);
      view = resolve(defs, ov.props[s.prop]);
    } else if ("items" in s) {
      if (!view.node.items || typeof view.node.items !== "object") return null;
      view = resolve(defs, view.node.items);
      required = true;
    } else {
      const hit = (alts(view.node) ?? []).map((a) => resolve(defs, a)).find((m) => {
        const d = objectView(defs, m.node)?.props[s.key];
        return d !== undefined && valuesOf(defs, resolve(defs, d).node)?.join() === s.value;
      });
      if (!hit) return null;
      view = { ...hit, nullable: false };
      required = true;
    }
  }
  return { view, required };
}

const render = (segs: Seg[]) =>
  segs.map((s, i) => ("prop" in s ? (i ? `.${s.prop}` : s.prop) : "items" in s ? "[]" : `<${s.key}=${s.value}>`)).join("");

/** 我们的 schema 里有哪些路径，以及每条路径上我们的约定（只看我们自己的结构，不看 codex） */
export function oursPaths(schema: Json): { segs: Seg[]; path: string; ours: OursDesc }[] {
  const out: { segs: Seg[]; path: string; ours: OursDesc }[] = [];
  const visit = (raw: Json, segs: Seg[], required: boolean, disc: boolean) => {
    const { node, nullable } = resolve({}, raw);
    const members = alts(node);
    const key = members && members.every((m) => m.properties) ? discOf({}, members)?.key : undefined;
    const values = key ? uniq(members!.map((m) => String(m.properties[key].const))) : valuesOf({}, node);
    const ours: OursDesc = { required, nullable: nullable || isAny(node), types: typesOf({}, node), ...(values ? { values } : {}), ...(disc ? { disc: true } : {}) };
    out.push({ segs, path: render(segs), ours });
    if (key) {
      for (const m of members!) visit(m, [...segs, { key, value: String(m.properties[key].const) }], true, false);
      return;
    }
    const parentDisc = segs.at(-1);
    for (const [k, c] of Object.entries(node.properties ?? {})) {
      visit(c, [...segs, { prop: k }], (node.required ?? []).includes(k), parentDisc !== undefined && "key" in parentDisc && parentDisc.key === k);
    }
    if (node.type === "array" && node.items && typeof node.items === "object" && node.maxItems !== 0) visit(node.items, [...segs, { items: true }], true, false);
  };
  visit(schema, [], true, false);
  return out;
}

/** 一个根定义的投影。closed：登记为封闭的定义名 */
export function project(defs: Defs, root: string, oursSchema: Json, closed: ReadonlySet<string>): Record<string, PNode> {
  const out: Record<string, PNode> = {};
  for (const p of oursPaths(oursSchema)) {
    const hit = navigate(defs, root, p.segs);
    if (!hit) {
      out[p.path] = { missing: true, ours: p.ours };
      continue;
    }
    const { view, required } = hit;
    const n: PNode = { types: typesOf(defs, view.node), nullable: view.nullable, required, ours: p.ours };
    if (view.ref) n.ref = view.ref;
    if (view.ref && closed.has(view.ref)) n.closed = true;
    const values = valuesOf(defs, view.node);
    if (values) n.values = values;
    const ov = objectView(defs, view.node);
    if (ov?.disc) Object.assign(n, { discriminator: ov.disc.key, members: ov.disc.values });
    else if (ov) n.keys = Object.fromEntries(Object.keys(ov.props).sort().map((k) => [k, ov.required.has(k)]));
    out[p.path] = n;
  }
  return out;
}

const accepts = (acceptor: string[], given: string[]) => acceptor.includes("any") || given.every((t) => acceptor.includes(t) || (t === "integer" && acceptor.includes("number")));
const childPath = (path: string, k: string) => (path ? `${path}.${k}` : k);

function inboundProblems(n: PNode): string[] {
  const o = n.ours;
  const theirs = n.members ?? n.values;
  const out: string[] = [];
  if (o.required && !n.required) out.push("我们按必有读，schema 里可以缺");
  if (n.nullable && !o.nullable) out.push("schema 允许 null，我们不收");
  if (!accepts(o.types, n.types ?? [])) out.push(`类型 ${n.types} 我们收不了（我们收 ${o.types}）`);
  if (n.closed && o.values?.join() !== theirs?.join()) out.push(`封闭枚举不一致：schema ${theirs}，我们 ${o.values}`);
  // 判别联合没登记成封闭的就是开放联合：我们只列认识的成员，其余成员归 O 类
  if (!n.closed && o.values && !o.disc && !n.members) out.push("我们按封闭枚举读，但它没有登记在 USED.closed 里");
  return out;
}

function outboundProblems(n: PNode, path: string, nodes: Record<string, PNode>): string[] {
  const o = n.ours;
  const theirs = n.members ?? n.values;
  const out: string[] = [];
  for (const [k, req] of Object.entries(n.keys ?? {})) if (req && !nodes[childPath(path, k)]?.ours.required) out.push(`schema 要求 ${k}，我们不保证发`);
  if (o.nullable && !n.nullable && !n.types?.includes("any")) out.push("我们可能发 null，schema 不收");
  if (!accepts(n.types ?? [], o.types)) out.push(`我们发的类型 ${o.types} schema 不收（收 ${n.types}）`);
  const extra = theirs ? (o.values ?? []).filter((v) => !theirs.includes(v)) : [];
  if (extra.length) out.push(`我们会发的值 ${extra} schema 不认`);
  return out;
}

/** 投影是否自洽：in = 我们能收下 codex 会发的一切；out = codex 能收下我们会发的一切。返回问题列表，空 = 兼容 */
export function compat(proj: Projection, dir: "in" | "out"): string[] {
  const out: string[] = [];
  for (const [def, nodes] of Object.entries(proj)) {
    for (const [path, n] of Object.entries(nodes)) {
      const at = `${def} ${path || "(根)"}`;
      if (n.missing) out.push(`${at}：schema 里没有这个${dir === "in" ? "我们读" : "我们发"}的字段或分支`);
      else for (const why of dir === "in" ? inboundProblems(n) : outboundProblems(n, path, nodes)) out.push(`${at}：${why}`);
    }
  }
  return out;
}
