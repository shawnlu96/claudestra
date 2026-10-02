/**
 * GitHub calls of the merge train, all server-side through `gh` argv (never a shell string, never a local fetch or worktree):
 * refs + merges API build the train branch, a draft PR triggers CI (ci.yml runs on any pull_request).
 * Branch writes refuse anything outside `train/` here as well as in the engine. tests/scheduler-merge-train-gh.test.ts.
 */
import { runBounded } from "./run-bounded.js";
import { repoOfPr, TRAIN_BRANCH, type TrainCheck, type TrainGh } from "./scheduler-merge-train.js";

const SHA = /^[a-f0-9]{40}$/i;
/** GitHub lists at most 3000 files per PR; at the cap the list may be cut, and a cut list could hide an overlap. */
export const PR_FILES_CAP = 3000;
const oneLine = (s: string) => s.trim().split("\n")[0]?.slice(0, 300) ?? "";
const prNumber = (prRef: string): string => {
  const n = /\/pull\/(\d+)\/?$/.exec(prRef)?.[1];
  if (!n) throw new Error("PR URL 不合法");
  return n;
};
const ownBranch = (branch: string): string => {
  if (!TRAIN_BRANCH.test(branch)) throw new Error(`拒绝操作非列车分支：${branch}`);
  return branch;
};
const sha = (out: string, what: string): string => {
  const v = out.trim();
  if (!SHA.test(v)) throw new Error(`${what} 没给出完整 SHA`);
  return v;
};

export function trainGh(command: typeof runBounded = runBounded): TrainGh {
  const env = { ...process.env, DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "", GIT_TERMINAL_PROMPT: "0" };
  const raw = (args: string[], timeoutMs = 120_000) => command(["gh", ...args], { env, timeoutMs });
  const gh = async (...args: string[]) => {
    const r = await raw(args);
    if (r.code !== 0 || r.timedOut) throw new Error(`gh ${args[0]} ${args[1] ?? ""} 失败：${oneLine(r.stderr) || `exit ${r.code ?? "timeout"}`}`);
    return r.stdout;
  };
  const missing = (stderr: string) => /\b(404|422)\b|Not Found|Reference does not exist/i.test(stderr);
  return {
    async mainHead(repo) { return sha(await gh("api", `repos/${repo}/git/ref/heads/main`, "--jq", ".object.sha"), "main"); },
    async prFiles(prRef) {
      const out = await gh("api", "--paginate", `repos/${repoOfPr(prRef)}/pulls/${prNumber(prRef)}/files`, "--jq",
        ".[] | .filename, (.previous_filename // empty)");
      const files = out.split("\n").map((l) => l.trim()).filter(Boolean);
      return files.length >= PR_FILES_CAP ? null : files;
    },
    async prHead(prRef) { return sha(await gh("api", `repos/${repoOfPr(prRef)}/pulls/${prNumber(prRef)}`, "--jq", ".head.sha"), "PR head"); },
    async createBranch(repo, branch, at) {
      ownBranch(branch);
      const r = await raw(["api", "-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${sha(at, "起点")}`]);
      if (r.code === 0 && !r.timedOut) return;
      if (!/already exists/i.test(r.stderr)) throw new Error(`建列车分支失败：${oneLine(r.stderr) || `exit ${r.code ?? "timeout"}`}`);
      await gh("api", "-X", "PATCH", `repos/${repo}/git/refs/heads/${branch}`, "-f", `sha=${at}`, "-F", "force=true");
    },
    async mergeInto(repo, branch, head, message) {
      const r = await raw(["api", "-X", "POST", `repos/${repo}/merges`, "-f", `base=${ownBranch(branch)}`, "-f", `head=${sha(head, "成员 head")}`,
        "-f", `commit_message=${message}`]);
      if (r.code === 0 && !r.timedOut) return "merged"; // 201 merged, 204 already contained
      if (/\b409\b|merge conflict/i.test(r.stderr)) return "conflict";
      throw new Error(`拼车合并失败：${oneLine(r.stderr) || `exit ${r.code ?? "timeout"}`}`);
    },
    async openDraft(repo, branch, title, body) {
      const owner = repo.split("/")[0];
      const found = (await gh("api", `repos/${repo}/pulls?head=${owner}:${ownBranch(branch)}&state=open`, "--jq", ".[0].number // empty")).trim();
      const n = found || (await gh("api", "-X", "POST", `repos/${repo}/pulls`, "-f", `head=${branch}`, "-f", "base=main", "-f", `title=${title}`,
        "-f", `body=${body}`, "-F", "draft=true", "--jq", ".number")).trim();
      if (!/^\d+$/.test(n)) throw new Error("开列车 draft PR 没拿到 PR 号");
      return Number(n);
    },
    async checks(repo, pr) {
      const r = await raw(["pr", "checks", String(pr), "-R", repo, "--json", "bucket,name,link"], 30_000);
      if (r.timedOut) throw new Error("gh pr checks 超时");
      if (!r.stdout.trim()) {
        if (/no checks reported/i.test(r.stderr)) return []; // CI not registered yet: pending, the CI timeout bounds the wait
        throw new Error(`gh pr checks 无结果：${oneLine(r.stderr)}`);
      }
      const list = JSON.parse(r.stdout) as unknown; // exit 8 = pending, still valid JSON
      if (!Array.isArray(list) || list.some((c) => !c || typeof c.name !== "string" ||
        !["pass", "fail", "pending", "skipping", "cancel"].includes(String(c.bucket)))) throw new Error("gh pr checks 输出无效");
      return list as TrainCheck[];
    },
    async failLog(repo, link) {
      const run = /\/actions\/runs\/(\d+)/.exec(link)?.[1];
      if (!run) return "";
      const out = await gh("run", "view", run, "-R", repo, "--log-failed");
      // Lines are "<job>\t<step>\t<timestamp> <text>"; the tail is where the failure is.
      return out.split("\n").map((l) => l.split("\t").at(-1)!.replace(/^\S+Z\s/, "").trim()).filter(Boolean).slice(-6).join(" | ");
    },
    async parents(repo, at) {
      const list = JSON.parse(await gh("api", `repos/${repo}/commits/${sha(at, "提交")}`, "--jq", "[.parents[].sha]")) as unknown;
      if (!Array.isArray(list) || list.some((p) => typeof p !== "string" || !SHA.test(p))) throw new Error("提交父节点无效");
      return list as string[];
    },
    async mergeMatchHead(prRef, head) {
      repoOfPr(prRef);
      await gh("pr", "merge", prRef, "--merge", "--match-head-commit", sha(head, "审查 head"));
      return sha(await gh("pr", "view", prRef, "--json", "mergeCommit", "--jq", ".mergeCommit.oid"), "合并提交");
    },
    async closePr(repo, pr) { await gh("api", "-X", "PATCH", `repos/${repo}/pulls/${pr}`, "-f", "state=closed"); },
    async deleteBranch(repo, branch) {
      const r = await raw(["api", "-X", "DELETE", `repos/${repo}/git/refs/heads/${ownBranch(branch)}`]);
      if ((r.code !== 0 || r.timedOut) && !missing(r.stderr)) throw new Error(`删列车分支失败：${oneLine(r.stderr) || `exit ${r.code ?? "timeout"}`}`);
    },
  };
}
