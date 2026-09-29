/** tmux 命令失败的说明文字（从 lib/tmux-helper.ts 原样搬出：那个文件行数封顶，tmuxRawStrict 抛错时用它）。tests/tmux-target.test.ts。 */

/** 单行的失败说明（纯函数，便于单测）。 */
export function formatTmuxFailure(args: string[], code: number | null, err: string): string {
  const cmd = `tmux ${args.join(" ")}`;
  const why = err || (code === null ? "（超时被杀，无输出）" : "（无 stderr 输出）");
  return `${cmd} 失败（exit ${code ?? "null"}）：${why}`;
}
