/**
 * 把输入行接到真 stdin 上（src/acp-host.ts 一行调用；按键怎么解释在 tty-input.ts）。
 * raw 模式下 Ctrl-C 不再产生 SIGINT，所以退出时一定要把终端模式还回去，不然回到 shell 后不回显。
 * 打开 bracketed paste：粘贴的多行内容夹在 ESC[200~ … ESC[201~ 里，里面的回车留在正文（tmux 按 pane 的模式转发）；终端不支持时每个回车都发一条。
 */
import type { AcpHost } from "./host.js";
import type { TtyScreen } from "./tty-screen.js";
import { createTtyInput } from "./tty-input.js";

type Stdin = Pick<NodeJS.ReadStream, "setRawMode" | "setEncoding" | "on" | "resume">;

/** 返回底栏输入行的画法（交给 createTtyScreen 的 input） */
export function attachTtyInput(
  stdin: Stdin, host: Pick<AcpHost, "turnState" | "pendingPermission" | "terminal">, tty: TtyScreen, exit: () => void,
  write: (s: string) => void = (s) => void process.stdout.write(s),
): (cols: number) => string {
  const input = createTtyInput({
    busy: () => host.turnState.busy,
    permission: () => host.pendingPermission,
    request: (op) => host.terminal(op),
    print: (line) => tty.print(line),
    redraw: () => tty.tick(),
    exit,
  });
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.on("data", (d) => input.feed(String(d)));
  stdin.resume();
  write("\x1b[?2004h");
  process.on("exit", () => {
    write("\x1b[?2004l");
    try {
      stdin.setRawMode(false);
    } catch (e) {
      console.error(`还原终端模式失败（zsh 回到提示符时会自己复位）：${String(e)}`);
    }
  });
  return (cols) => input.line(cols);
}
