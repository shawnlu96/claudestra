/**
 * AskUserQuestion 弹窗的 pane 侧解析（v2.17.2）。
 *
 * 背景（2026-08-07 migration 事故）：CC 2.1.x 把 AUQ 的 tool_use 攒到用户作答后
 * 才连同 tool_result 一起写进 session jsonl —— jsonl 检测结构性迟到（实测弹窗挂
 * 4 分钟无人知晓，直到人工在终端作答后 200ms 检测才触发）。及时通路只能从 tmux
 * pane 上识别弹窗本体，这里是那套识别 + 结构化解析的纯函数。
 *
 * 实测两种形态（CC 2.1.222，隔离会话逐键验证）：
 * - **single**（单问题且单选）：无 tab 栏，`☐ <header>` 标题行 + `❯ N. label`
 *   选项列（右侧可能有 preview 框）。↑/↓/数字移光标，Enter 一击即选定并提交。
 * - **tabbed**（多问题，或任一问题 multiSelect）：首行 tab 栏
 *   `←  ☐ sec1  ☐ sec2  ✔ Submit  →`。多选 section 数字键直接 toggle `[ ]`；
 *   单选 section 数字移光标、Enter 选定并自动跳下一段；Right 切段；最后落在
 *   Submit(Review) 段按 Enter 提交。
 * - 两种形态都渲染 `N. Type something`（自由输入）和 `Chat about this` 伪选项，
 *   解析时剔除；Review 段只有 `1. Submit answers` 一个选项，靠"真实选项 ≥2"
 *   的门槛自然判非弹窗。
 */

export interface AuqPaneOption {
  label: string;
  /** 该选项行是否带 ❯ 光标 */
  cursor: boolean;
  /** multiSelect 形态下当前是否已勾选（[✔] / [x]） */
  checked: boolean;
  description?: string;
  /** 描述在画面上的逐行原文（折行前）：和提交方的那一版比对时，只有这些行之间允许「空格或无」（auqPaneMatches） */
  descLines?: string[];
}

export interface AuqPaneParse {
  /** single = 单问题单选（Enter 直接提交）；tabbed = 有 tab 栏 */
  form: "single" | "tabbed";
  /** tab 栏 section 名（不含 Submit）；single 形态为 [header] */
  sections: string[];
  /** 当前可见 section 的问题文本 */
  question: string;
  /** 问题在画面上的逐行原文（同 descLines） */
  questionLines: string[];
  /** 当前可见 section 的真实选项（伪选项已剔除） */
  options: AuqPaneOption[];
  /** 当前可见 section 是否多选（选项带 checkbox） */
  multiSelect: boolean;
}

const FOOTER_RE = /Enter to select ·.*Esc to cancel/;
const TABBAR_RE = /^\s*←\s+.*✔\s*Submit\s+→\s*$/;
const HEADER_RE = /^\s*[☐☒□■]\s+(.+?)\s*$/;
const OPTION_RE = /^\s*(❯\s+)?(\d+)\.\s+(\[.\]\s*)?(.*)$/;
const BOX_CHARS_RE = /[─│┌┐└┘├┤┬┴┼╭╮╯╰═║╔╗╚╝]/;
const PSEUDO_OPTION_RE = /^(Type something|Chat about this)\b/;
/** footer 往上最多扫这么多行找区域上界（tab 栏 / ☐ 标题） */
const MAX_SCAN_LINES = 45;

/** tab 栏 → section 名列表（`✔ Submit` 段剔除） */
export function parseAuqTabSections(line: string): string[] {
  const inner = line.replace(/^\s*←\s*/, "").replace(/\s*→\s*$/, "");
  return inner
    .split(/\s{2,}/)
    .map((t) => t.trim())
    .filter((t) => /^[☐☒□■]/.test(t))
    .map((t) => t.replace(/^[☐☒□■]\s*/, ""))
    .filter(Boolean);
}


