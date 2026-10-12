// 复用回执的汇总核对（merge-arch-REUSE1，ci.yml 的 check 作业）。用法：
//   bun scripts/ci-proof-reuse-verify.ts <回执工件目录>
// 目录里没有回执 = 本次运行每项检查都实际执行过，直接通过。有回执时逐份再核一遍（lib 的 ciProofReuseProblems，与合并侧证明验证器同一个函数）：
// 回执属于写下它的那次 run / attempt（第 1 片的 run.json）、绑定的是 check 作业自己检出算出的 tree / base / 锁文件 / workflow / guard 基准、检查在批准范围内，
// 并经 API 把原 run 重新读回来核一次。核出问题就红：那项检查这次既没执行、也没有站得住的复用。API 读不到（网络 / 限流）不算问题，
// 只给警告、离线部分照核——查询失败不能打断合并路径；合并侧读取端（lib 的 readCiRunReuse）读不回则按问题拒，不沿用这里的宽松。
// 撤销名单（CI_PROOF_REUSE_REVOKED）不需要 API：原 run 在名单里就红，与读不读得回无关。tests/ci-proof-reuse.test.ts。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CI_PROOF_REUSE_ARTIFACT, CI_PROOF_REUSE_WORKFLOW, CI_REUSE_GUARD_BASELINE, type CiReuseOrigin, type CiReuseReceipt, type CiReuseSubject,
  ciProofReuseProblems, ciReuseDigest, ciReuseReceiptProblems, readCiReuseReceiptOrigin,
} from "../src/lib/ci-proof-reuse.ts";
import { githubDeps, revokedRuns, RUN_FILE } from "./ci-proof-reuse.ts";

export interface VerifyInput {
  subject: CiReuseSubject;
  run: { runId: number; attempt: number };
  /** 文件名 → 解出来的值（坏 JSON 是 null）。 */
  receipts: Map<string, unknown>;
  revokedRuns: number[];
  /** 把一份回执的原 run 重新读回来；读不到就抛。 */
  origin(receipt: CiReuseReceipt): Promise<CiReuseOrigin>;
}

/** errors 非空 = 红；warnings 只是原 run 这次读不到。 */
export async function verifyReceipts(input: VerifyInput): Promise<{ errors: string[]; warnings: string[]; verified: string[] }> {
  const errors: string[] = [], warnings: string[] = [], verified: string[] = [], origins: CiReuseOrigin[] = [], online: unknown[] = [];
  for (const [file, raw] of input.receipts) {
    const { receipt, id, problems } = ciReuseReceiptProblems(input.subject, input.run, raw, input.revokedRuns);
    if (!receipt) { errors.push(`${file}：${problems.join("；")}`); continue; }
    // 撤销名单是本地确定的事实：联网之前先核，原 run 读得回读不回都拒，不落到下面"读不回只警告"的那一支
    if (input.revokedRuns.includes(receipt.origin.runId)) { errors.push(...problems); continue; }
    try {
      origins.push(await input.origin(receipt));
      online.push(raw);
      verified.push(`${id} ← run ${receipt.origin.runId} attempt ${receipt.origin.attempt}`);
    } catch (e) {
      warnings.push(`${id} 的原 run ${receipt.origin.runId} 这次读不回来（${(e as Error).message}），只核了回执本身`);
      errors.push(...problems);
    }
  }
  const all = [...input.receipts.values()];
  // 读回来的那些走完整核对（含回执本身与重复回执）；一份都没读回来时重复回执仍要拦
  errors.push(...ciProofReuseProblems(input.subject, input.run, { artifact: { ...input.run, receipts: online }, origins, revokedRuns: input.revokedRuns }));
  const ids = all.map((raw) => ciReuseReceiptProblems(input.subject, input.run, raw, input.revokedRuns).receipt?.inputs.check.id).filter(Boolean);
  if (online.length !== all.length && new Set(ids).size !== ids.length) errors.push("同一项检查有多份回执");
  return { errors: [...new Set(errors)], warnings, verified };
}

/**
 * 回执要绑定的 run / attempt：第 1 片写下的 run.json。只重跑失败作业时第 1 片可能留在更早的 attempt，所以 attempt 可以小于本次，
 * 但必须是同一个 run；缺了它或对不上时回执不可信（返回原因）。
 */
export function writerRun(marker: unknown, runId: number, attempt: number): { runId: number; attempt: number } | string {
  const m = typeof marker === "object" && marker !== null ? marker as Record<string, unknown> : {};
  if (!Number.isSafeInteger(m.runId) || !Number.isSafeInteger(m.attempt)) return `有回执却没有合法的 ${RUN_FILE}，认不出是哪次 attempt 写的`;
  if (m.runId !== runId || (m.attempt as number) < 1 || (m.attempt as number) > attempt) return `回执目录由 run ${m.runId} attempt ${m.attempt} 写下，不属于本次 run ${runId} attempt ${attempt}`;
  return { runId, attempt: m.attempt as number };
}

function git(...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}：${r.stderr.toString().trim().slice(0, 200)}`);
  return r.stdout.toString().trim();
}

async function main(args: string[]): Promise<number> {
  const dir = args[0], env = process.env;
  if (!dir) { console.error("用法：bun scripts/ci-proof-reuse-verify.ts <回执工件目录>"); return 1; }
  const from = join(dir, CI_PROOF_REUSE_ARTIFACT);
  const names = existsSync(from) ? readdirSync(from).filter((n) => n.endsWith(".json") && n !== RUN_FILE).sort() : [];
  if (!names.length) { console.log("复用：本次运行没有复用回执，每项检查都实际执行过"); return 0; }
  const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return null; } }; // 坏 JSON 读作 null，回执解析按非法拒
  const run = writerRun(existsSync(join(from, RUN_FILE)) ? parse(readFileSync(join(from, RUN_FILE), "utf8")) : null, Number(env.GITHUB_RUN_ID), Number(env.GITHUB_RUN_ATTEMPT));
  if (typeof run === "string") { console.log(`::error title=ci-proof-reuse::${run}`); return 1; }
  const digest = (path: string) => ciReuseDigest(readFileSync(path, "utf8")), api = githubDeps(env, env.RUNNER_TEMP || dir);
  const r = await verifyReceipts({
    subject: { repo: env.GITHUB_REPOSITORY ?? "", base: env.REUSE_BASE ?? "", tree: git("rev-parse", "HEAD^{tree}"), bun: Bun.version, lockfileDigest: digest("bun.lock"),
      workflowDigest: digest(CI_PROOF_REUSE_WORKFLOW), guardBaseline: digest(CI_REUSE_GUARD_BASELINE) },
    run,
    receipts: new Map(names.map((n) => [n, parse(readFileSync(join(from, n), "utf8"))] as const)),
    revokedRuns: revokedRuns(env.CI_PROOF_REUSE_REVOKED), origin: (r) => readCiReuseReceiptOrigin(r, api),
  });
  r.warnings.forEach((w) => console.log(`::warning title=ci-proof-reuse::${w}`));
  r.errors.forEach((e) => console.log(`::error title=ci-proof-reuse::${e}`));
  if (r.errors.length) return 1;
  console.log(`复用：${names.length} 份回执核对通过 · ${r.verified.join(" · ") || "原 run 未读回，仅核回执本身"} · 复用的只是这几项静态检查，测试与 guard 照旧实际执行`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
