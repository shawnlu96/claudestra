/**
 * Codex 运行中会卡住整个回合、只有 owner 能处理的弹框（限额 / 换模型等，docs 13 §4.1）→ 自动建一条「待你处理」（source codex）。
 * 启动期那几种在 runtimes/codex-ready.ts 的 BLOCKING_DIALOG_RE，由启动流程自己处理；「换个便宜模型？」那种选项框走 AUQ（lib/auq-pane.ts）。
 * 只认 Codex 窗口、只看 pane 末尾 15 个非空行，命中的那一行还得是 Codex 的报错行（「■ 」开头）；扩展规则另认紧跟其后的对话框选项：
 * 不这么收紧的话，Claude agent 的 pane、Codex resume 回放的历史里提到这句话就会建出假的 ask（tests/runtime-dialogs.test.ts）。
 * 扩展口：状态目录的 codex-dialogs.json（[{pattern, flags?, title}]），拿到新原屏先在那里加一行，再挪进 CODEX_RUNTIME_DIALOGS 补单测。
 */
import { readFileSync, statSync } from "node:fs";
import { t } from "./i18n.js";
import { codexMenuState } from "./codex-menu.js";
import { statePath } from "./paths.js";
import { DIALOG_SHAPE_RE, nonEmptyTail, VERDICT_TAIL_LINES } from "./runtimes/codex-ready.js";

export interface RuntimeDialog {
  title: string;
  context: string;
}

interface Rule {
  re: RegExp;
  title: string;
  /** 只认「■ 」报错行：额度这句 Codex 只画成报错行，正文编号列表里引用它不算（tests/runtime-dialogs.test.ts） */
  errorLine?: true;
}

const CODEX_RUNTIME_DIALOGS: Rule[] = [
  // 额度用完：rollout 里是 task_complete.error（codex_error_info usage_limit_exceeded），TUI 把原文画成「■ You've hit…」一行
  { re: /You've hit your usage limit[^\n]*/i, title: t("Codex 额度用完了", "Codex usage limit reached"), errorLine: true },
];

/** Codex TUI 的报错行记号 */
const ERROR_MARK_RE = /^\s*■\s/;
/** 扩展规则命中行下面这么多行里出现选项行 / 回车继续，才算弹框本身（整个末尾判的话，正文里任何「1. 」列表都能冒充） */
const DIALOG_BELOW_LINES = 4;

const CODEX_DIALOGS_FILE = statePath("codex-dialogs.json");

/** 文件里的规则：坏行（不是对象、正则编不过、没有标题）跳过；按 mtime 缓存，改了下次检测就生效 */
let cache: { path: string; mtime: number; rules: Rule[] } = { path: "", mtime: -1, rules: [] };

export function parseDialogRules(raw: unknown): Rule[] {
  if (!Array.isArray(raw)) return [];
  const out: Rule[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r.pattern !== "string" || typeof r.title !== "string" || !r.title.trim()) continue;
    try {
      out.push({ re: new RegExp(r.pattern, typeof r.flags === "string" ? r.flags.replace(/[gy]/g, "") : "i"), title: r.title.trim().slice(0, 40) });
    } catch {
      continue; // 正则写错的那一行不生效，其余照用
    }
  }
  return out;
}

function fileRules(path: string): Rule[] {
  let mtime = -1;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    return []; // 没有扩展文件是常态
  }
  if (cache.path === path && cache.mtime === mtime) return cache.rules;
  let rules: Rule[] = [];
  try {
    rules = parseDialogRules(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    console.error(`⚠️ ${path} 读不了（Codex 弹框扩展规则先不用）: ${(e as Error).message}`);
  }
  cache = { path, mtime, rules };
  return rules;
}

export function detectCodexRuntimeDialog(pane: string, runtime: string | undefined, extraPath = CODEX_DIALOGS_FILE): RuntimeDialog | null {
  if (runtime !== "codex") return null;
  const lines = nonEmptyTail(pane, VERDICT_TAIL_LINES);
  const tail = lines.join("\n");
  for (const d of [...CODEX_RUNTIME_DIALOGS, ...fileRules(extraPath)]) {
    const m = d.re.exec(tail);
    if (!m) continue;
    const at = tail.slice(0, m.index).split("\n").length - 1;
    const below = lines.slice(at + 1, at + 1 + DIALOG_BELOW_LINES).join("\n");
    if (ERROR_MARK_RE.test(lines[at]) || (!d.errorLine && DIALOG_SHAPE_RE.test(below))) return { title: d.title, context: m[0].slice(0, 300) };
  }
  // 选择菜单：AUQ 认得出的（parsed）已有选择卡，这里不再出第二张；认不出的兜底出一张运行时卡，不放选项按钮（T63）
  if (codexMenuState(pane) === "unparsed") return { title: t("Codex 停在选择菜单", "Codex is waiting on a selection menu"), context: lines.slice(-6).join(" ").slice(0, 300) };
  return null;
}
