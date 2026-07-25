/**
 * 进程级异常兜底。
 *
 * 此前全仓库 `process.on(` 零命中：没有 uncaughtException，也没有 unhandledRejection。
 * Bun 的默认行为是打印后非零退出，配合 launchd 的 KeepAlive 确实能自愈 —— 但有两个
 * 实际问题：
 *   1. 死因经常看不见。stdout/stderr 分别重定向到 /tmp/claudestra-<name>.{out,err}，
 *      而崩溃栈打在哪、有没有被截断，取决于当时的缓冲状态；日志里常常只剩一个突然
 *      中断的时间线，排查时完全没线索。
 *   2. 分不清"崩了"和"正常退出"。两者在 launchd 眼里都是重启一次。
 *
 * 这里不改变 crash-only 的设计（照旧退出让 launchd 拉起），只保证**死因一定被写进
 * stderr**，并且带上进程名和时间戳，让日志能对上号。
 */

let installed = false;

/**
 * @param opts.exitOnCrash 崩溃后是否退出进程。
 *
 *   **默认 true，但 channel-server 必须传 false。** 区别在于有没有人把它拉起来：
 *   bridge / launcher / cron 都是 launchd KeepAlive 托管的，退出即重启，crash-only
 *   是安全的；而 channel-server 是 Claude Code 的 stdio 子进程，**没有任何守护**
 *   —— 实测 Claude Code 既不会在 stdio EOF 时 respawn，也不会自动重连，一旦进程
 *   没了就是该 agent 永久失联、只能人工 /mcp。给它装"未处理 rejection 就退出"
 *   等于把一条本来只是打印警告的路径升级成掉线事故。
 */
export function installCrashGuard(
  name: string,
  opts?: { exitOnCrash?: boolean }
): void {
  if (installed) return;
  installed = true;
  const exitOnCrash = opts?.exitOnCrash ?? true;

  const dump = (kind: string, err: unknown) => {
    const ts = new Date().toISOString();
    const detail =
      err instanceof Error
        ? `${err.name}: ${err.message}\n${err.stack ?? "(无 stack)"}`
        : typeof err === "object"
          ? JSON.stringify(err)
          : String(err);
    // 直接写 fd 2，不经 console —— 进程正在死，尽量少依赖还能不能正常工作的东西。
    try {
      process.stderr.write(`\n💥 [${ts}] ${name} ${kind}\n${detail}\n`);
    } catch {
      /* 连 stderr 都写不了就算了 */
    }
  };

  process.on("uncaughtException", (err) => {
    dump("uncaughtException", err);
    if (exitOnCrash) process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    dump("unhandledRejection", reason);
    if (exitOnCrash) process.exit(1);
  });
}
