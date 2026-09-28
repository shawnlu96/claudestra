/**
 * 跑一条外部命令，超时一到立刻返回：子进程开在独立进程组里，超时整组 SIGKILL，结果不等管道关闭。
 * 为什么不用 quota-keychain 的 runWithTimeout：它杀的是直接子进程、再等 stdout/stderr 读完，git fetch 这类命令的孙进程
 * （ssh / git-remote-https）继承了管道，杀掉父进程后还会拖到自己退出（实测 1 s 超时拖到 8 s）。tests/run-bounded.test.ts。
 */
import { spawn } from "node:child_process";

export interface BoundedResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** 输出上限：命令正常输出都在几十 KB 内，超了就截断（不让一个异常输出把内存吃满） */
const CAP = 1024 * 1024;

export function runBounded(argv: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs: number }): Promise<BoundedResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: (e as Error).message, timedOut: false });
      return;
    }
    const out: string[] = [];
    const err: string[] = [];
    let size = 0;
    const take = (buf: string[]) => (chunk: Buffer) => {
      if (size >= CAP) return;
      size += chunk.length;
      buf.push(chunk.toString("utf8"));
    };
    child.stdout?.on("data", take(out));
    child.stderr?.on("data", take(err));
    let done = false;
    const finish = (code: number | null, timedOut: boolean, extraErr = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: out.join(""), stderr: err.join("") + extraErr, timedOut });
    };
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // 进程组已经没了（刚好自己退出）：没有要杀的，照常按超时返回
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(null, true);
    }, opts.timeoutMs);
    child.on("error", (e) => finish(null, false, e.message)); // 命令不存在（ENOENT）等：按失败返回，原因进 stderr
    // close 在管道读完之后才触发；孙进程占着管道时它迟迟不来，超时那一支先返回
    child.on("close", (code) => finish(code, false));
  });
}
