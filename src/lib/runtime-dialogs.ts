/**
 * Codex 运行中会卡住整个回合、只有 owner 能处理的弹框（限额 / 换模型等，docs 13 §4.1）→ 自动建一条「待你处理」（source codex）。
 * 启动期那几种在 runtimes/codex-ready.ts 的 BLOCKING_DIALOG_RE，由启动流程自己处理，不在这里。
 * 规则表现在是空的：09-28 16:28 那次限额弹框没留下 pane 原文（bridge 日志和 Codex rollout 里都没有），拿到样本后按
 * tests/fixtures 的做法存原屏、在这里加一行并补单测。表是空的时候 detect 恒为 null，接线已经在 permission-watcher 里。
 */

export interface RuntimeDialog {
  title: string;
  context: string;
}

const CODEX_RUNTIME_DIALOGS: { re: RegExp; title: string }[] = [];

export function detectCodexRuntimeDialog(pane: string): RuntimeDialog | null {
  for (const d of CODEX_RUNTIME_DIALOGS) {
    const m = d.re.exec(pane);
    if (m) return { title: d.title, context: m[0].slice(0, 300) };
  }
  return null;
}