/**
 * v2.23+ Pi 的选择/确认对话框（owner 2026-09-21 实报：「pi 里面有些选项没办法
 * 发到 Claudestra 里面做选择」——截图是权限守门扩展的 `工具守门: rm-rf-relative`
 * 确认框，agent 就那么停着，手机侧完全无感）。
 *
 * Pi 的 TUI 不是 Claude Code 那套：没有 `❯ N.` 编号选项，也没有
 * `Enter to select · Esc to cancel` 那行 footer，所以 CC 的解析器一律返回 null，
 * 整条交互卡链路（web 卡片 + Discord 按钮 + /answer 端点）都不会被触发。
 *
 * Pi 的共用 select 组件（`ctx.ui.confirm` / `ctx.ui.select` / 内建对话框都走它）
 * 渲染成：
 *
 * ```
 *   工具守门: rm-rf-relative
 *   rm -rf 相对路径，需确认
 *
 *   仍要执行吗？
 *
 *   → Yes
 *     No
 *
 *   ↑↓ navigate   enter select   escape/ctrl+c cancel
 * ```
 *
 * 翻译成 AuqPaneParse 之后，**下游一个字都不用改**：单问题单选的键序列本来就是
 * 「Down×n + Enter」（buildAuqKeystrokes 的第一条分支），取消本来就是 Esc，
 * 陈旧重验本来就是「再解析一次 pane」——正好都是 Pi 这个组件的键位。
 */
const PI_FOOTER_RE = /↑↓\s+\S*\s*navigate\b.*\bselect\b.*\bcancel\b/;
const PI_CURSOR_RE = /^\s*(→|›)\s+(.*\S)\s*$/;
/** 选项块/标题块各自最多这么多行，多了当不是对话框 */
const PI_MAX_BLOCK_LINES = 10;

/** footer 往上取一段连续非空行（跳过前置空行）。返回 [块, 块上方的下标]。 */
function piBlockAbove(lines: string[], from: number): { block: string[]; next: number } {
  let i = from;
  while (i >= 0 && lines[i].trim() === "") i--;
  const block: string[] = [];
  while (i >= 0 && lines[i].trim() !== "" && block.length <= PI_MAX_BLOCK_LINES) {
    block.unshift(lines[i]);
    i--;
  }
  return { block, next: i };
}

export function parsePiSelectPane(pane: string): AuqPaneParse | null {
  const lines = pane.split("\n");

  let footerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PI_FOOTER_RE.test(lines[i])) {
      footerIdx = i;
      break;
    }
  }
  if (footerIdx < 0) return null;

  // 选项块：footer 上方第一段连续非空行，其中**恰好一行**带 → 光标。
  // 「恰好一行」是把普通正文误当选项挡在外面的主判据。
  const { block: optLines, next } = piBlockAbove(lines, footerIdx - 1);
  if (optLines.length < 2 || optLines.length > 8) return null;
  if (optLines.some((l) => BOX_CHARS_RE.test(l))) return null;
  const options: AuqPaneOption[] = optLines.map((l) => {
    const m = l.match(PI_CURSOR_RE);
    return { label: m ? m[2] : l.trim(), cursor: !!m, checked: false };
  });
  if (options.filter((o) => o.cursor).length !== 1) return null;

  // 问题：再往上取两段（Pi 把 confirm 的 title 和 message 分成两块渲染）。
  const q1 = piBlockAbove(lines, next);
  const q2 = piBlockAbove(lines, q1.next);
  const questionLines = [...q2.block, ...q1.block].map((l) => l.trim()).filter((l) => l && !BOX_CHARS_RE.test(l));
  if (!questionLines.length) return null;

  return { form: "single", sections: ["Pi 确认"], question: questionLines.join(" "), questionLines, options, multiSelect: false };
}

