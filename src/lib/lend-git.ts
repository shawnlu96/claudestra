/**
 * 出借写代码单（i28-R6）两侧共用的几条规矩：单子种类与出借角色的对应、出借分支的名字、仓库地址、查远端分支 head。
 * 分支名固定 `lend/<任务 id>-<出借方指纹前 4 位>`：A 挂单时按对方钉住的公钥算，B 领单时按自己的公钥再算一遍，对不上就不领；
 * B 只推这一个分支（lend-push.ts），A 只认这个分支上的 head（ledger-lend-deliver.ts）。
 * 仓库地址只有 GitHub：沙箱 lab 里（CLAUDESTRA_SANDBOX=1 且有 lab 根目录）换成 lab 根下 git/<owner>/<repo>.git 的本地 bare 仓库，
 * 生产环境这个分支永远走不到。tests/lend-write.test.ts。
 */
import { isAbsolute, join } from "node:path";
import { parseLsRemote, type RemoteHead } from "./order-deliver.js";
import type { BoundedResult } from "./run-bounded.js";
import { isSandbox } from "./sandbox.js";
import { LAB_ROOT_ENV } from "./sandbox-lab.js";

/** 出借单的步骤：review = 审查；write = 开工单（卡在 build）；fix = 修复单（卡在 fix） */
export const LEND_STEPS = ["review", "write", "fix"] as const;
export type LendStep = (typeof LEND_STEPS)[number];
export const WRITE_STEPS: readonly LendStep[] = ["write", "fix"];
export const isWriteStep = (s: string): boolean => (WRITE_STEPS as readonly string[]).includes(s);

/** 出借角色：审查单要 review，开工 / 修复单要 write（lend.json 两侧各自声明） */
export const roleOfStep = (step: string): "review" | "write" | null => (step === "review" ? "review" : isWriteStep(step) ? "write" : null);

/** 卡的阶段 → 这一阶段能挂出去的单；别的阶段借不出去 */
export const stepOfStage = (stage: string): LendStep | null => (stage === "review" ? "review" : stage === "build" ? "write" : stage === "fix" ? "fix" : null);

const FP = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){3}$/;
const TASK = /^[\w.-]{1,64}$/;
/** 出借分支的完整形状：前缀固定、任务 id 与台账同口径、结尾 4 位小写十六进制 */
export const LEND_BRANCH_RE = /^lend\/[\w.-]{1,64}-[0-9a-f]{4}$/;
/** 基线分支名：普通 git 分支名，不以 - 开头、没有 ..，不能是出借分支自己 */
const BASE_RE = /^(?!-)(?!.*\.\.)(?!lend\/)[\w./-]{1,100}$/;

export function lendBranch(taskId: string, fp: string): string | null {
  const f = fp.toLowerCase();
  if (!TASK.test(taskId) || !FP.test(f)) return null;
  return `lend/${taskId}-${f.slice(0, 4)}`;
}

export const isBaseBranch = (b: string): boolean => BASE_RE.test(b) && !b.endsWith("/") && !b.endsWith(".lock");

/** 沙箱 lab 的本地 bare 仓库根；不在 lab 里 = null（走 GitHub） */
export function labGitRoot(env: Record<string, string | undefined> = process.env): string | null {
  const root = (env[LAB_ROOT_ENV] || "").trim();
  return isSandbox(env) && root && isAbsolute(root) ? join(root, "git") : null;
}

/** 这个仓库拉取、推送、查 head 都用的地址（repo 已按 owner/repo 校验过） */
export function lendRepoUrl(repo: string, env: Record<string, string | undefined> = process.env): string {
  const lab = labGitRoot(env);
  return lab ? `file://${join(lab, `${repo}.git`)}` : `https://github.com/${repo}.git`;
}

type Runner = (argv: string[], o: { cwd?: string; env: Record<string, string>; timeoutMs: number }) => Promise<BoundedResult>;

/** 远端某个分支现在的 head：按地址直接查（A 本机不一定有这个仓库的 clone），不带凭据交互 */
export async function remoteHeadAt(repo: string, branch: string, run: Runner, env: Record<string, string | undefined> = process.env): Promise<RemoteHead> {
  const r = await run(["git", "ls-remote", lendRepoUrl(repo, env), `refs/heads/${branch}`], {
    env: { ...Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string")), GIT_TERMINAL_PROMPT: "0" },
    timeoutMs: 15_000,
  });
  return parseLsRemote(r, branch);
}
