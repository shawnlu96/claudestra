import { open, type FileHandle } from "node:fs/promises";
import { splitChunkLines, type ChunkLine } from "./jsonl-lines.js";

export interface ReadCursor {
  identity: string | null;
  observedSize: number;
  offset: number;
  lineNo: number;
  generation: number;
  source?: string;
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

/** Skip complete startup records, but leave any unfinished UTF-8 bytes on disk for the next read. */
export async function tailReadCursor(path: string): Promise<ReadCursor> {
  const file = await open(path, "r");
  try {
    const s = await file.stat();
    const cursor = newReadCursor();
    cursor.identity = `${s.dev}:${s.ino}`;
    cursor.source = `${cursor.identity}:0`;
    cursor.observedSize = s.size;
    for (let at = 0; at < s.size;) {
      const bytes = await readBytes(file, at, Math.min(at + 65536, s.size));
      if (!bytes.length) break;
      for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) { cursor.lineNo++; cursor.offset = at + i + 1; }
      at += bytes.length;
    }
    return cursor;
  } finally { await file.close(); }
}

/** fstat and reads share a handle so an atomic rename cannot mix the old size with the new file's bytes.
 * JSONL retains residual bytes on disk; shell consumes raw bytes and owns its streaming decoder / terminal tail rule. */
export async function readCursor(path: string, cursor: ReadCursor, mode: "jsonl" | "shell" = "jsonl"):
Promise<{ bytes: Uint8Array; lines: ChunkLine[]; reset: boolean; source: string }> {
  const file = await open(path, "r");
  try {
    const s = await file.stat();
    const identity = `${s.dev}:${s.ino}`;
    const reset = cursor.identity !== null && (identity !== cursor.identity || s.size < cursor.observedSize);
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
    cursor.source = `${identity}:${cursor.generation}`;
    cursor.observedSize = s.size;
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
