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
}

export interface AuqPaneParse {
  /** single = 单问题单选（Enter 直接提交）；tabbed = 有 tab 栏 */
  form: "single" | "tabbed";
  /** tab 栏 section 名（不含 Submit）；single 形态为 [header] */
  sections: string[];
  /** 当前可见 section 的问题文本 */
  question: string;
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

export function parseAuqPane(pane: string): AuqPaneParse | null {
  const lines = pane.split("\n");

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
    }
  }

  // 4) 有效性门槛：AUQ schema 每问 2-4 个真实选项；Review 段（只有
  //    "1. Submit answers"）和各种残缺渲染都会被这里挡掉。
  if (options.length < 2 || options.length > 6) return null;
  const question = qLines.join(" ").trim();
  if (!question) return null;

  return { form, sections, question, options, multiSelect: anyCheckbox };
}
