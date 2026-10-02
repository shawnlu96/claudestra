/** 侧栏「新终端」（宿主 shell，web/features/terminal/shell-button.tsx、use-shell-view.tsx）的字典条目，规则同 lib/i18n-dict.ts；主字典顶在行数上限，单独成文件 */
export const SHELL_DICT: Record<string, string> = {
  "新终端": "New terminal",
  "新终端（在这台机器上开 shell）": "New terminal (a shell on this machine)",
  "在这台机器上开一个 shell，粘贴命令直接跑": "Open a shell on this machine — paste a command and run it",
  "起始目录": "Start in",
  "新开一个": "Open new",
  "最多同时开 {n} 个终端，先关掉一个": "At most {n} terminals at once — close one first",
  "已开的终端（断开不会结束，可以回来接着用）": "Open terminals (leaving keeps them running — come back any time)",
  "还没有开着的终端": "No open terminals",
  "关闭此终端": "Close this terminal",
  "关闭后 shell 和里面正在跑的命令都会结束，确定？": "Closing ends the shell and anything running in it. Continue?",
  "关闭失败": "Close failed",
};
