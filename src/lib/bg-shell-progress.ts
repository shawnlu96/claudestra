/**
 * 后台 shell（run_in_background Bash）输出的增量消费与「真结束」判定（bg-activity-watcher → web 后台任务卡）。
 *
 * 结束信号只认 Claude Code 自己的输出约定：进程退出后 CC 往任务 .output 末尾追加一个独立行
 * `[exited with code N]`；任务被结束（TaskStop 等）时追加的是独立行 `[killed]`（前面可能还有一行 SIGTERM 提示），
 * 没有退出码，结局记「已停止」。**静默多久都不算结束**——重定向到文件的 `bun test > log` 可以十几分钟一字不写
 * （2026-10 实报：3 分钟不增长被判结束，实际 12 分钟才跑完）。文件消失 / 读失败也不证明结束了，只能算「状态未知」。
 *
 * 判定口径（两种终止行同一套，单测 tests/bg-shell-progress.test.ts）：
 *   - 必须整行精确匹配（允许 CRLF 的 \r），日志里「提到」这串字（前后有别的字、半截标记）不算（lib/shell-end-line.ts，与 web 共用的 twin）；
 *   - 必须是当前读到的**最后一行**：后面还有输出说明它只是普通日志行；
 *   - 带换行的终止行随读随收；没带换行的残尾要再等一轮 poll 文件不再增长才认（防止它只是更长一行的前半截）；
 *   - 跨多次读的半行、UTF-8 多字节被切开都靠 pending + 流式解码拼回。
 * 这是基于 CC 输出约定的判定，不声称任意程序输出都无法伪造这一行。
 */

import { shellEndOf, type ShellEnd } from "./shell-end-line.js";

const MAX_LINE = 300; // 单行渲染截断（与 subagent 行同量级，Discord / web 都按行展示）

export interface ShellProgress {
  /** 最后一个换行之后的残尾（下次读拼上） */
  pending: string;
  decoder: TextDecoder;
}

export function newShellProgress(): ShellProgress {
  return { pending: "", decoder: new TextDecoder() };
}

/** 吃进一段新字节：返回可渲染的完整行（已截断、去 \r、跳空行）与本段是否以独立终止行收尾 */
export function feedShellChunk(st: ShellProgress, bytes: Uint8Array): { lines: string[]; end: ShellEnd | null } {
  const parts = (st.pending + st.decoder.decode(bytes, { stream: true })).split("\n");
  st.pending = parts.pop() ?? "";
  const full = parts.map((l) => l.replace(/\r$/, ""));
  const lines = full.filter((l) => l.trim()).map((l) => l.slice(0, MAX_LINE));
  // 终止行必须是最后一个完整行、且后面没有残尾（有残尾 = 终止行之后还在输出，它只是普通日志）
  const last = full.length ? full[full.length - 1] : "";
  const end = !st.pending && full.length ? shellEndOf(last) : null;
  return { lines, end };
}

/** 本轮文件没再增长时调用：残尾恰好是完整终止行（CC 没补换行）→ 收进来当最后一行 */
export function settleShellTail(st: ShellProgress): { line: string; end: ShellEnd } | null {
  const end = shellEndOf(st.pending);
  if (!end) return null;
  const line = st.pending.replace(/\r$/, "");
  st.pending = "";
  return { line, end };
}
