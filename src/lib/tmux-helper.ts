/**
 * tmux helper — 共享工具
 *
 * 所有 worker 都是 `master` session 里的 window（iTerm2 -CC 模式下每个是一个 tab）。
 * 统一走私有 socket 避免和用户的其他 tmux 混在一起。
 */

export const TMUX_SOCK = "/tmp/claude-orchestrator/master.sock";
export const MASTER_SESSION = "master";
export const WORKER_PREFIX = "worker-";

/** 执行 tmux 命令，返回 stdout。失败不抛错，返回空字符串。 */
export async function tmuxRaw(args: string[]): Promise<string> {
  const proc = Bun.spawn(["tmux", "-S", TMUX_SOCK, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

/** 非阻塞 fire-and-forget 发送（用于 C-c 等不需要等待的操作） */
export function tmuxFire(args: string[]): void {
  Bun.spawn(["tmux", "-S", TMUX_SOCK, ...args]);
}

/** tmux window target: `master:worker-xxx` */
export function windowTarget(name: string): string {
  return `${MASTER_SESSION}:${name}`;
}

/** 发送文本到窗口（literal 模式 + 单独的 Enter） */
export async function tmuxSendLine(
  target: string,
  text: string,
  delayMs = 100
): Promise<void> {
  await tmuxRaw(["send-keys", "-t", target, "-l", "--", text]);
  await Bun.sleep(delayMs);
  await tmuxRaw(["send-keys", "-t", target, "Enter"]);
}

/** 发送中断 Ctrl+C */
export function tmuxInterrupt(target: string): void {
  tmuxFire(["send-keys", "-t", target, "C-c"]);
}

/** 读取 window 最近 N 行（默认 40） */
export async function tmuxCapture(
  target: string,
  lines = 40
): Promise<string> {
  return tmuxRaw(["capture-pane", "-t", target, "-p", "-J", "-S", `-${lines}`]);
}

/** 基于 "❯" 提示符检测是否空闲 */
export async function isIdle(target: string): Promise<boolean> {
  const tail = await tmuxRaw(["capture-pane", "-t", target, "-p"]);
  const last5 = tail.split("\n").slice(-5).join("\n");
  return /❯/.test(last5);
}

/**
 * 检测一段 tmux pane 里是否存在 Claude Code 的确认弹窗。
 * 覆盖启动时的 dev-channel / trust files / skip permissions / 选项菜单 等。
 * 共用同一份列表，避免 manager/launcher 之间漂移。
 *
 * 注意：不要匹配 "bypass permissions mode" 或 "bypass permissions" —
 * 这些是 Claude Code 启动完成后的横幅文字，不是需要确认的提示。
 */
export function hasClaudePromptToConfirm(pane: string): boolean {
  return (
    pane.includes("Enter to confirm") ||
    pane.includes("Esc to cancel") ||
    pane.includes("Do you want") ||
    pane.includes("Are you sure") ||
    pane.includes("I am using this for local development") ||
    pane.includes("trust the files") ||
    pane.includes("Trust the files") ||
    pane.includes("Do you trust") ||
    pane.includes("Yes, proceed") ||
    pane.includes("skip all permission") ||
    pane.includes("Skip all permission") ||
    (pane.includes("❯ 1.") && pane.includes("Yes"))
  );
}

/** 列出 master session 下所有 window 名 */
export async function listWindows(): Promise<string[]> {
  const out = await tmuxRaw([
    "list-windows",
    "-t", MASTER_SESSION,
    "-F", "#{window_name}",
  ]);
  if (!out) return [];
  return out.split("\n");
}

/** 列出所有 worker-* window */
export async function listWorkerWindows(): Promise<string[]> {
  const windows = await listWindows();
  return windows.filter((w) => w.startsWith(WORKER_PREFIX));
}

/** master session 是否存在 */
export async function masterSessionExists(): Promise<boolean> {
  const out = await tmuxRaw(["list-sessions", "-F", "#{session_name}"]);
  return out.split("\n").includes(MASTER_SESSION);
}

/** 确保 tmux socket 目录存在 */
export async function ensureSocketDir(): Promise<void> {
  await Bun.spawn(["mkdir", "-p", "/tmp/claude-orchestrator"]).exited;
}
