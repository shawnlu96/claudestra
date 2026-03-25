/**
 * 终端截图：将 tmux capture-pane 的 ANSI 输出渲染成 PNG 图片
 */

import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

// ANSI 16 色调色板（暗色主题）
const COLORS: Record<number, string> = {
  0: "#1e1e2e",   // black
  1: "#f38ba8",   // red
  2: "#a6e3a1",   // green
  3: "#f9e2af",   // yellow
  4: "#89b4fa",   // blue
  5: "#cba6f7",   // magenta
  6: "#94e2d5",   // cyan
  7: "#cdd6f4",   // white
  8: "#585b70",   // bright black
  9: "#f38ba8",   // bright red
  10: "#a6e3a1",  // bright green
  11: "#f9e2af",  // bright yellow
  12: "#89b4fa",  // bright blue
  13: "#cba6f7",  // bright magenta
  14: "#94e2d5",  // bright cyan
  15: "#ffffff",  // bright white
};

const BG_COLOR = "#1e1e2e";
const FG_COLOR = "#cdd6f4";
const FONT_SIZE = 13;
const LINE_HEIGHT = 15;
const CHAR_WIDTH = 7.8;
const PADDING = 12;

interface TextSpan {
  text: string;
  fg: string;
  bg: string;
  bold: boolean;
}

function parseAnsi(input: string): TextSpan[][] {
  const lines = input.split("\n");
  const result: TextSpan[][] = [];

  for (const line of lines) {
    const spans: TextSpan[] = [];
    let fg = FG_COLOR;
    let bg = BG_COLOR;
    let bold = false;
    let pos = 0;

    // eslint-disable-next-line no-control-regex
    const re = /\x1b\[([0-9;]*)m/g;
    let match: RegExpExecArray | null;
    let lastIndex = 0;

    while ((match = re.exec(line)) !== null) {
      // Text before this escape
      if (match.index > lastIndex) {
        spans.push({ text: line.slice(lastIndex, match.index), fg, bg, bold });
      }
      lastIndex = re.lastIndex;

      // Parse SGR codes
      const codes = match[1].split(";").map(Number);
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        if (c === 0) { fg = FG_COLOR; bg = BG_COLOR; bold = false; }
        else if (c === 1) bold = true;
        else if (c >= 30 && c <= 37) fg = COLORS[c - 30] || FG_COLOR;
        else if (c >= 40 && c <= 47) bg = COLORS[c - 40] || BG_COLOR;
        else if (c >= 90 && c <= 97) fg = COLORS[c - 82] || FG_COLOR;
        else if (c >= 100 && c <= 107) bg = COLORS[c - 92] || BG_COLOR;
        else if (c === 39) fg = FG_COLOR;
        else if (c === 49) bg = BG_COLOR;
      }
    }

    // Remaining text
    if (lastIndex < line.length) {
      spans.push({ text: line.slice(lastIndex), fg, bg, bold });
    }

    if (spans.length === 0) {
      spans.push({ text: "", fg: FG_COLOR, bg: BG_COLOR, bold: false });
    }

    result.push(spans);
  }

  return result;
}

export async function renderTerminal(text: string, outputPath: string): Promise<void> {
  // 去掉末尾空行
  const cleanText = text.replace(/\n+$/, "");
  const parsed = parseAnsi(cleanText);

  const maxChars = Math.max(...parsed.map((spans) =>
    spans.reduce((acc, s) => acc + s.text.length, 0)
  ), 40);

  const width = Math.ceil(maxChars * CHAR_WIDTH) + PADDING * 2;
  const height = parsed.length * LINE_HEIGHT + PADDING * 2;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // 背景
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, width, height);

  // 绘制每行
  for (let lineIdx = 0; lineIdx < parsed.length; lineIdx++) {
    const spans = parsed[lineIdx];
    let x = PADDING;
    const y = PADDING + lineIdx * LINE_HEIGHT + FONT_SIZE;

    for (const span of spans) {
      const textWidth = span.text.length * CHAR_WIDTH;

      // 背景色
      if (span.bg !== BG_COLOR) {
        ctx.fillStyle = span.bg;
        ctx.fillRect(x, y - FONT_SIZE + 2, textWidth, LINE_HEIGHT);
      }

      // 文字
      ctx.fillStyle = span.fg;
      ctx.font = `${span.bold ? "bold " : ""}${FONT_SIZE}px monospace`;
      ctx.fillText(span.text, x, y);

      x += textWidth;
    }
  }

  // 保存 PNG
  const buffer = canvas.toBuffer("image/png");
  await Bun.write(outputPath, buffer);
}

// CLI 模式
if (import.meta.main) {
  const input = await Bun.stdin.text();
  const output = process.argv[2] || "/tmp/claude-orchestrator/screenshot.png";
  await renderTerminal(input, output);
  console.log(output);
}
