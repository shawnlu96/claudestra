/**
 * docs 流程模板（TIER3e）：经 task-tier-spec.ts registerTierTemplate 注册，流程定义逐版取 code 的（同一份节点、对抗审查、跨家族），
 * 不另写流程；模型有效值完全由 task-tier-models.ts（TIER_DEFAULTS.docs + 表）给，这里不碰。文件范围钩子在 task-tier-docs-scope.ts。
 * 门控 = taskTierModels，按项目：on / observe 第一次同步时挂上、之后进程内常驻（observe 下钩子只记会拒、放行，由 tierCheckGate 决定）；
 * off 不挂，也不摘别的项目要用的注册——本项目 off 的 docs 由三处消费边界各自按项目拒：开卡（dag-tools-start.ts preflightStart，
 * docsOffProblem，与未注册同一句）、调度规划（scheduler-plan.ts，docsTierPause，旧模板校验的 workflow_drift 拒绝路径）、
 * 交付（task-tier-deliver-wiring.ts）；三处同时也是 on 下的同步点，冷启动的进程不靠先开卡。
 * 加载即给真实交付入口装上交付门控与 docs 交付的实际 diff 读取（task-tier-deliver-wiring.ts installDeliverTierDeps；直接 import 会成环）。
 * tests/task-tier-docs-template.test.ts。
 */
import { gitIn } from "./scheduler-ui-carry-proof.js";
import { templateFor } from "./scheduler-template.js";
import { installDeliverTierDeps, type DeliveredFiles } from "./task-tier-deliver-wiring.js";
import { readRegistryAgentsSync } from "./registry.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { getSchedulerSession } from "./scheduler-sessions.js";
import { taskTierMode, tierCheckGate, type TaskTierPort } from "./task-tier-models.js";
import { docsDeliveryCheck, docsDispatchCheck } from "./task-tier-docs-scope.js";
import { registerTierChecks, registerTierTemplate, tierLaunchable, type TierFlow } from "./task-tier-spec.js";

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

/**
 * 按项目当前 taskTierModels 档位同步 docs；返回本项目现在能不能用 docs（on / observe = true）。
 * 注册表是进程级的、调度进程同时服务多个项目：on / observe 第一次同步时挂上，之后常驻；off 不挂、也不摘别的项目已挂的——
 * 本项目 off 的拒绝由各消费边界按项目做（开卡 docsOffProblem、调度规划 docsTierPause、交付 task-tier-deliver-wiring.ts），
 * 全部 off 的进程从头到尾不注册。
 */
export function syncDocsTemplate(project: string, p?: TaskTierPort): boolean {
  const { mode } = p ? taskTierMode(project, p) : taskTierMode(project);
  if (mode === "off") return false;
  if (undo && !tierLaunchable("docs")) resetDocsTemplate(); // 注册表被别处撤掉了：本模块的记录作废，重新挂
  if (!undo) {
    const flows = registerTierTemplate("docs", docsFlows());
    const checks = registerTierChecks({ dispatch: docsDispatchCheck, delivery: docsDeliveryCheck });
    undo = () => { checks(); flows(); };
  }
  return true;
}

const OFF_PAUSE = "docs 卡暂停：本项目 taskTierModels 是 off，docs 流程模板不可用。恢复开关（scheduler-recovery … on --key taskTierModels），或纠正规格（改成已有模板后重新开卡）";

/**
 * 调度规划边界（scheduler-plan.ts planSchedulerBase，在模板校验之前）：只看 docs 卡，别的模板不读开关、原样返回 null。
 * 本项目 off = 暂停原因（规划器按旧模板校验的 workflow_drift 拒绝路径停，不派活、不起会话）；on / observe 先按本项目同步注册
 * （冷启动的调度进程不靠先开卡 / 交付），返回 null 照 code 流程规划。
 */
export function docsTierPause(project: string, template: string): string | null {
  if (template !== "docs") return null;
  return syncDocsTemplate(project) ? null : OFF_PAUSE;
}

/** 开卡边界（dag-tools-start.ts preflightStart 校验 template 参数）：本项目 off 时 docs 与未注册时同一句拒绝；别的情况 null */
export function docsOffProblem(project: string, template: string): string | null {
  return template === "docs" && !syncDocsTemplate(project) ? "类型 docs 还没有注册流程模板，不能开卡" : null;
}

/** 摘掉 docs 模板与钩子（测试清理；生产不摘） */
export function resetDocsTemplate(): void {
  const u = undo;
  undo = null;
  u?.();
}

/** 经已登记的同步 git 读取口（scheduler-ui-carry-proof.ts gitIn：只读本地对象、非零退出 / 警告即抛），本模块自己不起进程 */
const git = (dir: string, args: string[]): string => gitIn(dir)(...args).toString();

/** dir 仓库里交付 head 相对基线（origin/main，没有就 main）的变更路径；head 对象不在本机先 fetch 这一个提交 */
export function gitDiffFiles(dir: string, head: string): string[] {
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("交付 head 不是完整 SHA");
  try { git(dir, ["cat-file", "-e", `${head}^{commit}`]); } catch { git(dir, ["fetch", "--no-tags", "--quiet", "origin", head]); }
  const base = ["origin/main", "main"].find((ref) => { try { git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]); return true; } catch { return false; } });
  if (!base) throw new Error("本卡仓库里没有 origin/main 或 main");
  const out = git(dir, ["diff", "--name-only", "-z", "--no-renames", `${base}...${head}`, "--"]);
  if (out && !out.endsWith("\0")) throw new Error("git diff 文件列表不完整");
  return out.split("\0").filter(Boolean);
}

/** 生产实现：本卡仓库目录 = scheduler.json repoDir，没有就作者会话的 cwd（与 order-deliver-scope-git.ts scopeDiff 同口径）。只对 docs 卡跑 */
const gitDeliveredFiles: DeliveredFiles = (db, task, head) => {
  const dir = readSchedulerConfig().projects[task.project]?.repoDir
    ?? readRegistryAgentsSync().find((a) => a.name === (getSchedulerSession(db, task.id, "author")?.agent ?? task.agent))?.cwd;
  if (!dir) throw new Error("找不到本卡仓库目录");
  return gitDiffFiles(dir, head);
};


let filesPort: DeliveredFiles = gitDeliveredFiles;
/** Tests only: swap how delivered files are read (undefined = back to git). */
export function useDeliveredFilesPort(fn?: DeliveredFiles): void { filesPort = fn ?? gitDeliveredFiles; }

installDeliverTierDeps({
  files: (db, task, head) => filesPort(db, task, head),
  gate: (db, phase, ctx) => tierCheckGate(db, phase, ctx),
  syncDocs: (project) => syncDocsTemplate(project),
});
