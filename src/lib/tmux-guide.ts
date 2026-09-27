/**
 * tmux 快速教程打印器
 *
 * 被 setup.ts 和 manager.ts tmux-help 共用。
 * 输出针对 Claudestra 的 master session 场景：iTerm2 -CC 模式 + 普通 tmux。
 * 语言跟 lib/i18n：setup 选完语言就 setLangInMemory；manager 没 initLang，tmux-help 仍是中文。
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

import { t } from "./i18n.js";
import { TMUX_SOCK } from "./paths.js";

const SOCK = TMUX_SOCK;

function p(s: string = "") { process.stdout.write(s + "\n"); }
/** 一行灰字说明 */
function dim(zh: string, en: string) { p(`${c.dim}${t(zh, en)}${c.reset}`); }

export function printTmuxGuide(): void {
  const bar = "━".repeat(60);

  p("");
  p(`${c.cyan}${bar}${c.reset}`);
  p(`${c.bold}${c.cyan}  ${t("tmux × iTerm2 attach（1 分钟）", "tmux × iTerm2 attach (1 minute)")}${c.reset}`);
  p(`${c.cyan}${bar}${c.reset}`);
  p("");
  p(t(
    `${c.dim}Claudestra 把所有 agent 放进一个 tmux session（叫 ${c.bold}master${c.reset}${c.dim}），${c.reset}`,
    `${c.dim}Claudestra puts every agent in one tmux session (called ${c.bold}master${c.reset}${c.dim}),${c.reset}`,
  ));
  dim("每个 agent 是其中一个 window。用 iTerm2 的 tmux 集成（-CC 模式）", "one window per agent. With iTerm2's tmux integration (-CC mode),");
  dim("attach 后，每个 window 就是一个 iTerm2 tab，鼠标点、⌘T 都能用。", "each window becomes an iTerm2 tab once attached — clicking and ⌘T both work.");
  p("");

  p(`${c.bold}${c.yellow}${t("第 1 步：配置 iTerm2（先做，一次配完永远受益）", "Step 1: configure iTerm2 (do this first — one-time setup)")}${c.reset}`);
  p(`${c.cyan}iTerm2 → Settings → General → tmux${c.reset} ${t("标签页，按下面勾选：", "tab, tick these:")}`);
  p("");
  p(`  ${c.green}☑${c.reset} ${c.bold}Attaching${c.reset}: ${c.cyan}Tabs in the attaching window${c.reset}  ` +
    `${c.dim}${t("(agent 变 tab，不另开窗口)", "(agents become tabs, no extra window)")}${c.reset}`);
  p(`  ${c.green}☑${c.reset} ${c.bold}Automatically bury the tmux client session after connecting${c.reset}`);
  p(`  ${c.green}☑${c.reset} ${c.bold}Use "tmux" profile rather than profile of the connecting session${c.reset}`);
  p(`  ${c.green}☑${c.reset} ${c.bold}Status bar shows tmux status bar content${c.reset}`);
  p(`  ${c.green}☑${c.reset} ${c.bold}Pausing${c.reset}: Pause a pane if it would take more than ${c.yellow}120${c.reset} seconds  ${c.dim}(+ Warn + Unpause)${c.reset}`);
  p(`  ${c.green}☑${c.reset} ${c.bold}Mirror tmux paste buffer to local clipboard${c.reset}`);
  p("");

  p(`${c.bold}${c.green}${t("第 2 步：attach", "Step 2: attach")}${c.reset}`);
  p("");
  p(`  ${c.cyan}tmux -S ${SOCK} -CC attach${c.reset}`);
  p("");
  dim("每个 agent 变成一个 iTerm2 tab，可以鼠标点、⌘⇧[ / ⌘⇧] 切换。", "Each agent becomes an iTerm2 tab; click or use ⌘⇧[ / ⌘⇧] to switch.");
  dim("关闭窗口 = detach（agent 继续跑），下次 attach 回来状态还在。", "Closing the window = detach (agents keep running); attach again and everything is still there.");
  p("");

  p(`${c.bold}${c.magenta}${t("可选：shell alias", "Optional: shell alias")}${c.reset}`);
  p(t(
    `${c.dim}写到 ~/.zshrc 或 ~/.bashrc，以后 ${c.bold}ca${c.reset}${c.dim} 一键 attach：${c.reset}`,
    `${c.dim}Add this to ~/.zshrc or ~/.bashrc, then ${c.bold}ca${c.reset}${c.dim} attaches in one go:${c.reset}`,
  ));
  p("");
  p(`  ${c.cyan}alias ca='tmux -S ${SOCK} -CC attach'${c.reset}`);
  p("");

  p(`${c.bold}${c.blue}${t(
    "非 iTerm2 终端（Terminal.app / Alacritty / kitty / Warp）：普通 tmux 模式",
    "Other terminals (Terminal.app / Alacritty / kitty / Warp): plain tmux mode",
  )}${c.reset}`);
  p("");
  p(`  ${c.cyan}claudestra${c.reset}   ${c.dim}${t(
    "在 iTerm2 外运行会自动用普通模式（--plain 可强制；--iterm 反过来唤起 iTerm2）",
    "uses plain mode automatically outside iTerm2 (--plain forces it; --iterm opens iTerm2 instead)",
  )}${c.reset}`);
  p(`  ${c.dim}${t("或", "or")}  tmux -S ${SOCK} attach${c.reset}`);
  p("");
  dim("切窗口 Ctrl-B n / p，离开（agent 继续跑）Ctrl-B d。-CC 模式只有 iTerm2 认，", "Switch windows with Ctrl-B n / p; leave (agents keep running) with Ctrl-B d. Only iTerm2 understands -CC mode —");
  dim("在别的终端里会吐出一屏控制协议文本。", "other terminals print a screenful of control-protocol text.");
  p("");
  p(t(
    `${c.yellow}⚠${c.reset} ${c.dim}会话在私有 socket 里，普通 ${c.reset}tmux ls${c.dim} 看不到是正常的；看窗口列表用 ${c.cyan}claudestra ls${c.reset}`,
    `${c.yellow}⚠${c.reset} ${c.dim}The session lives on a private socket, so plain ${c.reset}tmux ls${c.dim} not showing it is normal; list windows with ${c.cyan}claudestra ls${c.reset}`,
  ));
  p(t(
    `${c.dim}（或 ${c.cyan}tmux -S ${SOCK} ls${c.reset}${c.dim}）。${c.reset}`,
    `${c.dim}(or ${c.cyan}tmux -S ${SOCK} ls${c.reset}${c.dim}).${c.reset}`,
  ));
  p("");

  p(`${c.cyan}${bar}${c.reset}`);
  p("");
  p(`${c.dim}${t("再看这份教程：", "See this guide again: ")}${c.cyan}bun src/manager.ts tmux-help${c.reset}`);
  p("");
}
