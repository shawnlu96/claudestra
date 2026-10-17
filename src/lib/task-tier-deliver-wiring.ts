/**
 * 交付阶段的类型门控接线（TIER3e，消费 task-tier-models.ts tierCheckGate 的交付分支）：ledger-write.ts deliver 在开事务前调一行，
 * `ledger deliver`、MCP deliver、出借交付、peer PR 交付都经它。拒绝 = 抛 LedgerError，交付一笔都不写（门控记的事件在事务外，留得下）。
 * - 非 docs 卡：taskTierModels off 直接返回；否则只跑门控（不读 diff、不同步 docs 注册），没有钩子拒绝就放行、不记事件。
 * - docs 卡：off = 暂停（要求恢复开关或纠正规格），不挂模板、不记事件；on / observe 先同步 docs 注册，再读交付 head 相对基线的实际 diff
 *   与规格版本绑定作证据，交 tierCheckGate（observe 只记会拒）。读 diff 失败也交给钩子，按「无法证明」拒。
 * 依赖注入：门控、档位、docs 同步都经 task-tier-models.ts（它经 recovery-policy / appendEvent 又回到 ledger-write.ts），直接 import 成环；
 * 由 task-tier-docs-template.ts 加载时 installDeliverTierDeps 装上。没装 = docs 模板没加载（docs 不可达、也没有交付钩子），原样放行。
 * tests/task-tier-deliver-wiring.test.ts。
 */
import type { Database } from "bun:sqlite";
import { cardGlobs } from "./card-repo.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { getMeta, getTask, LedgerError } from "./ledger-store.js";
import { readRegistryAgentsSync } from "./registry.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { getSchedulerSession } from "./scheduler-sessions.js";
import { readTextSoft, specPathFor } from "./task-spec.js";
import type { DocsCheckCtx } from "./task-tier-docs-scope.js";
import type { TaskTier, TierCheckCtx } from "./task-tier-spec.js";
import type { LedgerTask } from "./ledger-stages.js";

/** 交付 head 相对基线改到的全部路径（新增 / 修改 / 删除；重命名两头都列）；读不到就抛 */
export type DeliveredFiles = (db: Database, task: LedgerTask, head: string) => string[];

const GIT_TIMEOUT_MS = 15_000;

function git(dir: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: GIT_TIMEOUT_MS });
  if (!r.success) throw new Error(`git ${args[0]} 失败（exit ${r.exitCode}）：${r.stderr.toString().trim().split("\n").pop()?.slice(0, 160) ?? ""}`);
  return r.stdout.toString();
}

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

/** 注入的 TIER3 能力：taskTierMode、tierCheckGate、syncDocsTemplate */
export interface DeliverTierDeps {
  mode: (project: string) => "on" | "observe" | "off";
  gate: (db: Database, phase: "delivery", ctx: TierCheckCtx) => string | null;
  syncDocs: (project: string) => boolean;
}
let deps: DeliverTierDeps | null = null;
export function installDeliverTierDeps(d: DeliverTierDeps): void { deps = d; }

/** 真实交付入口调用：按卡类型过交付门控，拒绝就抛（交付不写） */
export function deliverTierGate(db: Database, taskId: string, head: string | undefined): void {
  const task = deps && getTask(db, taskId);
  if (!deps || !task) return; // 卡不存在由 deliver 自己报 not_found
  const w = getWorkflow(db, task.id);
  const tier = (w?.template ?? "code") as string;
  const fileGlobs = cardGlobs(task);
  if (tier !== "docs") {
    if (deps.mode(task.project) === "off") return;
    const why = deps.gate(db, "delivery", { project: task.project, taskId: task.id, tier: tier as TaskTier, fileGlobs });
    if (why) throw new LedgerError("invalid", `类型校验拒绝交付：${why}`);
    return;
  }
  if (!deps.syncDocs(task.project)) {
    throw new LedgerError("invalid", `${task.id} 是 docs 卡，但本项目 taskTierModels 是 off：docs 卡暂停。恢复开关（scheduler-recovery … on --key taskTierModels），或纠正规格（改成已有模板后重新开卡）`);
  }
  let files: string[] | undefined, filesError: string | undefined;
  try {
    if (!head) throw new Error("交付没带 head");
    files = filesPort(db, task, head);
  } catch (e) {
    filesError = (e as Error).message;
  }
  let specText: string | null = null;
  try { specText = readTextSoft(specPathFor(task, getMeta(db, task.project).docsDir)); } catch { specText = null; }
  const ctx: DocsCheckCtx = { project: task.project, taskId: task.id, tier: "docs", fileGlobs, ...(files ? { files } : {}),
    docs: { ...(files ? { files } : {}), ...(filesError ? { filesError } : {}), stored: w ? { template: w.template, specRev: w.specRev } : null,
      specRev: task.specRev, specText } };
  const why = deps.gate(db, "delivery", ctx);
  if (why) throw new LedgerError("invalid", `类型校验拒绝交付：${why}`);
}
