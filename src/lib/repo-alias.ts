/**
 * rename-floka-REPOALIAS1 · the repository's old and new name (floka-repo/migrate.ts OFFICIAL_REPO → PROPOSED_REPO) compared as one.
 * After the GitHub transfer, gh answers with the new name while the ledger's tasks.pr / extra.repo and the origin keep the old one,
 * so every owner/repo or PR comparison that used exact strings would call the project's own card foreign.
 * - Only that one pair is aliased: another repository of the same owner, another org's `floka`, a fork all stay distinct, and no
 *   URL is rewritten. Values are normalised only inside a comparison; what is stored, shown or written to events stays raw.
 * - Recovery key `repoAlias` (off / observe / on, default observe): off and observe answer the exact comparison; observe logs one
 *   line per call site per hour when the aliased answer differs; on answers the aliased one. The key is read only when the two
 *   answers differ, i.e. only for an old-name / new-name pair. floka-repo/url.ts keeps its own exact detection on purpose.
 * tests/repo-alias*.test.ts.
 */
import { OFFICIAL_REPO, PROPOSED_REPO } from "./floka-repo/migrate.js";
import { readRecoveryFile, type RecoveryMode } from "./recovery-policy-file.js";
import type { ObservedAction } from "./recovery-policy.js";
import { statePath } from "./paths.js";

const KEY = "repoAlias";
/** The project whose recovery policy holds the switch: the repository being renamed is this project's. */
const PROJECT = "claude-orchestrator";
const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;
const OLD = OFFICIAL_REPO.toLowerCase();
const NEW = PROPOSED_REPO.toLowerCase();
/** GitHub owner rules; repository name never `.` / `..`; PR number a positive integer. Nothing else is a PR link. */
const PR_LINK = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/(?!\.\.?\/)([\w.-]{1,100})\/pull\/([1-9]\d*)\/?$/;

/** `owner/repo` lowercased, the old name mapped to the new one; anything not shaped `owner/repo` = null. */
export function canonicalRepo(repo: string | null | undefined): string | null {
  if (typeof repo !== "string" || !OWNER_REPO.test(repo)) return null;
  const lower = repo.toLowerCase();
  return lower === OLD ? NEW : lower;
}

/** Same repository once canonical; an invalid side is never equal (not even to another invalid one). */
export function sameRepo(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = canonicalRepo(a);
  return x !== null && x === canonicalRepo(b);
}

export const repoAllowed = (repo: string | null | undefined, repos: readonly string[]): boolean => repos.some((r) => sameRepo(repo, r));

/** A full PR link's repository (as written) and number; any other host, path or number = null. */
export function prParts(url: string | null | undefined): { repo: string; number: number } | null {
  const m = typeof url === "string" ? PR_LINK.exec(url) : null;
  const n = m ? Number(m[3]) : NaN;
  return m && Number.isSafeInteger(n) ? { repo: `${m[1]}/${m[2]}`, number: n } : null;
}

/** canonical repository + PR number, e.g. `floka-ai/floka#12`; not a full PR link = null. */
export function prKey(url: string | null | undefined): string | null {
  const p = prParts(url);
  const repo = p ? canonicalRepo(p.repo) : null;
  return p && repo ? `${repo}#${p.number}` : null;
}

export function samePr(a: string | null | undefined, b: string | null | undefined): boolean {
  const k = prKey(a);
  return k !== null && k === prKey(b);
}

let modeOf: () => RecoveryMode = readMode;
let observeSink: (a: ObservedAction) => void = (a) => console.warn(`[repo-alias] ${a.action}`);
const lastLogged = new Map<string, number>();
const HOUR_MS = 3_600_000;

/** keys.repoAlias → project mode → observe, the same order recoveryPolicy reads (the key is high-risk, so its default is observe);
 *  an unreadable file answers off like recoveryPolicy does. Read through the file reader, not recovery-policy.ts: that module
 *  reaches ledger-write, which imports order-deliver-pr, and this module sits under it. */
function readMode(): RecoveryMode {
  const r = readRecoveryFile(statePath("recovery-policy.json"));
  if (r.status === "corrupt") return "off";
  const cfg = r.status === "ok" && Object.hasOwn(r.data.projects, PROJECT) ? r.data.projects[PROJECT] : undefined;
  return cfg?.keys?.[KEY] ?? cfg?.mode ?? "observe";
}

function observeDiff(site: string, exact: unknown, aliased: unknown, now: number): void {
  const last = lastLogged.get(site);
  if (last !== undefined && now - last < HOUR_MS) return;
  lastLogged.set(site, now);
  const sample: ObservedAction = { project: PROJECT, mechanism: KEY, target: "", actionKey: site,
    action: `observe ${site}: 逐字比较 ${String(exact)}，新旧名归一后 ${String(aliased)}；repoAlias 不是 on，仍按逐字` };
  observeSink(sample);
}

/**
 * The call site's answer: `exact` is what it computed before (kept for off / observe), `aliased` the same question with the old
 * and new name as one. Callers build `aliased` as a superset of `exact` matches, so only the alias pair can make them differ.
 * `same` compares non-boolean answers (a found card, say); default Object.is.
 */
export function aliasPick<T>(site: string, exact: T, aliased: T, same: (a: T, b: T) => boolean = Object.is, now = Date.now()): T {
  if (same(exact, aliased)) return exact;
  const mode = modeOf();
  if (mode === "on") return aliased;
  if (mode === "observe") observeDiff(site, exact, aliased, now);
  return exact;
}

/** Two owner/repo identities at a call site: exact equality, or (repoAlias on) the renamed repository's old and new name as one.
 *  ledger verify compares origin / PR / extra.repo with it and keeps those values raw (extra.repo also feeds CI recovery's gh calls). */
export function aliasSameRepo(site: string, a: string | null, b: string | null): boolean {
  return aliasPick(site, a === b, a === b || sameRepo(a, b));
}

/** Tests only: pin the mode (null = the policy file again), capture observe lines, reset the hourly dedup. */
export function setRepoAliasForTest(o: { mode?: RecoveryMode | null; sink?: ((a: ObservedAction) => void) | null }): void {
  if (o.mode !== undefined) modeOf = o.mode === null ? readMode : () => o.mode as RecoveryMode;
  if (o.sink !== undefined) observeSink = o.sink ?? ((a) => console.warn(`[repo-alias] ${a.action}`));
  lastLogged.clear();
}
