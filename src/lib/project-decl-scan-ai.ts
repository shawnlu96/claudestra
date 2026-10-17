/**
 * generality-PROJSCAN1 · optional model summary through codex.ts: a new thread (never a named or resumed session, whose policy is
 * unknown), explicit cwd in the isolation area, read-only, no global MCP. Codex read-only only removes write access; it does not
 * confine reads. Unless an isolation port attests that reads outside the target are impossible, the summary is refused and the
 * caller reports the manual entry. The model sees redacted discovery material and may only regroup or drop known candidate ids.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CodexResult, CodexRunOpts } from "./codex.js";
import type { CandidateGroup, DiscoveryResult } from "./project-decl-discovery.js";

export interface ReadIsolation { confined: boolean; evidence: string }
/** What the existing codex call can honestly claim today: write protection, not read confinement. */
export const CODEX_READ_ISOLATION: ReadIsolation = { confined: false,
  evidence: "codex read-only sandbox blocks writes only; reads outside the target repository are not prevented" };
export interface SummaryPorts { codex?: (opts: CodexRunOpts) => Promise<CodexResult>; isolation: ReadIsolation }
export type SummaryOutcome =
  | { status: "applied"; groups: Record<string, CandidateGroup | "skip">; ignoredIds: number }
  | { status: "refused" | "failed"; reason: string };

const SUMMARY_TIMEOUT_MS = 180_000;
const GROUPS = ["author", "review", "build", "tests", "skip"];

function prompt(d: DiscoveryResult): string {
  const material = {
    sources: d.sources.map((s) => ({ path: s.path, kind: s.kind, excerpt: s.text.slice(0, 1500) })),
    candidates: d.candidates.map((c) => ({ id: c.id, argv: c.argv, cwd: c.cwd, group: c.group, definition: c.definition })),
  };
  return ["You classify repository commands for a project declaration draft.",
    "Use only the JSON material below. Do not run tools, read files or use the network.",
    "For each candidate id choose one group: author, review, build, tests, or skip (skip anything that deploys or sends data).",
    "Reply with JSON only: {\"items\":[{\"id\":\"...\",\"group\":\"...\"}]}. Never invent ids or commands.",
    JSON.stringify(material)].join("\n");
}
function parseItems(message: string, ids: Set<string>): SummaryOutcome {
  const start = message.indexOf("{"), end = message.lastIndexOf("}");
  let raw: unknown;
  try { raw = JSON.parse(message.slice(start, end + 1)); }
  catch { return { status: "failed", reason: "SUMMARY_UNPARSABLE" }; /* deterministic grouping stays in force */ }
  const items = (raw as { items?: unknown })?.items;
  if (!Array.isArray(items)) return { status: "failed", reason: "SUMMARY_UNPARSABLE" };
  const groups: Record<string, CandidateGroup | "skip"> = {};
  let ignoredIds = 0;
  for (const item of items) {
    const { id, group } = (item ?? {}) as { id?: unknown; group?: unknown };
    if (typeof id !== "string" || !ids.has(id)) { ignoredIds++; continue; }
    if (typeof group !== "string" || !GROUPS.includes(group)) return { status: "failed", reason: "SUMMARY_INVALID_GROUP" };
    groups[id] = group as CandidateGroup | "skip";
  }
  return { status: "applied", groups, ignoredIds };
}

export async function summarizeDiscovery(d: DiscoveryResult, areaRoot: string, ports: SummaryPorts): Promise<SummaryOutcome> {
  if (!ports.isolation.confined) return { status: "refused", reason: "READ_ISOLATION_UNAVAILABLE" };
  const cwd = join(areaRoot, "summary");
  mkdirSync(cwd, { recursive: true });
  const codex = ports.codex ?? (await import("./codex.js")).runCodex;
  const result = await codex({ prompt: prompt(d), cwd, sandbox: "read-only", isolateMcp: true, timeoutMs: SUMMARY_TIMEOUT_MS });
  if (!result.ok) return { status: "failed", reason: "SUMMARY_UNAVAILABLE" };
  return parseItems(result.message, new Set(d.candidates.map((c) => c.id)));
}
