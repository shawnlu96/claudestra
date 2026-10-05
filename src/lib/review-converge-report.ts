/** Legacy report markers belong to a named finding, never to the report as a whole. */
import { readFileSync } from "node:fs";
import { quoteExternal } from "./quote-text.js";
import { basisFromText, findingBasis, type BasisSource, type FindingBasis } from "./review-converge-basis.js";

function readReport(path: string): string {
  try { return readFileSync(path, "utf8"); }
  catch (e) {
    // Missing legacy reports cannot supply a basis; the draft retains the source path for PM to recover it.
    console.warn(`[review-converge] 读审查报告失败 ${path}: ${(e as Error).message}`);
    return "";
  }
}

/** A marker on the finding's own line or in its Markdown section, ending at the next heading. */
export function reportBasis(f: BasisSource, report: string): FindingBasis | null {
  const escaped = f.findingId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const id = new RegExp(`(^|[^\\w.-])${escaped}(?=$|[^\\w.-])`);
  const lines = report.split(/\r?\n/);
  let heading = "";
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#{1,6}\s/.test(lines[i])) heading = lines[i];
    if (!id.test(lines[i])) continue;
    const direct = basisFromText(lines[i]) ?? basisFromText(heading);
    if (direct) return direct;
    if (!/^\s*#{1,6}\s/.test(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && !/^\s*#{1,6}\s/.test(lines[end])) end++;
    // From the heading itself, so a marker it opens and the section closes still counts.
    const basis = basisFromText(lines.slice(i, end).join("\n"));
    if (basis) return basis;
  }
  return null;
}

/** Ingestion resolves description/report fallback before the wire description is discarded. */
export function storedBasis(f: BasisSource, report: string, file = false): { basis?: FindingBasis } {
  const basis = findingBasis(f) ?? reportBasis(f, file ? readReport(report) : report);
  return basis ? { basis } : {};
}

export function quotedReviewReport(path: string): string {
  const report = readReport(path);
  return report ? report.split(/\r?\n/).map((line) => `> ${quoteExternal(line, line.length)}`).join("\n")
    : "> 报告暂不可读；请按来源路径补回原文。";
}
