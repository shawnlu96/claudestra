import { readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { codexSessionIdFromFilename } from "./codex-session.js";
import { observationTime } from "./quota-observation.js";

type RecordValue = Record<string, any>;
export interface RolloutQuota {
  rateLimits: RecordValue;
  observedAt: number;
  path: string;
  sessionId: string;
  cwd: string | null;
}

export interface RolloutScanOptions {
  now?: number;
  maxFiles?: number;
  maxBytes?: number;
  maxEntries?: number;
  diagnostic?: (reason: string) => void;
}

/** Inspect all observation lines: copied mtimes, clock rollback and trailing conversation do not bound their times. */
export function newestRateLimitEvent(lines: string[], now: number, diagnostic: (reason: string) => void,
  usable: (limits: unknown) => boolean = () => true): Pick<RolloutQuota, "rateLimits" | "observedAt"> | null {
  let best: Pick<RolloutQuota, "rateLimits" | "observedAt"> | null = null;
  for (const line of lines) {
    if (!line.includes('"rate_limits"')) continue;
    let e: RecordValue;
    try { e = JSON.parse(line); } catch { continue; } // A partial/corrupt line is not an observation.
    const p = e?.payload;
    if (e?.type !== "event_msg" || p?.type !== "token_count" || !p.rate_limits || typeof p.rate_limits !== "object") continue;
    const at = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
    const time = observationTime(at, now);
    if (!time.eligible) { diagnostic("observation_" + time.qualification); continue; }
    if (usable(p.rate_limits) && (!best || at >= best.observedAt)) best = { rateLimits: p.rate_limits, observedAt: at };
  }
  return best;
}

function discover(root: string, maxFiles: number, maxEntries: number): { files: string[]; complete: boolean } {
  const dirs = [root];
  const files: string[] = [];
  let entries = 0;
  while (dirs.length) {
    const dir = dirs.pop()!;
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch (error) {
      if (dir === root && (error as NodeJS.ErrnoException).code === "ENOENT") return { files, complete: true };
      return { files, complete: false };
    }
    for (const ent of ents) {
      if (++entries > maxEntries) return { files, complete: false };
      const path = join(dir, ent.name);
      if (ent.isDirectory()) dirs.push(path);
      else if (ent.isFile() && codexSessionIdFromFilename(ent.name)) {
        if (files.length >= maxFiles) return { files, complete: false };
        files.push(path);
      }
    }
  }
  return { files, complete: true };
}

function quotaMeta(lines: string[], path: string): Pick<RolloutQuota, "sessionId" | "cwd"> {
  let p: RecordValue = {};
  try {
    const first = JSON.parse(lines[0] ?? "");
    if (first?.type === "session_meta") p = first.payload ?? {};
  } catch { /* Invalid metadata leaves the observation unbound and uses the filename id. */ }
  return { sessionId: String(p.id ?? p.session_id ?? codexSessionIdFromFilename(basename(path)) ?? ""),
    cwd: typeof p.cwd === "string" ? p.cwd : null };
}

/** Incomplete scans never publish a best-so-far value as the latest observation. */
export async function scanRolloutQuota(root: string, options: RolloutScanOptions = {},
  usable: (limits: unknown) => boolean = () => true) {
  const now = options.now ?? Date.now();
  const diagnostic = options.diagnostic ?? ((reason: string) => console.warn("[codex-quota] " + reason));
  const listing = discover(root, options.maxFiles ?? 256, options.maxEntries ?? 4096);
  let bytesRead = 0;
  let filesRead = 0;
  const incomplete = (reason: string) => {
    diagnostic(reason);
    return { complete: false, value: null, reason, filesRead, bytesRead };
  };
  if (!listing.complete) return incomplete("scan_incomplete_listing");
  let best: RolloutQuota | null = null;
  for (const path of listing.files) {
    try {
      const before = statSync(path);
      if (bytesRead + before.size > (options.maxBytes ?? 32 * 1024 * 1024)) return incomplete("scan_incomplete_bytes");
      const text = await Bun.file(path).slice(0, before.size).text();
      bytesRead += before.size;
      filesRead++;
      const after = statSync(path);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) return incomplete("scan_changed_file");
      const lines = text.split("\n");
      const hit = newestRateLimitEvent(lines, now, diagnostic, usable);
      if (hit && (!best || hit.observedAt > best.observedAt)) best = { ...hit, path, ...quotaMeta(lines, path) };
    } catch (error) {
      return incomplete("scan_read_failed:" + (error as Error).message);
    }
  }
  return { complete: true, value: best, reason: null, filesRead, bytesRead };
}
