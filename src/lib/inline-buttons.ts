/**
 * reply 正文里的行内按钮微语法(v2.20+):`[[{#id .style}按钮文字]]`。
 *
 * 与 do-md 0.11.2 的 InlineRule 同源:`{…}` capture 紧跟在**开分隔符后**
 * (README 实例 `=={bg=red}x==`、`<{.mention id=1}Name>`——不是 Pandoc 的尾置,
 * docs/design-domd-inline-buttons.md 首版把这个写反了)。Web 端由 DOMD 的
 * inlineRules+component 渲染成真按钮;Discord 正文塞不了原生按钮 → 出站时
 * 这里解析拆分:从正文剥离,转成块级 components 按钮行(方案 A,两端同一套
 * `[button:<id>]` 回投 wire)。
 *
 * ⚠ src/lib/inline-buttons.ts 与 web/lib/chat/inline-buttons.ts 必须**逐字节一致**
 * (tests/inline-buttons.test.ts 有 parity 测试钉住)——改一处必须同步另一处。
 * 因此本文件不许 import 任何依赖。
 */

export interface InlineButtonSpec {
  /** 回投 `[button:<id>]` 用的 id(白名单 ^[\w:-]+$)。 */
  id: string;
  /** 原始行内 markdown label(web 端 DOMD 自己渲染;Discord 用 plainLabel 清洗)。 */
  label: string;
  /** primary | success | danger | secondary(缺省)。 */
  style: string;
}

/** `[[{#id .style}label]]`——capture 紧跟开分隔符;label 不含换行/方括号/花括号。 */
const BTN_RE = /\[\[\{([^}\n]*)\}([^\n[\]{}]+?)\]\]/g;
const ID_RE = /^[\w:-]+$/;
const STYLES = new Set(["primary", "success", "danger", "secondary"]);

/** 解析 `{…}` capture:`#x` → id(后者胜,同 do-md);首个 `.word` → style。 */
function parseCapture(capture: string): { id?: string; style: string } {
  let id: string | undefined;
  let style = "secondary";
  let styleSet = false;
  for (const tok of capture.trim().split(/\s+/)) {
    if (tok.startsWith("#") && tok.length > 1) id = tok.slice(1);
    else if (tok.startsWith(".") && tok.length > 1 && !styleSet) {
      styleSet = true;
      const s = tok.slice(1);
      if (STYLES.has(s)) style = s;
    }
  }
  return { id, style };
}

/** 一行里 inline code span(`…`)的区间——span 内的 `[[…]]` 是字面量,不算按钮。 */
function codeSpanRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = /`[^`\n]*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

interface RawMatch {
  spec: InlineButtonSpec;
  line: number;
  start: number;
  end: number;
}

/** 扫出全部合法按钮匹配(跳过 fenced code 与 inline code span;无合法 id 的不算)。 */
function scan(text: string): { lines: string[]; matches: RawMatch[] } {
  const lines = text.split("\n");
  const matches: RawMatch[] = [];
  let inFence = false;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line.includes("[[")) continue;
    const spans = codeSpanRanges(line);
    BTN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BTN_RE.exec(line))) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (spans.some(([a, b]) => start < b && end > a)) continue;
      const { id, style } = parseCapture(m[1]);
      if (!id || !ID_RE.test(id)) continue; // 无/坏 id → 字面量留着,不产出死按钮
      matches.push({ spec: { id, label: m[2].trim(), style }, line: li, start, end });
    }
  }
  return { lines, matches };
}

/** 只解析不剥离(web 历史还原:判断某条 reply 里有哪些行内按钮 id)。 */
export function parseInlineButtons(text: string): InlineButtonSpec[] {
  if (!text.includes("[[")) return [];
  return scan(text).matches.map((m) => m.spec);
}

/**
 * 剥离前 max 个行内按钮并返回净化正文(Discord 出站用)。max 之外的保留字面量
 * (Discord components 上限 5 行 × 5 钮,超容量的按钮宁可看见语法也别静默消失)。
 * 剥空的行整行删掉;剥离造成的 3+ 连续空行收敛为空行。
 */
export function splitInlineButtons(
  text: string,
  max = Infinity
): { text: string; buttons: InlineButtonSpec[] } {
  if (!text.includes("[[")) return { text, buttons: [] };
  const { lines, matches } = scan(text);
  const taken = matches.slice(0, Math.max(0, max));
  if (!taken.length) return { text, buttons: [] };

  const byLine = new Map<number, RawMatch[]>();
  for (const m of taken) {
    const arr = byLine.get(m.line) ?? [];
    arr.push(m);
    byLine.set(m.line, arr);
  }
  const outLines: string[] = [];
  for (let li = 0; li < lines.length; li++) {
    const hits = byLine.get(li);
    if (!hits) {
      outLines.push(lines[li]);
      continue;
    }
    let line = lines[li];
    // 从后往前剥,offset 不漂移
    for (const h of [...hits].sort((a, b) => b.start - a.start)) {
      line = line.slice(0, h.start) + line.slice(h.end);
    }
    line = line.replace(/[ \t]+$/, "");
    if (line.trim() === "") continue; // 整行只有按钮 → 行删掉
    outLines.push(line);
  }
  const stripped = outLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: stripped, buttons: taken.map((m) => m.spec) };
}

/** label 的纯文本形态(Discord 按钮 label / 用户点击气泡):去掉常见行内标记。
 *  下划线保留(file_name 这类不是格式符的概率远大于斜体)。 */
export function plainLabel(label: string): string {
  return label
    .replace(/\*\*|~~|`/g, "")
    .replace(/\*/g, "")
    .trim();
}

/** 按钮语法 → 纯 label(「复制整条」等纯文本场景;非按钮语法原样保留)。 */
export function inlineButtonsToText(text: string): string {
  if (!text.includes("[[")) return text;
  const { lines, matches } = scan(text);
  if (!matches.length) return text;
  const byLine = new Map<number, RawMatch[]>();
  for (const m of matches) {
    const arr = byLine.get(m.line) ?? [];
    arr.push(m);
    byLine.set(m.line, arr);
  }
  return lines
    .map((line, li) => {
      const hits = byLine.get(li);
      if (!hits) return line;
      let out = line;
      for (const h of [...hits].sort((a, b) => b.start - a.start)) {
        out = out.slice(0, h.start) + "[" + plainLabel(h.spec.label) + "]" + out.slice(h.end);
      }
      return out;
    })
    .join("\n");
}

/** 按钮列表 → 中性 components 按钮行(每行 ≤5,Discord ActionRow 上限)。 */
export function toButtonRows(
  buttons: InlineButtonSpec[]
): Array<{ type: "buttons"; buttons: Array<{ id: string; label: string; style: string }> }> {
  const rows: Array<{ type: "buttons"; buttons: Array<{ id: string; label: string; style: string }> }> = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push({
      type: "buttons",
      buttons: buttons.slice(i, i + 5).map((b) => ({
        id: b.id,
        label: plainLabel(b.label).slice(0, 80) || b.id,
        style: b.style,
      })),
    });
  }
  return rows;
}
