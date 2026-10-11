import { closeSync, openSync, readSync, statSync, type Stats } from "node:fs";
import { basename, resolve } from "node:path";
import { codexSessionIdFromFilename } from "./codex-session.js";
import type { RolloutQuota } from "./quota-observation-rollout.js";

type Event = Pick<RolloutQuota, "rateLimits" | "observedAt">;
interface IndexedFile {
  fingerprint: string;
  offset: number;
  complete: boolean;
  decoder: TextDecoder;
  tail: string;
  firstLine: boolean;
  meta: Pick<RolloutQuota, "sessionId" | "cwd">;
  events: Event[];
}

// Completed files retain only quota observations; partial files also retain their unfinished line.
// Bound the number of independent roots so temporary scans do not keep entire indexes alive.
const roots = new Map<string, Map<string, IndexedFile>>();
export function rolloutIndex(root: string, files: string[]): Map<string, IndexedFile> {
  const key = resolve(root);
  const index = roots.get(key) ?? new Map<string, IndexedFile>();
  roots.delete(key);
  roots.set(key, index);
  if (roots.size > 8) roots.delete(roots.keys().next().value!);
  const present = new Set(files);
  for (const path of index.keys()) if (!present.has(path)) index.delete(path);
  return index;
}

function fingerprint(stat: Stats): string {
  // ctime and inode catch replacement and equal-size rewrites with restored mtime.
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

export function parseRateLimitLine(line: string): Event | null {
  if (!line.includes('"rate_limits"')) return null;
  let e;
  try { e = JSON.parse(line); } catch { return null; } // Partial/corrupt JSON is not an observation.
  const p = e?.payload;
  if (e?.type !== "event_msg" || p?.type !== "token_count" || !p.rate_limits || typeof p.rate_limits !== "object") return null;
  return { rateLimits: p.rate_limits, observedAt: typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN };
}

function consumeLine(entry: IndexedFile, line: string): void {
  if (entry.firstLine) {
    entry.firstLine = false;
    try {
      const first = JSON.parse(line);
      const p = first?.type === "session_meta" ? first.payload : null;
      if (p) entry.meta = { sessionId: String(p.id ?? p.session_id ?? entry.meta.sessionId),
        cwd: typeof p.cwd === "string" ? p.cwd : null };
    } catch { /* Invalid metadata leaves the observation unbound and uses the filename id. */ }
  }
  const event = parseRateLimitLine(line);
  if (event) entry.events.push(event);
}

function consumeText(entry: IndexedFile, text: string, final: boolean): void {
  const lines = (entry.tail + text).split("\n");
  entry.tail = lines.pop()!;
  for (const line of lines) consumeLine(entry, line);
  if (final) {
    if (entry.tail) consumeLine(entry, entry.tail);
    entry.tail = "";
  }
}

/** Budget applies to new I/O. Interrupted files resume; changed files restart from byte zero. */
export function indexRolloutFile(index: Map<string, IndexedFile>, path: string, maxBytes: number) {
  const before = statSync(path);
  const stamp = fingerprint(before);
  let entry = index.get(path);
  if (!entry || entry.fingerprint !== stamp) {
    entry = { fingerprint: stamp, offset: 0, complete: false, decoder: new TextDecoder(), tail: "", firstLine: true,
      meta: { sessionId: codexSessionIdFromFilename(basename(path)) ?? "", cwd: null }, events: [] };
  }
  if (entry.complete) return { entry, bytesRead: 0, filesRead: 0, changed: false };
  const count = Math.min(before.size - entry.offset, Math.max(0, maxBytes));
  if (count === 0 && entry.offset < before.size) return { entry, bytesRead: 0, filesRead: 0, changed: false };
  const fd = openSync(path, "r");
  let bytesRead = 0;
  try {
    const buffer = Buffer.alloc(Math.min(64 * 1024, count));
    while (bytesRead < count) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, count - bytesRead), entry.offset);
      if (n === 0) break;
      entry.offset += n;
      bytesRead += n;
      consumeText(entry, entry.decoder.decode(buffer.subarray(0, n), { stream: true }), false);
    }
    entry.complete = entry.offset === before.size;
    if (entry.complete) consumeText(entry, entry.decoder.decode(), true);
    const changed = fingerprint(statSync(path)) !== stamp || bytesRead !== count;
    if (changed) index.delete(path);
    else index.set(path, entry);
    return { entry, bytesRead, filesRead: 1, changed };
  } catch (error) {
    index.delete(path); // Discard partially mutated state so a later retry cannot skip unread bytes.
    throw error;
  } finally {
    closeSync(fd);
  }
}
