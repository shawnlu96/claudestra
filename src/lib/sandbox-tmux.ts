/**
 * 沙箱里的 tmux 闸（lib/tmux-helper.ts 与 bridge/term-fit.ts 调）。非沙箱进程全是空操作。
 *
 * - socket：`tmux -S <sock>` 会跟着软链走。沙箱 agent 一条 `ln -sf /tmp/claude-orchestrator/master.sock
 *   <root>/run/master.sock`，之后沙箱对自己 tmux 的任何操作（包括 down 的 kill-server）就落到生产上。
 *   所以每次调 tmux 前核对：socket 不是软链、真实路径在沙箱运行目录里、不碰生产目录。
 * - new-window / 带 -c 的 new-session：`-c` 的目录必须是沙箱根下已存在的目录（不存在或进不去时 tmux 静默回落到 $HOME）；
 *   建完再读 #{pane_current_path} 复核一遍，不在根目录下就关掉窗口并报错。new-session 不带 -c（终端 viewer 的临时 session）不管。
 */
import { lstatSync } from "fs";
import { DEFAULT_RUNTIME_DIR, RUNTIME_DIR } from "./paths.js";
import { denyDirs, isSandbox, pathsOverlap, refuseInSandbox, sandboxAgentDirProblem } from "./sandbox.js";

function socketProblem(sock: string): string | null {
  let link = false;
  try {
    link = lstatSync(sock).isSymbolicLink();
  } catch {
    /* 还不存在（server 没起）：只看路径本身 */
  }
  if (link) return `tmux socket ${sock} 是软链`;
  if (!pathsOverlap(sock, RUNTIME_DIR)) return `tmux socket ${sock} 不在沙箱运行目录 ${RUNTIME_DIR} 里`;
  const prod = [DEFAULT_RUNTIME_DIR, ...denyDirs(process.env)].find((d) => pathsOverlap(sock, d));
  return prod ? `tmux socket ${sock} 落在生产目录 ${prod} 里` : null;
}

/** 完整的 tmux argv（含 `-S <sock>`）在沙箱里的前置检查；不安全就抛错，安全原样返回 */
export function sandboxTmuxArgv(argv: string[]): string[] {
  if (!isSandbox()) return argv;
  const s = argv.indexOf("-S");
  const sock = s >= 0 ? argv[s + 1] ?? "" : "";
  const problems = [sock ? socketProblem(sock) : "tmux 调用没带 -S（会连到默认 server）"];
  const sub = s >= 0 ? argv.slice(s + 2) : [];
  if (sub[0] === "new-window" || (sub[0] === "new-session" && sub.includes("-c"))) {
    const c = sub.indexOf("-c");
    problems.push(c >= 0 ? sandboxAgentDirProblem(sub[c + 1] ?? "") : "沙箱里的 new-window 必须带 -c <沙箱根下的目录>");
  }
  const bad = problems.filter((p): p is string => !!p);
  if (bad.length) refuseInSandbox(`调 tmux：${bad.join("；")}`);
  return argv;
}

/** new-window / 带 -c 的 new-session 成功之后的复核：窗口实际所在目录必须在沙箱根下，否则关掉它并抛错 */
export async function sandboxVerifyNewWindow(args: string[], run: (a: string[]) => Promise<string>): Promise<void> {
  const session = args[0] === "new-session" && args.includes("-c");
  if (!isSandbox() || !(session || args[0] === "new-window")) return;
  const t = session ? `=${args[args.indexOf("-s") + 1] ?? ""}` : args[args.indexOf("-t") + 1] ?? "";
  const target = `${t.endsWith(":") ? t : `${t}:`}=${args[args.indexOf("-n") + 1] ?? ""}`; // = 精确匹配：别复核到前缀同名的窗口上
  const cwd = (await run(["display-message", "-p", "-t", target, "#{pane_current_path}"])).trim();
  const problem = sandboxAgentDirProblem(cwd);
  if (!problem) return;
  await run(["kill-window", "-t", target]);
  refuseInSandbox(`把窗口建在 ${cwd}（已关掉）：${problem}`);
}
