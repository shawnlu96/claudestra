/**
 * Codex 运行中会卡住整个回合、只有 owner 能处理的弹框（限额 / 换模型等，docs 13 §4.1）→ 自动建一条「待你处理」（source codex）。
 * 启动期那几种在 runtimes/codex-ready.ts 的 BLOCKING_DIALOG_RE，由启动流程自己处理，不在这里。
 * 内置规则表还是空的：本机 bridge 日志、Codex rollout（rate_limit_reached_type 从来是 null）、测试 fixture 里都没有运行中弹框的原屏。
 * 扩展口：状态目录的 codex-dialogs.json（[{pattern, flags?, title}]）——拿到原屏后先在那里加一行就生效，再把样本存进 fixture、
 * 挪进 CODEX_RUNTIME_DIALOGS 并补单测（tests/runtime-dialogs.test.ts）。接线在 permission-watcher（noteRuntimeDialogs）。
 */
import { readFileSync, statSync } from "node:fs";
import { statePath } from "./paths.js";

export interface RuntimeDialog {
  title: string;
  context: string;
}

interface Rule {
  re: RegExp;
  title: string;
}

const CODEX_RUNTIME_DIALOGS: Rule[] = [];

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

export function detectCodexRuntimeDialog(pane: string, extraPath = CODEX_DIALOGS_FILE): RuntimeDialog | null {
  for (const d of [...CODEX_RUNTIME_DIALOGS, ...fileRules(extraPath)]) {
    const m = d.re.exec(pane);
    if (m) return { title: d.title, context: m[0].slice(0, 300) };
  }
  return null;
}
