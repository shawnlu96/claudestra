/**
 * 压缩命令在 CC 输入框里放不放得下（纯函数，tests/ctx-boundary-fit.test.ts）。输入框有最大显示行数，超出只画末尾几行，
 * 而且第一行照样画「❯」、看不出截断，敲完核对只能读到后半截。所以敲之前按窗口宽高估一下，放不下就退一档（自定清单 →
 * 默认清单 → 只发 /compact），连 /compact 都放不下就不敲；估少了由敲完的核对兜底（看到的正好是后半截就删掉、退一档）。
 * 数字是私有 tmux 里真 CC 2.1.283 实测的（adv2 P2-1），CC 改版改了输入框要重测。
 */
import { compactCommand, DEFAULT_KEEP_LIST, type CompactAction, type CompactKeep } from "./ctx-boundary-policy.js";

export interface PaneSize {
  width: number;
  height: number;
}

/** 每行放得下的列数：左边「❯ 」或两格缩进，右边留两格（16～200 列逐档实测） */
export const inputCols = (width: number) => width - 4;

/** 最多显示几行：max(3, ⌊高/2⌋ − 5)（12～60 行高逐档实测）；12 行以下没量，只按 1 行算 */
export const inputRowsVisible = (height: number) => (height < 12 ? 1 : Math.max(3, Math.floor(height / 2) - 5));

/**
 * 这段字在输入框里占几行，照 wrap-ansi（hard、trim、按词折行）数：按空格分词，放不下的词挪到下一行；比一行还长的词
 * （连着的中文就是一个长词）从当前行接着断，挪到下一行能少断一次就先换行；中文按 2 列算（Bun.stringWidth）。
 * 16～120 列和真 CC 逐行对得上，只有 24 列时默认清单少算一行，所以 fitsInputBox 留一行余量。
 */
export function inputRowsNeeded(text: string, cols: number): number {
  let rows = 1;
  let cur = 0;
  const newRow = () => {
    rows++;
    cur = 0;
  };
  text.split(" ").forEach((w, i) => {
    const lw = Bun.stringWidth(w);
    if (i > 0 && cur > 0) cur++; // 词前的空格；行首的会被 trim 掉
    if (lw > cols) {
      if (Math.floor((lw - 1) / cols) < 1 + Math.floor((lw - (cols - cur) - 1) / cols)) newRow();
      const chars = [...w];
      chars.forEach((ch, j) => {
        const cw = Bun.stringWidth(ch);
        if (cur + cw > cols) newRow();
        cur += cw;
        if (cur === cols && j < chars.length - 1) newRow();
      });
      return;
    }
    if (cur + lw > cols && cur > 0 && lw > 0) newRow();
    cur += lw;
  });
  return rows;
}

/**
 * 整条能不能显示出来：多留一行（光标可能另起一行；窄窗口里估算偶尔少一行）。只占一行、行尾还空着给光标的短命令不用留。
 * 一行不到 2 列（中文字放不下）直接算放不下。
 */
export function fitsInputBox(line: string, size: PaneSize): boolean {
  const cols = inputCols(size.width);
  if (cols < 2) return false;
  const rows = inputRowsNeeded(line, cols);
  return (rows === 1 && Bun.stringWidth(line) < cols ? 1 : rows + 1) <= inputRowsVisible(size.height);
}

type CompactTier = "keep" | "default" | "bare" | "save";
const TIER_TEXT: Record<CompactTier, string> = { keep: "自定保留清单", default: "默认保留清单", bare: "只发 /compact", save: "/save-compact" };
export interface TieredLine {
  tier: CompactTier;
  line: string;
}

/** 从长到短的几档；save-compact 只有一档（13 字，窗口再小也放得下，放不下就跳过） */
export function compactTiers(action: CompactAction, keep: CompactKeep | null): TieredLine[] {
  if (action === "save-compact") return [{ tier: "save", line: compactCommand(action, null) }];
  const dflt: TieredLine = { tier: "default", line: `/compact ${DEFAULT_KEEP_LIST}` };
  return [...(keep ? [{ tier: "keep" as const, line: compactCommand(action, keep) }] : []), dflt, { tier: "bare", line: "/compact" }];
}

/** 按窗口挑能敲的几档（从长到短）；窗口大小读不到就不估，全留着，由敲完的核对兜底 */
export function tiersThatFit(action: CompactAction, keep: CompactKeep | null, size: PaneSize | null): { all: TieredLine[]; fit: TieredLine[] } {
  const all = compactTiers(action, keep);
  return { all, fit: size ? all.filter((t) => fitsInputBox(t.line, size)) : all };
}

export const sizeText = (size: PaneSize | null | undefined) => (size ? `窗口 ${size.width}×${size.height}` : "窗口大小没读到");

/** 退了几档的说明（日志、dry-run 用）；没退档返回 null */
export function tierNote(all: TieredLine[], used: TieredLine, size: PaneSize | null | undefined): string | null {
  const dropped = all.slice(0, all.indexOf(used));
  if (!dropped.length) return null;
  return `${sizeText(size)} 放不下${dropped.map((t) => TIER_TEXT[t.tier]).join("、")}，退到${TIER_TEXT[used.tier]}`;
}

/** dry-run 里「会敲什么」：按当前窗口大小挑档，连 /compact 都放不下就写明会跳过 */
export function describeCompactPlan(action: CompactAction, keep: CompactKeep | null, size: PaneSize | null): string {
  const { all, fit } = tiersThatFit(action, keep, size);
  const first = fit[0];
  if (!first) return `${sizeText(size)} 连 ${all.at(-1)!.line} 都放不下：跳过并提醒 owner`;
  const note = tierNote(all, first, size);
  return note ? `${first.line}（${note}）` : first.line;
}

export const normBox = (s: string) => s.replace(/\s+/g, ""); // CC 按词折行，折行处的空格会被吃掉：去掉空白再比（09-29 真 CC 实测）

/** 显示区满了：输入框占满最多显示的行数，前面可能还有没画出来的 */
const boxMayBeCut = (rows: number, size: PaneSize | null | undefined) => !!size && rows >= inputRowsVisible(size.height);

/** 框里看到的（去空白后的 got，占 rows 行）是不是正好这段字：显示区没满就得完全一样；满了（可能截断）只要是它的后半截 */
export function boxShows(got: string, rows: number, text: string, size: PaneSize | null | undefined): boolean {
  const want = normBox(text);
  return got === want || (got.length > 0 && boxMayBeCut(rows, size) && want.endsWith(got));
}

/**
 * 自己留在框里的字还剩哪段：inflight 是最后一批发出去、不知道生效了几个的退格（中途弹对话框、核对没对上），框里应是 text 的
 * 前 [长度 − inflight, 长度] 个字。对上一个就是它（只差空白的取短的：少删）；几个不同的长度都对得上（重复的字 + 截断）就拿不准，
 * 返回 null，一个字也不删。框空且 inflight 覆盖得到 → ""（已经删完了）。
 */
export function ourRemainder(got: string, rows: number, text: string, inflight: number, size: PaneSize | null | undefined): string | null {
  const chars = [...text];
  let hit: string | null = null;
  for (let len = Math.max(0, chars.length - inflight); len <= chars.length; len++) {
    const cand = chars.slice(0, len).join("");
    if (!(cand ? boxShows(got, rows, cand, size) : got === "")) continue;
    if (hit !== null && normBox(hit) !== normBox(cand)) return null;
    hit ??= cand;
  }
  return hit;
}
