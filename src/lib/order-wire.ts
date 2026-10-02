/**
 * The one work-order format shared by local MCP dispatch (M2 take_order / deliver, M3 take_review / submit_verdict) and
 * remote lending (docs/design/remote-capacity.md §2.1, R3 / R4). Every parser is strict: an unknown or missing field, a
 * wrong type or an over-long value is refused rather than dropped or cut, because a wire may come from another machine
 * and a silently trimmed order is a different order. `v` lets M2 / M3 rename fields later without guessing.
 * Rendering and redaction live in order-wire-render.ts. tests/order-wire.test.ts.
 */
import { deliverWithoutDisputes, deliverDisputeFields, type FindingDispute } from "./review-arbiter-wire.js";
import type { ReviewFinding } from "./scheduler-review.js";
import { wireBasis } from "./review-converge-basis.js";
import type { WorkOrder } from "./worker-session.js";
import { convergenceFields, withoutConvergence, type ConvergenceWire } from "./lend-arbiter-wire.js";

const ORDER_WIRE_VERSION = 1;
/** Whole-wire byte cap: a spec quoted inline plus findings fits; anything larger is refused at both ends, never trimmed. */
export const WIRE_MAX_BYTES = 32 * 1024;

/** UTF-8 bytes, the unit of WIRE_MAX_BYTES: String.length would let a CJK or emoji field run to 3–4x its stated size. */
export const WIRE_LIMITS = {
  items: 20, input: 16 * 1024, line: 2000, writeBack: 2000, findings: 100, probe: 4000, fallback: 500, summary: 500, path: 400,
} as const;

type OrderStep = WorkOrder["step"];
export interface OrderWire {
  convergence?: ConvergenceWire;
  v: typeof ORDER_WIRE_VERSION;
  /** = scheduler intent id (the dedup key); the only handle a deliver / verdict may cite. */
  orderId: string;
  taskId: string;
  specRev: number;
  /** Feature sub-DAG version (T84); null until the task belongs to one. */
  dagVersion: number | null;
  node: string;
  step: OrderStep;
  round: number;
  head: string | null;
  /** GitHub owner/repo and PR: the only code coordinates a remote worker gets. Null for local orders. */
  repo: string | null;
  pr: number | null;
  inputs: string[];
  outputs: string[];
  acceptance: string[];
  writeBack: string;
  findings: ReviewFinding[];
  /** 「再不行退到 X」 from the planner's P1 streak rule. */
  fallback: string | null;
}

export interface DeliverWire {
  disputes?: FindingDispute[];
  v: typeof ORDER_WIRE_VERSION;
  orderId: string;
  head: string;
  evidence: string;
  summary: string;
  selfCheck: string;
}

interface VerdictFinding extends ReviewFinding { description: string }
export interface VerdictWire {
  v: typeof ORDER_WIRE_VERSION;
  orderId: string;
  head: string;
  verdict: "pass" | "changes" | "block";
  p0: number;
  p1: number;
  p2: number;
  findings: VerdictFinding[];
  reportPath: string;
}

export type WireResult<T> = { ok: true; value: T } | { ok: false; error: string };

class WireError extends Error {}
const fail = (path: string, why: string): never => { throw new WireError(`${path}: ${why}`); };

const ORDER_ID = /^[\w.:-]{1,200}$/;
const TASK_ID = /^[\w.-]{1,64}$/;
const NODE = /^[\w.-]{1,64}$/;
const FINDING_ID = /^[\w.-]{1,80}$/;
const FAMILY = /^[\w.-]{1,64}$/;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
/** The one head test, shared with the peer renderer so a caller that skipped the parser gets the same answer. */
export const isFullSha = (s: string): boolean => FULL_SHA.test(s);
/** GitHub owner (alnum / hyphen, not leading) / repo name; "." and ".." are not repos and would walk paths when joined. */
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;
/** Same shape as quote-text.ts pathLike: a path, not a sentence. */
const PATH = /^[\p{L}\p{N}_~./][\p{L}\p{M}\p{N}_~./+@%=,:#()-]*$/u;
/** Free text may span lines (a spec, a probe) but carries no other control characters. */
const BAD_MULTI = /[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/;
const BAD_SINGLE = /[\p{Cc}\u2028\u2029]/u;

function record(v: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail(path, "要是对象");
  const r = v as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => !keys.includes(k));
  if (extra.length) fail(path, `不认识的字段 ${extra.slice(0, 3).join(", ")}`);
  const missing = keys.filter((k) => !(k in r));
  if (missing.length) fail(path, `缺字段 ${missing.join(", ")}`);
  return r;
}

function text(v: unknown, path: string, max: number, multiLine = false): string {
  if (typeof v !== "string" || v.length === 0) return fail(path, "要是非空字符串");
  const bytes = Buffer.byteLength(v);
  if (bytes > max) fail(path, `超长（${bytes} > ${max} 字节）`);
  if ((multiLine ? BAD_MULTI : BAD_SINGLE).test(v)) fail(path, "含控制字符");
  return v;
}

function matching(v: unknown, path: string, re: RegExp): string {
  if (typeof v !== "string" || !re.test(v)) fail(path, "格式不对");
  return v as string;
}

function int(v: unknown, path: string, min: number, max: number): number {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) fail(path, `要是 ${min}–${max} 的整数`);
  return v as number;
}

