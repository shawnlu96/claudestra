/** jsonl-watcher 的会话文件定位（从 bridge/jsonl-watcher.ts 原样搬出：它只用 lib 的函数，watcher 文件要腾出行数给 ACP 推送模式）。 */
import { existsSync, realpathSync } from "node:fs";
import { sourceFor } from "./runtimes/index.js";
import { findSessionJsonlBySessionId, sessionJsonlPath } from "./session-source.js";

/**
 * v2.23+ runtime 感知的会话文件定位。
 * Claude Code 的路径可预测（推算即可，文件还没生成也能算出将来在哪）；
 * Pi 的文件名带时间戳前缀，**只能扫目录**，所以这里每次调用都重新解析 ——
 * pending 轮询必须复用这个函数，不能缓存一次路径死等。
 */
export function resolveSessionPath(
  runtime: string | undefined, cwd: string, sessionId: string, sessionFile?: string,
): string | null {
  // ① 真源：Pi 扩展在 register 帧里自报的会话文件（文件名带时间戳，算不出来）
  if (sessionFile) {
    // 它是 agent 进程给的值，realpath 后必须落在 Pi 的会话根之下——否则一个失守的 agent
    // 进程能借它让 bridge 尾读任意 jsonl（比如 master 的会话）流进自己频道。
    // **只对 Pi 放行**：runtime 也可能来自自报，而 ~/.codex/sessions 里还有用户的私人
    // 会话——Codex 的 rollout 由 registry 的 sessionId 定位，通道进程也刻意不自报路径。
    try {
      const real = realpathSync(sessionFile);
      if (runtime === "pi" && sourceFor(runtime).ownsPath(real)) return real;
      console.warn(`⚠ 忽略越界的自报 sessionFile: ${sessionFile}`);
    } catch { /* 不存在 / 解析失败 → 走常规定位 */ }
  }
  const predicted = sessionJsonlPath(runtime, cwd, sessionId);
  if (predicted && existsSync(predicted)) return predicted;
  // 推算落空 → 按 sessionId 全库扫一遍兜底（slug/cwd 记录不准时自愈）
  const found = findSessionJsonlBySessionId(runtime, sessionId);
  return found && existsSync(found) ? found : null;
}
