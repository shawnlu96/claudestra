/** 发给执行者 / 审查员的单里引用审查结论的共用部分（review-order.ts 审查单、order-take.ts 修复单）：按 wire 的字节上限截、只留 wire 认的字段。 */
import { WIRE_LIMITS } from "./order-wire.js";
import type { ReviewFinding } from "./scheduler-review.js";

/** 按 UTF-8 字节截（wire 按字节限长）；截断处标 … 说明不是原文全文 */
export function clipWire(s: string, max: number): string {
  const clean = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g, " ");
  if (Buffer.byteLength(clean) <= max) return clean;
  let out = "";
  for (const ch of clean) {
    if (Buffer.byteLength(out + ch) > max - 3) break;
    out += ch;
  }
  return `${out}…`;
}

const FINDING_KEYS: readonly (keyof ReviewFinding)[] = ["findingId", "family", "severity", "probe"];

/** review 事件里的逐项结论 → wire 的 findings：只留四个字段、probe 按 wire 限长截，坏行丢掉（整单最后还要过 parseOrderWire）。两种单共用 */
export function wireFindings(raw: unknown): ReviewFinding[] {
  const rows = (Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
  return rows.filter((f) => f && typeof f === "object" && FINDING_KEYS.every((k) => typeof f[k] === "string")).slice(0, WIRE_LIMITS.findings)
    .map((f) => ({ findingId: f.findingId as string, family: f.family as string, severity: f.severity as ReviewFinding["severity"],
      probe: clipWire(f.probe as string, WIRE_LIMITS.probe) }));
}
