/**
 * 以子进程跑 `manager.ts <args>` 并取回它的 JSON 结果——bridge（management.ts）和
 * cron 共用这一份。
 *
 * 为什么收成一份（2026-09 审查 D7-7 / D6-2）：两份旧实现都把 stderr 设成 pipe 却从不
 * 读。manager 顶层崩溃（import/语法错误、锁抛错）时 stdout 是空的，调用方只能看到
 * 一句「manager 执行失败」，真正的原因在没人读的 stderr 里；不读还可能让管道写满、
 * 子进程卡住。cron 那份还没有超时。launcher 的 runCmd 早就为同一个坑修过
 * （2026-07-27「brew 更新失败:」后面什么都没有）。
 */

export interface RawRun {
  cmd: string;
  out: string;
  err: string;
  exitCode: number | null;
  timedOut: boolean;
  budgetMs: number;
}

/** stderr 末 n 行（去空行），拼进错误信息用 */
export function stderrTail(err: string, n = 3): string {
  return err
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-n)
    .join(" | ");
}

/** 纯函数：把一次子进程运行解释成 manager 的结果对象。 */
export function interpretManagerRun(r: RawRun): any {
  if (r.timedOut) {
    return { ok: false, error: `manager ${r.cmd} 超时（>${r.budgetMs / 1000}s）已强杀` };
  }
  const text = r.out.trim();
  try {
    // manager 失败时也会输出 {ok:false,error} 并以 1 退出——有 JSON 就以 JSON 为准
    return JSON.parse(text);
  } catch {
    const tail = stderrTail(r.err);
    const parts = [text || `manager ${r.cmd} 执行失败`, `exit=${r.exitCode ?? "?"}`];
    if (tail) parts.push(`stderr: ${tail}`);
    return { ok: false, error: parts.join("；") };
  }
}

export interface RunManagerOpts {
  bunPath: string;
  managerPath: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
}

export async function runManagerProcess(args: string[], opts: RunManagerOpts): Promise<any> {
  const proc = Bun.spawn([opts.bunPath, "run", opts.managerPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: opts.env ?? process.env,
  });
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(9); } catch { /* 已退出 */ }
  }, opts.timeoutMs);
  try {
    // stdout / stderr 并发读完，防任何一边写满管道把子进程卡住
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return interpretManagerRun({ cmd: args[0] ?? "", out, err, exitCode, timedOut, budgetMs: opts.timeoutMs });
  } finally {
    clearTimeout(killer);
  }
}

/**
 * `manager list` 的严格版：失败就抛，而不是返回空列表。
 * watcher 们以前 `list.agents || []` + `catch {}`，manager 一坏就当成「没有 agent」，
 * 卡死检测、链路哨兵全部静默失明。
 */
export function agentsFromList(result: any): any[] {
  if (!result || result.ok === false) {
    throw new Error(`manager list 失败: ${result?.error ?? "无输出"}`);
  }
  return Array.isArray(result.agents) ? result.agents : [];
}

/**
 * 按「状态切换」打日志：同一组件连续失败只在第一次喊，恢复时说一声。
 * 轮询型 watcher 每几秒跑一次，不能每轮刷一行。
 */
export function createFailureLatch(component: string, log: (msg: string) => void = console.error) {
  let failing = false;
  return {
    fail(err: unknown): void {
      if (failing) return;
      failing = true;
      log(`⚠️ [${component}] 失败，本轮跳过（恢复前不再重复报）: ${(err as Error)?.message ?? String(err)}`);
    },
    ok(): void {
      if (!failing) return;
      failing = false;
      log(`✅ [${component}] 已恢复`);
    },
    get failing() { return failing; },
  };
}
