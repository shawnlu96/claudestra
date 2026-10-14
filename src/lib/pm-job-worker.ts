/**
 * PM 处理员的一次性 worker（agents-PMJOB1）：独立于 bridge 的进程（入口 src/manager/pm-job-worker.ts，由调度服务起），
 * 逐单认领（锁 + 租约，上限 1）→ 额度门 → 共享 Codex 槽位 → 一次全新的只读 runCodex → 代码核对输出 → 草稿与结果原子落盘。
 * 它不发任何消息、不碰台账：结果只写进单子文件，投递由 bridge 扫单时做。超时 / 失败 / 额度异常不重试，写成要升级的草稿。
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { runCodex, type CodexResult, type CodexRunOpts } from "./codex.js";
import { pmJobQuotaGate, type PmJobQuotaGate } from "./pm-job-quota.js";
import { judgePmJobOutput } from "./pm-job-rules.js";
import { acquireCodexSlot, type CodexSlotHandle } from "./pm-job-slots.js";
import { PmJobStore } from "./pm-job-store.js";
import { pmJobDraft, pmJobPrompt } from "./pm-job-text.js";
import type { PmJob, PmJobResult, PmJobUsage } from "./pm-job-types.js";

const PM_JOB_TIMEOUT_MS = 5 * 60_000;
const PM_JOB_LEASE_MS = 90_000;

export interface PmJobWorkerDeps {
  store: PmJobStore;
  now(): number;
  pid: number;
  run(opts: CodexRunOpts): Promise<CodexResult>;
  quota(project: string): Promise<PmJobQuotaGate>;
  slot(): Promise<CodexSlotHandle | null>;
  /** 读不到 = null */
  read(path: string): string | null;
  timeoutMs: number;
  leaseMs: number;
}

const readSoft = (path: string): string | null => { try { return readFileSync(path, "utf8"); } catch { return null; } };
const pmJobWorkerDeps = (): PmJobWorkerDeps => ({
  store: new PmJobStore(), now: Date.now, pid: process.pid, run: runCodex, quota: (p) => pmJobQuotaGate(p), slot: () => acquireCodexSlot("pm-job"),
  read: readSoft, timeoutMs: PM_JOB_TIMEOUT_MS, leaseMs: PM_JOB_LEASE_MS,
});

export const specHashOf = (text: string): string => createHash("sha256").update(text).digest("hex");
const escalated = (reason: string): PmJobResult => ({ verdict: "escalate", type: "unknown", answer: "", evidence: [], reason, pending: [] });
const interrupted = (job: PmJob) => {
  const result = escalated("处理员进程中断，没有结果（不重跑）");
  return { result, draft: pmJobDraft({ ...job, state: "drafted", result }) };
};

/** 批准路径里的仓库相对文件（或规格文件本身：按这次跑的那份规格）有多少行；越出仓库 / 不在批准路径 / 读不到 = null */
function approvedLines(job: Pick<PmJob, "repoDir" | "paths" | "specPath">, spec: string, file: string, read: PmJobWorkerDeps["read"]): number | null {
  const count = (text: string | null) => (text === null ? null : text.split("\n").length);
  if (file === job.specPath) return count(spec);
  if (!file || isAbsolute(file) || file.split(/[\\/]/).some((s) => s === ".." || s === "." || !s)) return null;
  if (!job.paths.some((p) => p === file || new Bun.Glob(p).match(file))) return null;
  const full = join(job.repoDir, file);
  try {
    const rel = relative(realpathSync(job.repoDir), realpathSync(full));
    if (!rel || isAbsolute(rel) || rel.split(sep)[0] === "..") return null; // 软链指到仓库外的不算
  } catch { return null; }
  return count(read(full));
}

async function answer(job: PmJob, d: PmJobWorkerDeps): Promise<{ result: PmJobResult; usage?: PmJobUsage }> {
  // 有接单时的快照就用快照跑（PM 答问时追加的「PM 补」不再让草稿落空）；没快照的旧单子照旧读文件、核哈希
  const spec = job.spec ?? d.read(job.specPath);
  if (spec === null) return { result: escalated("规格文件读不到") };
  if (job.spec === undefined && specHashOf(spec) !== job.specHash) return { result: escalated("规格在提问之后改过") };
  const prompt = pmJobPrompt(job, spec);
  // 一次全新会话：不带 thread（不 resume）、只读沙箱、不加载全局 MCP
  const r = await d.run({ prompt, cwd: job.repoDir, sandbox: "read-only", timeoutMs: d.timeoutMs, isolateMcp: true });
  const usage: PmJobUsage = { requests: 1, elapsedMs: r.elapsedMs, promptChars: prompt.length, answerChars: r.ok ? r.message.length : 0 };
  if (!r.ok) return { result: escalated(`处理员运行失败：${r.message.slice(0, 300)}`), usage };
  const specLines = spec.split("\n");
  return { result: judgePmJobOutput(r.message, {
    forbidden: job.forbidden, ...(job.forbiddenAll ? { gates: { all: job.forbiddenAll, hard: job.hard === true } } : {}),
    lines: (f) => approvedLines(job, spec, f, d.read), specPath: job.specPath, specLine: (n) => (n >= 1 && n <= specLines.length ? specLines[n - 1]! : null),
  }), usage };
}

/** 一单：额度不够 / 不明不上模型；槽位满就放回队列（返回 false，这轮不再领）；其余都写出 drafted */
async function work(job: PmJob, token: string, d: PmJobWorkerDeps): Promise<boolean> {
  const finish = (result: PmJobResult, usage?: PmJobUsage) => d.store.finish(job.askId, token, d.now(), result, usage, pmJobDraft);
  const quota = await d.quota(job.project).catch((e: Error): PmJobQuotaGate => ({ ok: false, kind: "unknown", reason: `额度核对出错：${e.message.slice(0, 200)}` }));
  if (!quota.ok) return finish(escalated(`${quota.reason}，处理员未启动`)).then(() => true);
  const slot = await d.slot().catch(() => null); // 槽位状态读写出错按没拿到算，放回队列
  if (!slot) return d.store.requeue(job.askId, token, d.now()).then(() => false);
  const beat = setInterval(() => void d.store.renew(job.askId, token, d.now(), d.leaseMs).catch(() => { /* 这次续租没写上：下一拍再续，过期则由下次认领记成中断 */ }), Math.max(50, Math.floor(d.leaseMs / 3)));
  try {
    const out = await answer(job, d).catch((e: Error) => ({ result: escalated(`处理员出错：${e.message.slice(0, 300)}`), usage: undefined }));
    await finish(out.result, out.usage);
    return true;
  } finally {
    clearInterval(beat);
    await slot.release().catch(() => { /* 归还没写上：到期 / 进程退出后自动回收 */ });
  }
}

/** 领到没单为止；返回处理了几单。任何一单抛错（落盘失败）就停：单子留在 running，租约过期后由下一次认领记成中断、bridge 超时升级 */
export async function runPmJobWorker(deps: Partial<PmJobWorkerDeps> = {}): Promise<number> {
  const d = { ...pmJobWorkerDeps(), ...deps }, token = `${d.pid}.${d.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
  let done = 0;
  for (;;) {
    const job = await d.store.claim(d.now(), { token, pid: d.pid, ms: d.leaseMs }, interrupted);
    if (!job) return done;
    if (!(await work(job, token, d))) return done;
    done++;
  }
}
