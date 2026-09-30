/** 发给执行者 / 审查员的单里引用审查结论的共用部分（review-order.ts 审查单、order-take.ts 修复单）：按 wire 的字节上限截、只留 wire 认的字段。 */
import { WIRE_LIMITS, WIRE_MAX_BYTES } from "./order-wire.js";
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

/** probe 逐级压到这些长度；压到最短还装不下就从最轻的一项开始丢 */
const PROBE_STEPS = [2000, 1000, 500, 200] as const;
const SEVERITY_RANK: Record<ReviewFinding["severity"], number> = { P0: 0, P1: 1, P2: 2 };

/**
 * 单子整体不许超 WIRE_MAX_BYTES，而每项结论只按单项限长——合法的 VerdictWire（每项都满长）搬进修复单 / 审查单会超。
 * 超了就先压 probe、再按严重度从轻往重丢项，并在 inputs 末尾说明省了什么、全文去哪看；装得下就原样返回。
 * 这样单子总能交出去（take_order / take_review 不会因为上一轮结论太长而永远领不到）。tests/scheduler-dispatch-wake.test.ts。
 */
export function fitFindings<W extends { inputs: string[]; findings: ReviewFinding[] }>(wire: W, report: string | null): W {
  const fits = (w: W): boolean => Buffer.byteLength(JSON.stringify(w)) <= WIRE_MAX_BYTES;
  if (fits(wire)) return wire;
  const total = wire.findings.length;
  const ranked = [...wire.findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const withNote = (rows: ReviewFinding[], cap: number): W => ({
    ...wire, findings: rows,
    inputs: [...wire.inputs, clipWire(`上一轮逐项结论单子装不下：probe 截到 ${cap} 字节以内` +
      `${rows.length < total ? `，只列最严重的 ${rows.length}/${total} 项` : ""}；全文看${report ? `审查报告 ${report}` : "台账里这一轮的 review 事件"}`, WIRE_LIMITS.line)],
  });
  const capped = (cap: number): ReviewFinding[] => ranked.map((f) => ({ ...f, probe: clipWire(f.probe, cap) }));
  for (const cap of PROBE_STEPS) {
    const w = withNote(capped(cap), cap);
    if (fits(w)) return w;
  }
  const last = PROBE_STEPS[PROBE_STEPS.length - 1];
  const rows = capped(last);
  while (rows.length) {
    rows.pop();
    const w = withNote(rows, last);
    if (fits(w)) return w;
  }
  return withNote([], last);
}
