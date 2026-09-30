/**
 * What the deploy job does, in the order of the PM's deploy script: bring the main tree to origin/main (it must contain the merge),
 * `web-release deploy`, the relay only when the pulled commits touch web / relay code (a relay restart drops every connection,
 * peers included), then restart the four daemons. Checking the result is `ledger verify`, run by the scheduler afterwards.
 * Every step first re-checks the job's maintenance lease and the deadline: a job that lost its lease stops, it never goes on.
 * Machine-specific parts (relay command, labels) come from scheduler.json. Tests: tests/scheduler-deploy-steps.test.ts.
 */
import { resolveBunPath } from "./bun-path.js";
import type { BoundedResult, runBounded } from "./run-bounded.js";

export interface StepsInput {
  repoDir: string; mergeSha: string; relayArgv: string[] | null; restartLabels: string[];
  env: Record<string, string>; uid: number; deadline: number;
}
interface StepRecord { step: string; code: number | null; timedOut: boolean; ms: number; tail: string }
export interface StepsOutcome {
  ok: boolean; summary: string; steps: StepRecord[]; relay: "ran" | "failed" | "not_needed" | "not_configured"; head: string | null;
}

/** Same rule as the PM's deploy script: web, relay server, relay deploy scripts and the bridge-side relay client. */
const RELAY_PATHS = /^(web\/|src\/relay\/|src\/relay\.ts$|deploy\/relay\/|src\/lib\/relay-)/;
export const needsRelay = (files: readonly string[]): boolean => files.some((f) => RELAY_PATHS.test(f));

class Stop extends Error {}

export async function runDeploySteps(input: StepsInput, run: typeof runBounded, held: () => boolean, now: () => number = Date.now): Promise<StepsOutcome> {
  const steps: StepRecord[] = [];
  const env = { ...input.env, DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "", GIT_TERMINAL_PROMPT: "0", CLAUDESTRA_MERGE_SHA: input.mergeSha };
  const exec = async (step: string, argv: string[], timeoutMs: number): Promise<BoundedResult> => {
    if (!held()) throw new Stop(`维护租约已失，${step} 之前停下`);
    if (now() > input.deadline) throw new Stop(`超过部署截止时间，${step} 之前停下`);
    const t0 = now();
    const r = await run(argv, { cwd: input.repoDir, env, timeoutMs: Math.max(1000, Math.min(timeoutMs, input.deadline - t0)) });
    steps.push({ step, code: r.code, timedOut: r.timedOut, ms: now() - t0, tail: (r.stderr || r.stdout).trim().slice(-600) });
    return r;
  };
  const must = async (step: string, argv: string[], timeoutMs = 120_000): Promise<string> => {
    const r = await exec(step, argv, timeoutMs);
    if (r.code !== 0 || r.timedOut) throw new Stop(`${step} 失败（${r.timedOut ? "超时" : `exit ${r.code}`}）`);
    return r.stdout.trim();
  };
  const git = (...args: string[]) => ["git", "-C", input.repoDir, ...args];
  let relay: StepsOutcome["relay"] = "not_needed", head: string | null = null;
  try {
    if (await must("branch", git("rev-parse", "--abbrev-ref", "HEAD")) !== "main") throw new Stop("主树不在 main 分支，不动它");
    if (await must("clean", git("status", "--porcelain", "--untracked-files=no"))) throw new Stop("主树有未提交改动，不拉代码");
    const before = await must("head-before", git("rev-parse", "HEAD"));
    await must("fetch", git("fetch", "--quiet", "origin", "main"));
    if ((await exec("merge-in-origin", git("merge-base", "--is-ancestor", input.mergeSha, "origin/main"), 60_000)).code !== 0) {
      throw new Stop("origin/main 不含合并提交");
    }
    await must("pull", git("merge", "--ff-only", "--quiet", "origin/main"));
    head = await must("head-after", git("rev-parse", "HEAD"));
    await must("web-release", [resolveBunPath(), "src/manager.ts", "web-release", "deploy"], 25 * 60_000);
    const pulled = await must("diff-pulled", git("diff", "--name-only", before, head));
    const merged = await must("diff-merge", git("diff", "--name-only", `${input.mergeSha}^1`, input.mergeSha));
    if (needsRelay([...pulled.split("\n"), ...merged.split("\n")].filter(Boolean))) {
      relay = input.relayArgv ? ((await exec("relay", input.relayArgv, 25 * 60_000)).code === 0 ? "ran" : "failed") : "not_configured";
    }
    // Each daemon is restarted even if an earlier one failed: half-restarted services would run mixed code.
    const failedRestarts: string[] = [];
    for (const label of input.restartLabels) {
      const r = await exec(`restart ${label}`, ["/bin/launchctl", "kickstart", "-k", `gui/${input.uid}/${label}`], 30_000);
      if (r.code !== 0 || r.timedOut) failedRestarts.push(label);
    }
    const problems = [...(relay === "failed" ? ["中继部署失败"] : []), ...(failedRestarts.length ? [`重启失败：${failedRestarts.join(", ")}`] : [])];
    const summary = problems.length ? problems.join("；") : `部署到 ${head.slice(0, 12)}，中继 ${relay}，重启 ${input.restartLabels.length} 个服务`;
    return { ok: problems.length === 0, summary, steps, relay, head };
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    return { ok: false, summary: e.message, steps, relay, head };
  }
}
