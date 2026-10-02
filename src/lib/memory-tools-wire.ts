/**
 * 项目记忆在派单 wire 上的两个可选字段（设计稿 docs/design/project-memory.md §2.2、§3.4；PM 定 wire-ownership）：
 * - DeliverWire.memoryRefs：[{id, use: applied | irrelevant | wrong, note?}]，wrong 必须带 note（交付后自动转成 dispute mark）；
 * - VerdictWire.findings[].pitfall：true = 这条 P1 不只是这张卡的错、是会再犯的坑（M3 据此生成 open 坑）。
 * 解析和 order-wire.ts 一样严格：不认识的键、类型不对、超长一律拒，不丢不截。两个字段都可选——旧版对端不发，收到缺字段照常接受；
 * 发给不认这两个字段的旧版对端前用 withoutMemoryFields 去掉（旧解析器见到不认识的字段整单拒）；出借结论发往 A 一律经 lendVerdictForPeer。
 * pitfall:false 与缺省同义，解析后不保留，免得一份不带坑标的结论在旧对端那里被拒。order-wire.ts 只接线，逻辑都在这里；
 * 本文件不依赖台账，order-wire 引它不会把库拉进 wire 层。tests/memory-tools-wire.test.ts。
 */

export const MEMORY_REF_USES = ["applied", "irrelevant", "wrong"] as const;
type MemoryRefUse = (typeof MEMORY_REF_USES)[number];
export interface MemoryRef { id: string; use: MemoryRefUse; note?: string }

/** 记忆 id：`<4 位本机前缀>-m<序号>`，决定索引行 `-d<序号>` */
export const MEMORY_ID = /^[0-9a-z]{4}-[md][1-9]\d{0,9}$/;
const REFS_MAX = 20;
const NOTE_MAX = 300;
const BAD_LINE = /[\p{Cc}\u2028\u2029]/u;

type Fail = (path: string, why: string) => never;
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** 交给原来的严格解析之前先摘掉 memoryRefs（它单独解析） */
export function deliverWithoutMemoryRefs(raw: unknown): unknown {
  if (!obj(raw)) return raw;
  const { memoryRefs: _m, ...rest } = raw;
  return rest;
}

export function parseMemoryRefs(v: unknown, fail: Fail): MemoryRef[] {
  if (!Array.isArray(v) || v.length > REFS_MAX) return fail("memoryRefs", `要是不超过 ${REFS_MAX} 项的数组`);
  const seen = new Set<string>();
  return v.map((r, i) => {
    const p = `memoryRefs[${i}]`;
    if (!obj(r)) return fail(p, "要是对象");
    const extra = Object.keys(r).filter((k) => !["id", "use", "note"].includes(k));
    if (extra.length) fail(p, `不认识的字段 ${extra.slice(0, 3).join(", ")}`);
    if (typeof r.id !== "string" || !MEMORY_ID.test(r.id)) fail(`${p}.id`, "格式不对（记忆 id 如 ab12-m6）");
    if (seen.has(r.id as string)) fail(`${p}.id`, "重复");
    seen.add(r.id as string);
    if (!MEMORY_REF_USES.includes(r.use as MemoryRefUse)) fail(`${p}.use`, `只认 ${MEMORY_REF_USES.join(" / ")}`);
    if ("note" in r && (typeof r.note !== "string" || !r.note.trim() || Buffer.byteLength(r.note) > NOTE_MAX || BAD_LINE.test(r.note))) {
      fail(`${p}.note`, `要是非空、不超过 ${NOTE_MAX} 字节的单行文字`);
    }
    if (r.use === "wrong" && !("note" in r)) fail(`${p}.note`, "标 wrong 要写 note（哪里不对），会转成争议给 PM");
    return { id: r.id as string, use: r.use as MemoryRefUse, ...("note" in r ? { note: r.note as string } : {}) };
  });
}

/** 没给 = {}（旧对端）；给了就严格解析 */
export function deliverMemoryRefFields(raw: unknown, fail: Fail): { memoryRefs?: MemoryRef[] } {
  if (!obj(raw) || !("memoryRefs" in raw)) return {};
  return { memoryRefs: parseMemoryRefs(raw.memoryRefs, fail) };
}

/**
 * 结论里逐条的 pitfall：摘掉再交给 findingList（它按固定键表收），按下标记下哪些是 true。
 * pitfall 只能是布尔，true 只给 P1（设计稿 §2.2：只对 P1 有意义）。findings 不是数组时原样返回，让原解析报错。
 */
export function findingPitfalls(findings: unknown, fail: Fail): { rows: unknown; pitfalls: boolean[] } {
  if (!Array.isArray(findings)) return { rows: findings, pitfalls: [] };
  const pitfalls: boolean[] = [];
  const rows = findings.map((f, i) => {
    if (!obj(f) || !("pitfall" in f)) return pitfalls.push(false), f;
    const { pitfall, ...rest } = f;
    if (typeof pitfall !== "boolean") fail(`findings[${i}].pitfall`, "要是布尔");
    if (pitfall && f.severity !== "P1") fail(`findings[${i}].pitfall`, "只有 P1 能标 pitfall");
    pitfalls.push(pitfall as boolean);
    return rest;
  });
  return { rows, pitfalls };
}

/** 解析后的 findings 按下标补回 pitfall:true */
export const withPitfalls = (pitfalls: readonly boolean[]) => <T extends object>(f: T, i: number): T & { pitfall?: true } =>
  (pitfalls[i] ? { ...f, pitfall: true as const } : f);

/**
 * 发给对端之前：对端不认记忆字段（协议版本不够）就去掉 deliver.memoryRefs 与 verdict.findings[].pitfall；认就原样。
 * 接受 DeliverWire / VerdictWire 或任何带这两处的对象，不改入参。
 */
export function withoutMemoryFields<T>(wire: T, peerSupportsMemory: boolean): T {
  if (peerSupportsMemory || !obj(wire)) return wire;
  const { memoryRefs: _m, ...rest } = wire as Record<string, unknown>;
  if (Array.isArray(rest.findings)) {
    rest.findings = rest.findings.map((f) => (obj(f) && "pitfall" in f ? (({ pitfall: _p, ...x }) => x)(f) : f));
  }
  return rest as T;
}

/**
 * 出借 peer 之间还没有「认记忆字段」的能力协商（hello 只协商 proto 1/2，都早于本字段）：按旧版对待，发往 A 的结论一律去掉 pitfall。
 * lend-submit.ts buildPayload 在算 sha256、落 journal 之前调，CLI lend submit 与 submit_verdict 工具两条发送链都经它；
 * 改成按对端能力放行要等共享台账（M8）带上能力位，否则旧 A 的严格解析整单拒收、单子停掉。tests/memory-tools-wire.test.ts。
 */
const LEND_PEER_MEMORY_FIELDS = false;
export const lendVerdictForPeer = <T>(verdict: T): T => withoutMemoryFields(verdict, LEND_PEER_MEMORY_FIELDS);
