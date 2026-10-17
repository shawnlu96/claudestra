/**
 * merge-arch-CIPRECHK1 · 交付前本机预检（恢复键 ciDeliverPrecheck，缺省 on）：manager deliver 写入前、worker submitLendWork 提交前共用。
 * 绑定工作副本的 repo / base / head / 工作区 / 选测图摘要 → CI 同一套 ci-impact 选测（≤50 个跑选集，超了或 all 只跑改动测试并写明降级）
 * + 登记检查（ci-impact-registration-check.ts）→ 跑完再绑一次，变了就作废。测试经 scripts/test.ts（全量测试闸 FULLGATE1）起，本卡从不起全量。
 * 不替代 CI；通过只是放行原交付校验。off = 不读工作副本、不起进程，与没有本卡时逐字一致。真实端口在 ci-deliver-precheck-run.ts。
 * tests/ci-deliver-precheck.test.ts、tests/ci-deliver-precheck-entry.test.ts、tests/ci-deliver-precheck-concurrency.test.ts。
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { getEventByDedup } from "./ledger-store.js";
import { gateRecovery, recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import { isTestProcess } from "./test-guard.js";

const PRECHECK_KEY = "ciDeliverPrecheck";
/** 选集超过这么多个测试文件（或选测给 all）就降级：只跑改动测试 + 登记检查 */
export const PRECHECK_MAX_TESTS = 50;
/** 出借 worker 侧没有台账项目可查：恢复键按本机编排项目读（与规格里的回退命令同一个项目） */
export const LEND_PRECHECK_PROJECT = "claude-orchestrator";

/** 一次预检绑定的全部事实；任何一项在跑测试前后不同，结果就作废 */
interface PrecheckBinding { repo: string; base: string; mergeBase: string; head: string; status: string; selection: string }
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
}
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
}
export interface PrecheckPort {
  /** skip = 不适用（交付的仓库没有 ci-impact 选测，例如台账里别的项目）：放行，回执写明 */
  inspect(worktree: string): Promise<Inspection | { error: string } | { skip: string }>;
  /** 只带文件跑（经全量测试闸入口）；files 永远非空 */
  runTests(worktree: string, files: string[]): Promise<TestRun>;
  recall(key: string): PrecheckReceipt | null;
  remember(key: string, receipt: PrecheckReceipt): void;
}

/** 测试注入端口；没注入时测试进程不预检（别的测试照常交付），生产进程用真实端口 */
export const precheckHooks: { port?: PrecheckPort } = {};
const portAvailable = (): boolean => precheckHooks.port !== undefined || !isTestProcess();
async function resolvePort(): Promise<PrecheckPort> {
  return precheckHooks.port ?? (await import("./ci-deliver-precheck-run.js")).realPrecheckPort();
}

const bindingKey = (b: PrecheckBinding): string =>
  createHash("sha256").update(JSON.stringify(["v1", PRECHECK_MAX_TESTS, b.repo, b.base, b.mergeBase, b.head, b.status, b.selection])).digest("hex");

/** 跑什么：有界选集照跑；超阈值或 all 降级为改动测试，原规模与原因进回执 */
export function planRun(ins: Inspection): { scope: PrecheckReceipt["scope"]; files: string[]; selected: number | "all"; degradeReasons: string[] } {
  if (ins.run === "selected" && ins.tests.length <= PRECHECK_MAX_TESTS) return { scope: "selected", files: ins.tests, selected: ins.tests.length, degradeReasons: [] };
  const why = ins.run === "all" ? [`选测给出 all：${ins.reasons.slice(0, 5).join("；") || "（无原因）"}`]
    : [`选集 ${ins.tests.length} 个测试文件，超过阈值 ${PRECHECK_MAX_TESTS}`];
  return { scope: "degraded", files: ins.changedTests, selected: ins.run === "all" ? "all" : ins.tests.length,
    degradeReasons: [...why, "只跑本次新增 / 修改的测试 + 登记检查，不算完整相关测试通过"] };
}

const DRIFT: [keyof PrecheckBinding, string][] = [["repo", "仓库"], ["base", "base"], ["mergeBase", "合并基"], ["head", "head"], ["status", "工作区"],
  ["selection", "选测图摘要"]];