const nullable = <T>(v: unknown, read: (x: unknown) => T): T | null => (v === null ? null : read(v));

function texts(v: unknown, path: string, max: number): string[] {
  if (!Array.isArray(v) || v.length > WIRE_LIMITS.items) return fail(path, `要是不超过 ${WIRE_LIMITS.items} 项的数组`);
  return v.map((s, i) => text(s, `${path}[${i}]`, max, true));
}

const FINDING_KEYS = ["findingId", "family", "severity", "probe"] as const;

function findingList<T extends ReviewFinding>(v: unknown, path: string, keys: readonly string[], more: (r: Record<string, unknown>, p: string) => Omit<T, keyof ReviewFinding>): T[] {
  if (!Array.isArray(v) || v.length > WIRE_LIMITS.findings) return fail(path, `要是不超过 ${WIRE_LIMITS.findings} 项的数组`);
  const ids = new Set<string>();
  return v.map((raw, i) => {
    const p = `${path}[${i}]`;
    const r = record(raw, p, keys);
    const findingId = matching(r.findingId, `${p}.findingId`, FINDING_ID);
    if (ids.has(findingId)) fail(`${p}.findingId`, "重复");
    ids.add(findingId);
    if (!["P0", "P1", "P2"].includes(r.severity as string)) fail(`${p}.severity`, "只认 P0 / P1 / P2");
    const base: ReviewFinding = { findingId, family: matching(r.family, `${p}.family`, FAMILY), severity: r.severity as ReviewFinding["severity"],
      probe: text(r.probe, `${p}.probe`, WIRE_LIMITS.probe, true) };
    return { ...base, ...more(r, p) } as T;
  });
}

function version(v: unknown): typeof ORDER_WIRE_VERSION {
  if (v !== ORDER_WIRE_VERSION) fail("v", `只认版本 ${ORDER_WIRE_VERSION}`);
  return ORDER_WIRE_VERSION;
}

function sized(raw: unknown): void {
  let bytes: number;
  // A cycle or BigInt makes stringify throw; that is the answer (not a wire), reported as a refusal, not lost.
  try { bytes = Buffer.byteLength(JSON.stringify(raw) ?? ""); } catch { return fail("$", "不能序列化成 JSON"); }
  if (bytes > WIRE_MAX_BYTES) fail("$", `整单超过 ${WIRE_MAX_BYTES} 字节`);
}

function guarded<T>(raw: unknown, read: () => T): WireResult<T> {
  try {
    sized(raw);
    return { ok: true, value: read() };
  } catch (e) {
    if (e instanceof WireError) return { ok: false, error: e.message };
    throw e;
  }
}

const ORDER_KEYS = ["v", "orderId", "taskId", "specRev", "dagVersion", "node", "step", "round", "head", "repo", "pr", "inputs", "outputs",
  "acceptance", "writeBack", "findings", "fallback"] as const;
const STEPS: readonly OrderStep[] = ["restate", "write", "review", "fix"];

