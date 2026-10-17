/**
 * i28-ASK4 测试类扩围的判定（isTestScopeAsk，order-ask-default.ts 原样转出），加 ASKSCOPE3 快路（恢复键 askScopeTests）：
 * reason = superseded_assertion、没有 extra.held / risk、不是 security 模板、文件名不碰权限类字样、文件在卡的 base 版里都已存在——
 * on：开出时 notice 记 skipped、不通知 PM，order-ask-default.ts 下一次扫描就按 ASK4 原事务批准（追加 fileGlobs、规格「自动定」、tell 执行者），
 * 卡上另记一条 note（op ask_scope_tests）；observe：照旧通知 PM、15 分钟，另记 recovery_observe；off：不判。
 * new_test 不走快路。是否快路只在开出时定，扫描不再看档位（同 ASKDEF1）。tests/order-ask-test-scope-fast.test.ts。
 */
import { Database } from "bun:sqlite";
import { getAsk, patchAsk, type Ask, type OpenedAsk } from "./ledger-asks.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getMeta, getTask } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import type { AskDeps, AskSource } from "./order-ask.js";
import { ASK_SCOPE_REASONS, type AskScopeReason } from "./order-wire.js";
import { privateCardRepo } from "./card-repo.js";
import { recordObserved, recoveryPolicy } from "./recovery-policy.js";
import { runBounded } from "./run-bounded.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { scanSpecHead } from "./spec-lint-head.js";
import { readTextSoft, specPathFor } from "./task-spec.js";

/** 卡的 base 版里这些文件都在（不许借快路新建 / 删除测试文件）；缺省按 scheduler.json 的 repoDir 用 git 读对象 */
export type BaseHas = (db: Database, task: LedgerTask, files: string[]) => Promise<boolean>;

/** 远端出借写单（本机台账 lend_orders 那一行的 step）；本机的单 = null */
function lendStepOf(db: Database, orderId: string): string | null {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_orders'").get()) return null;
  return (db.query("SELECT step FROM lend_orders WHERE orderId = ?").get(orderId) as { step: string } | null)?.step ?? null;
}

const isTestFile = (f: unknown): boolean => typeof f === "string" && f.startsWith("tests/") && !f.split("/").some((s) => s === ".." || s === "." || !s);

/** i28-ASK4：远端写单上、files 全在 tests/、reason 合法的提问（ASK2 的本机默认做法提问另走 isDefaultAsk） */
export function isTestScopeAsk(db: Database, a: Ask): boolean {
  const files = a.extra.files;
  if (a.extra.via !== "mcp_ask" || a.blocking === false || a.extra.class === "design" || !a.taskId) return false;
  if (!Array.isArray(files) || !files.length || !files.every(isTestFile)) return false;
  if (!ASK_SCOPE_REASONS.includes(a.extra.reason as AskScopeReason)) return false;
  return ["write", "fix"].includes(lendStepOf(db, String(a.extra.orderId ?? "")) ?? "");
}

/** 开出时定了走快路的（askScopeTests=on） */
export const isTestScopeFast = (a: Ask): boolean => a.extra.testScopeFast === true;

/** 文件名碰到这些字样的一律不走快路（权限 / 闸 / 凭据类测试照旧等 PM 或 15 分钟） */
const SENSITIVE = ["auth", "gate", "secret", "permission", "guard", "caller-identity", "credential"];

/** 卡的 base：本卡最早一张出借写单的 head（开工起点），没有就按 origin/main */
function baseRef(db: Database, taskId: string): string {
  try {
    const row = db.query("SELECT head FROM lend_orders WHERE taskId = ? AND step = 'write' AND head IS NOT NULL ORDER BY createdAt LIMIT 1").get(taskId) as { head: string } | null;
    if (row && /^[0-9a-f]{40}$/.test(row.head)) return row.head;
  } catch { /* 老表没有 taskId / head 列：按 origin/main */ }
  return "origin/main";
}

const gitBaseHas: BaseHas = async (db, task, files) => {
  if (privateCardRepo(task)) return false; // 私仓卡不在本仓 clone 里，核不了 base 就不走快路
  const dir = readSchedulerConfig().projects[task.project]?.repoDir;
  if (!dir) return false;
  const ref = baseRef(db, task.id);
  for (const f of files) {
    const r = await runBounded(["git", "cat-file", "-e", `${ref}:${f}`], { cwd: dir, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 10_000 });
    if (r.code !== 0) return false;
  }
  return true;
};

