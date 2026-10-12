/** tmux 命令失败的说明文字（从 lib/tmux-helper.ts 原样搬出：那个文件行数封顶，tmuxRawStrict 抛错时用它）。tests/tmux-target.test.ts。 */

/** 单行的失败说明（纯函数，便于单测）。 */
export function formatTmuxFailure(args: string[], code: number | null, err: string): string {
  const cmd = `tmux ${args.join(" ")}`;
  const why = err || (code === null ? "（超时被杀，无输出）" : "（无 stderr 输出）");
  return `${cmd} 失败（exit ${code ?? "null"}）：${why}`;
}

/**
 * tmuxRawStrict 的失败：message 与 formatTmuxFailure 逐字相同，另带结构化字段供分辨「tmux 明确没执行」和「结果不明」。
 * code 为 null 或 ≥128 = 被信号终止（含 15 秒超时的 SIGKILL，Bun 报 137）。
 */
export class TmuxCommandError extends Error {
  constructor(args: string[], readonly code: number | null, readonly stderr: string) {
    super(formatTmuxFailure(args, code, stderr));
  }
  /** tmux 自己正常退出、退出码非 0 且说了原因（如命令过长）：确定什么都没执行。 */
  get refusedByTmux(): boolean {
    return this.code !== null && this.code > 0 && this.code < 128 && this.stderr !== "";
  }
}
