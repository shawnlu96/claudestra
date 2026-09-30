/** gh and deployment commands are structured argv, never interpolated into a shell string. */
import { runBounded } from "./run-bounded.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import type { MergeExternal, PrSnapshot } from "./scheduler-merge-driver.js";
import type { MergeRun } from "./scheduler-merge.js";
import { deploymentJobs, type DeployJobs } from "./scheduler-deploy-job.js";

type ProjectSchedule = SchedulerConfig["projects"][string];
type ManagerCall = (...args: string[]) => Promise<Record<string, unknown>>;

const oneLine = (s: string) => s.trim().split("\n")[0]?.slice(0, 350) ?? "";
const parsed = (s: string, label: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(s);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch (e) {
    throw new Error(`${label} JSON 无效：${(e as Error).message}`);
  }
  throw new Error(`${label} 没有 JSON 对象`);
};

/** External data is bounded and checked before it can become a durable receipt. */
export function mergeExternal(project: ProjectSchedule, manager: ManagerCall, command: typeof runBounded = runBounded,
  jobs: DeployJobs = deploymentJobs()): MergeExternal {
  const cwd = project.deploy.cwd;
  const run = async (argv: string[], envExtra: Record<string, string> = {}, timeoutMs = 120_000) => {
    const r = await command(argv, { cwd, env: { ...process.env, DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "", GIT_TERMINAL_PROMPT: "0", ...envExtra }, timeoutMs });
    if (r.code !== 0 || r.timedOut) throw new Error(`${argv[0]} 失败：${oneLine(r.stderr) || `exit ${r.code ?? "timeout"}`}`);
    return r.stdout;
  };
  const gh = (...args: string[]) => run(["gh", ...args]);
  const envFor = (row: MergeRun) => ({ CLAUDESTRA_MERGE_SHA: row.mergeSha ?? "", CLAUDESTRA_PR_URL: row.prRef,
    CLAUDESTRA_TASK_ID: row.taskId });
  return {
    async inspect(prRef): Promise<PrSnapshot> {
      const repo = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+\/?$/.exec(prRef)?.[1];
      if (!repo) throw new Error("PR URL 不合法");
      const local = parsed(await gh("repo", "view", "--json", "nameWithOwner"), "gh repo view");
      if (String(local.nameWithOwner).toLowerCase() !== repo.toLowerCase()) throw new Error("部署仓库与 PR 仓库不一致");
      const raw = parsed(await gh("pr", "view", prRef, "--json",
        "state,headRefOid,headRefName,baseRefName,isDraft,isCrossRepository,mergeStateStatus,mergeCommit"), "gh pr view");
      const state = String(raw.state);
      if (!["OPEN", "MERGED", "CLOSED"].includes(state) || typeof raw.headRefOid !== "string") throw new Error("PR 状态或 head 无效");
      let checks: PrSnapshot["checks"] = [];
      if (state === "OPEN" && raw.isDraft !== true) {
        const checkRun = await command(["gh", "pr", "checks", prRef, "--json", "bucket,name"],
          { cwd, env: { ...process.env, DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "", GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 30_000 });
        if (checkRun.timedOut || !checkRun.stdout.trim()) throw new Error(`gh pr checks 无结果：${oneLine(checkRun.stderr)}`);
        const list = JSON.parse(checkRun.stdout) as unknown; // gh exits 8 for pending checks while still returning valid JSON
        if (!Array.isArray(list) || list.some((c) => !c || typeof c !== "object" ||
          !["pass", "fail", "pending", "skipping", "cancel"].includes(String((c as Record<string, unknown>).bucket)))) {
          throw new Error("gh pr checks 输出无效");
        }
        checks = list as PrSnapshot["checks"];
      }
      return { state: state as PrSnapshot["state"], head: raw.headRefOid, branch: String(raw.headRefName ?? ""), base: String(raw.baseRefName ?? ""),
        draft: raw.isDraft === true, crossRepository: raw.isCrossRepository !== false, mergeState: String(raw.mergeStateStatus ?? ""),
        mergeSha: typeof (raw.mergeCommit as { oid?: unknown } | null)?.oid === "string" ? (raw.mergeCommit as { oid: string }).oid : null,
        checks };
    },
    async updateBranch(prRef) { await gh("pr", "update-branch", prRef); },
    async merge(prRef, expectedHead) {
      const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/.exec(prRef);
      if (!match || !/^[a-f0-9]{40}$/i.test(expectedHead)) throw new Error("PR 或 expected head 无效");
      // GitHub REST merge rejects a changed head with 409; plain gh pr merge has no atomic head pin.
      const result = parsed(await gh("api", "-X", "PUT", `repos/${match[1]}/pulls/${match[2]}/merge`,
        "-f", `sha=${expectedHead}`, "-f", "merge_method=merge"), "gh merge API");
      if (result.merged !== true || typeof result.sha !== "string" || !/^[a-f0-9]{40}$/i.test(result.sha)) {
        throw new Error("GitHub 未确认合并提交");
      }
      return result.sha;
    },
    async deploy(row) { return jobs.submit(row, project.deploy); },
    async deployed(row) {
      const job = await jobs.observe(row);
      if (job.status !== "complete") return job;
      const result = parsed(await run(project.deploy.verifyArgv, envFor(row)), "deploy verify");
      if (result.ok !== true || result.mergeSha !== row.mergeSha || typeof result.receipt !== "string" ||
        result.receipt.length < 1 || result.receipt.length > 500 || /[\p{Cc}\p{Cf}]/u.test(result.receipt)) {
        return { status: "unknown", reason: "deployment receipt does not verify the exact merge SHA" };
      }
      return { status: "deployed", receipt: result.receipt };
    },
    async verifyLedger(row) {
      const r = await manager("ledger", "verify", row.taskId, "--dedup", `scheduler:${row.intentId}:verify`);
      if (r.ok !== true || (r.result !== "pass" && (r.event as { data?: { result?: string } } | undefined)?.data?.result !== "pass")) {
        throw new Error(`ledger verify 未通过：${String(r.error ?? r.result ?? "unknown").slice(0, 300)}`);
      }
      return `ledger verify ${row.taskId} pass`;
    },
  };
}
