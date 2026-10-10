/**
 * 极简终端：只认 tty-screen.ts 用到的几个序列（\r、ESC[2K、ESC[1A、\n，颜色 SGR 略过），把写出去的字节还原成屏幕上的行。
 * tests/acp-tty.test.ts 用它断言「屏幕上最后看到什么」，交付证据里的 TTY 快照也用它；别的 ESC 序列一律报错，免得漏网。
 */
export function termText(out: string): string {
  const lines: string[] = [""];
  let row = 0;
  for (let i = 0; i < out.length; i++) {
    const c = out[i]!;
    if (c === "\r") continue; // 只在 ESC[2K 前出现：回行首；本模拟按整行处理
    if (c === "\n") {
      row++;
      lines[row] ??= "";
    } else if (c === "\x1b") {
      const m = /^\x1b\[(2K|1A|[\d;]*m)/.exec(out.slice(i));
      if (!m) throw new Error(`没见过的控制序列：${JSON.stringify(out.slice(i, i + 8))}`);
      if (m[1] === "2K") lines[row] = "";
      else if (m[1] === "1A") row = Math.max(0, row - 1); // 其余是颜色（SGR）：不占格，略过
      i += m[0].length - 1;
    } else lines[row] += c;
  }
  return lines.join("\n");
}
