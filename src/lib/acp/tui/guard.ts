/**
 * 新视图的保险：任何一次调用抛错，就记一条原因（宿主的 host.log）、擦掉新视图的底栏、换成逐行视图（tty-screen.ts），
 * 并把这次调用在逐行视图上重放——那条消息照样显示，宿主不退出。只退一次：退回后的逐行视图再出错照旧往上抛（和接新视图之前一样）。
 * tests/acp-tui-guard.test.ts。
 */
import type { TtyScreen } from "../tty-screen.js";
import type { TuiScreen } from "./screen.js";

export function guardScreen(primary: () => TuiScreen, fallback: () => TtyScreen, log: (msg: string) => void): TuiScreen {
  let cur: TtyScreen | TuiScreen, fell = false;
  const fallBack = (e: unknown) => {
    fell = true;
    log(`ACP 终端新视图出错，退回逐行视图：${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    try {
      cur?.close();
    } catch (err) {
      log(`新视图收尾也出错（底栏可能留一两行旧字，下一次重画前不影响收消息）：${String(err)}`);
    }
    cur = fallback();
  };
  try {
    cur = primary();
  } catch (e) {
    fallBack(e);
  }
  const run = (fn: (s: TtyScreen | TuiScreen) => void) => {
    if (fell) return fn(cur);
    try {
      fn(cur);
    } catch (e) {
      fallBack(e);
      fn(cur);
    }
  };
  return {
    show: (item, at) => run((s) => s.show(item, at)),
    update: (u, at) => run((s) => s.update(u, at)),
    print: (line) => run((s) => s.print(line)),
    tick: () => run((s) => s.tick()),
    resize: () => run((s) => s.resize()),
    close: () => run((s) => s.close()),
    config: (raw) => run((s) => ("config" in s ? s.config(raw) : undefined)),
  };
}
