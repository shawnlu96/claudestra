import { adaptFontSize } from "../features/terminal/term-font-fit";

/** 量尺页面里的字号取法（仓库根 scripts/acp-term-measure.ts 打包进页面；放在 web/ 下是因为它是 DOM 代码，根 tsconfig 不收）：before = 改前 terminal-view.tsx 的 adaptFontSize 原样照抄 */
const raf = () => new Promise((r) => requestAnimationFrame(r));

async function before(term: any, container: HTMLElement, cc: number) {
  const avail = container.clientWidth;
  const fs0 = term.options.fontSize ?? 13;
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = `${fs0}px ${term.options.fontFamily}`;
  const ratio = ctx.measureText("W").width / fs0;
  const cellW = (avail - 2) / cc;
  const fs = Math.max(8, Math.min(16, Math.floor(cellW / ratio)));
  const ls = Math.max(0, Math.min(3, cellW - fs * ratio));
  if (fs !== fs0) term.options.fontSize = fs;
  term.options.letterSpacing = ls;
  for (let n = 6; n > 0; n--) {
    await raf();
    const screen = container.querySelector(".xterm-screen") as HTMLElement | null;
    if (!screen || !screen.offsetWidth) return;
    const lsNow = term.options.letterSpacing ?? 0;
    if (screen.offsetWidth > avail + 1) {
      if (lsNow > 0.05) term.options.letterSpacing = 0;
      else if ((term.options.fontSize ?? 8) > 8) term.options.fontSize = (term.options.fontSize ?? 9) - 1;
      else return;
      continue;
    }
    const rawCell = screen.offsetWidth / cc - lsNow;
    if (rawCell <= 0) return;
    const lsT = Math.max(0, Math.min(4, (avail - 2) / cc - rawCell));
    if (Math.abs(lsT - lsNow) > 0.05) term.options.letterSpacing = lsT;
    else return;
  }
}

/** after = 改后的 term-font-fit.ts（真的那份，打包进页面）；收敛要几帧 + 中文字体加载，多等一会儿 */
async function after(term: any, box: HTMLElement, cc: number) {
  adaptFontSize(term, box, cc, () => false);
  for (let i = 0; i < 12; i++) await raf();
  await new Promise((r) => setTimeout(r, 300));
  for (let i = 0; i < 3; i++) await raf();
}

const VARIANTS: Record<string, (term: any, box: HTMLElement, cc: number) => Promise<void>> = { before, after };

type Setup = { v: string; cols: number; rows: number; text: string; font: string };
export type Dims = { fs: number; ls: number; cell: number; cellH: number; screenW: number; avail: number; left: number; top: number };

/** 开一个 xterm（WebGL）按某种取法定字号，写入内容，返回实际格宽等 */
async function setup({ v, cols, rows, text, font }: Setup): Promise<Dims> {
  const w = window as any, f = VARIANTS[v];
  if (!f) throw new Error(`没有这个取法：${v}`);
  const box = document.getElementById("t")!;
  const term = new w.Terminal({ cols, rows, fontSize: 13, fontFamily: font, theme: { background: "#1e1e2e", foreground: "#cdd6f4" } });
  term.open(box);
  term.loadAddon(new w.WebglAddon.WebglAddon());
  await f(term, box, cols);
  await new Promise<void>((res) => term.write(text, () => res()));
  for (let i = 0; i < 5; i++) await raf();
  const dims = term._core._renderService.dimensions.css; // 量尺读私有字段没关系：只在这里用
  const screen = box.querySelector(".xterm-screen") as HTMLElement;
  const rect = screen.getBoundingClientRect();
  return { fs: term.options.fontSize, ls: term.options.letterSpacing, cell: dims.cell.width, cellH: dims.cell.height, screenW: screen.offsetWidth, avail: box.clientWidth, left: rect.left, top: rect.top };
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
    for (let x = x0; x < x1; x++) if (inkCol(x, 0)) ((left = left < 0 ? x : left), (right = x));
    glyphs.push({ left: left / s, right: (right + 1) / s, box: (x1 - x0) / s, punct: /[，：、]/.test(ch) || left < 0 });
    cellX += 2 * r.cell;
  }
  const gaps = glyphs.slice(1).flatMap((g, i) => (g.punct || glyphs[i]!.punct ? [] : [g.left - glyphs[i]!.right])); // 只量相邻两个汉字之间
  const han = glyphs.filter((g) => !g.punct);
  let enRight = 0;
  for (let x = 0; x < c.width; x++) if (inkCol(x, 2 * rowH)) enRight = x;
  return { inkW: han.reduce((a, g) => a + g.right - g.left, 0) / han.length, gapMean: gaps.reduce((a, b) => a + b, 0) / gaps.length, gapMax: Math.max(...gaps),
    inkRatio: han.reduce((a, g) => a + (g.right - g.left) / g.box, 0) / han.length, enRightBlank: width - (enRight + 1) / s };
}

Object.assign(globalThis, { __setup: setup, __ink: ink });
