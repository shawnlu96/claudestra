/** Only verified report bodies define history boundaries; text inside a report cannot impersonate another round. */
import { createHash } from "node:crypto";
import type { LedgerEvent } from "./ledger-stages.js";
import type { OrderWire } from "./order-wire.js";
import { shortenHeads, shortenShas } from "./order-gate-heads.js";
import { redactOrderForPeer, sanitizeForeign } from "./order-wire-render.js";

export interface FitReport { event: LedgerEvent; report: string | null }
export interface FitDigest { seq: number; kind: "report" | "diff" | "probe"; sha256: string }
interface FitSection { start: number; reportStart: number; reportEnd: number; end: number; source: FitReport }

/** Full digests belong to local event data; the peer text only quotes their 16-character prefixes. */
export const fitDigest = (text: string): string => createHash("sha256").update(text).digest("hex");

export function fitReportSummary({ event, report }: FitReport): string {
  const findings = Array.isArray(event.data.findings) ? event.data.findings as Record<string, unknown>[] : [];
  const counts = ["P0", "P1", "P2"].map((s) => `${s} ${findings.filter((f) => f.severity === s).length}`).join(" / ");
  const titles = findings.map((f) => {
    const text = sanitizeForeign(String(f.title ?? f.description ?? f.probe ?? f.findingId)).split(/\r?\n/)[0];
    return `${f.severity} ${Array.from(text).slice(0, 120).join("")}`;
  }).join("；\n");
  return `第 ${event.data.round} 轮摘要：结论 ${event.data.verdict ?? "未记录"}；${counts}；${titles}；` +
    `原报告全文 sha256 前16位 ${fitDigest(report!).slice(0, 16)}；台账事件 seq ${event.seq}`;
}

/** Derive the same peer-visible body as the existing transfer path, retaining the original bytes solely for its digest. */
function peerBody(wire: OrderWire, report: string, heads: ReadonlySet<string>): string {
  const short = shortenShas(shortenHeads(report, heads), heads, wire.head).text;
  return redactOrderForPeer({ ...wire, inputs: [short] }, wire.head).order.inputs[0];
}

function peerSummary(wire: OrderWire, source: FitReport): string {
  const rows = Array.isArray(source.event.data.findings) ? source.event.data.findings as Record<string, unknown>[] : [];
  // Reject secrets in full titles before the formatter masks addresses and personal info, then applies its title cap.
  const titles = rows.map((f) => String(f.title ?? f.description ?? f.probe ?? f.findingId));
  redactOrderForPeer({ ...wire, inputs: titles }, wire.head);
  return redactOrderForPeer({ ...wire, inputs: [fitReportSummary(source)] }, wire.head).order.inputs[0];
}

function fitSections(text: string, wire: OrderWire, reports: readonly FitReport[], heads: ReadonlySet<string>): FitSection[] {
  const sections: FitSection[] = [];
  let cursor = 0;
  for (const source of reports) {
    const { event, report } = source;
    if (report === null || typeof event.data.round !== "number" || typeof event.data.head !== "string") continue;
    const header = `## 第 ${event.data.round} 轮 · ${event.data.head.slice(0, 12)}\n\n报告原文(`;
    const start = text.indexOf(header, cursor);
    if (start < 0) continue;
    if (text.indexOf("## 第 ", cursor) !== start) return [];
    const marker = text.indexOf("):\n", start + header.length);
    if (marker < 0) return [];
    if (typeof event.data.path === "string" && text.slice(start + header.length, marker) !== peerBody(wire, event.data.path, heads)) continue;
    const reportStart = marker + 3, original = peerBody(wire, report, heads);
    const body = text.startsWith(original + "\n\n修复 diff 摘要:\n", reportStart) ? original
      : Number(event.data.round) < wire.round ? peerSummary(wire, source) : original;
    const reportEnd = reportStart + body.length;
    // Verify the entire report, not a regex delimiter that an external report could contain.
    // Several reviewers can share a round/head; an omitted review must not consume the represented review's boundary.
    if (text.slice(reportStart, reportEnd) !== body || !text.startsWith("\n\n修复 diff 摘要:\n", reportEnd)) continue;
    const next = text.indexOf("\n\n## 第 ", reportEnd);
    const end = next < 0 ? text.length : next;
    sections.push({ start, reportStart, reportEnd, end, source });
    cursor = end;
  }
  return sections;
}

export const FIT_AUX_BYTES = 2048;
/** The cap includes the marker and measures UTF-8; slicing code points cannot introduce a replacement character. */
export function fitAux(text: string): string {
  if (Buffer.byteLength(text) <= FIT_AUX_BYTES) return text;
  const marker = `\n[已截断，全文 sha256 前16位 ${fitDigest(text).slice(0, 16)}]`, room = FIT_AUX_BYTES - Buffer.byteLength(marker);
  let prefix = "", used = 0;
  for (const char of text) {
    used += Buffer.byteLength(char);
    if (used > room) break;
    prefix += char;
  }
  return prefix + marker;
}

export function fitHistory(text: string, wire: OrderWire, reports: readonly FitReport[], heads: ReadonlySet<string>,
  stage: "history" | "diff" | "probe"): { text: string; digests: FitDigest[] } {
  const digests: FitDigest[] = [];
  // Ranges are computed from the original body, then edited right to left so an earlier replacement cannot move a later range.
  for (const section of fitSections(text, wire, reports, heads).reverse()) {
    if (Number(section.source.event.data.round) >= wire.round) continue;
    if (stage === "history") {
      text = text.slice(0, section.reportStart) + peerSummary(wire, section.source) + text.slice(section.reportEnd);
      digests.push({ seq: section.source.event.seq, kind: "report", sha256: fitDigest(section.source.report!) });
      continue;
    }
    const diffStart = section.reportEnd + "\n\n修复 diff 摘要:\n".length;
    const probeMarker = text.indexOf("\n\n复现 probe:\n", diffStart);
    if (probeMarker < 0 || probeMarker >= section.end) continue;
    const start = stage === "diff" ? diffStart : probeMarker + "\n\n复现 probe:\n".length;
    const end = stage === "diff" ? probeMarker : section.end;
    const full = text.slice(start, end), cut = fitAux(full);
    if (cut !== full) digests.push({ seq: section.source.event.seq, kind: stage, sha256: fitDigest(full) });
    text = text.slice(0, start) + cut + text.slice(end);
  }
  return { text, digests: digests.reverse() };
}
