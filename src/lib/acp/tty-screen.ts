/**
 * ACP 窗口是 TTY 时的画法（src/acp-host.ts 接线；不是 TTY 就不用它，照旧一段一行纯文本，测试和日志靠那个）。
 * 不设滚动区：最后一行永远是状态行，光标停在它上面；要写内容就先擦掉这一行、写内容、再把状态行画回来。
 * tmux attach、网页终端（xterm 连 tmux）都只认这几个序列：\r、ESC[2K 擦行、ESC[1A 上移。tests/acp-tty.test.ts。
 */
import { createTextStream } from "./transcript-stream.js";
import { createTranscriptStamper } from "./transcript.js";
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

export function createTtyScreen(io: TtyIo, state: () => TurnState, now: () => number = Date.now): TtyScreen {
  const stamp = createTranscriptStamper(), stream = createTextStream();
  let status = "", drawnCols = 0, busySince: number | null = null;
  const render = (): string => {
    const s = state();
    busySince = s.busy ? (busySince ?? now()) : null;
    return fitWidth(statusText(s, busySince === null ? 0 : now() - busySince), io.columns());
  };
  /** 擦掉屏上的状态行：画的时候比现在宽，终端已把它折成几行（光标在最后一折），每折都擦。定时重画可能先于 resize 事件，所以每次都要看 */
  const erase = (): string => {
    const cols = Math.max(1, io.columns());
    return `${CLEAR}${"\x1b[1A\x1b[2K".repeat(drawnCols > cols ? foldsOf(status, cols) : 0)}`;
  };
  const draw = (body: string, next: string) => {
    io.write(`${erase()}${body}${next}`);
    status = next;
    drawnCols = io.columns();
  };
  const put = (body: string) => draw(`${body}\n`, render());
  return {
    show: (item, at) => stream.settle(item).forEach((i) => put(stamp(i, at))),
    update: (u, at) => stream.chunk(u).forEach((i) => put(stamp(i, at))),
    print: put,
    tick() {
      const next = render();
      if (next !== status || io.columns() !== drawnCols) draw("", next);
    },
    resize: () => draw("", render()),
    close: () => io.write(erase()),
  };
}
