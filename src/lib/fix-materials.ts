/**
 * Lent fix orders' material (dispatch-recovery-MAT): with the `materials` recovery policy on, the order carries the last review's
 * structured findings (id / severity / description through the order's findings field; file / line / acceptance basis here)
 * plus an immutable reference to the report (event seq, sha256 prefix, bytes) instead of the report text, which stays local.
 * Only real stored fields are read: a finding without file / line says so, never a path guessed from its probe. The input still
 * passes the same peer gate whole; a refusal blocks the order locally. observe / off / no port send the full text as before.
 * tests/fix-materials.test.ts, tests/fix-materials-offer.test.ts.
 */
import { createHash } from "node:crypto";
import type { LedgerEvent } from "./ledger-stages.js";
import { LedgerError } from "./ledger-store.js";
import { basisField, type FindingBasis } from "./review-converge-basis.js";
import type { OrderWire } from "./order-wire.js";
import { WIRE_LIMITS } from "./order-wire.js";
import type { InputSplit } from "./order-wire-chunks.js";
import type { ReviewFinding } from "./scheduler-review.js";

export type MaterialsMode = "on" | "observe" | "off";
/** Narrow read of the shared recovery policy (CFG's recoveryPolicy fits it); only `mode` is used here. */
export type MaterialsPolicy = (project: string, mechanism: "materials") => { mode: string };

const MODES: readonly string[] = ["on", "observe", "off"];

/** No port = observe (nothing sent changes); a port that throws or answers an unknown mode = off. */
export function materialsMode(policy: MaterialsPolicy | undefined, project: string): MaterialsMode {
  if (!policy) return "observe";
  try {
    const mode = policy(project, "materials")?.mode;
    return MODES.includes(mode) ? mode as MaterialsMode : "off";
  } catch {
    return "off"; // An unreadable policy must not turn recovery on; off keeps the original full-text path, the caller sees no change.
  }
}

interface FixItem { findingId: string; severity: ReviewFinding["severity"]; file: string | null; line: number | null; basis: FindingBasis | null }
export interface FixMaterials {
  mode: MaterialsMode;
  /** The review event the items came from and the report it names; the report bytes are hashed, never rewritten. */
  source: { eventSeq: number; sha256: string; bytes: number };
  items: FixItem[];
}

const FINDING_KEYS = ["findingId", "family", "severity", "probe"] as const;
/** Same shape quote-text / order-wire accept as a path; anything else is not a usable location. */
const PATH = /^[\p{L}\p{N}_~./][\p{L}\p{M}\p{N}_~./+@%=,:#()-]*$/u;

const fileOf = (v: unknown): string | null => typeof v === "string" && Buffer.byteLength(v) <= WIRE_LIMITS.path && PATH.test(v) ? v : null;
const lineOf = (v: unknown): number | null => Number.isSafeInteger(v) && (v as number) > 0 ? v as number : null;

/** The review event whose report is `path` (the last one, as lastReviewOf picks); its findings filtered the way lastReviewOf keeps them. */
export function fixMaterials(mode: MaterialsMode, events: readonly LedgerEvent[], path: string, report: string): FixMaterials | null {
  const e = events.findLast((x) => x.kind === "review" && x.data.path === path);
  const rows = (Array.isArray(e?.data.findings) ? e!.data.findings : []) as Record<string, unknown>[];
  const items = rows.filter((f) => f && typeof f === "object" && FINDING_KEYS.every((k) => typeof f[k] === "string")).slice(0, WIRE_LIMITS.findings)
    .map((f) => ({ findingId: f.findingId as string, severity: f.severity as ReviewFinding["severity"], file: fileOf(f.file),
      line: fileOf(f.file) ? lineOf(f.line) : null, basis: basisField(f.basis) }));
  if (!e || !items.length) return null;
  return { mode, items, source: { eventSeq: e.seq, sha256: createHash("sha256").update(report).digest("hex"), bytes: Buffer.byteLength(report) } };
}

/** Checked inside the offer transaction: a review written after the material was read means the items may be stale. */
export function assertFresh(events: readonly LedgerEvent[], m: FixMaterials): void {
  if (events.some((e) => e.kind === "review" && e.seq > m.source.eventSeq)) {
    throw new LedgerError("conflict", `修复材料备好后卡上又记了新的审查（来源事件 #${m.source.eventSeq} 之后），重新挂单`);
  }
}

/** What the offer note records: enough to compare observe against on, nothing from the report text. */
export const materialsNote = (m: FixMaterials): Record<string, unknown> => ({ mode: m.mode, items: m.items.length,
  unlocated: m.items.filter((i) => !i.file).length, eventSeq: m.source.eventSeq, sha256: m.source.sha256.slice(0, 12), bytes: m.source.bytes });

const LABEL = "修复材料（结构化必需项，不是审查报告原文）";
const basisText = (b: FindingBasis | null): string => (b === "regression" ? "回归" : b ? `验收线 ${b.slice("acceptance:".length)}` : "审查结论未标");

/** The input text; `findings` is the order's findings field before aliasing, so item N names its row by position, not by id. */
export function materialsText(m: FixMaterials, findings: readonly ReviewFinding[]): string {
  const lines = m.items.map((item) => {
    const at = findings.findIndex((f) => f.findingId === item.findingId);
    if (at < 0) throw new LedgerError("invalid", `修复材料：必需项 ${item.findingId} 对不上派单的逐项结论，本机阻塞（不改发报告全文）`);
    const where = item.file ? `${item.file}${item.line ? `:${item.line}` : ""}` : "审查结论未给结构化 file / line（按描述复现定位，不要猜路径）";
    return `- 上一轮审查第 ${at + 1} 条（${item.severity}）· 位置：${where} · 验收对应：${basisText(item.basis)}`;
  });
  return [`来源：本机台账审查事件 #${m.source.eventSeq}，报告 sha256 前 12 位 ${m.source.sha256.slice(0, 12)}、${m.source.bytes} 字节；报告全文留在本机，本单不含它，也不是删改过的原文。`,
    "逐条（描述即「上一轮审查」里对应那一条的原文）：", ...lines,
    "需要报告全文：用 ask（class=blocker）申请，由本机走同一授权与外发闸再发；不要用附件、编码或别的渠道。"].join("\n");
}

/** The fix wire with the material input placed before the standard answers (the last input), split like every other source. */
export function withMaterials(wire: OrderWire, m: FixMaterials, findings: readonly ReviewFinding[], split: InputSplit): OrderWire {
  const parts = split([[LABEL, materialsText(m, findings)]]);
  return { ...wire, inputs: [...wire.inputs.slice(0, -1), ...parts, ...wire.inputs.slice(-1)] };
}

/** Prefix of the gate refusal when structured material was on the order: still a gate refusal (isGateRefusal), stated as a local block. */
export const MATERIALS_BLOCKED = "修复材料结构化必需项被拒收，本机阻塞（不改发全文、附件或别的渠道）；";
