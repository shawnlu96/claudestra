/** gh commands are structured argv, never interpolated into a shell string. */
import { createHash } from "node:crypto";
import { runBounded } from "./run-bounded.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import type { MergeExternal, PrSnapshot, ReviewCarry } from "./scheduler-merge-driver.js";
import { trainContext, withMergeTrain } from "./scheduler-merge-train-tick.js";

type ProjectSchedule = SchedulerConfig["projects"][string];

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
const SHA = /^[a-f0-9]{40}$/i;
const repoOf = (prRef: string): string => {
  const repo = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+\/?$/.exec(prRef)?.[1];
  if (!repo) throw new Error("PR URL 不合法");
  return repo;
};
/** runBounded silently stops reading at 1 MiB; anything near that may be cut, and two cut diffs could compare equal. */
const DIFF_LIMIT = 900 * 1024;
const MAIN_REF = "refs/remotes/origin/main";

/** External data is bounded and checked before it can become a durable receipt. */
export function mergeExternal(project: ProjectSchedule, command: typeof runBounded = runBounded): MergeExternal {
  const cwd = project.repoDir;
  const run = async (argv: string[], timeoutMs = 120_000) => {
    const r = await command(argv, { cwd, env: { ...process.env, DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "", GIT_TERMINAL_PROMPT: "0" }, timeoutMs });
    if (r.code !== 0 || r.timedOut) throw new Error(`${argv[0]} 失败：${oneLine(r.stderr) || `exit ${r.code ?? "timeout"}`}`);
    return r.stdout;
  };
  const gh = (...args: string[]) => run(["gh", ...args]);
  const git = (...args: string[]) => run(["git", ...args]);
  /** Net diff exactly as `git diff main...head` prints it, with every knob that could vary between calls pinned. */
  const netDiff = async (head: string) => {
    const out = await git("-c", "core.quotePath=true", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames",
      "--binary", "--full-index", `${MAIN_REF}...${head}`);
    if (Buffer.byteLength(out) >= DIFF_LIMIT) throw new Error("净 diff 太大，无法逐字核对");
    return out;
  };
  return withMergeTrain({ // the merge train only adds a gate + a head-pinned merge for members it verified
    async inspect(prRef): Promise<PrSnapshot> {
      const repo = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+\/?$/.exec(prRef)?.[1];
      if (!repo) throw new Error("PR URL 不合法");
      const local = parsed(await gh("repo", "view", "--json", "nameWithOwner"), "gh repo view");
      if (String(local.nameWithOwner).toLowerCase() !== repo.toLowerCase()) throw new Error("repoDir 仓库与 PR 仓库不一致");
      const raw = parsed(await gh("pr", "view", prRef, "--json",
        "state,headRefOid,headRefName,baseRefName,isDraft,isCrossRepository,mergeStateStatus,mergeCommit"), "gh pr view");
      const state = String(raw.state);
      if (!["OPEN", "MERGED", "CLOSED"].includes(state) || typeof raw.headRefOid !== "string") throw new Error("PR 状态或 head 无效");
      let checks: PrSnapshot["checks"] = [];
      if (state === "OPEN" && raw.isDraft !== true) {
        const checkRun = await command(["gh", "pr", "checks", prRef, "--json", "bucket,name,link"],
          { cwd, env: { ...process.env, DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "", GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 30_000 });
        // A conflicted PR gets no CI run, and right after main moves GitHub reports UNKNOWN before it knows; only those states
        // (seen in the same view) read "no checks" as an empty list. The driver bounces DIRTY and waits out UNKNOWN (bounded).
        const noChecksYet = !checkRun.timedOut && !checkRun.stdout.trim() && ["DIRTY", "UNKNOWN"].includes(String(raw.mergeStateStatus));
        if (!noChecksYet && (checkRun.timedOut || !checkRun.stdout.trim())) throw new Error(`gh pr checks 无结果：${oneLine(checkRun.stderr)}`);
        const list = noChecksYet ? [] : JSON.parse(checkRun.stdout) as unknown; // gh exits 8 for pending checks while still returning valid JSON
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
    async freshness(prRef, head) {
      if (!SHA.test(head)) throw new Error("head 无效");
      const raw = parsed(await gh("api", `repos/${repoOf(prRef)}/compare/main...${head}`, "--jq",
        "{behind: .behind_by, main: .base_commit.sha}"), "gh compare");
      if (!Number.isSafeInteger(raw.behind) || (raw.behind as number) < 0 || typeof raw.main !== "string" || !SHA.test(raw.main)) {
        throw new Error("gh compare 未给出落后提交数或 main 头");
      }
      return { behindBy: raw.behind as number, mainHead: raw.main };
    },
    /** Local git, not the compare API: GitHub caps listed files and patches, and a truncated pair could hide a smuggled change. */
    async carryReview(prRef, oldHead, newHead): Promise<ReviewCarry> {
      repoOf(prRef);
      if (!SHA.test(oldHead) || !SHA.test(newHead)) return { ok: false, reason: "head 不是完整 SHA" };
      await git("fetch", "--no-tags", "--quiet", "origin", newHead, `+refs/heads/main:${MAIN_REF}`);
      const mainHead = (await git("rev-parse", "--verify", `${MAIN_REF}^{commit}`)).trim();
      const [self, ...parents] = (await git("rev-list", "--parents", "-n", "1", newHead)).trim().split(/\s+/);
      if (self?.toLowerCase() !== newHead.toLowerCase()) throw new Error("新 head 读不到");
      const others = parents.filter((p) => p.toLowerCase() !== oldHead.toLowerCase());
      if (parents.length !== 2 || others.length !== 1) return { ok: false, reason: `新 head 不是「原审查 head + main 提交」的合并提交（父提交 ${parents.length} 个）` };
      const mainParent = others[0]!;
      const onMain = await command(["git", "merge-base", "--is-ancestor", mainParent, MAIN_REF],
        { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 30_000 });
      if (onMain.timedOut || (onMain.code !== 0 && onMain.code !== 1)) throw new Error(`git merge-base 失败：${oneLine(onMain.stderr)}`);
      if (onMain.code !== 0) return { ok: false, reason: `另一个父提交 ${mainParent.slice(0, 12)} 不在 main 上` };
      const [before, after] = [await netDiff(oldHead), await netDiff(newHead)];
      if (before !== after) return { ok: false, reason: "合并 main 后 PR 对 main 的净 diff 变了" };
      return { ok: true, reason: "净 diff 一致", mainParent, mainHead, diffHash: createHash("sha256").update(after).digest("hex") };
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
  }, trainContext(command));
}