/**
 * Codex 的选择框（额度快满时「要不要换便宜模型」、命令审批等）。以前 bridge 完全看不见：Codex 的回合照样能跑，
 * 框一直挂在屏幕底部，手机侧无感（2026-09-28 codex 额度用完那晚挂了一小时）。Codex 0.153 渲染成：
 *
 * ```
 *   Approaching rate limits
 *   Switch to gpt-5.6-luna for lower credit usage?
 *
 * › 1. Switch to gpt-5.6-luna                 Older fast and efficient model.
 *   2. Keep current model
 *
 *   Press enter to confirm or esc to go back
 * ```
 *
 * 选项行是「编号. 名字  两个以上空格  说明」，光标 `›` 只在一行上；键位与 Pi 相同（↑↓ + Enter，Esc 取消），
 * 翻译成 AuqPaneParse 后下游不用改。
 */
const CODEX_FOOTER_RE = /^\s*Press enter to confirm or esc to (go back|cancel)\b/i;
const CODEX_OPTION_RE = /^\s*(›\s+)?\d+\.\s+(.*\S)\s*$/;

function parseCodexSelectPane(pane: string): AuqPaneParse | null {
  const lines = pane.split("\n");
  let footerIdx = -1;
  for (let i = lines.length - 1; i >= 0 && lines.length - i <= MAX_SCAN_LINES; i--) {
    if (CODEX_FOOTER_RE.test(lines[i])) {
      footerIdx = i;
      break;
    }
  }
  if (footerIdx < 0) return null;
  const { block: optLines, next } = piBlockAbove(lines, footerIdx - 1);
  if (optLines.length < 2 || optLines.length > 8) return null;
  const options: AuqPaneOption[] = [];
  for (const l of optLines) {
    const m = l.match(CODEX_OPTION_RE);
    if (!m) return null; // 选项块里混了别的行 ⇒ 不是这种框，宁可不认
    const [label, ...rest] = m[2].split(/\s{2,}/);
    const description = rest.join(" ").trim();
    options.push({ label, cursor: !!m[1], checked: false, ...(description ? { description, descLines: [description] } : {}) });
  }
  if (options.filter((o) => o.cursor).length !== 1) return null;
  // 标题紧贴选项（中间最多一个空行）；隔得更远的是上面别的输出（比如「■ You've hit your usage limit」），不当问题
  const gap = lines[next]?.trim() === "" ? 1 : 0;
  if (lines[next - gap]?.trim() === "") return null;
  const questionLines = piBlockAbove(lines, next).block.map((l) => l.trim()).filter(Boolean);
  if (!questionLines.length) return null;
  return { form: "single", sections: ["Codex"], question: questionLines.join(" "), questionLines, options, multiSelect: false };
}