/** 快路的结构化条件（PM 定 1），不看问题原文；held / risk / security 模板任何一条都不走 */
async function fastEligible(db: Database, a: Ask, baseHas: BaseHas): Promise<boolean> {
  if (!isTestScopeAsk(db, a) || a.extra.reason !== "superseded_assertion" || typeof a.extra.held === "string" || a.extra.risk) return false;
  const files = (a.extra.files as string[]);
  if (files.some((f) => SENSITIVE.some((w) => f.toLowerCase().includes(w)))) return false;
  const task = getTask(db, a.taskId as string);
  const spec = task && readTextSoft(specPathFor(task, getMeta(db, task.project).docsDir));
  if (!task || spec == null) return false;
  const flow = db.query("SELECT template FROM task_workflows WHERE taskId = ?").get(task.id) as { template: string } | null;
  if (flow?.template === "security" || scanSpecHead(spec).decls.some((d) => d.trim().toLowerCase() === "security")) return false;
  return baseHas(db, task, files);
}

const TEST_SCOPE_FAST_NOTE = "测试类扩围快路（askScopeTests），未通知 PM，下一次扫描自动批准";

/**
 * 开出普通 ask 之后、通知 PM 之前调（risk = 执行者标的 risk：askDefaultAll 关着时 extra 里不记，这里另传）：on 且符合条件 → 记 notice=skipped + testScopeFast，返回给执行者的说明（调用方不再通知 PM）；
 * observe → 记 recovery_observe，返回 null（照旧通知）；off / 不符合 → null。永不抛出：出错按原路。
 */
export async function openTestScopeFast(db: Database, deps: Pick<AskDeps, "policy" | "baseHas">, src: AskSource, opened: OpenedAsk,
  risk?: string): Promise<string | null> {
  let writer: Database | undefined;
  try {
    const ask = opened.ask;
    if (opened.existed && isTestScopeFast(ask)) return TEST_SCOPE_FAST_NOTE;
    if (ask.state !== "open" || ask.extra.notice !== "pending") return null;
    const mode = (deps.policy ?? recoveryPolicy)(src.task.project, "askScopeTests").mode;
    if (mode === "off" || risk || !(await fastEligible(db, ask, deps.baseHas ?? gitBaseHas))) return null;
    writer = (db.query("PRAGMA query_only").get() as { query_only: number }).query_only
      ? new Database(db.filename, { readwrite: true, create: false }) : db;
    if (writer !== db) writer.exec("PRAGMA busy_timeout = 5000");
    if (mode === "observe") {
      recordObserved(writer, { project: src.task.project, mechanism: "askScopeTests", target: src.task.id, actionKey: ask.id,
        action: `测试类扩围快路批准 ask ${ask.id}（不通知 PM、下一次扫描就批）`,
        data: { askId: ask.id, orderId: src.orderId, files: ask.extra.files, would: "fast" } }, Date.now());
      return null;
    }
    const w = writer;
    const done = w.transaction(() => {
      const cur = getAsk(w, ask.id);
      if (cur?.state !== "open" || cur.extra.notice !== "pending") return false;
      patchAsk(w, ask.id, { extra: { notice: "skipped", testScopeFast: true } });
      return true;
    }).immediate();
    return done ? TEST_SCOPE_FAST_NOTE : null;
  } catch (e) {
    console.error(`⚠️ ask ${opened.ask.id} 测试类扩围快路未判成，按原路通知 PM：${(e as Error).message}`);
    return null;
  } finally { if (writer && writer !== db) writer.close(); }
}

/** 批准时转告执行者的「为什么现在批」 */
export const testScopeWhy = (a: Ask): string => isTestScopeFast(a) ? "被规格替代的旧断言，按快路（askScopeTests）" : "PM 15 分钟没回，";

/** 快路批准：卡上记一条 note（op ask_scope_tests）；在 closeIfDue 结案的事务里调 */
export function noteTestScopeFast(db: Database, a: Ask, now: number): void {
  if (!isTestScopeFast(a) || !a.taskId) return;
  appendEvent(db, { actor: "system:ask-default", dedupKey: `ask-scope-tests:${a.id}`, now }, { project: a.project, target: a.taskId, kind: "note",
    text: `${a.taskId} 提问 ask ${a.id} 测试类扩围（被规格替代的旧断言）按快路自动批准：${(a.extra.files as string[]).join("、")}；交付按尺寸核`,
    data: { op: "ask_scope_tests", askId: a.id, orderId: a.extra.orderId ?? null, files: a.extra.files } });
}
