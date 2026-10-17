/**
 * merge-arch-KEYSORT1 · order checks for registry files that cards insert lines into. The recovery key table is kept in JS default
 * sort order (UTF-16 code units) so inserts at different places merge on GitHub; a same-gap collision falls back to merge=union,
 * whose result puts the PR's line first and is out of order about half the time. The merge queue runs the check for each
 * file here on the union result it would push (scheduler-merge-union-git.ts) and refuses on a problem. Pure functions only.
 */
import { resourceKey } from "./ledger-scheduler.js";

const RECOVERY_TABLE_HEAD = "export const RECOVERY_KEYS = [";
const RECOVERY_KEY_LINE = /^ {2}"([^"\n]+)",$/;

/** Duplicate or out-of-order keys in the RECOVERY_KEYS block of recovery-keys.ts' text; null when it is unique and sorted. */
export function recoveryKeysOrderProblem(text: string): string | null {
  const lines = text.split("\n"), start = lines.indexOf(RECOVERY_TABLE_HEAD);
  const end = start < 0 ? -1 : lines.findIndex((l, i) => i > start && l.startsWith("]"));
  if (start < 0 || end < 0) return "找不到 RECOVERY_KEYS 表";
  const keys = lines.slice(start + 1, end).map((l) => RECOVERY_KEY_LINE.exec(l)?.[1]).filter((k): k is string => k !== undefined);
  const seen = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) return `有重复键：${k}`;
    seen.add(k);
  }
  for (let i = 1; i < keys.length; i++) {
    if (keys[i - 1]! > keys[i]!) return `不按字母序：${keys[i - 1]} 在 ${keys[i]} 前`;
  }
  return null;
}

/** union-merged file → its order check over the file's text (null = fine). */
export const ORDERED_UNION_FILES: Readonly<Record<string, (text: string) => string | null>> = Object.freeze({
  "src/lib/recovery-keys.ts": recoveryKeysOrderProblem,
});

/** The check registered for `file`, if any (own keys only: a path like "constructor" never reaches Object.prototype). */
export const orderCheckFor = (file: string): ((text: string) => string | null) | undefined =>
  Object.hasOwn(ORDERED_UNION_FILES, file) ? ORDERED_UNION_FILES[file] : undefined;

const UNION_FILE_KEYS: ReadonlySet<string> = new Set(Object.keys(ORDERED_UNION_FILES).map((f) => resourceKey(f) ?? f));
/**
 * UNIONLANE1: `resource` (a fileGlobs entry or a held file lock) names a file registered above. Normalized by resourceKey like
 * every lock: case does not matter, a `./` prefix or other unsafe spelling never matches, a glob is not the file itself.
 */
export function isOrderedUnionFile(resource: string): boolean {
  const key = resourceKey(resource);
  return key !== null && UNION_FILE_KEYS.has(key);
}
