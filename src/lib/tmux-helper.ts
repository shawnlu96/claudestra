/**
 * tmux helper — 共享工具
 *
 * 所有 agent 都是 `master` session 里的 window（iTerm2 -CC 模式下每个是一个 tab）。
 * 统一走私有 socket 避免和用户的其他 tmux 混在一起。
 */

export const TMUX_SOCK = "/tmp/claude-orchestrator/master.sock";
export const MASTER_SESSION = "master";
export const AGENT_PREFIX = "agent-";

/**
 * 执行 tmux 命令，返回 stdout。失败不抛错，返回空字符串。
 *
 * `-f /dev/null` 绕开用户 ~/.tmux.conf：私有 socket 启动的 tmux server
 * 默认仍会读用户配置，如果用户设了 `set -g base-index 1`，我们假定 master:0
 * 存在的代码就会全挂。禁掉配置就强制用默认 base-index=0。
 */
export async function tmuxRaw(
  args: string[],
  opts?: { timeoutMs?: number }
): Promise<string> {
  const proc = Bun.spawn(["tmux", "-f", "/dev/null", "-S", TMUX_SOCK, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  // 超时强杀。tmuxRaw 全是查询/发键这类瞬时命令（正常 <100ms），但它坐在多条热
  // 轮询路径上（permission-watcher 每 8s、wedge-watcher、jsonl-watcher…），一旦
  // tmux server 卡住而这里没有超时，每一轮都会永久挂起一个 await + 一个子进程。
  // 同样的坑在 sessions-inventory.ts 上真实发生过：2026-07-24 cask 升级后连
  // `claude --version` 都永久 hang，堆了 30+ 僵尸进程。15s 对瞬时命令极宽松。
  const killer = setTimeout(() => {
    try { proc.kill(9); } catch { /* 已退出 */ }
  }, opts?.timeoutMs ?? 15_000);
  try {
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim();
  } finally {
    clearTimeout(killer);
  }
}

/** 非阻塞 fire-and-forget 发送（用于 C-c 等不需要等待的操作） */
export function tmuxFire(args: string[]): void {
  Bun.spawn(["tmux", "-f", "/dev/null", "-S", TMUX_SOCK, ...args]);
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

/**
 * 等 shell 就绪 + 清掉 shell 初始化阶段的 Y/n 交互（oh-my-zsh "Would you like
 * to update? [Y/n]"、homebrew "Update? (y/N)" 之类）。
 *
 * 为什么需要：tmux new-window 后 .zshrc 加载可能耗时数秒，oh-my-zsh 一旦达到
 * UPDATE_ZSH_DAYS 阈值（默认 13 天）就弹这种 Y/n 提示。如果在 prompt 出现**前**
 * 就 send-keys 输入 `claude ...`，第一个字符 'c' 被吞掉当 "no"（zsh read -k 1），
 * 剩下 `laude ...` 跑成 shell 命令报 "command not found"，Claude Code 永远没启动，
 * 调用方 30s 等就绪超时。
 *
 * 策略：在 maxWaitMs 时间窗（默认 5s）内轮询：
 * - 看到 Y/n → 发 'n' + Enter 拒绝
 * - shell idle prompt 出现 → 立即返回
 * - 超时 → 也返回（让调用方继续；现实里超过 5s 还没就绪本来就会继续超时）
 */
const Y_N_PROMPT_RE = /[\[(](?:Y\/n|y\/N|yes\/no)[\])]/i;

function looksLikeShellPromptTail(pane: string): boolean {
  const lines = pane.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return false;
  const last = lines[lines.length - 1];
  // 常见 shell prompt 收尾：% $ # > ❯ » λ；oh-my-zsh ➜ + 路径
  return /[%$#>❯»λ]\s*$/.test(last) || /➜\s+\S/.test(last);
}

export async function clearShellInitPrompts(
  target: string,
  maxWaitMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const pane = await tmuxCapture(target, 10);
    if (Y_N_PROMPT_RE.test(pane)) {
      await tmuxRaw(["send-keys", "-t", target, "n", "Enter"]);
      await new Promise((r) => setTimeout(r, 600));
      continue;
    }
    if (looksLikeShellPromptTail(pane)) return;
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** 基于 "❯" 提示符检测是否空闲。
 *
 * 旧版 Claude Code 的 idle prompt 是一行只有 "❯"（可带空格）。新版（≥ 2.1.129）
 * 可能在 ❯ 同行渲染光标占位符 `▎` 或 placeholder 文字（"Type a message..."），
 * 让严格的「行只有 ❯」匹配永远失败 → wedge-watcher / cmdList / bridge 中断判断
 * 全部把 fresh idle agent 错认成"忙"。
 *
 * 修法：双模匹配 +「没有正在跑」的反向信号
 * - 模式 1：legacy 严格匹配 `^\s*❯\s*$`
 * - 模式 2：宽松匹配 — ❯ 在 last 5 行 + pane 含 "bypass permissions" banner +
 *   pane **不**含 "esc to interrupt"
 *
 * 「esc to interrupt」是 Claude Code 状态栏在跑工具 / 等 LLM 响应时才会显示的
 * 文字。它存在 = agent 在忙，不是 idle。idle 状态栏只有 "shift+tab to cycle"。
 *
 * 选项菜单（"❯ 1. xxx"）情况：模式 1 当然不匹配；模式 2 不会匹配因为 modal
 * 通常没有 bypass banner（modal 覆盖输入框）。两种都返回 false，正确。
 */
/**
 * Claude Code TUI 底部模式状态栏正则。不同 `--permission-mode` 文案不同：
 *   bypass      → "⏵⏵ bypass permissions on (shift+tab to cycle)"
 *   auto        → "⏵⏵ auto mode on (shift+tab to cycle)"
 *   acceptEdits → "⏵⏵ accept edits on (shift+tab to cycle)"
 *   plan        → "⏸ plan mode on (shift+tab to cycle)"
 * 共同稳定子串是 "(shift+tab to cycle)"。default 模式无 banner（我们不给 agent 用）。
 *
 * v2.0.24+：旧代码只认 "bypass permissions"，导致 auto/acceptEdits/plan 模式的 agent
 * 永远不被判就绪/idle → 启动 60s 超时。统一成「任一模式 banner」。保留 "bypass
 * permissions" 分支兼容老 pane / 测试 fixture。
 */
export const CC_MODE_BANNER_RE = /shift\+tab to cycle|bypass permissions/i;

/**
 * TUI 契约探针（纯函数，便于单测）。
 *
 * 为什么需要它：控制流依赖约 25 处 Claude Code 终端画面的文案匹配，其中最关键的
 * 是「空闲」与「在忙」两个判据。CC 一旦改文案，不会有任何报错——而是**语义静默
 * 反转**：paneLooksIdle 恒为 false → launcher 判定所有 agent 已死 → 无限重启。
 * 2026 年已经真实发生三次（07-15 spinner 轮换、07-16 /model 落盘行为、07-24 自动
 * 升级致全部 agent 启动挂死）。这个探针把"静默反转"降级成"明确报警"。
 *
 * 判据：CC 在任一时刻要么空闲（底部有模式 banner）、要么在忙（有 esc to interrupt）。
 * 屏幕上确实是个 TUI，却两者都不命中 —— 那就是文案变了。
 * `tuiPresent` 只看输入框边框，刻意不参与任何控制流判断，纯粹用来避免对空 pane
 * 或裸 shell 误报。
 */
export function probeTuiContract(pane: string): {
  tuiPresent: boolean;
  matched: string[];
  suspect: boolean;
} {
  const tail = pane.split("\n").slice(-15).join("\n");
  const tuiPresent = /─{20,}/.test(tail);
  const matched: string[] = [];
  if (CC_MODE_BANNER_RE.test(tail)) matched.push("mode-banner");
  if (/esc to interrupt|esc to cancel/i.test(tail)) matched.push("busy-indicator");
  return { tuiPresent, matched, suspect: tuiPresent && matched.length === 0 };
}

/** 纯函数版：给定 pane 文本判断是否 idle。便于单测。 */
export function paneLooksIdle(pane: string): boolean {
  const lines = pane.split("\n");
  const last5 = lines.slice(-5);
  // 模式 1: 严格匹配 — 老 Claude Code 行为
  if (last5.some((line) => /^\s*❯\s*$/.test(line))) return true;
  // 模式 2: 宽松匹配 — 新 Claude Code 输入框可能带光标 / placeholder
  // v2.0.14+: "bypass permissions" / "esc to interrupt" 检查都收紧到 last 10 行。
  // 之前 `pane.includes(...)` / 全 pane regex 会把 scrollback 里 stale 的旧 TUI banner
  // 字符串误命中，dev-channels modal 时假阳性返回 true → wedge / launch polling 提前
  // 退出根本没机会按 Enter dismiss modal。Claude Code TUI 的 bypass banner 永远在
  // 输入框下面 1-2 行 = 真 idle 时一定在 last 10。
  const last10Joined = lines.slice(-10).join("\n");
  const hasPrompt = /❯/.test(last5.join("\n"));
  const hasBanner = CC_MODE_BANNER_RE.test(last10Joined);
  const isWorking = /esc to interrupt/i.test(last10Joined);
  return hasPrompt && hasBanner && !isWorking;
}

export async function isIdle(target: string): Promise<boolean> {
  const tail = await tmuxRaw(["capture-pane", "-t", target, "-p"]);
  return paneLooksIdle(tail);
}

/**
 * Claude Code TUI 启动就绪检测 —— 比 isIdle 宽松，专给 launch 流程用。
 *
 * 为什么需要：isIdle 要求行**只**含 ❯，但新版 Claude Code（≥ 2.1.129）启动后
 * 的输入框可能把光标占位符 / placeholder 文字渲染在 ❯ 同一行（如 `❯ ▎` 或
 * `❯ Type a message...`），让 isIdle 永远 false → cmdCreate / cmdResume 30s 超时
 * 然后误清理一个其实已经就绪的 agent。
 *
 * 改成两个**联合**信号：
 * 1. ❯ 出现在 pane 最后 5 行（容忍 ❯ 后面有任何字符）
 * 2. pane 里出现 "bypass permissions" — Claude Code TUI 状态栏的固定文字
 *
 * 同时满足才算 ready。这个组合在 restart 路径（startClaudeInWindow）已经用了
 * 很久，稳定。统一到 launch 流程里消除 create / resume 路径的滞后。
 */
export function isClaudeReady(pane: string): boolean {
  const lines = pane.split("\n");
  // v2.0.14+: bypass banner 检查从 `pane.includes(...)` 收紧到 last 10 行，避免
  // 旧 claude session 残留在 scrollback 的 banner 字符串造成假阳性。具体 bug：
  // restart 流程里 startClaudeInWindow 的 polling 第一次轮询就误以为 ready，跳过
  // hasPromptToConfirm 分支没机会按 Enter，dev-channels modal 永远卡在那儿。
  const hasPrompt = /❯/.test(lines.slice(-5).join("\n"));
  const hasBanner = CC_MODE_BANNER_RE.test(lines.slice(-10).join("\n"));
  return hasPrompt && hasBanner;
}

/**
 * Claude Code 是否已退出、pane 停在 shell 提示符。
 *
 * 关键：用户的 zsh 主题（starship / pure）shell 提示符就是 `❯`，跟 Claude Code
 * 的输入框符号一样。所以**先**用 Claude TUI 标志（bypass permissions / esc to
 * interrupt / ❯ N. 选项菜单）排除"claude 还在跑"，**再**看最后一行是不是常见
 * shell prompt 收尾字符。两步顺序不能反，否则 shell 的 ❯ 会被当成 claude 输入框。
 *
 * 用途：wedge-watcher 靠它区分"claude 卡住"（要救援）和"claude 已退出到 shell"
 * （是掉线，不是卡死，发 Esc/C-c 没用）。launch / gracefulExit 也用它判 shell 就绪。
 */
export function isAtShell(pane: string): boolean {
  const nonEmpty = pane.split("\n").filter((l) => l.trim());
  const tail = nonEmpty.slice(-5).join("\n");
  // 如果底部有 Claude Code TUI 标志（任一模式 banner / 跑工具 / modal），肯定不在 shell
  if (CC_MODE_BANNER_RE.test(tail) || /esc to interrupt|esc to cancel/i.test(tail)) return false;
  if (/^\s*❯\s*\d+\./m.test(tail)) return false;
  const lastLine = nonEmpty.pop() || "";
  // 常见 shell prompt 收尾字符：$ (bash/sh)、% (zsh default)、# (root)、> (fish/cmd)、
  // ❯ (starship / pure 主题 — 依赖上面的 Claude TUI exclusion 判断不是 Claude 的输入框)、
  // » (pure)、λ (lambda prompt)
  if (/[%$#>❯»λ]\s*$/.test(lastLine)) return true;
  // oh-my-zsh robbyrussell 主题：prompt 不一定以 ➜ 结尾，常见形式是
  // "➜  <dir> git:(<branch>) ✗" 之类，结尾是 `)` / `✗` / 路径文字。
  // 只要最后一行里包含 `➜  <非空>`（箭头+空格+目录），就当作在 shell。
  if (/➜\s+\S/.test(lastLine)) return true;
  return false;
}

// ────────────────────────────────────────────────
// 运行时权限模式检测 + Shift+Tab 循环（v2.2.0+ 临时放行功能用）
// ────────────────────────────────────────────────
//
// Claude Code TUI 的 Shift+Tab 按这个顺序循环切换 permission mode（实测，需启动带
// --allow-dangerously-skip-permissions 才会包含 bypass）：
//   auto → default → acceptEdits → plan → bypassPermissions → (回到 auto)
// 用于「auto 拦截 → 一键临时切 bypass 重试 → 切回」：算出从当前模式到目标模式要
// 按几下 Shift+Tab。
export const PERMISSION_MODE_CYCLE = [
  "auto",
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
] as const;

/** 从 pane 底部 banner 判断当前 permission mode。default 模式没 banner（只有 ❯）。 */
export function detectPermissionMode(pane: string): string | null {
  const tail = pane.split("\n").slice(-6).join("\n");
  if (/auto mode on/i.test(tail)) return "auto";
  if (/accept edits on/i.test(tail)) return "acceptEdits";
  if (/plan mode on/i.test(tail)) return "plan";
  if (/bypass permissions on/i.test(tail)) return "bypassPermissions";
  // 无 mode banner 但在 ready 提示符 → default 模式（无 banner）
  if (/❯/.test(pane.split("\n").slice(-5).join("\n"))) return "default";
  return null;
}

/** 从 current 模式切到 target 模式需要按几下 Shift+Tab（沿 PERMISSION_MODE_CYCLE）。
 *  任一模式不在循环里返回 -1。 */
export function btabStepsTo(current: string, target: string): number {
  const ci = (PERMISSION_MODE_CYCLE as readonly string[]).indexOf(current);
  const ti = (PERMISSION_MODE_CYCLE as readonly string[]).indexOf(target);
  if (ci < 0 || ti < 0) return -1;
  const n = PERMISSION_MODE_CYCLE.length;
  return (ti - ci + n) % n;
}

/**
 * 检测 pane 上是否有"可以安全自动按 Enter 确认"的 modal。
 *
 * 先用 parseModalOptions 做几何识别（必须有 ❯ 标记的选项菜单）。检测到 modal
 * 之后，再用一个**负向 blacklist** 排除"必须用户决定"的弹窗：
 * - 运行时权限弹窗（detectRuntimePermissionPrompt）：edit / run / allow ...
 * - session-idle 弹窗（detectSessionIdlePrompt），除非显式 allowSessionIdle=true
 *   master 启动时允许（默认从摘要恢复），agent 不允许（permission-watcher 会发按钮）
 *
 * 这样 Claude Code 改启动期 modal 文案（dev-channel / trust files / skip
 * permissions ...）不会再让 launcher 卡住 — 只要修结构稳定的 ❯ + Enter to
 * confirm 几何特征还在，自动通过。
 */
export function isAutoConfirmableModal(
  pane: string,
  opts: { allowSessionIdle?: boolean } = {}
): boolean {
  const modalOpts = parseModalOptions(pane);
  if (!modalOpts) return false;
  // parseModalOptions 已经保证至少 1 个 ❯，但显式再校验一次，防未来重构破坏不变量
  if (!modalOpts.some((o) => o.selected)) return false;
  // 运行时权限弹窗（Do you want to edit / run / allow ...）必须用户决定
  if (detectRuntimePermissionPrompt(pane)) return false;
  // session-idle 弹窗除非显式允许
  if (!opts.allowSessionIdle && detectSessionIdlePrompt(pane)) return false;
  return true;
}

/**
 * 检测 session 闲置弹窗（resume 时 Claude Code 可能弹这个让用户选）。
 * 区别于 hasClaudePromptToConfirm — 这个弹窗必须让用户主动选，不能自动确认。
 * 返回弹窗描述，没有返回 null。
 */
export function detectSessionIdlePrompt(pane: string): string | null {
  const lines = pane.split("\n");
  // v2.0.23+: 只看 pane 底部 —— 真 session-idle 弹窗总在最底下。之前 pane.includes
  // 扫**全 pane**，会把 scrollback 里显示的代码 / 输出当成真弹窗误报。实测：owner 编辑
  // 本检测器自己的测试 fixture（"❯ 1. Resume from summary" 之类）时，claudestra 的屏幕
  // 上就显示着这段源码，detectSessionIdlePrompt 把它当成真弹窗，permission-watcher
  // 发了条假的"session 已闲置"通知。parseModalOptions 早就只看底部 30 行，这里对齐。
  const tail = lines.slice(-20).join("\n");
  if (!tail.includes("❯ 1.")) return null;
  // Claude Code 的 session resume 提示特征文字
  if (!(tail.includes("Resume from summary") || tail.includes("Resuming the full session"))) {
    return null;
  }
  // v2.0.23+: 负向 guard —— 真弹窗会盖住输入框，底部不会有 bypass / esc-to-interrupt
  // 状态栏。claude 正常运行时这俩永远钉在最底下；如果底部还有它们，说明那段 modal
  // 文字只是屏幕上显示的内容（源码 / 工具输出），claude 没真弹窗。
  const lastFew = lines.slice(-8).join("\n");
  if (CC_MODE_BANNER_RE.test(lastFew) || /esc to interrupt/i.test(lastFew)) return null;
  // v2.0.23+: 底部已是 shell 提示符 → claude 已退出，那段 modal 文字只是 scrollback
  // 残留（比如从弹窗按 Esc 退出后）。真弹窗有 "❯ N." 选项 / "Esc to cancel"，
  // isAtShell 对它必返回 false，所以这条只挡"已退到 shell"的残留误判。
  if (isAtShell(pane)) return null;

  // 提取说明行（"This session is 21h 6m old and 913.2k tokens"）
  const m = tail.match(/This session is ([\s\S]+?tokens?)\./i)
    || tail.match(/This session is ([^\n]+)/i);
  return m ? m[1].trim().slice(0, 150) : "Session 闲置提示";
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

/**
 * 给定一个 agent window name，返回所有同名 window 的稳定 `@<id>` 列表。
 *
 * 为啥要 by id：tmux 用 `session:name` 当 target 时，多 window 同名会
 * 报 "more than one window"；用 `@<id>` 永远唯一。kill 这种破坏性操作
 * 必须 by id 才能避免 ambiguous 错误被 catch 吞掉、把杀的对象搞错。
 *
 * 返回长度：
 *   0 = 没有该名字的 window（agent 真 dead）
 *   1 = 正常一份
 *  ≥2 = zombie 累积（restart 死循环 + 静默吞错的历史遗留），调用方应该全杀重建
 */
export async function listWindowIdsByName(name: string): Promise<string[]> {
  const out = await tmuxRaw([
    "list-windows",
    "-t", MASTER_SESSION,
    "-F", "#{window_name}\t#{window_id}",
  ]);
  if (!out) return [];
  const ids: string[] = [];
  for (const line of out.split("\n")) {
    const [winName, id] = line.split("\t");
    if (winName === name && id) ids.push(id);
  }
  return ids;
}

/** master session 是否存在 */
export async function masterSessionExists(): Promise<boolean> {
  const out = await tmuxRaw(["list-sessions", "-F", "#{session_name}"]);
  return out.split("\n").includes(MASTER_SESSION);
}

/** master:0 这个窗口是否存在（区别于 master session 本身存在） */
export async function masterWindowExists(): Promise<boolean> {
  const out = await tmuxRaw(["list-windows", "-t", MASTER_SESSION, "-F", "#{window_index}"]);
  if (!out) return false;
  return out.split("\n").some((w) => w.trim() === "0");
}

/**
 * tmux window 里是不是真的跑着一个 child 进程（判断 Claude Code 还活着）。
 *
 * 原理：window pane 的 `#{pane_pid}` 是那个终端的 shell PID（zsh/bash）。
 * Claude Code 作为子进程跑。`pgrep -P <shell_pid>` 如果有输出就是有子进程
 * （Claude Code 或别的），空输出就是 shell 在 idle prompt → Claude 已死。
 *
 * 完全不看 pane 文本，不会被 prompt 主题 / 版本号覆盖等 tmux title tricks 骗到。
 * 返回 null 表示查不到 pane pid（window 本身就不存在），调用方按需处理。
 */
export async function windowHasChildProcess(target: string): Promise<boolean | null> {
  const pidRaw = await tmuxRaw(["list-panes", "-t", target, "-F", "#{pane_pid}"]);
  const pid = parseInt(pidRaw.trim().split("\n")[0] || "", 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const proc = Bun.spawn(["pgrep", "-P", String(pid)], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim().length > 0;
}

/** 确保 tmux socket 目录存在 */
export async function ensureSocketDir(): Promise<void> {
  await Bun.spawn(["mkdir", "-p", "/tmp/claude-orchestrator"]).exited;
}
