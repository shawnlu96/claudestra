/**
 * What the body upload (team-body-sync.ts) hands to the scrub, written here so the gate masks less by mistake
 * (team-project-TEAMSCRUB). The gate itself is untouched: it still masks a whole paragraph for one hit, so the text is laid
 * out and rewritten before it gets there. observe counts through the same three functions.
 * - teamBodyReviewText: a review as paragraphs, so a path in one finding's probe no longer takes the verdict line with it.
 * - teamBodySourceText: rewrites that would otherwise trip the gate for nothing (launchd deploy label, ask-default markers)
 *   or pass it when they must not (private-repo paths, which the absolute-path rule does not see).
 * - teamBodyScrubHeads: commit candidates in the text join the heads the scrub is asked about.
 * tests/team-body-text.test.ts.
 */
import { basename } from "node:path";
import { hexCandidates } from "./peer-pr-redact.js";
import { DEPLOY_LABEL_PREFIX } from "./scheduler-deploy.js";
import type { TeamBodyKind } from "./shared-ledger-contract-team-body.js";

/**
 * A review event as people read it. A verdict submitted through submit_verdict carries no text: verdict, counts and
 * findings (each with its description and probe) sit in data, so they are written out here. The report is named, not read: its path is the reviewer's.
 * One paragraph each for the verdict line, every finding (its probe stays with it) and the report; the text follows as it is.
 * The first line stays the verdict line: the web reads it there (web/features/collab/team-body/team-body-model.ts reviewOf).
 */
export function teamBodyReviewText(text: string, data: string): string {
  let d: Record<string, unknown> = {};
  try { const parsed = JSON.parse(data); if (parsed && typeof parsed === "object") d = parsed; } catch { /* text alone */ }
  const parts: string[] = [];
  if (typeof d.verdict === "string") parts.push(`审查结论 ${d.verdict} · P0 ${Number(d.p0) || 0} / P1 ${Number(d.p1) || 0} / P2 ${Number(d.p2) || 0}`);
  if (Array.isArray(d.findings)) for (const f of d.findings as Record<string, unknown>[]) {
    if (!f || typeof f !== "object") continue;
    const desc = typeof f.description === "string" && f.description ? `：${f.description}` : "";
    const finding = `- [${String(f.severity ?? "?")}] ${String(f.findingId ?? "")}${desc}`;
    // probe is required and, for older / CLI records without a description, the finding's only text.
    parts.push(typeof f.probe === "string" && f.probe ? `${finding}\n  复现：${f.probe}` : finding);
  }
  if (typeof d.path === "string" && d.path) parts.push(`报告：${basename(d.path)}（全文在主场）`);
  if (text) parts.push(text);
  return parts.join("\n\n");
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A deploy job's launchd label: the prefix plus 32 hex, which the gate masks as a long hex with its whole paragraph. */
const DEPLOY_LABEL = new RegExp(`(?<![A-Za-z0-9._-])${escape(DEPLOY_LABEL_PREFIX)}[0-9a-f]{24}([0-9a-f]{8})(?![0-9A-Za-z])`, "g");
/** A line that is nothing but one marker of an ask's auto-decided section (order-ask-default-spec.ts); no other HTML comment. */
const ASK_MARKER_LINE = /^[^\S\n]*<!-- \/?ask-default:[A-Za-z0-9_.:-]+ -->[^\S\n]*(?:\n|$)/gm;
/**
 * `repo:<org>/<repo>[/path]`, the local marker of a private repository (shared-ledger-source-dag-push-version.ts). Only ASCII
 * letters, digits and `._-` in front make it part of another word; the path runs to the first blank, quote or closing bracket.
 */
const REPO_TOKEN = String.raw`(?<![A-Za-z0-9._-])repo:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^\s\`'"<>)）\]】]*)?`;
const REPO_LIST_LINE = new RegExp(String.raw`^[^\S\n]*(?:[-*+]|\d+[.)])[^\S\n]+(\`?)${REPO_TOKEN}\1[^\S\n]*(?:\n|$)`, "gm");
const REPO_INLINE = new RegExp(REPO_TOKEN, "g");
const TEAM_BODY_PRIVATE_REPO = "[私仓路径]";

/**
 * One source text as it goes to the scrub; "" stays "". Local ledger and spec files are never rewritten.
 * - event: a full deploy label reads `deploy.<last 8>`, the form new receipts are written in (scheduler-deploy-tick.ts).
 * - spec: ask-default marker lines are dropped.
 * - every kind: a list item that is only a private-repo marker is dropped whole (no placeholder, as the DAG upload drops
 *   the glob); anywhere else the marker becomes TEAM_BODY_PRIVATE_REPO. Neither the org nor the repo name is kept.
 */
export function teamBodySourceText(kind: TeamBodyKind, raw: string): string {
  let out = raw;
  if (kind === "event") out = out.replace(DEPLOY_LABEL, "deploy.$1");
  if (kind === "spec") out = out.replace(ASK_MARKER_LINE, "");
  return out.replace(REPO_LIST_LINE, "").replace(REPO_INLINE, TEAM_BODY_PRIVATE_REPO);
}

/**
 * The heads the scrub is asked about: the cards' own plus every 40 / 64-hex candidate in this round's texts. The scrub
 * still keeps only what the install repository knows as a commit, so any other long hex is masked as before.
 */
export function teamBodyScrubHeads(heads: readonly string[], raws: readonly string[]): string[] {
  return [...new Set([...heads, ...raws.flatMap(hexCandidates)])];
}