/** 预检本体：绑定 → 选测 / 登记 → 跑测试 → 再绑定核对；相同绑定的通过结果直接复用 */
export async function runPrecheck(worktree: string, head: string, port: PrecheckPort): Promise<PrecheckReceipt> {
  const fail = (failures: string[], key = ""): PrecheckReceipt => ({ ok: false, scope: "selected", selected: 0, ran: [], degradeReasons: [], failures, key, reused: false });
  const ins = await port.inspect(worktree);
  if ("error" in ins) return fail([`无法执行预检：${ins.error}`]);
  if ("skip" in ins) return { ...fail([]), ok: true, skipped: ins.skip };
  if (!ins.binding.head.startsWith(head.toLowerCase()) || head.length < 7) return fail([`工作副本 HEAD ${ins.binding.head.slice(0, 12)} 不是交付 head ${head.slice(0, 12)}（在交付的工作副本里运行）`]);
  if (ins.binding.status) return fail(["工作副本有未提交的已跟踪改动：先提交干净再交付"]);
  const key = bindingKey(ins.binding);
  const prior = port.recall(key);
  if (prior?.ok && prior.key === key) return { ...prior, reused: true };
  const plan = planRun(ins);
  const failures = ins.registration.map((r) => `登记检查：${r}`);
  if (plan.files.length) {
    const r = await port.runTests(worktree, plan.files);
    if (r.code !== 0) failures.push(`相关测试失败（退出码 ${r.code}，${plan.files.length} 个文件）${r.tail ? `：\n${r.tail}` : ""}`);
  }
  const after = await port.inspect(worktree);
  if (!("binding" in after)) failures.push(`跑完后无法重新核对工作副本：${"error" in after ? after.error : after.skip}`);
  else for (const [k, what] of DRIFT) if (after.binding[k] !== ins.binding[k]) failures.push(`预检期间${what}变了，结果作废，重新交付`);
  const receipt: PrecheckReceipt = { ok: !failures.length, scope: plan.scope, selected: plan.selected, ran: plan.files, degradeReasons: plan.degradeReasons,
    failures, key, reused: false };
  if (receipt.ok) port.remember(key, receipt);
  return receipt;
}

const rollback = (project: string) => `回退：ledger scheduler-recovery ${project} off --key ${PRECHECK_KEY} --reason …`;
/** 回执的一行说明（通过时）或失败清单（不通过时） */
export function describeReceipt(r: PrecheckReceipt, project: string): string {
  const size = r.scope === "selected" ? `选集 ${r.ran.length} 个测试文件` : `降级（原选集 ${r.selected}）：${r.degradeReasons.join("；")}；实跑 ${r.ran.length} 个`;
  if (r.skipped) return `交付前预检不适用：${r.skipped}`;
  if (r.ok) return `交付前预检通过${r.reused ? "（复用同一绑定的结果）" : ""}：${size}；登记检查通过；不替代 CI`;
  return `交付前预检未通过，未写交付（${rollback(project)}）：\n${r.failures.map((f) => `- ${f}`).join("\n")}${r.ran.length ? `\n（${size}）` : ""}`;
}

/** manager deliver 的预检：null = 放行（off / 不适用 / 通过），否则是失败清单；pass 回执经 note 带回 */
export async function managerDeliverPrecheck(db: Database, a: { project: string; taskId: string; head?: string; dedup?: string; worktree: string; now: number },
  policy?: RecoveryPolicyPort): Promise<{ refusal: string | null; note?: string }> {
  const head = a.head?.toLowerCase();
  // 不带 head 的交付没有代码可绑；同一 dedup 的交付已写过 = 去重重放，原交付自己回 duplicate
  if (!head || !portAvailable() || (a.dedup && getEventByDedup(db, a.dedup))) return { refusal: null };
  const g = await gateRecovery(db, { project: a.project, mechanism: PRECHECK_KEY, target: a.taskId, actionKey: head, action: "交付前跑选中测试与登记检查" },
    async () => runPrecheck(a.worktree, head, await resolvePort()), { now: a.now, policy });
  if (g.outcome !== "acted") return { refusal: null };
  const text = describeReceipt(g.value, a.project);
  console.error(`[${PRECHECK_KEY}] ${text}`);
  return g.value.ok ? { refusal: null, note: text } : { refusal: text };
}

/** worker submitLendWork 的预检：没有台账，只按恢复键 on 执行；observe / off 都不跑 */
export async function lendSubmitPrecheck(worktree: string, head: string, policy: RecoveryPolicyPort = recoveryPolicy): Promise<string | null> {
  if (!portAvailable() || policy(LEND_PRECHECK_PROJECT, PRECHECK_KEY).mode !== "on") return null;
  const r = await runPrecheck(worktree, head, await resolvePort());
  const text = describeReceipt(r, LEND_PRECHECK_PROJECT);
  console.error(`[${PRECHECK_KEY}] ${text}`);
  return r.ok ? null : text;
}
