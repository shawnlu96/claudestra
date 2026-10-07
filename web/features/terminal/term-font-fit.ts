import type { Terminal } from "@xterm/xterm";
import { postClientLog } from "@/lib/client-log";

/**
 * 网页终端的字号 / 字距 / 汉字宽度（terminal-view.tsx 调；量尺 scripts/acp-term-measure.ts，改前改后数值在 ACPT-3 证据里）。
 * 等宽西文一格约 0.6em，汉字占两格 = 1.2em（手机上还摊进了字距），而汉字字形只有 1em：每个字右边空出近四分之一，
 * 52 列的手机上看着就是「回 复 ： 固 定」。所以另注册一个只管 CJK 码段的回退字体（系统中文字体），按当前格宽放大到两格少 1px。
 * 码段不含 ASCII，xterm 量格宽用的「W」不变，英文行一像素不动；本机没有这些中文字体就加载失败，照旧回退。
 */
const CJK_RANGE = "U+2E80-303F, U+3040-30FF, U+3100-9FFF, U+AC00-D7AF, U+F900-FAFF, U+FE30-FE4F, U+FF00-FFEF";
const CJK_SRC = ["PingFangSC-Regular", "PingFang SC Regular", "Hiragino Sans GB W3", "Microsoft YaHei", "Noto Sans CJK SC Regular", "NotoSansCJKsc-Regular", "Source Han Sans SC"]
  .map((n) => `local("${n}")`).join(", ");
const CJK_FAMILY = /^"term-cjk-[\d.]+", /;
/** 汉字放到两格少这么多（px）：留一点字间，和正常中文排版的字距相当 */
const CJK_GAP = 1;

let face: FontFace | null = null;

/** 按屏上实际格宽（.xterm-screen 宽 / 列数）给汉字补宽；改了家族名 xterm 才会重画字形缓存，所以每个放大比例一个名字 */
export async function fitCjkGlyphs(term: Terminal, container: HTMLElement): Promise<void> {
  const screen = container.querySelector(".xterm-screen") as HTMLElement | null;
  const fs = term.options.fontSize ?? 13, family = term.options.fontFamily ?? "monospace";
  if (!screen?.offsetWidth || !term.cols || typeof FontFace === "undefined") return;
  const pct = Math.round(((2 * (screen.offsetWidth / term.cols) - CJK_GAP) / fs) * 1000) / 10;
  const name = `term-cjk-${pct}`;
  if (family.startsWith(`"${name}", `) || pct <= 100) return;
  try {
    const desc: FontFaceDescriptors & { sizeAdjust: string } = { unicodeRange: CJK_RANGE, sizeAdjust: `${pct}%` }; // lib.dom 还没收 size-adjust
    const next = await new FontFace(name, CJK_SRC, desc).load();
    if (face) document.fonts.delete(face);
    document.fonts.add(next);
    face = next;
    term.options.fontFamily = `"${name}", ${family.replace(CJK_FAMILY, "")}`;
  } catch (e) {
    postClientLog(`[term] 没有可用的系统中文字体，汉字按默认宽度显示：${String(e)}`); // 只是字间宽一点，不影响内容
  }
}

/**
 * [mobile] 字号自适应：window 的完整列数正好铺满容器宽（iTerm 镜像的 window 常比手机视口宽——缩字号而不是裁内容）。
 * measureText 估 cell 宽，floor 保守取整，余量摊进 letterSpacing（52 列的取整损失能到几十 px，右侧一条空白很显眼）；
 * rAF 多轮校验（估算与 renderer 实测有偏差）：溢出 → 先清字距 → 仍溢出缩字号；有空隙 → 实测反推字符宽把空隙摊进字距，上限 6 轮防振荡。
 * 收敛后给汉字补宽（fitCjkGlyphs）。⚠ 不做高度方向的字号约束：44 行塞进可用高会把字号压到看不清，超高由画布底锚裁顶处理。
 */
export function adaptFontSize(term: Terminal, container: HTMLElement, cc: number, disposed: () => boolean): void {
  const avail = container.clientWidth;
  if (!cc || !avail) return;
  const fs0 = term.options.fontSize ?? 13;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return;
  ctx.font = `${fs0}px ${term.options.fontFamily}`;
  const ratio = ctx.measureText("W").width / fs0;
  if (!ratio || !isFinite(ratio)) return;
  const cellW = (avail - 2) / cc;
  const fs = Math.max(8, Math.min(16, Math.floor(cellW / ratio)));
  if (fs !== fs0) term.options.fontSize = fs;
  term.options.letterSpacing = Math.max(0, Math.min(3, cellW - fs * ratio));
  const settle = (n: number) => {
    if (n <= 0) return void fitCjkGlyphs(term, container);
    requestAnimationFrame(() => {
      if (disposed()) return;
      const screen = container.querySelector(".xterm-screen") as HTMLElement | null;
      if (!screen || !screen.offsetWidth) return;
      const lsNow = term.options.letterSpacing ?? 0;
      if (screen.offsetWidth > avail + 1) {
        if (lsNow > 0.05) term.options.letterSpacing = 0;
        else if ((term.options.fontSize ?? 8) > 8) term.options.fontSize = (term.options.fontSize ?? 9) - 1;
        else return;
        return settle(n - 1);
      }
      const rawCell = screen.offsetWidth / cc - lsNow;
      if (rawCell <= 0) return;
      const lsT = Math.max(0, Math.min(4, (avail - 2) / cc - rawCell));
      if (Math.abs(lsT - lsNow) <= 0.05) return void fitCjkGlyphs(term, container);
      term.options.letterSpacing = lsT;
      settle(n - 1);
    });
  };
  settle(6);
}
