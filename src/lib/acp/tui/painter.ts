/**
 * 往终端写的唯一出口（screen.ts 用）：定稿行写在底栏上面、写完就进 tmux 滚动记录；底栏每次擦掉重画。
 * 不设滚动区、不用绝对坐标，光标只用 \r、ESC[2K、ESC[1A；底栏永远紧跟在最后一行定稿后面，光标停在底栏最后一行（隐藏，输入框里画假光标）。
 * 窗口变窄时 tmux 已把旧底栏各行折成几行（光标在最后一折），按 tty-status.ts foldsOf（照 tmux 重排规则）每折都擦。
 * 「这里该空一行」用记号 GAP_MARK 传进来，写出前才定：前一行已经是空行（含上一批的末行）就不空。tests/acp-tui-screen.test.ts。
 */
import { foldsOf } from "../tty-status.js";
import { stripSgr } from "./text.js";

export interface PainterIo {
  write(s: string): void;
  columns(): number;
}

export const GAP_MARK = "\0gap";
const CLEAR = "\r\x1b[2K", UP = "\x1b[1A\x1b[2K", HIDE = "\x1b[?25l", SHOW = "\x1b[?25h";

export function createPainter(io: PainterIo, render: () => string[]) {
  let footer: string[] = [""], drawnCols = 0, hidden = false, lastBlank = true;
  const erase = (): string => {
    const c = Math.max(1, io.columns());
    const folds = drawnCols > c ? footer.reduce((n, l) => n + foldsOf(stripSgr(l), c), 0) : 0;
    return `${CLEAR}${UP.repeat(footer.length - 1 + folds)}`;
  };
  const resolveGaps = (marked: readonly string[]): string[] => {
    const body: string[] = [];
    for (const l of marked) {
      if (l !== GAP_MARK) body.push(l);
      else if (!lastBlank) body.push("");
      if (body.length) lastBlank = body.at(-1) === "";
    }
    return body;
  };
  const draw = (marked: readonly string[], next = render()) => {
    const body = resolveGaps(marked);
    io.write(`${hidden ? "" : HIDE}${erase()}${body.map((l) => `${l}\n`).join("")}${next.join("\n")}`);
    [footer, drawnCols, hidden] = [next, io.columns(), true];
  };
  return {
    /** 有定稿就写定稿 + 底栏；没有就只在底栏变了（含宽度变了）时重画 */
    commit(body: readonly string[]): void {
      const next = render();
      if (body.length || next.join("\n") !== footer.join("\n") || io.columns() !== drawnCols) draw(body, next);
    },
    redraw: (): void => draw([]),
    close(): void {
      io.write(`${erase()}${SHOW}`);
      [footer, hidden] = [[""], false];
    },
  };
}
