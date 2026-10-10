/**
 * UISDEL1: the optional `uiEvidence` of a DeliverWire — a bounded before / after screenshot manifest, nothing else. Structure only:
 * it binds the shots to one card / head / specRev / target review round and to where the bytes live (`local` = this machine's
 * artifact root for the card; `imported` = artifacts a peer order already had imported here). No image bytes, no URLs, no absolute
 * paths: a peer's path is foreign text and never opened. `digest` is the canonical manifest digest (sha256 over canonicalJson of
 * every other field, shots sorted); a declared shot sha256 is only a claim until ledger-deliver-ui.ts hashes the actual bytes.
 * Same parser for MCP (parseDeliverWire), the CLI flag and peer deliveries. tests/order-deliver-ui.test.ts、tests/ledger-lend-write-ui.test.ts.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";

const UI_EVIDENCE_LIMITS = { shots: 16, summary: 500, ref: 200 } as const;
type UiPhase = "before" | "after";
type UiSource = "local" | "imported";
export interface UiShot { view: string; size: string; phase: UiPhase; ref: string; sha256: string }
export interface UiEvidence { v: 1; taskId: string; head: string; specRev: number; round: number; source: UiSource; summary: string; shots: UiShot[]; digest: string }

const KEYS = ["v", "taskId", "head", "specRev", "round", "source", "summary", "shots", "digest"] as const;
const SHOT_KEYS = ["view", "size", "phase", "ref", "sha256"] as const;
const TASK_ID = /^(?!\.\.?$)[\w.-]{1,64}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const VIEW = /^[\w.-]{1,64}$/;
const SIZE = /^[1-9]\d{1,4}x[1-9]\d{1,4}$/;
/** Relative, ≤ 4 segments of [\w.-], never "." / "..", an image extension: no absolute path, no traversal, no control characters. */
const SEGMENT = /^(?!\.\.?$)[\w.-]{1,100}$/;
const IMAGE = /\.(?:png|jpe?g|webp)$/i;
const BAD_LINE = /[\p{Cc}\u2028\u2029]/u;

class UiEvidenceError extends Error {}
const bad = (path: string, why: string): never => { throw new UiEvidenceError(`uiEvidence${path}: ${why}`); };

function exact(v: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) bad(path, "要是对象");
  const r = v as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => !keys.includes(k));
  if (extra.length) bad(path, `不认识的字段 ${extra.slice(0, 3).join(", ")}`);
  const missing = keys.filter((k) => !(k in r));
  if (missing.length) bad(path, `缺字段 ${missing.join(", ")}`);
  return r;
}
function str(v: unknown, path: string, re: RegExp): string {
  if (typeof v !== "string" || !re.test(v)) bad(path, "格式不对");
  return v as string;
}
function int(v: unknown, path: string, min: number): number {
  if (!Number.isSafeInteger(v) || (v as number) < min) bad(path, `要是 ≥ ${min} 的整数`);
  return v as number;
}

function uiRefOk(ref: string): boolean {
  if (Buffer.byteLength(ref) > UI_EVIDENCE_LIMITS.ref || !IMAGE.test(ref)) return false;
  const parts = ref.split("/");
  return parts.length <= 4 && parts.every((p) => SEGMENT.test(p));
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0); // code units, not locale: the digest must not depend on the machine
const shotOrder = (a: UiShot, b: UiShot): number => cmp(a.view, b.view) || cmp(a.size, b.size) || cmp(a.phase === "before" ? "0" : "1", b.phase === "before" ? "0" : "1");

/** The canonical manifest digest: every field but digest, shots in (view, size, before → after) order. */
export function uiEvidenceDigest(e: Omit<UiEvidence, "digest">): string {
  const { v, taskId, head, specRev, round, source, summary } = e;
  const shots = [...e.shots].sort(shotOrder).map(({ view, size, phase, ref, sha256 }) => ({ view, size, phase, ref, sha256 }));
  return createHash("sha256").update(canonicalJson({ v, taskId, head, specRev, round, source, summary, shots })).digest("hex");
}