export function parseAuqPane(pane: string): AuqPaneParse | null {
  const lines = pane.split("\n");

  // Pi / Codex 的对话框长得完全不一样（无 `❯ N.` 无 CC footer），先试它们；
  // 三家 footer 签名互斥，不会互相误命中。
  const pi = parsePiSelectPane(pane);
  if (pi) return pi;
  const codex = parseCodexSelectPane(pane);
  if (codex) return codex;

  // 1) footer 提示行在场才可能是 AUQ 弹窗
  let footerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER_RE.test(lines[i])) {
      footerIdx = i;
      break;
    }
  }
  if (footerIdx < 0) return null;

  // 2) 向上找区域上界：tab 栏（tabbed）或孤立 ☐ 标题行（single）。
  //    权限弹窗等界面可能带相似 footer，但没有这两种结构 —— 靠这个判据区分。
  let topIdx = -1;
  let form: "single" | "tabbed" = "single";
  let sections: string[] = [];
  for (let i = footerIdx - 1; i >= 0 && footerIdx - i <= MAX_SCAN_LINES; i--) {
    const line = lines[i];
    if (TABBAR_RE.test(line)) {
      form = "tabbed";
      topIdx = i;
      sections = parseAuqTabSections(line);
      break;
    }
    const h = line.match(HEADER_RE);
    if (h && !/Submit/.test(line)) {
      form = "single";
      topIdx = i;
      sections = [h[1]];
      break;
    }
  }
  if (topIdx < 0) return null;

  // 3) 区域内逐行抽问题文本 + 选项。选项 label 截掉右侧 preview 框；
  //    multiSelect 布局里选项下一行的描述附回该选项。
  const options: AuqPaneOption[] = [];
  let anyCheckbox = false;
  const qLines: string[] = [];
  let sawOption = false;
  /** 描述行只允许紧跟"真实选项"；伪选项（Type something 等）出现后关闭附着 */
  let attachDesc = false;
  for (let i = topIdx + 1; i < footerIdx; i++) {
    const raw = lines[i];
    const m = raw.match(OPTION_RE);
    if (m) {
      sawOption = true;
      let label = m[4] ?? "";
      const box = label.search(BOX_CHARS_RE);
      if (box >= 0) label = label.slice(0, box);
      label = label.trim();
      if (!label || PSEUDO_OPTION_RE.test(label)) {
        attachDesc = false;
        continue;
      }
      if (m[3]) anyCheckbox = true;
      options.push({
        label,
        cursor: !!m[1],
        checked: /\[[^ \]]\]/.test(m[3] || ""),
      });
      attachDesc = true;
      continue;
    }
    const t = raw.trim();
    if (!t || BOX_CHARS_RE.test(t) || /^Notes:/.test(t) || PSEUDO_OPTION_RE.test(t)) {
      if (!t || BOX_CHARS_RE.test(t)) continue; // 空行/框线不改变附着状态
      attachDesc = false;
      continue;
    }
    if (!sawOption) {
      qLines.push(t);
    } else if (attachDesc && options.length > 0) {
      const opt = options[options.length - 1];
      opt.description = opt.description ? `${opt.description} ${t}` : t;
      opt.descLines = [...(opt.descLines ?? []), t];
    }
  }

  // 4) 有效性门槛：AUQ schema 每问 2-4 个真实选项；Review 段（只有
  //    "1. Submit answers"）和各种残缺渲染都会被这里挡掉。
  if (options.length < 2 || options.length > 6) return null;
  const question = qLines.join(" ").trim();
  if (!question) return null;

  return { form, sections, question, questionLines: qLines, options, multiSelect: anyCheckbox };
}

/**
 * 提交方看到的那一版弹框和画面上的对不对得上（T65，替 owner 按键前最后一道）。逐项比：问题、单选 / 多选、选项个数、
 * 每个选项的文字和描述。多问题表单画面上只看得见当前一段：要求段数等于问题数、当前段就是第 1 问
 * （buildAuqKeystrokes 本来就假定从第 1 段起步），其余段看不见、核不了（已知边界）。单测 tests/auq-answer.test.ts
 */
export function auqPaneMatches(
  questions: readonly { question?: string; multiSelect?: boolean; options?: readonly { label?: string; description?: string }[] }[],
  p: AuqPaneParse,
): boolean {
  const q = questions[0];
  if (!q || (questions.length > 1 && p.sections.length !== questions.length)) return false;
  const opts = q.options ?? [];
  if (!!q.multiSelect !== p.multiSelect || opts.length !== p.options.length) return false;
  if (!textMatchesLines(q.question ?? "", p.questionLines)) return false;
  return opts.every((o, i) => oneSpace(o.label ?? "") === oneSpace(p.options[i].label) && textMatchesLines(o.description ?? "", p.options[i].descLines ?? []));
}

const oneSpace = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * 一段原文和画面上的几行对不对得上：每一行都得原样出现（连续空白算一个空格），行与行之间只允许「一个空格或什么都没有」——
 * 画面折行时吃掉了空格还是在字中间折的分不出来，只在真实折行处放宽；行内多一个、少一个空格都算不同的东西
 * （「/tmp/reports /tmp/archive」≠「/tmp/reports/tmp/archive」，除非恰好在那里折行——已知边界）
 */
export function textMatchesLines(text: string, lines: readonly string[]): boolean {
  const s = oneSpace(text);
  const parts = lines.map(oneSpace).filter(Boolean);
  let at = 0;
  for (const [i, part] of parts.entries()) {
    if (!s.startsWith(part, at)) return false;
    at += part.length;
    if (i < parts.length - 1 && s[at] === " ") at++;
  }
  return at === s.length;
}
