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

import { TMUX_SOCK } from "./paths.js";

const SOCK = TMUX_SOCK;

function p(s: string = "") { process.stdout.write(s + "\n"); }

export function printTmuxGuide(): void {
  const bar = "━".repeat(60);

  p("");
  p(`${c.cyan}${bar}${c.reset}`);
  p(`${c.bold}${c.cyan}  tmux × iTerm2 attach（1 分钟）${c.reset}`);
  p(`${c.cyan}${bar}${c.reset}`);
  p("");
  p(`${c.dim}Claudestra 把所有 agent 放进一个 tmux session（叫 ${c.bold}master${c.reset}${c.dim}），${c.reset}`);
  p(`${c.dim}每个 agent 是其中一个 window。用 iTerm2 的 tmux 集成（-CC 模式）${c.reset}`);
  p(`${c.dim}attach 后，每个 window 就是一个 iTerm2 tab，鼠标点、⌘T 都能用。${c.reset}`);
  p("");

  p(`${c.bold}${c.yellow}第 1 步：配置 iTerm2（先做，一次配完永远受益）${c.reset}`);
  p(`${c.cyan}iTerm2 → Settings → General → tmux${c.reset} 标签页，按下面勾选：`);
  p("");
  p(`  ${c.green}☑${c.reset} ${c.bold}Attaching${c.reset}: ${c.cyan}Tabs in the attaching window${c.reset}  ${c.dim}(agent 变 tab，不另开窗口)${c.reset}`);
  p(`  ${c.green}☑${c.reset} ${c.bold}Automatically bury the tmux client session after connecting${c.reset}`);
  p(`  ${c.green}☑${c.reset} ${c.bold}Use "tmux" profile rather than profile of the connecting session${c.reset}`);
  p(`  ${c.green}☑${c.reset} ${c.bold}Status bar shows tmux status bar content${c.reset}`);
  p(`  ${c.green}☑${c.reset} ${c.bold}Pausing${c.reset}: Pause a pane if it would take more than ${c.yellow}120${c.reset} seconds  ${c.dim}(+ Warn + Unpause)${c.reset}`);
  p(`  ${c.green}☑${c.reset} ${c.bold}Mirror tmux paste buffer to local clipboard${c.reset}`);
  p("");

  p(`${c.bold}${c.green}第 2 步：attach${c.reset}`);
  p("");
  p(`  ${c.cyan}tmux -S ${SOCK} -CC attach${c.reset}`);
  p("");
  p(`${c.dim}每个 agent 变成一个 iTerm2 tab，可以鼠标点、⌘⇧[ / ⌘⇧] 切换。${c.reset}`);
  p(`${c.dim}关闭窗口 = detach（agent 继续跑），下次 attach 回来状态还在。${c.reset}`);
  p("");

  p(`${c.bold}${c.magenta}可选：shell alias${c.reset}`);
  p(`${c.dim}写到 ~/.zshrc 或 ~/.bashrc，以后 ${c.bold}ca${c.reset}${c.dim} 一键 attach：${c.reset}`);
  p("");
  p(`  ${c.cyan}alias ca='tmux -S ${SOCK} -CC attach'${c.reset}`);
  p("");

  p(`${c.bold}${c.blue}非 iTerm2 终端（Terminal.app / Alacritty / kitty / Warp）：普通 tmux 模式${c.reset}`);
  p("");
  p(`  ${c.cyan}claudestra${c.reset}   ${c.dim}在 iTerm2 外运行会自动用普通模式（--plain 可强制；--iterm 反过来唤起 iTerm2）${c.reset}`);
  p(`  ${c.dim}或  tmux -S ${SOCK} attach${c.reset}`);
  p("");
  p(`${c.dim}切窗口 Ctrl-B n / p，离开（agent 继续跑）Ctrl-B d。-CC 模式只有 iTerm2 认，${c.reset}`);
  p(`${c.dim}在别的终端里会吐出一屏控制协议文本。${c.reset}`);
  p("");
  p(`${c.yellow}⚠${c.reset} ${c.dim}会话在私有 socket 里，普通 ${c.reset}tmux ls${c.dim} 看不到是正常的；看窗口列表用 ${c.cyan}claudestra ls${c.reset}`);
  p(`${c.dim}（或 ${c.cyan}tmux -S ${SOCK} ls${c.reset}${c.dim}）。${c.reset}`);
  p("");

  p(`${c.cyan}${bar}${c.reset}`);
  p("");
  p(`${c.dim}再看这份教程：${c.cyan}bun src/manager.ts tmux-help${c.reset}`);
  p("");
}
