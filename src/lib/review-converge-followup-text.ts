/**
 * The pure half of a downgrade follow-up (review-converge-followup.ts): why an item was demoted, the line PM reads when it
 * happens, and which probe paths may become the follow-up node's fileGlobs. The planner imports this without touching the
 * ledger. tests/review-converge-followup.test.ts.
 */
import { quoteExternal } from "./quote-text.js";
import { probePaths, type Downgrade, type DowngradeItem } from "./review-converge.js";

export const WHY_TEXT: Record<DowngradeItem["why"], string> = { no_basis: "没对应验收线", outside_diff: "修复 diff 外的新问题" };
const PER_NOTICE = 3;

/** The probe's first sentence, so PM can tell a misread marker at a glance. */
export function probeLead(probe: string): string {
  const flat = probe.replace(/\s+/g, " ").trim();
  const end = flat.search(/[。！？；]|[.!?;](?=\s|$)/);
  return end < 0 ? flat : flat.slice(0, end + 1);
}

/** 「F1 没对应验收线：『probe 开头』」 per demoted item, for the planner's pass notice (scheduler-plan.ts). */
export function downgradeBrief(d: Pick<Downgrade, "items">): string {
  const rows = d.items.slice(0, PER_NOTICE).map((i) => `${quoteExternal(i.findingId, 40)} ${WHY_TEXT[i.why]}：${quoteExternal(probeLead(i.probe), 80)}`);
  return rows.join("；") + (d.items.length > PER_NOTICE ? ` 等 ${d.items.length} 项` : "");
}

const PATH_CHAR = /[\p{L}\p{N}_@.~/-]/u;
/**
 * probePaths drops a token's leading `/` or `~/`, so ask the probe itself: the path must appear somewhere as written relative
 * (start of text, after a non-path character, or after `./`). `/package.json` or `~/repo/src/a.ts` never maps onto main's file.
 */
function writtenRelative(probe: string, p: string): boolean {
  for (let i = probe.indexOf(p); i >= 0; i = probe.indexOf(p, i + 1)) {
    const at = (k: number) => probe[k] ?? " ";
    if (!PATH_CHAR.test(at(i - 1)) || (at(i - 1) === "/" && at(i - 2) === "." && !PATH_CHAR.test(at(i - 3)))) return true;
  }
  return false;
}

/** Repo-relative paths a probe names; absolute / tmp ones are never files in the repo. */
const repoRelative = (probe: string, p: string): boolean => !/^(?:tmp|private|var|Users|home)\//.test(p) && writtenRelative(probe, p);

/**
 * fileGlobs for the follow-up node: probe paths that exist in the repo (main), or the source node's globs when none do.
 * A token like `void/done` or a bare `hold-slot.ts` the repo does not have is prose, not a lock.
 */
export function followUpGlobs(items: readonly Pick<DowngradeItem, "probe">[], own: readonly string[] | undefined,
  exists: (path: string) => boolean): string[] {
  const named = [...new Set(items.flatMap((i) => probePaths(i.probe).filter((p) => repoRelative(i.probe, p))))].filter((p) => exists(p));
  // The DAG accepts at most 50 globs. Cover all files for a larger report until PM narrows the draft, never drop locks.
  return named.length ? (named.length <= 50 ? named : ["**/*"]) : [...(own ?? ["**/*"])];
}
