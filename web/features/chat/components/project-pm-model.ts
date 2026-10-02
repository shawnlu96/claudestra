/**
 * 侧栏 project 菜单「主管 PM」二级页的纯逻辑（i28-PMSW2；组件在 project-pm.tsx，单测 tests/web-project-pm.test.ts）。
 * 候选按 API 原样列（执行者由后端排除，这里不过滤）；点别的候选先 dryRun 体检，问题逐条列出且不放行；
 * 确认只发一次真 POST，成功关菜单 + 轻提示，失败把原因留在菜单里。
 */
import type { PmCandidate, PmSwitchResult, ProjectPmView } from "@/lib/api/project-pm";

/** 选中某个候选后的确认行状态：problems 非空 = 不放行 */
export interface PmConfirm {
  agent: string;
  check: "pending" | "ok" | "sending" | "failed";
  problems: string[];
}

export interface PmFlowDeps {
  post(agent: string, dryRun: boolean): Promise<PmSwitchResult>;
  close(): void;
  flash(agent: string): void;
}

export function runtimeLabel(runtime: string): string {
  return runtime === "codex" ? "Codex" : runtime === "pi" ? "Pi" : "Claude";
}

/** 候选行：主文案是 agent 名，副标题 = runtime · 在线状态（中文 key，渲染时过 t()） */
export function pmRows(view: ProjectPmView): { name: string; current: boolean; runtime: string; status: "在线" | "离线" }[] {
  return view.candidates.map((c: PmCandidate) => ({
    name: c.name,
    current: c.name === view.active,
    runtime: runtimeLabel(c.runtime),
    status: c.online ? "在线" : "离线",
  }));
}

/** 后端体检问题用 "; " 串起来（lib/pm-role-switch.ts），manager 进程级错误用「；」 */
export function pmProblems(error: string): string[] {
  const out = error.split(/;\s+|；/).map((s) => s.trim()).filter(Boolean);
  return out.length ? out : ["操作失败"];
}

/**
 * 一条问题折行后约占几行菜单高（MenuShell 只拿行数算翻转）：文本区约 146px，13.5px 字号约 22 个半角 / 11 个全角一行，
 * 每多折一行约半个 ROW_H。只是定位估算，不影响显示（问题行本身完整折行，见 project-pm.tsx PmProblemItem）。
 */
export function pmProblemRows(problem: string): number {
  let units = 0;
  for (const ch of problem) units += ch.charCodeAt(0) > 0x2e7f ? 2 : 1;
  return 1 + (Math.max(1, Math.ceil(units / 22)) - 1) / 2;
}

/** 二级页行数（MenuShell 定位用）：返回 + 候选（至少占一行）+ 确认 / 取消 + 问题（长问题按折行估算） */
export function pmPageRows(view: ProjectPmView | null, confirm: PmConfirm | null): number {
  const problems = confirm ? confirm.problems.reduce((n, p) => n + pmProblemRows(p), 0) : 0;
  return 1 + Math.max(1, view?.candidates.length ?? 0) + (confirm ? 2 + problems : 0);
}

export async function checkPm(agent: string, deps: Pick<PmFlowDeps, "post">): Promise<PmConfirm> {
  const r = await deps.post(agent, true);
  return r.ok ? { agent, check: "ok", problems: [] } : { agent, check: "failed", problems: pmProblems(r.error) };
}

/** 确认切换：只发一次真 POST；成功返回 null（菜单已关），失败返回带原因的确认行 */
export async function confirmPm(agent: string, deps: PmFlowDeps): Promise<PmConfirm | null> {
  const r = await deps.post(agent, false);
  if (!r.ok) return { agent, check: "failed", problems: pmProblems(r.error) };
  deps.close();
  deps.flash(agent);
  return null;
}
