/**
 * v2.23.2+ 追加读的行号坐标（watcher 给直播事件带 seq 用）。
 *
 * 会话 jsonl 的「seq」= 全文件行号（session-history 的 parseHistoryLines：
 * lineOffset + 行内下标，空行也占号）。watcher 只读 [lastSize, size) 的新增字节，
 * 要给每条记录报同一坐标系的 seq，就得知道新增块之前有多少个换行（base），块内
 * 按 "\n" 切分后的下标即偏移；块尾没有换行的半行（CC 极少分两次写一行）不计入
 * 下一块的 base，于是续写的后半段仍落在同一行号上——与历史侧一致。
 */
export interface ChunkLine {
  seq: number;
  line: string;
}

/** 把新增块切成带 seq 的行（空白行丢弃但仍占号），并给出下一块的 base。 */
export function splitChunkLines(chunk: string, base: number): { lines: ChunkLine[]; next: number } {
  const parts = chunk.split("\n");
  const lines: ChunkLine[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].trim()) continue;
    lines.push({ seq: base + i, line: parts[i] });
  }
  return { lines, next: base + parts.length - 1 };
}
