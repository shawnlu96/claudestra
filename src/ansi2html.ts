#!/usr/bin/env bun
/**
 * ANSI terminal output → HTML with colors
 * 读取 stdin，输出 HTML 到 stdout 或指定文件
 */

const BG = "#1e1e2e";
const FG = "#cdd6f4";

const ANSI_16: Record<number, string> = {
  0: "#1e1e2e", 1: "#f38ba8", 2: "#a6e3a1", 3: "#f9e2af",
  4: "#89b4fa", 5: "#cba6f7", 6: "#94e2d5", 7: "#cdd6f4",
  8: "#585b70", 9: "#f38ba8", 10: "#a6e3a1", 11: "#f9e2af",
  12: "#89b4fa", 13: "#cba6f7", 14: "#94e2d5", 15: "#ffffff",
};

function ansi256ToHex(n: number): string {
  if (n < 16) return ANSI_16[n] || FG;
  if (n < 232) {
    const idx = n - 16;
    const r = Math.floor(idx / 36) * 51;
    const g = Math.floor((idx % 36) / 6) * 51;
    const b = (idx % 6) * 51;
    return `rgb(${r},${g},${b})`;
  }
  const gray = (n - 232) * 10 + 8;
  return `rgb(${gray},${gray},${gray})`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function ansiToHtml(input: string): string {
  const lines = input.split("\n");
  const htmlLines: string[] = [];

  for (const line of lines) {
    let fg = FG;
    let bg = BG;
    let bold = false;
    let dim = false;
    let italic = false;
    const spans: string[] = [];

    // eslint-disable-next-line no-control-regex
    const re = /\x1b\[([0-9;]*)m/g;
    let lastIdx = 0;
    let match: RegExpExecArray | null;

    while ((match = re.exec(line)) !== null) {
      if (match.index > lastIdx) {
        const text = escapeHtml(line.slice(lastIdx, match.index));
        if (text) {
          const styles: string[] = [`color:${fg}`];
          if (bg !== BG) styles.push(`background:${bg}`);
          if (bold) styles.push("font-weight:bold");
          if (dim) styles.push("opacity:0.6");
          if (italic) styles.push("font-style:italic");
          spans.push(`<span style="${styles.join(";")}">${text}</span>`);
        }
      }
      lastIdx = re.lastIndex;

      const codes = match[1] ? match[1].split(";").map(Number) : [0];
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        if (c === 0) { fg = FG; bg = BG; bold = false; dim = false; italic = false; }
        else if (c === 1) bold = true;
        else if (c === 2) dim = true;
        else if (c === 3) italic = true;
        else if (c === 22) { bold = false; dim = false; }
        else if (c === 23) italic = false;
        else if (c >= 30 && c <= 37) fg = ANSI_16[c - 30] || FG;
        else if (c === 38) {
          if (codes[i + 1] === 5) { fg = ansi256ToHex(codes[i + 2] || 0); i += 2; }
          else if (codes[i + 1] === 2) { fg = `rgb(${codes[i+2]||0},${codes[i+3]||0},${codes[i+4]||0})`; i += 4; }
        }
        else if (c === 39) fg = FG;
        else if (c >= 40 && c <= 47) bg = ANSI_16[c - 40] || BG;
        else if (c === 48) {
          if (codes[i + 1] === 5) { bg = ansi256ToHex(codes[i + 2] || 0); i += 2; }
          else if (codes[i + 1] === 2) { bg = `rgb(${codes[i+2]||0},${codes[i+3]||0},${codes[i+4]||0})`; i += 4; }
        }
        else if (c === 49) bg = BG;
        else if (c >= 90 && c <= 97) fg = ANSI_16[c - 82] || FG;
      }
    }

    if (lastIdx < line.length) {
      const text = escapeHtml(line.slice(lastIdx));
      if (text) {
        const styles: string[] = [`color:${fg}`];
        if (bg !== BG) styles.push(`background:${bg}`);
        if (bold) styles.push("font-weight:bold");
        if (dim) styles.push("opacity:0.6");
        spans.push(`<span style="${styles.join(";")}">${text}</span>`);
      }
    }

    htmlLines.push(spans.join("") || "&nbsp;");
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body {
  background: ${BG};
  color: ${FG};
  font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.0;
  padding: 10px;
  margin: 0;
}
div { white-space: pre; min-height: 1em; }
</style></head><body>
${htmlLines.map(l => `<div>${l}</div>`).join("\n")}
</body></html>`;
}

const input = await Bun.stdin.text();
const output = process.argv[2];
const html = ansiToHtml(input);

if (output) {
  await Bun.write(output, html);
  console.log("OK");
} else {
  console.log(html);
}