export function parseOrderWire(raw: unknown): WireResult<OrderWire> {
  return guarded(raw, () => {
    const r = record(withoutConvergence(raw), "$", ORDER_KEYS);
    if (!STEPS.includes(r.step as OrderStep)) fail("step", "只认 restate / write / review / fix");
    return {
      v: version(r.v), orderId: matching(r.orderId, "orderId", ORDER_ID), taskId: matching(r.taskId, "taskId", TASK_ID),
      specRev: int(r.specRev, "specRev", 0, 1e6), dagVersion: nullable(r.dagVersion, (x) => int(x, "dagVersion", 1, 1e6)),
      node: matching(r.node, "node", NODE), step: r.step as OrderStep, round: int(r.round, "round", 0, 1e6),
      head: nullable(r.head, (x) => matching(x, "head", FULL_SHA)), repo: nullable(r.repo, (x) => matching(x, "repo", REPO)),
      pr: nullable(r.pr, (x) => int(x, "pr", 1, 1e9)), inputs: texts(r.inputs, "inputs", WIRE_LIMITS.input),
      outputs: texts(r.outputs, "outputs", WIRE_LIMITS.line), acceptance: texts(r.acceptance, "acceptance", WIRE_LIMITS.line),
      writeBack: text(r.writeBack, "writeBack", WIRE_LIMITS.writeBack, true), findings: findingList(r.findings, "findings", FINDING_KEYS, () => ({})),
      fallback: nullable(r.fallback, (x) => text(x, "fallback", WIRE_LIMITS.fallback, true)),
      ...convergenceFields(raw, fail),
    };
  });
}

export function parseDeliverWire(raw: unknown): WireResult<DeliverWire> {
  return guarded(raw, () => {
    const r = record(deliverWithoutDisputes(raw), "$", ["v", "orderId", "head", "evidence", "summary", "selfCheck"]);
    return {
      v: version(r.v), orderId: matching(r.orderId, "orderId", ORDER_ID), head: matching(r.head, "head", FULL_SHA),
      evidence: matching(text(r.evidence, "evidence", WIRE_LIMITS.path), "evidence", PATH), summary: text(r.summary, "summary", WIRE_LIMITS.summary),
      selfCheck: text(r.selfCheck, "selfCheck", WIRE_LIMITS.probe, true), ...deliverDisputeFields(raw, fail),
    };
  });
}

export function parseVerdictWire(raw: unknown): WireResult<VerdictWire> {
  return guarded(raw, () => {
    const r = record(raw, "$", ["v", "orderId", "head", "verdict", "p0", "p1", "p2", "findings", "reportPath"]);
    if (!["pass", "changes", "block"].includes(r.verdict as string)) fail("verdict", "只认 pass / changes / block");
    const rows = Array.isArray(r.findings) ? r.findings.map((f) => (f && typeof f === "object" && !("basis" in f) ? { ...f, basis: null } : f)) : r.findings; // basis 可省（旧远端）
    const findings = findingList<VerdictFinding>(rows, "findings", [...FINDING_KEYS, "description", "basis"],
      (f, p) => ({ description: text(f.description, `${p}.description`, WIRE_LIMITS.probe, true), ...wireBasis(f.basis, (why) => fail(`${p}.basis`, why)) }));
    const counts = { p0: int(r.p0, "p0", 0, WIRE_LIMITS.findings), p1: int(r.p1, "p1", 0, WIRE_LIMITS.findings), p2: int(r.p2, "p2", 0, WIRE_LIMITS.findings) };
    for (const sev of ["P0", "P1", "P2"] as const) {
      const key = sev.toLowerCase() as "p0" | "p1" | "p2";
      if (findings.filter((f) => f.severity === sev).length !== counts[key]) fail(key, "与逐条问题的计数不一致");
    }
    if (r.verdict === "pass" && counts.p0 + counts.p1 > 0) fail("verdict", "有 P0 / P1 不能 pass");
    return {
      v: version(r.v), orderId: matching(r.orderId, "orderId", ORDER_ID), head: matching(r.head, "head", FULL_SHA),
      verdict: r.verdict as VerdictWire["verdict"], ...counts, findings,
      reportPath: matching(text(r.reportPath, "reportPath", WIRE_LIMITS.path), "reportPath", PATH),
    };
  });
}

/** M2 ask: a question about one's own current order. options may be omitted (no choices); an empty or over-long one is refused. */
export interface AskWire {
  v: typeof ORDER_WIRE_VERSION;
  orderId: string;
  question: string;
  options: string[];
  default?: string;
  class?: "design" | "scope" | "blocker";
  /** i28-ASK4 测试类扩围：申请加进本卡范围的文件（仓库相对路径）与理由；两个一起给才算，order-ask-default.ts 据此自动定 */
  files?: string[];
  reason?: AskScopeReason;
}

