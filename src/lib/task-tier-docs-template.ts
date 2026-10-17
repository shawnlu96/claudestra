/**
 * docs 流程模板（TIER3e）：经 task-tier-spec.ts registerTierTemplate 注册，流程定义逐版取 code 的（同一份节点、对抗审查、跨家族），
 * 不另写流程；模型有效值完全由 task-tier-models.ts（TIER_DEFAULTS.docs + 表）给，这里不碰。文件范围钩子在 task-tier-docs-scope.ts。
 * 门控 = taskTierModels：syncDocsTemplate 按项目当前档位挂 / 摘——off 摘掉模板与钩子（开卡回到旧模板校验的「docs 还没有注册」拒绝），
 * on / observe 挂上（observe 下钩子只记会拒、放行，由 tierCheckGate 决定）。注册表是进程级的，以最近一次同步为准：
 * 生产里开卡（dag-tools-start.ts preflightStart）与交付（task-tier-deliver-wiring.ts，冷进程懒加载本模块）各自先按本项目同步。
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

/** 按项目当前 taskTierModels 档位挂 / 摘 docs；返回现在是否已注册 */
export function syncDocsTemplate(project: string, p?: TaskTierPort): boolean {
  const { mode } = p ? taskTierMode(project, p) : taskTierMode(project);
  if (mode === "off") { resetDocsTemplate(); return false; }
  if (undo && !tierLaunchable("docs")) resetDocsTemplate(); // 注册表被别处撤掉了：本模块的记录作废，重新挂
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
  mode: (project) => taskTierMode(project).mode,
  gate: (db, phase, ctx) => tierCheckGate(db, phase, ctx),
  syncDocs: (project) => syncDocsTemplate(project),
});
