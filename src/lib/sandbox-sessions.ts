/**
 * 会话级的沙箱闸（manager 的 resume / adopt / takeover 调）。
 * - 沙箱里：按会话 id 恢复 / 收编一律不许——沙箱看不到生产 registry，给它一个生产会话 id 就会有两个进程
 *   同时写同一段对话。
 * - 生产里：不许接管沙箱的会话（cwd 在带 SANDBOX_MARKER 的目录下）——接管后那个生产 agent 的工作目录
 *   在沙箱根里，`sandbox clean` 会把它连目录删掉。
 */
import { openSync, readSync, closeSync } from "fs";
import { refuseInSandbox, sandboxRootOf } from "./sandbox.js";
import { findSessionJsonlBySessionId } from "./session-source.js";

/** Claude Code 会话的工作目录：读会话 jsonl 开头 64KB 里第一个带 cwd 的记录；找不到返回 null */
function sessionCwd(sessionId: string): string | null {
  const p = findSessionJsonlBySessionId("claude-code", sessionId);
  if (!p) return null;
  const buf = Buffer.alloc(65536);
  let n = 0;
  try {
    const fd = openSync(p, "r");
    n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
  } catch {
    return null; // 读不了就当查不到：调用方只是少一道判断，dir 参数那道仍在
  }
  for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
    try {
      const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
      if (typeof cwd === "string" && cwd) return cwd;
    } catch {
      /* 截断的最后一行 / 非 JSON：跳过 */
    }
  }
  return null;
}

/** resume / adopt 之前调：沙箱里直接拒绝；生产里目录或会话属于某个沙箱就拒绝 */
export function assertResumable(sessionId: string, dir?: string): void {
  refuseInSandbox("按会话 id 恢复 / 收编（会抢生产会话）");
  const home = process.env.HOME || "~";
  for (const d of [dir?.replace(/^~(?=$|\/)/, home), sessionCwd(sessionId)]) {
    const root = d ? sandboxRootOf(d) : null;
    if (root) throw new Error(`会话 ${sessionId.slice(0, 8)} 属于沙箱 ${root}：生产不接管沙箱的会话（sandbox clean 会删掉它的目录）`);
  }
}