/** superseded_assertion = 被本规格替代的旧断言；new_test = 为本卡新行为补测试 */
export const ASK_SCOPE_REASONS = ["superseded_assertion", "new_test"] as const;
export type AskScopeReason = (typeof ASK_SCOPE_REASONS)[number];

const ASK_LIMITS = { question: 2000, options: 10, option: 200, files: 20 } as const;

/** files / reason：都给或都不给；files 是不带通配、不带 .. 的仓库相对路径 */
function askScope(r: Record<string, unknown>): Pick<AskWire, "files" | "reason"> {
  if (!("files" in r) && !("reason" in r)) return {};
  if (!("files" in r) || !("reason" in r)) fail("files", "files 与 reason 要一起给");
  if (!ASK_SCOPE_REASONS.includes(r.reason as AskScopeReason)) fail("reason", `只认 ${ASK_SCOPE_REASONS.join(" / ")}`);
  if (!Array.isArray(r.files) || !r.files.length || r.files.length > ASK_LIMITS.files) fail("files", `要是 1–${ASK_LIMITS.files} 项的数组`);
  const files = (r.files as unknown[]).map((f, i) => {
    const s = matching(text(f, `files[${i}]`, WIRE_LIMITS.path), `files[${i}]`, PATH);
    if (s.split("/").some((seg) => seg === ".." || seg === "." || !seg) || /[*?[\]{}]/.test(s)) fail(`files[${i}]`, "要是不带通配、不带 . / .. 的仓库相对路径");
    return s;
  });
  return { files: [...new Set(files)], reason: r.reason as AskScopeReason };
}

/** order-ask.ts 存进 ask.extra 的那两项（没给 = 空） */
export const askScopeExtra = (q: Partial<Pick<AskWire, "files" | "reason">>): Pick<AskWire, "files" | "reason"> =>
  q.files?.length && q.reason ? { files: q.files, reason: q.reason } : {};

export function parseAskWire(raw: unknown): WireResult<AskWire> {
  return guarded(raw, () => {
    const given = raw && typeof raw === "object" && !Array.isArray(raw) && !("options" in raw) ? { ...raw, options: [] } : raw;
    const r = record(given, "$", ["v", "orderId", "question", "options",
      ...(given && typeof given === "object" ? ["default", "class", "files", "reason"].filter((k) => k in given) : [])]);
    if ("class" in r && !["design", "scope", "blocker"].includes(r.class as string)) fail("class", "只认 design / scope / blocker");
    if ("default" in r && (typeof r.default !== "string" || !r.default.trim() || [...r.default].length > 600)) fail("default", "默认做法要非空且不超过 600 字");
    if (!Array.isArray(r.options) || r.options.length > ASK_LIMITS.options) fail("options", `要是不超过 ${ASK_LIMITS.options} 项的数组`);
    return {
      v: version(r.v), orderId: matching(r.orderId, "orderId", ORDER_ID), question: text(r.question, "question", ASK_LIMITS.question, true),
      options: (r.options as unknown[]).map((o, i) => text(o, `options[${i}]`, ASK_LIMITS.option)),
      ...("default" in r ? { default: text(r.default, "default", 2400, true) } : {}),
      ...("class" in r ? { class: r.class as AskWire["class"] } : {}),
      ...askScope(r),
    };
  });
}

/** Local scheduler orders become wires field for field; only the names differ (dedupKey → orderId, fallbackWarning → fallback). */
export function orderWireOf(o: WorkOrder, at: { repo?: string | null; pr?: number | null; dagVersion?: number | null } = {}): OrderWire {
  return {
    v: ORDER_WIRE_VERSION, orderId: o.dedupKey, taskId: o.taskId, specRev: o.specRev, dagVersion: at.dagVersion ?? null, node: o.node,
    step: o.step, round: o.round, head: o.head, repo: at.repo ?? null, pr: at.pr ?? null, inputs: o.inputs, outputs: o.outputs,
    acceptance: o.acceptance, writeBack: o.writeBack, findings: o.findings ?? [], fallback: o.fallbackWarning ?? null,
  };
}
