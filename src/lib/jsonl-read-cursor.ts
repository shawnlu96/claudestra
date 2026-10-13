import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { splitChunkLines, type ChunkLine } from "./jsonl-lines.js";

export interface ReadCursor {
  identity: string | null;
  observedSize: number;
  offset: number;
  lineNo: number;
  generation: number;
  source?: string;
  /** sha256 and byte length of the last complete line ending at offset; a new file repeating it continues this generation. */
  anchor?: { sha256: string; length: number };
}

export function newReadCursor(offset = 0): ReadCursor {
  return { identity: null, observedSize: offset, offset, lineNo: 0, generation: 0 };
}

async function readBytes(file: FileHandle, from: number, to: number): Promise<Uint8Array> {
  const buf = Buffer.alloc(to - from);
  let used = 0;
  while (used < buf.length) {
    const r = await file.read(buf, used, buf.length - used, from + used);
    if (!r.bytesRead) break;
    used += r.bytesRead;
  }
  return buf.subarray(0, used);
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Anchor on the last complete line of a chunk that starts at a line boundary. */
function anchorOf(bytes: Uint8Array): ReadCursor["anchor"] {
  if (!bytes.length) return undefined;
  // A lone blank line has no earlier newline; a negative lastIndexOf start would wrap to its own byte.
  const line = bytes.subarray(bytes.length > 1 ? bytes.lastIndexOf(10, bytes.length - 2) + 1 : 0);
  return { sha256: sha256(line), length: line.length };
}

/** Same content moved/rewritten, or only the unconsumed tail cut: the anchored line still ends exactly at offset. */
async function continuesAnchor(file: FileHandle, size: number, cursor: ReadCursor): Promise<boolean> {
  const a = cursor.anchor;
  if (!a || !a.length || size < cursor.offset || a.length > cursor.offset) return false;
  const start = cursor.offset - a.length;
  const bytes = await readBytes(file, Math.max(0, start - 1), cursor.offset);
  const line = start ? bytes.subarray(1) : bytes;
  return (start === 0 || bytes[0] === 10) && line.length === a.length && sha256(line) === a.sha256;
}

/** Skip complete startup records, but leave any unfinished UTF-8 bytes on disk for the next read. */
export async function tailReadCursor(path: string): Promise<ReadCursor> {
  const file = await open(path, "r");
  try {
    const s = await file.stat();
    const cursor = newReadCursor();
    cursor.identity = `${s.dev}:${s.ino}`;
    cursor.source = `${cursor.identity}:0`;
    cursor.observedSize = s.size;
    let lineStart = 0;
    for (let at = 0; at < s.size;) {
      const bytes = await readBytes(file, at, Math.min(at + 65536, s.size));
      if (!bytes.length) break;
      for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) { cursor.lineNo++; lineStart = cursor.offset; cursor.offset = at + i + 1; }
      at += bytes.length;
    }
    if (cursor.offset) cursor.anchor = anchorOf(await readBytes(file, lineStart, cursor.offset));
    return cursor;
  } finally { await file.close(); }
}

/** fstat and reads share a handle so an atomic rename cannot mix the old size with the new file's bytes.
 * A changed inode or shrunk size is a new generation (read from 0) unless, in JSONL mode, the anchored line still ends at offset.
 * JSONL retains residual bytes on disk; shell consumes raw bytes and owns its streaming decoder / terminal tail rule. */
export async function readCursor(path: string, cursor: ReadCursor, mode: "jsonl" | "shell" = "jsonl"):
Promise<{ bytes: Uint8Array; lines: ChunkLine[]; reset: boolean; source: string }> {
  const file = await open(path, "r");
  try {
    const s = await file.stat();
    const identity = `${s.dev}:${s.ino}`;
    const changed = cursor.identity !== null && (identity !== cursor.identity || s.size < cursor.observedSize);
    const reset = changed && !(mode === "jsonl" && await continuesAnchor(file, s.size, cursor));
    const offset = reset ? 0 : cursor.offset;
    const base = reset ? 0 : cursor.lineNo;
    const buf = await readBytes(file, offset, Math.max(offset, s.size));
    // A truncate during the read must be retried before changing the consumer's state.
    if ((await file.stat()).size < s.size) throw Object.assign(new Error("file truncated during cursor read; retry next poll"), { code: "ECURSORRETRY" });
    const used = mode === "shell" ? buf.length : buf.lastIndexOf(10) + 1;
    const bytes = buf.subarray(0, used);
    const chunk = splitChunkLines(new TextDecoder().decode(bytes), base);
    cursor.generation += reset ? 1 : 0;
    cursor.identity = identity;
    // A continued generation keeps its source so Stop's turn mark still matches the same turn.
    if (reset || !cursor.source) cursor.source = `${identity}:${cursor.generation}`;
    cursor.observedSize = s.size;
    if (reset) cursor.anchor = undefined;
    if (mode === "jsonl" && used) cursor.anchor = anchorOf(bytes);
    cursor.offset = offset + used;
    cursor.lineNo = chunk.next;
    return { bytes, lines: mode === "jsonl" ? chunk.lines : [], reset, source: cursor.source };
  } finally { await file.close(); }
}

/** The caller flushes completed messages first; then clearing queued work and tool state prevents old-generation carryover. */
export function resetReadState(state: {
  tools: unknown[]; toolMsgId: string | null; textQueue: string[]; answerParts: string[];
  textTimer: ReturnType<typeof setTimeout> | null; rateLimited: boolean; apiErrorTurn?: unknown; lastAssistantSeq?: number;
}): void {
  if (state.textTimer) clearTimeout(state.textTimer);
  Object.assign(state, { tools: [], toolMsgId: null, textQueue: [], answerParts: [], textTimer: null,
    rateLimited: false, apiErrorTurn: false, lastAssistantSeq: undefined });
}
