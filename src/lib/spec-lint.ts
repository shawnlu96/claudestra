/**
 * ui 规格的必填检查（i28-UIQ1）：卡首写了「模板：ui」的规格必须有非空的「## 复用对象」和「## 对照基准」；
 * 复用对象写「无，新界面」时还要引用一条 owner 记的授权 ask（`ask_<id>`），同项目、针对本卡且 owner 已点批准按钮。
 * start_node 的预检调它（dag-tools-start.ts），自动开卡复用同一个预检：预检拒了 claim 结为 failed、按 arm 只通知 PM 一次，改了规格重新武装。
 * 只看卡首模板行：code / security 规格、没写模板行的规格一律放行。tests/spec-lint.test.ts。
 */
import type { Database } from "bun:sqlite";
import { getAsk, hasAsksTable, ownerAnswered } from "./ledger-asks.js";
import { scanSpecHead } from "./spec-lint-head.js";
import { join } from "node:path";
import { specSection } from "./review-pack.js";
import { readTextSoft } from "./task-spec.js";

const UI_REQUIRED_SECTIONS = ["复用对象", "对照基准"] as const;
const NEW_UI = /无\s*[,，、]?\s*新界面/;
const ASK_REF = /\bask_[a-z0-9]+\b/gi;

/** 和自动开卡共用卡首扫描，避免标题前的模板声明使两道门认出不同模板。 */
export function isUiSpec(text: string | null): boolean {
  const decls = text ? scanSpecHead(text).decls : [];
  return decls.length === 1 && decls[0].toLowerCase() === "ui";
}

/** 新界面批准只认同项目、同卡的授权 ask，且是 owner 点过绑定的批准按钮。 */
function ownerApproval(db: Database, id: string, project: string | undefined, taskId: string): boolean {
  if (!project || !hasAsksTable(db)) return false;
  const ask = getAsk(db, id);
  return !!ask && ask.project === project && ask.taskId === taskId && ask.kind === "authorize" &&
    ask.state === "answered" && ownerAnswered(ask.answer) &&
    !!ask.bind?.approve.some((button) => ask.answer?.choices.includes(`[button:${button}]`));
}

/** 规格文本的问题；null = 不是 ui 规格或检查通过。isOwnerApproval 按 askId 核台账 */
export function lintUiSpec(text: string, isOwnerApproval: (askId: string) => boolean): string | null {
  if (!isUiSpec(text)) return null;
  const missing = UI_REQUIRED_SECTIONS.filter((name) => !specSection(text, name).some((l) => l.trim()));
  if (missing.length) {
    return `ui 规格缺 ${missing.map((n) => `「## ${n}」`).join("")}（或该节为空）：补上后照常开卡。` +
      "复用对象写要复用的现有页面 / 组件；对照基准写验收时同屏对照的截图路径或说明";
  }
  const reuse = specSection(text, "复用对象").join("\n");
  if (!NEW_UI.test(reuse)) return null;
  const refs = [...reuse.matchAll(ASK_REF)].map((m) => m[0]);
  if (refs.some(isOwnerApproval)) return null;
  return "「## 复用对象」写了「无，新界面」，要引用同项目、针对本卡且 owner 已点批准按钮的授权 askId（ask_…）；旧 decision 文字引用不算批准，请 PM 发 ask";
}

/** start_node 预检用：inline 是 spec 参数给的正文，没有就读 <ledgerDir>/docs/tasks/<卡号>.md；都读不到不在这里拦（预检另有规格卡门） */
export function uiSpecGate(db: Database, ledgerDir: string, taskId: string, inline?: string, project?: string): string | null {
  const text = inline ?? readTextSoft(join(ledgerDir, "docs", "tasks", `${taskId}.md`));
  return text ? lintUiSpec(text, (askId) => ownerApproval(db, askId, project, taskId)) : null;
}
