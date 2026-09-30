/**
 * 归档副本的 runtime 从哪来：归档目录不在任何运行时的根下，路径认不出，只能靠旁边的 sidecar 或文件首行。
 *   sidecar  `<stem>.meta.json`（{runtime}），archiveSession 落盘时写；有它就不读正文
 *   首行     老归档没有 sidecar：读**完整**首行交给各运行时认。Codex 的 session_meta 带 base_instructions，
 *            实测单行 8KB 起，按固定字节截断必然解析失败（T75：截 512 字节时 Codex 归档全被当成 CC，历史 / 搜索为空）
 * 纯 fs，同步：sourceIdForPath 的调用方（历史、搜索、用量）都是同步拿 runtime 的（tests/codex-archive-read.test.ts）。
 */
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { writeFile, rename, unlink } from "node:fs/promises";

/** 首行读取上限：与 readCodexMetaPayload 同值，超过就当读不全 */
const FIRST_LINE_MAX_BYTES = 4 * 1024 * 1024;

export type FirstLine =
  | { kind: "line"; text: string } // 读到了换行
  | { kind: "eof"; text: string } // 到文件尾都没有换行（单行文件或正在写的半截）
  | { kind: "too-long" } // 上限内没见到换行
  | { kind: "unreadable" }; // 不存在 / 没权限 / 空文件

/** 从 64KB 起按 4 倍加宽，找到第一个换行为止，封顶 max */
export function readFirstLineSync(path: string, max: number = FIRST_LINE_MAX_BYTES): FirstLine {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { kind: "unreadable" }; // 调用方按「认不出」处理，且不缓存：文件可能稍后才出现
  }
  try {
    let buf = Buffer.alloc(Math.min(64 * 1024, max));
    let filled = 0;
    for (;;) {
      const n = readSync(fd, buf, filled, buf.length - filled, filled);
      const nl = buf.indexOf(0x0a, filled);
      filled += n;
      if (nl >= 0 && nl < filled) return { kind: "line", text: buf.toString("utf8", 0, nl) };
      if (n === 0 || filled < buf.length) {
        return filled === 0 ? { kind: "unreadable" } : { kind: "eof", text: buf.toString("utf8", 0, filled) };
      }
      if (buf.length >= max) return { kind: "too-long" };
      const next = Buffer.alloc(Math.min(buf.length * 4, max));
      buf.copy(next, 0, 0, filled);
      buf = next;
    }
  } catch {
    return { kind: "unreadable" }; // 读到一半出错（文件被换掉 / 权限变了）：同打不开
  } finally {
    closeSync(fd);
  }
}

/** `<dir>/<stem>.jsonl` → `<dir>/<stem>.meta.json`；不是 .jsonl 返回 null */
export function sessionSidecarPath(jsonlPath: string): string | null {
  return jsonlPath.endsWith(".jsonl") ? `${jsonlPath.slice(0, -".jsonl".length)}.meta.json` : null;
}

/** sidecar 里记的 runtime；没有 / 坏了 / 不是字符串 = null（调用方退回首行嗅探） */
export function readSidecarRuntime(jsonlPath: string): string | null {
  const p = sessionSidecarPath(jsonlPath);
  if (!p) return null;
  try {
    const runtime = JSON.parse(readFileSync(p, "utf8"))?.runtime;
    return typeof runtime === "string" && runtime ? runtime : null;
  } catch {
    return null; // 老归档没有 sidecar 是常态；坏的 sidecar 同样退回首行嗅探，不会比没有更糟
  }
}

/** 写 / 更新 sidecar（临时文件 + rename：读的一方不会读到半截）。内容已一致就不写 */
export async function writeSessionSidecar(jsonlPath: string, runtime: string): Promise<void> {
  const p = sessionSidecarPath(jsonlPath);
  if (!p || readSidecarRuntime(jsonlPath) === runtime) return;
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmp, `${JSON.stringify({ runtime })}\n`);
    await rename(tmp, p);
  } catch (e) {
    await unlink(tmp).catch(() => undefined); // 临时文件可能根本没写出来：删不掉无所谓，错误照样抛给调用方
    throw e;
  }
}
