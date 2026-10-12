import { readdirSync } from "node:fs";
import { join } from "node:path";
import { codexSessionIdFromFilename } from "./codex-session.js";
import { observationTime } from "./quota-observation.js";
import { judgeLedger, type RolloutSelector } from "./quota-observation-rollout-events.js";
import { indexRolloutFile, nodeRolloutIo, parseRateLimitLine, rolloutIndex, standingRolloutSelectors,
  trackRolloutSelector, type RolloutIo } from "./quota-observation-rollout-index.js";

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
  io?: RolloutIo;
}

// One identity for the default, so its kept events are found again on the next scan.
const anyLimits: RolloutSelector = () => true;
standingRolloutSelectors(anyLimits);

/** Inspect all observation lines: copied mtimes, clock rollback and trailing conversation do not bound their times. */
export function newestRateLimitEvent(lines: string[], now: number, diagnostic: (reason: string) => void,
  usable: (limits: unknown) => boolean = () => true): Pick<RolloutQuota, "rateLimits" | "observedAt"> | null {
  return newestEvent(lines.flatMap((line) => {
    const event = parseRateLimitLine(line);
    return event ? [event] : [];
  }), now, diagnostic, usable);
}

function newestEvent(events: Array<Pick<RolloutQuota, "rateLimits" | "observedAt">>, now: number,
  diagnostic: (reason: string) => void, usable: (limits: unknown) => boolean) {
  let best: Pick<RolloutQuota, "rateLimits" | "observedAt"> | null = null;
  for (const event of events) {
    const time = observationTime(event.observedAt, now);
    if (!time.eligible) { diagnostic("observation_" + time.qualification); continue; }
    if (usable(event.rateLimits) && (!best || event.observedAt >= best.observedAt)) best = event;
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

/**
 * Complete listing plus an incremental content index proves latest; interrupted scans return unknown.
 * `usable` must be a stable function of the limits alone: the index keeps its verdicts per function identity.
 * Register it with standingRolloutSelectors, or the first scan with it reads every file again from zero.
 */
export async function scanRolloutQuota(root: string, options: RolloutScanOptions = {}, usable: RolloutSelector = anyLimits) {
  const now = options.now ?? Date.now();
  const diagnostic = options.diagnostic ?? ((reason: string) => console.warn("[codex-quota] " + reason));
  // Archive length does not consume the content budget; unchanged files cost no reads.
  const listing = discover(root, options.maxFiles ?? Infinity, options.maxEntries ?? Infinity);
  let bytesRead = 0;
  let filesRead = 0;
  const incomplete = (reason: string) => {
    diagnostic(reason);
    return { complete: false, value: null, reason, filesRead, bytesRead };
  };
  if (!listing.complete) return incomplete("scan_incomplete_listing");
  const index = rolloutIndex(root, listing.files);
  trackRolloutSelector(index, usable);
  const io = options.io ?? nodeRolloutIo;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  let best: RolloutQuota | null = null;
  for (const path of listing.files) {
    try {
      const result = indexRolloutFile(index, path, { maxBytes: maxBytes - bytesRead, now, selector: usable, io });
      bytesRead += result.bytesRead;
      filesRead += result.filesRead;
      if (result.changed) return incomplete("scan_changed_file");
      if (!result.complete) return incomplete("scan_incomplete_bytes");
      // The clock is judged again on every scan; only events it can still change are kept to judge.
      const hit = judgeLedger(result.entry.ledger, now, usable, diagnostic);
      if (hit && (!best || hit.observedAt > best.observedAt)) best = { ...hit, path, ...result.entry.meta };
    } catch (error) {
      return incomplete("scan_read_failed:" + (error as Error).message);
    }
  }
  return { complete: true, value: best, reason: null, filesRead, bytesRead };
}
