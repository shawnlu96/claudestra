/**
 * 跑一条外部命令，超时一到立刻返回：子进程开在独立进程组里，超时整组 SIGKILL，结果不等管道关闭。
 * 为什么不用 quota-keychain 的 runWithTimeout：它杀的是直接子进程、再等 stdout/stderr 读完，git fetch 这类命令的孙进程
 * （ssh / git-remote-https）继承了管道，杀掉父进程后还会拖到自己退出（实测 1 s 超时拖到 8 s）。tests/run-bounded.test.ts。
 * 子进程自己退出后只再等 EXIT_GRACE_MS 收尾输出，留着管道的后台孙进程不算超时、退出码照实返回；
 * 调用方进程退出或收到 SIGINT / SIGTERM 时，还没结束的进程组一并杀掉（detached 的组收不到终端的 Ctrl-C）。
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
const EXIT_GRACE_MS = 200;

const live = new Set<number>();
let hooked = false;

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // 进程组已经没了（刚好自己退出）：没有要杀的
  }
}

/** 只装一次：退出时同步杀掉还登记着的组；收到信号先杀组、再按默认行为以该信号退出 */
function hookParentExit(): void {
  if (hooked) return;
  hooked = true;
  process.on("exit", () => live.forEach(killGroup));
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      live.forEach(killGroup);
      process.kill(process.pid, sig);
    });
  }
}

export function runBounded(argv: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs: number }): Promise<BoundedResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: (e as Error).message, timedOut: false });
      return;
    }
    const pid = child.pid;
    if (pid) {
      hookParentExit();
      live.add(pid);
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
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null, timedOut: boolean, extraErr = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      if (pid) {
        killGroup(pid); // 收尾：还占着管道的后台孙进程不留下
        live.delete(pid);
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code, stdout: out.join(""), stderr: err.join("") + extraErr, timedOut });
    };
    const timer = setTimeout(() => finish(null, true), opts.timeoutMs);
    child.on("error", (e) => finish(null, false, e.message)); // 命令不存在（ENOENT）等：按失败返回，原因进 stderr
    // exit 在进程退出时就来（管道可能还被孙进程占着）；再给一小段时间读完已写出的输出，close 先到就直接收尾
    child.on("exit", (code) => {
      grace = setTimeout(() => finish(code, false), EXIT_GRACE_MS);
    });
    child.on("close", (code) => finish(code, false));
  });
}
