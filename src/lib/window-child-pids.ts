/** 自动迁移需要确认空窗；查进程失败不能按“没有孩子”处理。普通读侧保留宽松语义。 */
export async function readWindowChildren(target: string, strict: boolean, query: (args: string[]) => Promise<string>,
  children: (out: string, pid: number) => number[]): Promise<number[]> {
  const raw = await query(["list-panes", "-t", target, "-F", "#{pane_pid}"]);
  const lines = raw.trim().split("\n"), pid = Number(lines[0]);
  if (!Number.isInteger(pid) || pid <= 0 || (strict && lines.length !== 1)) {
    if (strict) throw new Error("pane PID 未确认，拒绝按空窗启动");
    return [];
  }
  const proc = Bun.spawn(["ps", "-eo", "pid=,ppid="], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (strict && (code !== 0 || !out.split("\n").some((l) => Number(l.trim().split(/\s+/)[0]) === pid))) {
    throw new Error(`进程列表未确认（exit ${code}）：${err.trim()}`);
  }
  return children(out, pid);
}
