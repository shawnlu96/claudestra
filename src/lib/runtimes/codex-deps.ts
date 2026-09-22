/**
 * Codex 适配器的外部依赖（跑 codex、查窗口子进程、查锁、读 rollout 首行）。
 *
 * 全部经 CodexAdapterDeps 注入：单测换成假的，scripts/codex-adapter-e2e.ts 换成独立 tmux
 * socket 上的实现，生产用 defaultCodexDeps()。
 */
import { resolveBridgePort } from "../bridge-url.js";
import { closeSync, openSync, readSync } from "node:fs";
import { resolveCodexBinary } from "../codex-launch.js";
import { findCodexSessionPath } from "../codex-session.js";
import { defaultRunner, heldThreadIds, type Runner } from "../codex-thread.js";
import { REPO_ROOT } from "../repo-root.js";
import { windowChildPids, windowTarget } from "../tmux-helper.js";

export interface CodexAdapterDeps {
  run: Runner;
  /** 交互式 codex 的绝对路径（登录 shell 解析 + npm 壳换原生二进制） */
  resolveBin(): Promise<string | null>;
  /** exec 引导：返回 stdout / stderr / 退出码 */
  execBootstrap(argv: string[], cwd: string): Promise<{ code: number | null; out: string; err: string }>;
  /** 窗口名 → pane 的直接子进程（原生 codex 就是直接子进程，见 resolveCodexBinary） */
  childPids(windowName: string): Promise<number[]>;
  /** pid 持有的线程写锁 */
  heldThreadIds(pid: number): Promise<string[]>;
  /** 会话 id → rollout 首行的 cwd */
  sessionCwd(sessionId: string): string | null;
  /** channel-server / typing-hook 用的 bun */
  bunBin: string;
  /** Claudestra 仓库根（拼 channel-server / typing-hook 路径与频道规则用） */
  repoRoot: string;
  now(): number;
}

/** 同步读 rollout 首行的 cwd（buildLaunchCommand 是同步的；首行 session_meta 可能好几 KB） */
export function codexSessionCwdSync(
  sessionId: string,
  find: (sid: string) => string | null = findCodexSessionPath,
): string | null {
  const path = find(sessionId);
  if (!path) return null;
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(256 * 1024);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const rec = JSON.parse(buf.toString("utf8", 0, n).split("\n")[0]);
      const cwd = rec?.payload?.cwd;
      return rec?.type === "session_meta" && typeof cwd === "string" && cwd ? cwd : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null; // 读不到 / 首行不是 JSON：当作不知道 cwd，调用方会报「找不到工作目录」
  }
}

async function spawnBootstrap(argv: string[], cwd: string) {
  // stdin 必须是空的：否则 exec 会等 stdin 的「additional input」
  const proc = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* 进程已经自己退出，kill 失败无所谓 */
    }
  }, 180_000);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, out, err };
}

export function defaultCodexDeps(): CodexAdapterDeps {
  return {
    run: defaultRunner,
    resolveBin: async () => (await resolveCodexBinary(defaultRunner))?.real ?? null,
    execBootstrap: spawnBootstrap,
    childPids: (name) => windowChildPids(windowTarget(name)),
    heldThreadIds: (pid) => heldThreadIds(pid),
    sessionCwd: (sid) => codexSessionCwdSync(sid),
    bunBin: process.execPath,
    repoRoot: REPO_ROOT,
    now: () => Date.now(),
  };
}

/** ws://host:<port> → "<port>"（typing-hook 靠 BRIDGE_PORT 找 bridge） */
export function bridgePortOf(bridgeUrl: string): string {
  try {
    const u = new URL(bridgeUrl);
    if (u.port) return u.port;
  } catch {
    /* BRIDGE_URL 不是合法 URL：落到下面的环境变量 / 默认端口 */
  }
  return String(resolveBridgePort());
}
