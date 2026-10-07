/**
 * ACP 窗口是 TTY 时的画法（src/acp-host.ts 接线；不是 TTY 就不用它，照旧一段一行纯文本，测试和日志靠那个）。
 * 不设滚动区：底栏（状态行，接了输入时再加一行输入行）永远在最后，光标停在最后一行行尾；要写内容就先擦掉底栏、写内容、再画回来。
 * 光标只用 \r、ESC[2K 擦行、ESC[1A 上移（tmux attach、网页终端都认）；颜色（SGR）每行自带复位。排法和颜色在 tty-layout.ts。tests/acp-tty.test.ts。
 */
import { createTextStream } from "./transcript-stream.js";
import { createTtyLayout, dim } from "./tty-layout.js";
import { fitWidth, foldsOf, statusText, type TurnState } from "./tty-status.js";

export interface TtyIo {
  write(s: string): void;
  columns(): number;
}

export interface TtyScreen {
  /** 一段会话（transcript.ts 的段）：盖时间、正文终稿去掉已流出的部分 */
  show(item: string, at?: Date): void;
  /** 一条原始 session/update：正文增量流式续写 */
  update(u: unknown, at?: Date): void;
  /** 不盖时间的一行（宿主日志写不进盘时的退路） */
  print(line: string): void;
  /** 定时调：状态变了（含计时走了一秒）才重画 */
  tick(): void;
  /** 窗口宽度变了：终端会把变窄后放不下的旧状态行折成几行，一起擦掉再画 */
  resize(): void;
  /** 退出前擦掉状态行，shell 提示符别接在它后面 */
  close(): void;
}

const CLEAR = "\r\x1b[2K";

/** input：给了就在状态行下面多画一行输入行（tty-input.ts 按宽度截好的内容） */
export function createTtyScreen(io: TtyIo, state: () => TurnState, now: () => number = Date.now, input?: (cols: number) => string): TtyScreen {
  const layout = createTtyLayout(), stream = createTextStream();
  let footer: string[] = [""], drawnCols = 0, busySince: number | null = null;
  const render = (): string[] => {
    const s = state(), cols = io.columns();
    busySince = s.busy ? (busySince ?? now()) : null;
    const status = fitWidth(statusText(s, busySince === null ? 0 : now() - busySince), cols);
    return input ? [status, input(cols)] : [status];
  };
  /** 擦掉屏上的底栏：每行一行往上擦；画的时候比现在宽，终端已把各行折成几行（光标在最后一折），每折都擦。定时重画可能先于 resize 事件，所以每次都要看 */
  const erase = (): string => {
    const cols = Math.max(1, io.columns());
    const folds = drawnCols > cols ? footer.reduce((n, l) => n + foldsOf(l, cols), 0) : 0;
    return `${CLEAR}${"\x1b[1A\x1b[2K".repeat(footer.length - 1 + folds)}`;
  };
  const draw = (body: string, next: string[]) => {
    io.write(`${erase()}${body}${next.map((l, i) => (i ? l : dim(l))).join("\n")}`); // 底栏存纯文本：擦行按它算折数
    footer = next;
    drawnCols = io.columns();
  };
  const put = (body: string) => draw(`${body}\n`, render());
  return {
    show: (item, at) => stream.settle(item).forEach((i) => put(layout(i, io.columns(), at))),
    update: (u, at) => stream.chunk(u).forEach((i) => put(layout(i, io.columns(), at))),
    print: put,
    tick() {
      const next = render();
      if (next.join("\n") !== footer.join("\n") || io.columns() !== drawnCols) draw("", next);
    },
    resize: () => draw("", render()),
    close: () => io.write(erase()),
  };
}
