import type { ITerminalAddon, ITerminalInitOnlyOptions, ITerminalOptions, Terminal } from "@xterm/xterm";
import { adaptFontSize } from "../features/terminal/term-font-fit";

/** 量尺页面（仓库根 scripts/acp-term-measure.ts 打包进来；放在 web/ 下是因为它是 DOM 代码，根 tsconfig 不收） */
const raf = () => new Promise((r) => requestAnimationFrame(r));

/** 改前 = 同一套字号字距收敛、不给汉字补宽（term-font-fit.ts 的 settled 传空）；改后 = 原样。收敛要几帧 + 中文字体加载，多等一会儿 */
const fitWith = (cjk: boolean) => async (term: Terminal, box: HTMLElement, cc: number) => {
  adaptFontSize(term, box, cc, () => false, ...(cjk ? [] : [() => {}]));
  for (let i = 0; i < 12; i++) await raf();
  await new Promise((r) => setTimeout(r, 300));
  for (let i = 0; i < 3; i++) await raf();
};

const VARIANTS: Record<string, (term: Terminal, box: HTMLElement, cc: number) => Promise<void>> = { before: fitWith(false), after: fitWith(true) };

/** 页面里用 UMD 脚本挂到 window 上的 xterm 与 WebGL 插件；_core 是私有字段，量尺读格宽用（只在这里用） */
type Umd = { Terminal: new (o: ITerminalOptions & ITerminalInitOnlyOptions) => Terminal; WebglAddon: { WebglAddon: new () => ITerminalAddon } };
type Core = { _core: { _renderService: { dimensions: { css: { cell: { width: number; height: number } } } } } };

type Setup = { v: string; cols: number; rows: number; text: string; font: string };
export type Dims = { fs: number; ls: number; cell: number; cellH: number; screenW: number; avail: number; left: number; top: number };

/** 开一个 xterm（WebGL）按某种取法定字号，写入内容，返回实际格宽等 */
async function setup({ v, cols, rows, text, font }: Setup): Promise<Dims> {
  const w = window as unknown as Umd, f = VARIANTS[v];
  if (!f) throw new Error(`没有这个取法：${v}`);
  const box = document.getElementById("t")!;
  const term = new w.Terminal({ cols, rows, fontSize: 13, fontFamily: font, theme: { background: "#1e1e2e", foreground: "#cdd6f4" } });
  term.open(box);
  term.loadAddon(new w.WebglAddon.WebglAddon());
  await f(term, box, cols);
  await new Promise<void>((res) => term.write(text, () => res()));
  for (let i = 0; i < 5; i++) await raf();
  const dims = (term as unknown as Core)._core._renderService.dimensions.css;
  const screen = box.querySelector(".xterm-screen") as HTMLElement;
  const rect = screen.getBoundingClientRect();
  const o = term.options;
  return { fs: o.fontSize ?? 0, ls: o.letterSpacing ?? 0, cell: dims.cell.width, cellH: dims.cell.height, screenW: screen.offsetWidth, avail: box.clientWidth, left: rect.left, top: rect.top };
}

/** 截图逐像素量：第 0 行每个汉字两格里的墨迹宽、相邻两个汉字的间隙；第 2 行（英文）右边留多少 */
async function ink({ b64, r, zh, width }: { b64: string; r: Dims; zh: string; width: number }) {
  const img = new Image();
  img.src = `data:image/png;base64,${b64}`;
  await img.decode();
  const c = document.createElement("canvas");
  [c.width, c.height] = [img.width, img.height];
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const s = img.width / width, rowH = Math.round(r.cellH * s);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  const inkCol = (x: number, y0: number) => { // 这一列在这一行里有没有字（和背景色差得多就算）
    for (let y = y0; y < y0 + rowH; y++) {
      const i = (y * c.width + x) * 4;
      if (Math.abs(data[i]! - 0x1e) + Math.abs(data[i + 1]! - 0x1e) + Math.abs(data[i + 2]! - 0x2e) > 120) return true;
    }
    return false;
  };
  const glyphs: { left: number; right: number; box: number; punct: boolean }[] = [];
  let cellX = r.left;
  for (const ch of zh) {
    const x0 = Math.round(cellX * s), x1 = Math.round((cellX + 2 * r.cell) * s);
    let left = -1, right = -1;
    for (let x = x0; x < x1; x++) {
      if (!inkCol(x, 0)) continue;
      if (left < 0) left = x;
      right = x;
    }
    glyphs.push({ left: left / s, right: (right + 1) / s, box: (x1 - x0) / s, punct: /[，：、]/.test(ch) || left < 0 });
    cellX += 2 * r.cell;
  }
  const gaps = glyphs.slice(1).flatMap((g, i) => (g.punct || glyphs[i]!.punct ? [] : [g.left - glyphs[i]!.right])); // 只量相邻两个汉字之间
  const han = glyphs.filter((g) => !g.punct);
  let enRight = 0;
  for (let x = 0; x < c.width; x++) if (inkCol(x, 2 * rowH)) enRight = x;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return { inkW: mean(han.map((g) => g.right - g.left)), gapMean: mean(gaps), gapMax: Math.max(...gaps),
    inkRatio: mean(han.map((g) => (g.right - g.left) / g.box)), enRightBlank: width - (enRight + 1) / s };
}

Object.assign(globalThis, { __setup: setup, __ink: ink });
