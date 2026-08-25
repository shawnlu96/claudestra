/**
 * reply 正文里的行内交互微语法(v2.20+):`[[{…}文字]]`。
 *
 * 与 do-md 0.11.2 的 InlineRule 同源:`{…}` capture 紧跟在**开分隔符后**
 * (README 实例 `=={bg=red}x==`、`<{.mention id=1}Name>`——不是 Pandoc 的尾置,
 * docs/design-domd-inline-buttons.md 首版把这个写反了)。两类形态:
 *
 * - **按钮** `[[{#id .style}label]]`(带合法 #id):web 端渲染真按钮,点击回投
 *   `[button:<id>]`;Discord 出站剥离转块级 components 按钮行(方案 A)。
 * - **chip** `[[{.copy}cmd]]` / `[[{.agent}name]]` / `[[{.badge .tone}text]]`
 *   (无 #id,首个 .word 是 variant):web 端渲染点击复制 / agent 跳转 / 状态
 *   徽章;Discord 与纯文本场景降级成 label(copy 保留反引号包裹)。
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

/** `[[{…}label]]`——capture 紧跟开分隔符;label 不含换行/方括号/花括号。 */
const BTN_RE = /\[\[\{([^}\n]*)\}([^\n[\]{}]+?)\]\]/g;
const ID_RE = /^[\w:-]+$/;
const STYLES = new Set(["primary", "success", "danger", "secondary"]);

/** 解析 `{…}` capture:`#x` → id(后者胜,同 do-md);`.word` 依序进 classes。 */
function parseCapture(capture: string): { id?: string; classes: string[] } {
  let id: string | undefined;
  const classes: string[] = [];
  for (const tok of capture.trim().split(/\s+/)) {
    if (tok.startsWith("#") && tok.length > 1) id = tok.slice(1);
    else if (tok.startsWith(".") && tok.length > 1) classes.push(tok.slice(1));
  }
  return { id, classes };
}

/** 一行里 inline code span(`…`)的区间——span 内的 `[[…]]` 是字面量,不算数。 */
function codeSpanRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = /`[^`\n]*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

interface RawMatch {
  /** 合法按钮 id(有 → 按钮;无 → chip/坏语法)。 */
  id?: string;
  /** capture 里的 .word 序列(chip 的 variant = classes[0])。 */
  classes: string[];
  label: string;
  line: number;
  start: number;
  end: number;
}

/** 扫出全部 `[[{…}label]]` 匹配(跳过 fenced code 与 inline code span)。 */
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
      const { id, classes } = parseCapture(m[1]);
      matches.push({
        id: id && ID_RE.test(id) ? id : undefined,
        classes,
        label: m[2].trim(),
        line: li,
        start,
        end,
      });
    }
  }
  return { lines, matches };
}

const toSpec = (m: RawMatch): InlineButtonSpec => ({
  id: m.id!,
  label: m.label,
  style: m.classes.length && STYLES.has(m.classes[0]) ? m.classes[0] : "secondary",
});

/** 只解析不剥离(web 历史还原:判断某条 reply 里有哪些行内按钮 id)。 */
export function parseInlineButtons(text: string): InlineButtonSpec[] {
  if (!text.includes("[[")) return [];
  return scan(text).matches.filter((m) => m.id).map(toSpec);
}

/** 按 line/start 从后往前把每个匹配替换成 render(m) 的产物(null=剥掉)。 */
function replaceMatches(
  lines: string[],
  matches: RawMatch[],
  render: (m: RawMatch) => string | null
): string[] {
  const byLine = new Map<number, RawMatch[]>();
  for (const m of matches) {
    const arr = byLine.get(m.line) ?? [];
    arr.push(m);
    byLine.set(m.line, arr);
  }
  const out: string[] = [];
  for (let li = 0; li < lines.length; li++) {
    const hits = byLine.get(li);
    if (!hits) {
      out.push(lines[li]);
      continue;
    }
    let line = lines[li];
    let removedAll = true;
    for (const h of [...hits].sort((a, b) => b.start - a.start)) {
      const rep = render(h) ?? "";
      if (rep !== "") removedAll = false;
      line = line.slice(0, h.start) + rep + line.slice(h.end);
    }
    line = line.replace(/[ \t]+$/, "");
    if (removedAll && line.trim() === "") continue; // 整行只有被剥掉的内容 → 行删掉
    out.push(line);
  }
  return out;
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
  const taken = matches.filter((m) => m.id).slice(0, Math.max(0, max));
  if (!taken.length) return { text, buttons: [] };
  const stripped = replaceMatches(lines, taken, () => null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: stripped, buttons: taken.map(toSpec) };
}

/**
 * chip(无 #id 的 `[[{.variant}label]]`)降级成纯文本:copy → `label`(保留
 * 反引号,Discord 上仍是行内码观感),其余(agent/badge/未知)→ label。
 * 有合法 #id 的按钮不动(那是 splitInlineButtons 的事)。
 */
export function inlineChipsToText(text: string): string {
  if (!text.includes("[[")) return text;
  const { lines, matches } = scan(text);
  const chips = matches.filter((m) => !m.id);
  if (!chips.length) return text;
  return replaceMatches(lines, chips, (m) =>
    m.classes[0] === "copy" ? `\`${m.label}\`` : plainLabel(m.label)
  ).join("\n");
}

/** 按钮+chip 全部退化成纯文本(「复制整条」等场景):按钮 → [label],chip 同
 *  inlineChipsToText。 */
export function inlineButtonsToText(text: string): string {
  if (!text.includes("[[")) return text;
  const { lines, matches } = scan(text);
  if (!matches.length) return text;
  return replaceMatches(lines, matches, (m) =>
    m.id ? `[${plainLabel(m.label)}]` : m.classes[0] === "copy" ? `\`${m.label}\`` : plainLabel(m.label)
  ).join("\n");
}

/** label 的纯文本形态(Discord 按钮 label / 用户点击气泡):去掉常见行内标记。
 *  下划线保留(file_name 这类不是格式符的概率远大于斜体)。 */
export function plainLabel(label: string): string {
  return label
    .replace(/\*\*|~~|`/g, "")
    .replace(/\*/g, "")
    .trim();
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
