/**
 * docs 流程模板（TIER3e）：经 task-tier-spec.ts registerTierTemplate 注册，流程定义逐版取 code 的（同一份节点、对抗审查、跨家族），
 * 不另写流程；模型有效值完全由 task-tier-models.ts（TIER_DEFAULTS.docs + 表）给，这里不碰。文件范围钩子在 task-tier-docs-scope.ts。
 * 门控 = taskTierModels：syncDocsTemplate 按项目当前档位挂 / 摘——off 摘掉模板与钩子（开卡回到旧模板校验的「docs 还没有注册」拒绝），
 * on / observe 挂上（observe 下钩子只记会拒、放行，由 tierCheckGate 决定）。注册表是进程级的，以最近一次同步为准。
 * 加载即给真实交付入口装上交付门控（task-tier-deliver-wiring.ts installDeliverTierDeps；直接 import 会成环）。
 * tests/task-tier-docs-template.test.ts。
 */
import { templateFor } from "./scheduler-template.js";
import { installDeliverTierDeps } from "./task-tier-deliver-wiring.js";
import { taskTierMode, tierCheckGate, type TaskTierPort } from "./task-tier-models.js";
import { docsDeliveryCheck, docsDispatchCheck } from "./task-tier-docs-scope.js";
import { registerTierChecks, registerTierTemplate, type TierFlow } from "./task-tier-spec.js";

/** code 现有的每个版本原样借用（v2、v3）；code 以后加版本这里自动跟上 */
export function docsFlows(): TierFlow[] {
  const flows: TierFlow[] = [];
  for (let v = 1; v <= 16; v++) {
    const code = templateFor("code", v);
    if (!code) continue;
    const { id: _id, version: _v, ...rest } = code;
    flows.push({ ...rest, version: v });
  }
  return flows;
}

let undo: (() => void) | null = null;

/** 按项目当前 taskTierModels 档位挂 / 摘 docs；返回现在是否已注册 */
export function syncDocsTemplate(project: string, p?: TaskTierPort): boolean {
  const { mode } = p ? taskTierMode(project, p) : taskTierMode(project);
  if (mode === "off") { resetDocsTemplate(); return false; }
  if (!undo) {
    const flows = registerTierTemplate("docs", docsFlows());
    const checks = registerTierChecks({ dispatch: docsDispatchCheck, delivery: docsDeliveryCheck });
    undo = () => { checks(); flows(); };
  }
  return true;
}

/** 摘掉 docs 模板与钩子（off 同步、测试清理） */
export function resetDocsTemplate(): void {
  const u = undo;
  undo = null;
  u?.();
}

installDeliverTierDeps({ mode: (project) => taskTierMode(project).mode, gate: (db, phase, ctx) => tierCheckGate(db, phase, ctx), syncDocs: (project) => syncDocsTemplate(project) });
