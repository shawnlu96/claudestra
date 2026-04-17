/**
 * tmux 快速教程打印器
 *
 * 被 setup.ts 和 manager.ts tmux-help 共用。
 * 输出针对 Claudestra 的 master session 场景：iTerm2 -CC 模式 + 普通 tmux。
 */

const tty = process.stdout.isTTY;
const c = {
  reset: tty ? "\x1b[0m" : "",
  bold: tty ? "\x1b[1m" : "",
  dim: tty ? "\x1b[2m" : "",
  red: tty ? "\x1b[31m" : "",
  green: tty ? "\x1b[32m" : "",
  yellow: tty ? "\x1b[33m" : "",
  blue: tty ? "\x1b[34m" : "",
  magenta: tty ? "\x1b[35m" : "",
  cyan: tty ? "\x1b[36m" : "",
};

const SOCK = "/tmp/claude-orchestrator/master.sock";

function p(s: string = "") { process.stdout.write(s + "\n"); }

export function printTmuxGuide(): void {
  const bar = "━".repeat(60);

  p("");
  p(`${c.cyan}${bar}${c.reset}`);
  p(`${c.bold}${c.cyan}  tmux 快速上手（3 分钟）${c.reset}`);
  p(`${c.cyan}${bar}${c.reset}`);
  p("");

  p(`${c.dim}tmux 是一个终端复用器。Claudestra 把所有 agent 都塞进${c.reset}`);
  p(`${c.dim}同一个 tmux session（叫 ${c.bold}master${c.reset}${c.dim}），每个 agent 是其中一个 window。${c.reset}`);
  p(`${c.dim}你回到电脑后，通过 tmux 直接进到任意 agent 的终端跟它对话。${c.reset}`);
  p("");

  // ──────────────────────────────────────────
  // 方案 A: iTerm2 -CC 模式
  // ──────────────────────────────────────────
  p(`${c.bold}${c.green}━━━ 方案 A：iTerm2 -CC 模式（最推荐）${c.reset}`);
  p("");
  p(`如果你用 ${c.bold}iTerm2${c.reset}（macOS 默认推荐的终端），用这个。`);
  p(`每个 agent 会变成 iTerm2 原生 tab，可以直接用鼠标点、${c.bold}⌘T${c.reset} 开新 tab 一样自然。`);
  p("");
  p(`${c.cyan}tmux -S ${SOCK} -CC attach${c.reset}`);
  p("");
  p(`${c.dim}发生的事：${c.reset}`);
  p(`  ${c.dim}•${c.reset} iTerm2 弹出一个新窗口，顶部是一排 tab`);
  p(`  ${c.dim}•${c.reset} 每个 agent 占一个 tab（master / agent-xxx / ...）`);
  p(`  ${c.dim}•${c.reset} 用 ${c.yellow}⌘⇧[${c.reset} / ${c.yellow}⌘⇧]${c.reset} 或鼠标切换 tab`);
  p(`  ${c.dim}•${c.reset} 关掉窗口 = ${c.bold}detach${c.reset}（不是 kill，agent 继续跑）`);
  p("");
  p(`${c.dim}前置：iTerm2 → Settings → Profiles → Advanced → Semantic History${c.reset}`);
  p(`${c.dim}旁边有个 "tmux" section，确保 "tmux integration" 没禁用（默认就是开的）${c.reset}`);
  p("");

  // ──────────────────────────────────────────
  // 方案 B: 普通 tmux
  // ──────────────────────────────────────────
  p(`${c.bold}${c.green}━━━ 方案 B：普通 tmux 模式${c.reset}`);
  p("");
  p(`iTerm2 以外的终端（Alacritty / kitty / Warp / Linux 终端）用这个。`);
  p("");
  p(`${c.cyan}tmux -S ${SOCK} attach${c.reset}`);
  p("");
  p(`你会看到当前焦点 agent 的全屏终端，底部有状态栏列出所有 window。`);
  p("");

  p(`${c.bold}${c.yellow}必须记住的快捷键${c.reset}  ${c.dim}(tmux 前缀键是 Ctrl-B，先按 Ctrl-B 松开，再按下面的键)${c.reset}`);
  p("");
  p(`  ${c.yellow}Ctrl-B  n${c.reset}      下一个 window（下一个 agent）`);
  p(`  ${c.yellow}Ctrl-B  p${c.reset}      上一个 window`);
  p(`  ${c.yellow}Ctrl-B  w${c.reset}      弹出 window 列表，方向键选，Enter 确认`);
  p(`  ${c.yellow}Ctrl-B  0${c.reset}      跳到 window 0（大总管）`);
  p(`  ${c.yellow}Ctrl-B  1${c.reset}      跳到 window 1（第一个 agent）`);
  p(`  ${c.yellow}Ctrl-B  ,${c.reset}      重命名当前 window`);
  p(`  ${c.yellow}Ctrl-B  d${c.reset}      ${c.bold}detach${c.reset}（离开 tmux 但 agent 继续跑）`);
  p(`  ${c.yellow}Ctrl-B  [${c.reset}      进入滚动模式（方向键/PgUp 翻历史，q 退出）`);
  p("");

  // ──────────────────────────────────────────
  // 几个要懂的概念
  // ──────────────────────────────────────────
  p(`${c.bold}${c.magenta}几个坑${c.reset}`);
  p("");
  p(`  ${c.red}1.${c.reset} ${c.bold}detach 不是 kill${c.reset}`);
  p(`     ${c.dim}关掉 iTerm2 窗口或按 Ctrl-B d，agent 继续在后台跑。下次 attach 回来状态还在。${c.reset}`);
  p("");
  p(`  ${c.red}2.${c.reset} ${c.bold}不要 Ctrl-C 退 tmux${c.reset}`);
  p(`     ${c.dim}Ctrl-C 会被传到当前 agent（Claude Code 里就是打断它）。${c.reset}`);
  p(`     ${c.dim}要离开 tmux，用 Ctrl-B d 或直接关窗口。${c.reset}`);
  p("");
  p(`  ${c.red}3.${c.reset} ${c.bold}私有 socket${c.reset}`);
  p(`     ${c.dim}Claudestra 的 tmux 跑在 ${c.cyan}${SOCK}${c.reset}${c.dim} 上，不跟你平时的 tmux 混。${c.reset}`);
  p(`     ${c.dim}每次都要加 ${c.cyan}-S ${SOCK}${c.reset}${c.dim}。可以做个 shell alias：${c.reset}`);
  p("");
  p(`     ${c.cyan}alias ca='tmux -S ${SOCK} -CC attach'${c.reset}`);
  p("");
  p(`     ${c.dim}写到 ~/.zshrc 或 ~/.bashrc 里，以后 ${c.bold}ca${c.reset}${c.dim} 一个字母就能 attach。${c.reset}`);
  p("");
  p(`  ${c.red}4.${c.reset} ${c.bold}多个人同时 attach${c.reset}`);
  p(`     ${c.dim}可以。两个终端同时 attach 会看到同一个画面，一个动另一个也动。${c.reset}`);
  p("");

  p(`${c.cyan}${bar}${c.reset}`);
  p("");
  p(`${c.dim}想再看这份教程？跑: ${c.cyan}bun src/manager.ts tmux-help${c.reset}`);
  p("");
}
