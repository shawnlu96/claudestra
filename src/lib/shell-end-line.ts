/**
 * 后台 shell 终止行的解析规则（src / web 各一份，登记成 twin：scripts/guard/config.ts TWINS，去注释后逐行一致，改一边另一边跟着改）：
 * bridge 增量读输出（src/lib/bg-shell-progress.ts）与网页卡片收尾（web/features/chat/bg-shell-state.ts）都用它判结局。
 * CC 进程退出后在输出末尾追加独立行 `[exited with code N]`；任务被结束（TaskStop 等）时追加独立行 `[killed]`，没有退出码。
 * 必须整行精确匹配（允许 CRLF 的 \r）：日志里「提到」这串字（前后有别的字、大小写不同、半截标记）不算。
 */

const EXIT_LINE = /^\[exited with code (-?\d+)\]$/;
const KILLED_LINE = "[killed]";

/** 进程结局：退出行 → done + 退出码；[killed] → stopped（被结束，不是成功也不是失败） */
export type ShellEnd = { status: "done"; exitCode: number } | { status: "stopped"; exitCode: null };

/** 整行精确匹配退出标记 → 退出码；否则 null */
export function exitCodeOf(line: string): number | null {
  const m = EXIT_LINE.exec(line.replace(/\r$/, ""));
  return m ? Number(m[1]) : null;
}

/** 整行精确匹配终止行（退出行 / [killed]）→ 结局；否则 null */
export function shellEndOf(line: string): ShellEnd | null {
  if (line.replace(/\r$/, "") === KILLED_LINE) return { status: "stopped", exitCode: null };
  const code = exitCodeOf(line);
  return code === null ? null : { status: "done", exitCode: code };
}
