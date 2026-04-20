/**
 * tmux helper — 共享工具
 *
 * 所有 agent 都是 `master` session 里的 window（iTerm2 -CC 模式下每个是一个 tab）。
 * 统一走私有 socket 避免和用户的其他 tmux 混在一起。
 */

export const TMUX_SOCK = "/tmp/claude-orchestrator/master.sock";
export const MASTER_SESSION = "master";
export const AGENT_PREFIX = "agent-";

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

/** tmux window target: `master:agent-xxx` */
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

/** 基于 "❯" 提示符检测是否空闲。
 * 注意：Claude Code 的选项菜单也用 "❯ 1. xxx" 标记选中项，所以不能简单检测 "❯" 存在，
 * 必须是一行只有 "❯"（可带空格）才算 idle prompt。 */
export async function isIdle(target: string): Promise<boolean> {
  const tail = await tmuxRaw(["capture-pane", "-t", target, "-p"]);
  const last5 = tail.split("\n").slice(-5);
  // 行匹配：^\s*❯\s*$ — 只有 prompt，没有后续文本
  return last5.some((line) => /^\s*❯\s*$/.test(line));
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

/**
 * 检测 session 闲置弹窗（resume 时 Claude Code 可能弹这个让用户选）。
 * 区别于 hasClaudePromptToConfirm — 这个弹窗必须让用户主动选，不能自动确认。
 * 返回弹窗描述，没有返回 null。
 */
export function detectSessionIdlePrompt(pane: string): string | null {
  if (!pane.includes("❯ 1.")) return null;
  // Claude Code 的 session resume 提示特征文字
  if (pane.includes("Resume from summary") || pane.includes("Resuming the full session")) {
    // 提取说明行（"This session is 21h 6m old and 913.2k tokens"）
    const m = pane.match(/This session is ([\s\S]+?tokens?)\./i)
      || pane.match(/This session is ([^\n]+)/i);
    return m ? m[1].trim().slice(0, 150) : "Session 闲置提示";
  }
  return null;
}

/**
 * 解析 Claude Code TUI 里的数字选项 modal（/model 选择器、/mcp 菜单等）。
 * 返回所有可见选项 + 它们对应的按键。超过 25 项会截断（Discord select menu 上限）。
 * 没有检测到选项 modal 返回 null。
 */
export interface ModalOption {
  key: string;       // 发给 tmux 的字符（通常是 "1" / "2" ...）
  label: string;     // ≤80 字符，喂给 Discord button/select 的显示文本
  selected: boolean; // 是否当前高亮（❯ 前缀）
}

export function parseModalOptions(pane: string): ModalOption[] | null {
  // 只看 pane 最后 30 行（modal 总在底部）
  const tail = pane.split("\n").slice(-30);
  const seen = new Set<string>();
  const options: ModalOption[] = [];
  for (const raw of tail) {
    // 匹配 "❯ 1. 文本" 或 "  1. 文本"
    const m = raw.match(/^\s*(❯)?\s*(\d{1,2})\.\s+(.+?)\s*$/);
    if (!m) continue;
    const key = m[2];
    if (seen.has(key)) continue;
    const label = m[3].replace(/\s+/g, " ").trim().slice(0, 80);
    if (!label) continue;
    seen.add(key);
    options.push({ key, label, selected: !!m[1] });
  }
  if (options.length < 2) return null;
  // 关键：真 modal 一定有一个选中标记 ❯，否则就是 Claude 回复里普通的编号列表
  if (!options.some((o) => o.selected)) return null;
  return options.slice(0, 25);
}

/**
 * 检测箭头导航 modal（如 /effort 的 slider）。
 * 通过底部提示文字 "←/→ to change" 或 "↑/↓ to change" 识别。
 * 返回：
 *   - "horizontal" → 只有左右
 *   - "vertical"   → 只有上下
 *   - "both"       → 上下左右都能动
 *   - null         → 不是箭头 modal
 */
export type ArrowNavKind = "horizontal" | "vertical" | "both";

export function detectArrowNavModal(pane: string): ArrowNavKind | null {
  // 只看最后 20 行
  const tail = pane.split("\n").slice(-20).join("\n");
  const hasHoriz = /←\/→|◀\/▶|[^\s]→ to/.test(tail) || /to change/.test(tail) && /←/.test(tail);
  const hasVert = /↑\/↓|▲\/▼/.test(tail);
  // 还必须有 "Enter to confirm" 或 "Enter to" 暗示确认流程
  const hasEnter = /[Ee]nter to (confirm|select|continue|accept)/.test(tail);
  if (!hasEnter) return null;
  if (hasHoriz && hasVert) return "both";
  if (hasHoriz) return "horizontal";
  if (hasVert) return "vertical";
  return null;
}

/**
 * 检测运行时权限弹窗（区别于启动时的确认弹窗）。
 * 运行时的弹窗需要用户主动判断是否允许，不能自动确认。
 * 典型 pattern: "Do you want to ..." + "❯ 1." 选项菜单。
 *
 * 返回弹窗的描述（供 Discord 显示），没有返回 null。
 */
export function detectRuntimePermissionPrompt(pane: string): string | null {
  // 必须有选项菜单才算弹窗
  if (!pane.includes("❯ 1.")) return null;

  const patterns = [
    { re: /Do you want to make this edit to (.+?)\?/, label: "Edit 文件" },
    { re: /Do you want to create (.+?)\?/, label: "创建文件" },
    { re: /Do you want to (?:run|execute|proceed with) (.+?)\?/, label: "执行命令" },
    { re: /Do you want to allow (.+?)\?/, label: "允许操作" },
    { re: /Do you want to proceed\?/, label: "执行操作" },
  ];
  for (const { re, label } of patterns) {
    const m = pane.match(re);
    if (m) return m[1] ? `${label}: ${m[1].slice(0, 100)}` : label;
  }
  return null;
}
export async function listWindows(): Promise<string[]> {
  const out = await tmuxRaw([
    "list-windows",
    "-t", MASTER_SESSION,
    "-F", "#{window_name}",
  ]);
  if (!out) return [];
  return out.split("\n");
}

/** 列出所有 agent-* window */
export async function listAgentWindows(): Promise<string[]> {
  const windows = await listWindows();
  return windows.filter((w) => w.startsWith(AGENT_PREFIX));
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
