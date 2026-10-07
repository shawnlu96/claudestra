/**
 * 统一的受控收尾（I12、B57）：stdin EOF、信号、ACP 线路损坏、app-server 退出、协议错误、投递结果不明都走这一套，只跑一次。
 * ① 停止接受新请求 → ② 扫一次进程树 → ③ 关 app-server 的 stdin → ④ 等它退出最多 0.8s，清理集合还有活的就 SIGTERM →
 * ⑤ 1.6s 时再扫、还有活的 SIGKILL → 全量扫出「仍存活的相关进程」→ ⑥ 这时才写结果（卡上能说清还有谁活着）→ ⑦ stdout 最多排空 300ms 后退出。
 * 收到信号走快路径：扫完立即 SIGTERM，0.5s 后 SIGKILL，0.8s 内退出。都早于宿主 3s 后补的 SIGTERM（adapter-proc.ts）。
 * 宿主断开 / 信号退出码 0，其余 1（宿主照样重起）。tests/codex-adapter-shutdown.test.ts。
 */
import type { Survivor } from "./proc-tree.js";
import type { FatalCause } from "./turns.js";

/** 进程树的最小接口（proc-tree.ts 的 ProcTree） */
export interface Tree {
  scan(full?: boolean): Promise<void>;
  alive(): boolean;
  kill(sig: "SIGTERM" | "SIGKILL"): void;
  survivors(): Promise<Survivor[]>;
}

const TIMINGS = { graceMs: 800, killMs: 1_600, fastKillMs: 500, drainMs: 300 };

export interface ShutdownDeps {
  /** ①：服务端不再接请求、回合状态机放行所有等待 */
  stop(): void;
  closeAppStdin(): void;
  appExited: Promise<unknown>;
  tree: Tree;
  /** ⑥：tail 是写进结果的存活进程说明（没有就是空串） */
  writeResults(cause: FatalCause, tail: string): void;
  /** 收尾报告（只含 pid、ppid、pgid、可执行文件名、角色、来源） */
  report(left: Survivor[]): void;
  flush(): Promise<void>;
  exit(code: number): void;
  log(msg: string): void;
  timings?: Partial<typeof TIMINGS>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 返回触发函数：第一次触发生效，之后的只记日志 */
export function createShutdown(d: ShutdownDeps): (cause: FatalCause, opts?: { signal?: boolean }) => void {
  const t = { ...TIMINGS, ...d.timings };
  let started = false;

  const reap = async (fast: boolean) => {
    await d.tree.scan();
    d.closeAppStdin();
    if (fast) {
      d.tree.kill("SIGTERM");
      await sleep(t.fastKillMs);
    } else {
      await Promise.race([d.appExited, sleep(t.graceMs)]);
      await d.tree.scan();
      if (!d.tree.alive()) return;
      d.tree.kill("SIGTERM");
      await sleep(t.killMs - t.graceMs);
    }
    await d.tree.scan();
    if (d.tree.alive()) d.tree.kill("SIGKILL");
  };

  const run = async (cause: FatalCause, fast: boolean) => {
    d.stop();
    await reap(fast);
    const left = await d.tree.survivors();
    if (left.length) d.report(left);
    d.writeResults(cause, left.length ? `；还有 ${left.length} 个相关进程在运行（pid ${left.map((s) => s.pid).join(", ")}）` : "");
    await Promise.race([d.flush(), sleep(t.drainMs)]);
    d.exit(cause.kind === "stop" ? 0 : 1);
  };

  return (cause, opts = {}) => {
    if (started) return void d.log(`收尾已在进行，又来一个原因：${cause.why}`);
    started = true;
    d.log(`开始收尾：${cause.why}`);
    run(cause, !!opts.signal).catch((e) => {
      d.log(`收尾出错，直接退出：${e instanceof Error ? e.message : e}`);
      d.exit(1);
    });
  };
}