/** Strict: unknown / missing fields, an unpaired view+size, a duplicate, a bad ref or a digest that is not the canonical one all throw. */
export function parseUiEvidence(raw: unknown): UiEvidence {
  const r = exact(raw, "", KEYS);
  if (r.v !== 1) bad(".v", "只认版本 1");
  if (r.source !== "local" && r.source !== "imported") bad(".source", "只认 local / imported");
  if (typeof r.summary !== "string" || !r.summary.trim() || Buffer.byteLength(r.summary) > UI_EVIDENCE_LIMITS.summary || BAD_LINE.test(r.summary)) {
    bad(".summary", `要是一行非空、不超过 ${UI_EVIDENCE_LIMITS.summary} 字节`);
  }
  if (!Array.isArray(r.shots) || r.shots.length < 2 || r.shots.length > UI_EVIDENCE_LIMITS.shots) bad(".shots", `要是 2–${UI_EVIDENCE_LIMITS.shots} 项的数组`);
  const shots = (r.shots as unknown[]).map((s, i): UiShot => {
    const p = `.shots[${i}]`, x = exact(s, p, SHOT_KEYS);
    if (x.phase !== "before" && x.phase !== "after") bad(`${p}.phase`, "只认 before / after");
    if (typeof x.ref !== "string" || !uiRefOk(x.ref)) bad(`${p}.ref`, "要是工件根下的相对图片路径（≤4 段 [\\w.-]，不含 . / ..，png / jpg / webp）");
    return { view: str(x.view, `${p}.view`, VIEW), size: str(x.size, `${p}.size`, SIZE), phase: x.phase as UiPhase, ref: x.ref as string,
      sha256: str(x.sha256, `${p}.sha256`, HEX64) };
  });
  const seen = new Map<string, Set<UiPhase>>(), refs = new Set<string>();
  for (const s of shots) {
    const k = `${s.view} ${s.size}`, phases = seen.get(k) ?? new Set<UiPhase>();
    if (phases.has(s.phase)) bad(".shots", `${s.view} @ ${s.size} 的 ${s.phase} 重复`);
    if (refs.has(s.ref)) bad(".shots", `${s.ref} 重复引用`);
    phases.add(s.phase), refs.add(s.ref), seen.set(k, phases);
  }
  for (const [k, phases] of seen) if (phases.size !== 2) bad(".shots", `${k.replace(" ", " @ ")} 缺 ${phases.has("before") ? "after" : "before"}（同一展示状态 / 尺寸要有前后一对）`);
  const e = { v: 1 as const, taskId: str(r.taskId, ".taskId", TASK_ID), head: str(r.head, ".head", SHA40), specRev: int(r.specRev, ".specRev", 1),
    round: int(r.round, ".round", 1), source: r.source as UiSource, summary: r.summary as string, shots: [...shots].sort(shotOrder) };
  const digest = str(r.digest, ".digest", HEX64);
  if (digest !== uiEvidenceDigest(e)) bad(".digest", "不是这份清单的规范摘要");
  return { ...e, digest };
}

/** CLI flag / stored value: a JSON string or the object; null when absent. Throws the parser's message on anything else. */
export function readUiEvidence(raw: unknown): UiEvidence | null {
  if (raw === undefined || raw === null) return null;
  let v = raw;
  if (typeof raw === "string") {
    try { v = JSON.parse(raw); } catch { return bad("", "要是 JSON 对象"); }
  }
  return parseUiEvidence(v);
}

export const isUiEvidenceError = (e: unknown): e is Error => e instanceof UiEvidenceError;

// ── DeliverWire wiring (order-wire.ts parseDeliverWire): optional, strict, same shape as disputes / memoryRefs ──

export function deliverWithoutUi(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const { uiEvidence: _ui, ...rest } = raw as Record<string, unknown>;
  return rest;
}

export function deliverUiFields(raw: unknown, fail: (path: string, why: string) => never): { uiEvidence?: UiEvidence } {
  const value = (raw as Record<string, unknown>).uiEvidence;
  if (value === undefined) return {};
  try { return { uiEvidence: parseUiEvidence(value) }; } catch (e) { return isUiEvidenceError(e) ? fail("uiEvidence", e.message) : (() => { throw e; })(); }
}

/** MCP schema of the field (order-tools.ts); the parser above stays the authority. */
export const UI_EVIDENCE_SCHEMA = {
  type: "object", additionalProperties: false,
  description: "ui 卡：前后截图清单（只登记证据，不是批准）。shots 每个展示状态+尺寸一对 before/after；" +
    "ref 是本机工件根下本卡目录的相对路径；digest = 规范清单 sha256",
  properties: {
    v: { type: "number", enum: [1] }, taskId: { type: "string" }, head: { type: "string" }, specRev: { type: "number" },
    round: { type: "number", description: "交付后进入的 review 轮次（= 单上 round + 1）" }, source: { type: "string", enum: ["local", "imported"] },
    summary: { type: "string" }, digest: { type: "string" },
    shots: { type: "array", minItems: 2, maxItems: UI_EVIDENCE_LIMITS.shots, items: { type: "object", additionalProperties: false,
      properties: { view: { type: "string" }, size: { type: "string" }, phase: { type: "string", enum: ["before", "after"] }, ref: { type: "string" }, sha256: { type: "string" } },
      required: ["view", "size", "phase", "ref", "sha256"] } },
  },
  required: ["v", "taskId", "head", "specRev", "round", "source", "summary", "shots", "digest"],
} as const;
