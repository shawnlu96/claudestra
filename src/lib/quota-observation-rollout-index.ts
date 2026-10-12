import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { codexSessionIdFromFilename } from "./codex-session.js";
import { admitEvent, advanceLedger, ledgerResidue, ledgerStale, newLedger, type EventLedger, type RolloutEvent,
  type RolloutSelector } from "./quota-observation-rollout-events.js";

interface RolloutStat { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
/** File access of the index; tests inject it to count reads (tests/quota-observation-index-incremental.test.ts). */
export interface RolloutIo {
  stat(path: string): RolloutStat;
  open(path: string): number;
  read(fd: number, buffer: Buffer, length: number, position: number): number;
  close(fd: number): void;
}
export const nodeRolloutIo: RolloutIo = {
  stat: (path) => statSync(path),
  open: (path) => openSync(path, "r"),
  read: (fd, buffer, length, position) => readSync(fd, buffer, 0, length, position),
  close: (fd) => closeSync(fd),
};

/** Bytes before the resume offset that must be unchanged for a grown file to count as appended to. */
export const ROLLOUT_TAIL_CHECK_BYTES = 256;
const CHUNK_BYTES = 64 * 1024;
const NEWLINE = 0x0a;
const RATE_LIMITS_KEY = '"rate_limits"';
// Callers that pass a fresh closure per scan must not grow every file's ledger without bound.
const MAX_AD_HOC_SELECTORS = 4;
const standing: RolloutSelector[] = [];

/**
 * Selectors every index tracks from the first read on. A selector first seen after a file was read finds its
 * events already dropped and costs a read of that file from zero, which a byte budget may not allow.
 */
export function standingRolloutSelectors(...selectors: RolloutSelector[]): void {
  for (const selector of selectors) if (!standing.includes(selector)) standing.push(selector);
}

interface IndexedFile {
  /** As of the last read; a later stat that differs means there is something to reconcile. */
  stat: RolloutStat;
  offset: number;
  /** The last bytes before `offset`. */
  check: Buffer;
  /** Bytes after the last newline: a line still being written, or one cut by the byte budget. */
  pending: Buffer[];
  firstLine: boolean;
  meta: { sessionId: string; cwd: string | null };
  ledger: EventLedger;
}
export interface RolloutIndex { files: Map<string, IndexedFile>; selectors: RolloutSelector[] }

// Bound the number of independent roots so temporary scans do not keep entire indexes alive.
const roots = new Map<string, RolloutIndex>();
export function rolloutIndex(root: string, files: string[]): RolloutIndex {
  const key = resolve(root);
  const index = roots.get(key) ?? { files: new Map<string, IndexedFile>(), selectors: [] };
  roots.delete(key);
  roots.set(key, index);
  if (roots.size > 8) roots.delete(roots.keys().next().value!);
  const present = new Set(files);
  for (const path of index.files.keys()) if (!present.has(path)) index.files.delete(path);
  return index;
}

/** Make room for a selector that is not a standing one; the least recently used ad hoc one gives up its kept events. */
export function trackRolloutSelector(index: RolloutIndex, selector: RolloutSelector): void {
  const adHoc = index.selectors.filter((known) => known !== selector && !standing.includes(known));
  if (!standing.includes(selector)) adHoc.push(selector);
  const dropped = adHoc.splice(0, Math.max(0, adHoc.length - MAX_AD_HOC_SELECTORS));
  index.selectors = [...standing, ...adHoc];
  for (const entry of index.files.values()) for (const gone of dropped) entry.ledger.best.delete(gone);
}

/** Per file: distinct events kept (at most one per tracked selector), selectors tracked, events still in the future. */
export function rolloutIndexResidue(root: string): Array<{ path: string; kept: number; selectors: number; future: number }> {
  return [...(roots.get(resolve(root))?.files ?? [])].map(([path, entry]) => ({ path, ...ledgerResidue(entry.ledger) }));
}

// ctime and inode catch replacement and equal-size rewrites with restored mtime.
const sameStat = (a: RolloutStat, b: RolloutStat) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const grownFrom = (now: RolloutStat, then: RolloutStat) => now.dev === then.dev && now.ino === then.ino && now.size > then.size;

export function parseRateLimitLine(line: string): RolloutEvent | null {
  if (!line.includes(RATE_LIMITS_KEY)) return null;
  let e;
  try { e = JSON.parse(line); } catch { return null; } // Partial/corrupt JSON is not an observation.
  const p = e?.payload;
  if (e?.type !== "event_msg" || p?.type !== "token_count" || !p.rate_limits || typeof p.rate_limits !== "object") return null;
  return { rateLimits: p.rate_limits, observedAt: typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN };
}

function consumeLine(entry: IndexedFile, line: Buffer): void {
  if (entry.firstLine) {
    entry.firstLine = false;
    try {
      const first = JSON.parse(line.toString("utf8"));
      const p = first?.type === "session_meta" ? first.payload : null;
      if (p) entry.meta = { sessionId: String(p.id ?? p.session_id ?? entry.meta.sessionId),
        cwd: typeof p.cwd === "string" ? p.cwd : null };
    } catch { /* Invalid metadata leaves the observation unbound and uses the filename id. */ }
  }
  // Conversation lines run to megabytes; only candidates are decoded.
  if (!line.includes(RATE_LIMITS_KEY)) return;
  const event = parseRateLimitLine(line.toString("utf8"));
  if (event) admitEvent(entry.ledger, event);
}

/** Complete lines only: bytes after the last newline wait for the rest of their line. The chunk is reused, so they are copied. */
function consumeChunk(entry: IndexedFile, chunk: Buffer): void {
  let start = 0;
  for (let end = chunk.indexOf(NEWLINE); end !== -1; end = chunk.indexOf(NEWLINE, start)) {
    const rest = chunk.subarray(start, end);
    consumeLine(entry, entry.pending.length ? Buffer.concat([...entry.pending, rest]) : rest);
    entry.pending = [];
    start = end + 1;
  }
  if (start < chunk.length) entry.pending.push(Buffer.from(chunk.subarray(start)));
  entry.check = chunk.length >= ROLLOUT_TAIL_CHECK_BYTES
    ? Buffer.from(chunk.subarray(chunk.length - ROLLOUT_TAIL_CHECK_BYTES))
    : Buffer.from(Buffer.concat([entry.check, chunk]).subarray(-ROLLOUT_TAIL_CHECK_BYTES));
}

function freshEntry(path: string, stat: RolloutStat, now: number, selectors: readonly RolloutSelector[]): IndexedFile {
  return { stat, offset: 0, check: Buffer.alloc(0), pending: [], firstLine: true,
    meta: { sessionId: codexSessionIdFromFilename(basename(path)) ?? "", cwd: null }, ledger: newLedger(now, selectors) };
}

/** An appended-to file still ends its already-read part with the bytes seen last time. */
function tailUnchanged(io: RolloutIo, fd: number, entry: IndexedFile): { ok: boolean; bytes: number } {
  const want = entry.check.length;
  if (want === 0) return { ok: true, bytes: 0 };
  const seen = Buffer.alloc(want);
  let bytes = 0;
  while (bytes < want) {
    const n = io.read(fd, seen.subarray(bytes), want - bytes, entry.offset - want + bytes);
    if (n === 0) break;
    bytes += n;
  }
  return { ok: bytes === want && seen.equals(entry.check), bytes };
}

export interface IndexRead { maxBytes: number; now: number; selector: RolloutSelector; io: RolloutIo }

/**
 * Budget applies to new content. An interrupted file resumes; a file that only grew on the same inode resumes
 * after its last read bytes are verified; anything else restarts from byte zero. A file that changes while it is
 * read is reported changed (the scan stays unknown), but an append keeps the bytes read for the next scan.
 */
export function indexRolloutFile(index: RolloutIndex, path: string, { maxBytes, now, selector, io }: IndexRead) {
  const before = io.stat(path);
  let entry = index.files.get(path);
  if (entry && ledgerStale(entry.ledger, now, selector)) entry = undefined;
  let verify = false;
  if (entry && !sameStat(entry.stat, before)) {
    if (grownFrom(before, entry.stat)) verify = true;
    else entry = undefined;
  }
  entry ??= freshEntry(path, before, now, index.selectors);
  advanceLedger(entry.ledger, now);
  const done = (bytesRead: number, filesRead: number, changed: boolean) =>
    ({ entry: entry!, complete: entry!.offset === before.size, bytesRead, filesRead, changed });
  if (!verify && entry.offset === before.size) {
    index.files.set(path, entry);
    return done(0, 0, false);
  }
  const budget = Math.max(0, maxBytes);
  if (budget === 0) return done(0, 0, false);
  const fd = io.open(path);
  let bytesRead = 0;
  try {
    if (verify) {
      const tail = tailUnchanged(io, fd, entry);
      bytesRead += tail.bytes;
      if (!tail.ok) entry = freshEntry(path, before, now, index.selectors);
    }
    const count = Math.min(before.size - entry.offset, budget);
    const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, count));
    let got = 0;
    while (got < count) {
      const n = io.read(fd, buffer, Math.min(buffer.length, count - got), entry.offset);
      if (n === 0) break;
      entry.offset += n;
      got += n;
      consumeChunk(entry, buffer.subarray(0, n));
    }
    bytesRead += got;
    entry.stat = before;
    const after = io.stat(path);
    const changed = !sameStat(after, before) || got !== count;
    // Bytes read before an append are still the file's prefix; a short read or any other change is not trusted.
    if (got !== count || (changed && !grownFrom(after, before))) index.files.delete(path);
    else index.files.set(path, entry);
    return done(bytesRead, 1, changed);
  } catch (error) {
    index.files.delete(path); // Discard partially mutated state so a later retry cannot skip unread bytes.
    throw error;
  } finally {
    io.close(fd);
  }
}
