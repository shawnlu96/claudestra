/**
 * merge-arch-CIPRECHK1 · 交付前本机预检（恢复键 ciDeliverPrecheck，缺省 on）：manager deliver 写入前、worker submitLendWork 提交前共用。
 * 绑定工作副本的 repo / base / head / 工作区（含未跟踪文件内容）/ 选测图摘要 → CI 同一套 ci-impact 选测（≤50 个跑选集，超了或 all 只跑改动测试并写明降级；
 * head 未合入 base 时在 CI 的合并树里跑，合不出就拒交）+ 登记检查（交付树自己的登记表）→ 跑完再绑一次，变了就作废。测试经 scripts/test.ts（全量测试闸 FULLGATE1）起，本卡从不起全量。
 * 不替代 CI；通过只是放行原交付校验。off = 不读工作副本、不起进程，与没有本卡时逐字一致。本文件是两个入口的闸与回执文字；
 * 预检本体与真实端口在 ci-deliver-precheck-run.ts；bridge 入口（30 秒预算）改走后台预检，结果按 git 事实取回。
 * tests/ci-deliver-precheck.test.ts、tests/ci-deliver-precheck-entry.test.ts、tests/ci-deliver-precheck-concurrency.test.ts。
 */
import type { Database } from "bun:sqlite";
import { getEventByDedup } from "./ledger-store.js";
import { gateRecovery, recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import { isTestProcess } from "./test-guard.js";
import { fail, realPrecheckPort, runPrecheck } from "./ci-deliver-precheck-run.js";

const PRECHECK_KEY = "ciDeliverPrecheck";
/** 出借 worker 侧没有台账项目可查：恢复键按本机编排项目读（与规格里的回退命令同一个项目） */
export const LEND_PRECHECK_PROJECT = "claude-orchestrator";

/** 一次预检绑定的全部事实；任何一项在跑测试前后不同，结果就作废 */
/** untracked = 未跟踪（不含忽略的）文件路径与内容的摘要，空 = 没有 */
export interface PrecheckBinding { repo: string; base: string; mergeBase: string; head: string; status: string; untracked: string; selection: string }
export interface Inspection {
  binding: PrecheckBinding;
  /** CI 同口径（on）的选测：selected = 有界选集；all = 选测兜底全量（reasons 说明） */
  run: "selected" | "all";
  tests: string[];
  reasons: string[];
  /** 本次新增 / 修改且在 head 仍存在的测试文件（降级时只跑它们） */
  changedTests: string[];
  /** 登记检查的问题；空 = 登记齐全 */
  registration: string[];
  /** head 未合入 base（CI 测的合并树 ≠ head 的树）：测试在这棵合并树的临时检出里跑，不在工作副本里跑 */
  merge?: MergeTarget;
}
/** CI 的合并提交：第一父 base、第二父 head、树 = 两者合并的树 */
export interface MergeTarget { tree: string; base: string; head: string }
export interface TestRun { code: number; tail: string }
export interface PrecheckReceipt {
  ok: boolean;
  scope: "selected" | "degraded";
  /** 选测原选集规模（all = 全部测试文件数） */
  selected: number | "all";
  ran: string[];
  degradeReasons: string[];
  failures: string[];
  key: string;
  reused: boolean;
  skipped?: string;
  /** 后台还在跑（bridge 入口）：未写交付，稍后用同一 head 重交 */
  pending?: string;
  /** 这份回执实际绑定的工作副本事实（repo / base / 合并基 / head / 工作区 / 未跟踪文件）的摘要；后台结果按它核对事实键 */
  facts?: string;
}
export type BackgroundState = { state: "done"; receipt: PrecheckReceipt } | { state: "running" } | { error: string };
export interface PrecheckPort {
  /** skip = 不适用（交付的仓库没有 ci-impact 选测，例如台账里别的项目）：放行，回执写明 */
  inspect(worktree: string): Promise<Inspection | { error: string } | { skip: string }>;
  /** 只带文件跑（经全量测试闸入口）；files 永远非空；给了 merge 就在该合并树的临时检出里跑 */
  runTests(worktree: string, files: string[], merge?: MergeTarget): Promise<TestRun>;
  recall(key: string): PrecheckReceipt | null;
  remember(key: string, receipt: PrecheckReceipt): void;
  /** bridge 入口（manager 子进程 30 秒就被杀）：按 git 事实查后台结果，没有就起一个后台预检；同一份事实同时只跑一个 */
  background(worktree: string, head: string): Promise<BackgroundState>;
}

/** 测试注入端口；没注入时测试进程不预检（别的测试照常交付），生产进程用真实端口 */
export const precheckHooks: { port?: PrecheckPort } = {};
const portAvailable = (): boolean => precheckHooks.port !== undefined || !isTestProcess();
const resolvePort = (): PrecheckPort => precheckHooks.port ?? realPrecheckPort();

const rollback = (project: string) => `回退：ledger scheduler-recovery ${project} off --key ${PRECHECK_KEY} --reason …`;
/** 回执的一行说明（通过时）或失败清单（不通过时） */
export function describeReceipt(r: PrecheckReceipt, project: string): string {
  const size = r.scope === "selected" ? `选集 ${r.ran.length} 个测试文件` : `降级（原选集 ${r.selected}）：${r.degradeReasons.join("；")}；实跑 ${r.ran.length} 个`;
  if (r.skipped) return `交付前预检不适用：${r.skipped}`;
  if (r.pending) return `交付前预检还没跑完，未写交付：${r.pending}`;
  if (r.ok) return `交付前预检通过${r.reused ? "（复用同一绑定的结果）" : ""}：${size}；登记检查通过；不替代 CI`;
  return `交付前预检未通过，未写交付（${rollback(project)}）：\n${r.failures.map((f) => `- ${f}`).join("\n")}${r.ran.length ? `\n（${size}）` : ""}`;
}

/** bridge 的 MCP deliver（order-deliver.ts）带的 dedup 前缀：它在 bridge 的目录、30 秒预算里起 manager，同步跑不完 */
const BRIDGE_DEDUP = "mcp-deliver:";

/** bridge 入口：工作副本取执行者在 registry 里的目录，预检在后台跑，结果按 git 事实取回 */
async function viaBridge(port: PrecheckPort, head: string, agentCwd: () => Promise<string | undefined>): Promise<PrecheckReceipt> {
  const dir = await agentCwd();
  if (!dir) return fail(["registry 里没有执行者的工作目录，找不到交付的工作副本"]);
  const bg = await port.background(dir, head);
  if ("error" in bg) return fail([`无法执行预检：${bg.error}`]);
  if (bg.state === "done") return bg.receipt;
  return { ...fail([]), pending: `已在后台对 ${dir} 的 head ${head.slice(0, 12)} 跑选中测试与登记检查；几分钟后用同一 head 重交，通过的结果直接复用` };
}

/** manager deliver 的预检：null = 放行（off / 不适用 / 通过），否则是失败清单；pass 回执经 note 带回 */
export async function managerDeliverPrecheck(db: Database, a: { project: string; taskId: string; head?: string; dedup?: string; cwd: string;
  agentCwd: () => Promise<string | undefined>; now: number }, policy?: RecoveryPolicyPort): Promise<{ refusal: string | null; note?: string }> {
  const head = a.head?.toLowerCase();
  // 不带 head 的交付没有代码可绑；同一 dedup 的交付已写过 = 去重重放，原交付自己回 duplicate
  if (!head || !portAvailable() || (a.dedup && getEventByDedup(db, a.dedup))) return { refusal: null };
  const g = await gateRecovery(db, { project: a.project, mechanism: PRECHECK_KEY, target: a.taskId, actionKey: head, action: "交付前跑选中测试与登记检查" },
    async () => {
      const port = resolvePort();
      return a.dedup?.startsWith(BRIDGE_DEDUP) ? viaBridge(port, head, a.agentCwd) : runPrecheck(a.cwd, head, port);
    }, { now: a.now, policy });
  if (g.outcome !== "acted") return { refusal: null };
  const text = describeReceipt(g.value, a.project);
  console.error(`[${PRECHECK_KEY}] ${text}`);
  return g.value.ok ? { refusal: null, note: text } : { refusal: text };
}

/** worker submitLendWork 的预检：没有台账，只按恢复键 on 执行；observe / off 都不跑 */
export async function lendSubmitPrecheck(worktree: string, head: string, policy: RecoveryPolicyPort = recoveryPolicy): Promise<string | null> {
  if (!portAvailable() || policy(LEND_PRECHECK_PROJECT, PRECHECK_KEY).mode !== "on") return null;
  const r = await runPrecheck(worktree, head, resolvePort());
  const text = describeReceipt(r, LEND_PRECHECK_PROJECT);
  console.error(`[${PRECHECK_KEY}] ${text}`);
  return r.ok ? null : text;
}
