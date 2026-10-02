/**
 * ui 规格的必填检查（i28-UIQ1）：卡首写了「模板：ui」的规格必须有非空的「## 复用对象」和「## 对照基准」；
 * 复用对象写「无，新界面」时还要引用一条 owner 记的台账 decision（`decision #<seq>`）。
 * start_node 的预检调它（dag-tools-start.ts），自动开卡复用同一个预检：预检拒了 claim 结为 failed、按 arm 只通知 PM 一次，改了规格重新武装。
 * 只看卡首模板行：code / security 规格、没写模板行的规格一律放行。tests/spec-lint.test.ts。
 */
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { specSection } from "./review-pack.js";
import { readTextSoft } from "./task-spec.js";

const UI_REQUIRED_SECTIONS = ["复用对象", "对照基准"] as const;
const NEW_UI = /无\s*[,，、]?\s*新界面/;
const DECISION_REF = /(?:decision|决定|决策)\s*[#＃]?\s*(\d{1,12})/gi;

const TEMPLATE_LINE = /^模板\s*[:：]\s*(.*)$/;

/**
 * 卡首（第一个 `## ` 之前）恰好一行模板声明且值是 ui（不分大小写）。和 scheduler-autostart.ts parseSpecHead 同口径的子集，
 * 不直接调它：ui-acceptance.ts 经审查单被 scheduler 一侧引用，import 它会成环（guard deps:no-cycle）。
 */
export function isUiSpec(text: string | null): boolean {
  if (!text) return false;
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const end = lines.findIndex((l) => /^##\s/.test(l));
  const decls = (end < 0 ? lines : lines.slice(0, end)).flatMap((l) => l.match(TEMPLATE_LINE)?.[1]?.trim().toLowerCase() ?? []);
  return decls.length === 1 && decls[0] === "ui";
}

/** 台账里这个 seq 是 owner 记的 decision 事件 */
function ownerDecision(db: Database, seq: number): boolean {
  const row = db.query("SELECT kind, actor FROM events WHERE seq = ?").get(seq) as { kind: string; actor: string } | null;
  return row?.kind === "decision" && row.actor === "owner";
}

/** 规格文本的问题；null = 不是 ui 规格或检查通过。isOwnerDecision 按 seq 核台账 */
export function lintUiSpec(text: string, isOwnerDecision: (seq: number) => boolean): string | null {
  if (!isUiSpec(text)) return null;
  const missing = UI_REQUIRED_SECTIONS.filter((name) => !specSection(text, name).some((l) => l.trim()));
  if (missing.length) {
    return `ui 规格缺 ${missing.map((n) => `「## ${n}」`).join("")}（或该节为空）：补上后照常开卡。` +
      "复用对象写要复用的现有页面 / 组件；对照基准写验收时同屏对照的截图路径或说明";
  }
  const reuse = specSection(text, "复用对象").join("\n");
  if (!NEW_UI.test(reuse)) return null;
  const refs = [...reuse.matchAll(DECISION_REF)].map((m) => Number(m[1]));
  if (refs.some((seq) => isOwnerDecision(seq))) return null;
  return refs.length
    ? `「## 复用对象」写了「无，新界面」，但引用的 ${refs.map((s) => `decision #${s}`).join("、")} 不是 owner 记的台账决定`
    : "「## 复用对象」写了「无，新界面」，要附 owner 批过的台账决定引用（decision #<seq>）";
}

/** start_node 预检用：inline 是 spec 参数给的正文，没有就读 <ledgerDir>/docs/tasks/<卡号>.md；都读不到不在这里拦（预检另有规格卡门） */
export function uiSpecGate(db: Database, ledgerDir: string, taskId: string, inline?: string): string | null {
  const text = inline ?? readTextSoft(join(ledgerDir, "docs", "tasks", `${taskId}.md`));
  return text ? lintUiSpec(text, (seq) => ownerDecision(db, seq)) : null;
}
