/** Only explicitly supplied setup-tokens live here; a cleared record suppresses legacy environment fallback. */
import { chmodSync, constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR } from "./paths.js";
import { writeJsonAtomic } from "./state-file.js";

export const claudeTokenPath = (env: Record<string, string | undefined> = process.env) =>
  join(env.CLAUDESTRA_STATE_DIR || STATE_DIR, "lend-credentials", "claude-token.json");
const TOKEN_MAX = 8192;
interface RecordValue { token: string | null; savedAt: string | null }
export interface ClaudeTokenStatus { configured: boolean; savedAt: string | null }

function readRecord(path: string): RecordValue | undefined {
  let fd: number | undefined;
  try {
    lstatSync(path); // A missing file keeps legacy environment compatibility, even before directory migration.
    if (lstatSync(dirname(path)).isSymbolicLink() || (lstatSync(dirname(path)).mode & 0o077)) throw new Error("unsafe credential directory");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16_384 || (stat.mode & 0o077)) throw new Error("unsafe credential file");
    const r = JSON.parse(readFileSync(fd, "utf8"));
    if ((r.token !== null && typeof r.token !== "string") || (r.savedAt !== null && typeof r.savedAt !== "string")) throw new Error("invalid credential");
    if (r.token !== null && (!r.token || r.token.length > TOKEN_MAX || /[\s\x00-\x1f\x7f]/.test(r.token))) throw new Error("invalid credential");
    if (r.savedAt !== null && new Date(r.savedAt).toISOString() !== r.savedAt) throw new Error("invalid timestamp");
    return r;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // Malformed or unreadable credentials fail closed; never print file contents or parser errors.
    return { token: null, savedAt: null };
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function readClaudeLendToken(env: Record<string, string | undefined> = process.env): string | undefined {
  const r = readRecord(claudeTokenPath(env));
  return r === undefined ? env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || undefined : r.token?.trim() || undefined;
}

export function claudeTokenStatus(path = claudeTokenPath()): ClaudeTokenStatus {
  const r = readRecord(path);
  return { configured: !!r?.token, savedAt: r?.token ? r.savedAt : null };
}

export async function saveClaudeToken(token: string | null, path = claudeTokenPath()): Promise<ClaudeTokenStatus> {
  if (token !== null && (!token || token.length > TOKEN_MAX || /[\s\x00-\x1f\x7f]/.test(token))) throw new Error("invalid setup-token");
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (lstatSync(parent).isSymbolicLink()) throw new Error("unsafe credential directory");
  chmodSync(parent, 0o700);
  const savedAt = token ? new Date().toISOString() : null;
  await writeJsonAtomic(path, { token, savedAt }, { mode: 0o600, noFollow: true });
  return { configured: !!token, savedAt };
}
