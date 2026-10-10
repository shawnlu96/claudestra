/** Official borrower-side read-only git/GitHub probes; provider journal evidence stays on the provider. */
import type { WriteProbe } from "./lend-write-materials.js";
import type { ReborrowSourceProbe } from "./lend-reborrow-source.js";
import { ghEnv } from "./peer-pr-github.js";
import { runBounded } from "./run-bounded.js";
import { labGitRoot } from "./lend-git.js";
import { join } from "node:path";

export function reborrowSourceProbe(write: WriteProbe): ReborrowSourceProbe {
  const gh = (args: string[]) => runBounded(["gh", ...args], { env: ghEnv(process.env), timeoutMs: 60_000 });
  return {
    async read(f) {
      const { peer, repo, branch } = f.lease;
      const fp = await write.peerFp(peer), remote = await write.remoteHead(repo, branch);
      if (!fp || !remote.ok) return null;
      const result = await gh(["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json",
        "number,url,headRefName,headRefOid,baseRefName,isCrossRepository"]);
      if (result.code !== 0 || result.timedOut) return null;
      const rows = JSON.parse(result.stdout) as Record<string, unknown>[];
      if (!Array.isArray(rows) || rows.length > 1) return null;
      const p = rows[0];
      if (p && (p.isCrossRepository !== false || typeof p.number !== "number" || typeof p.url !== "string" ||
        typeof p.headRefName !== "string" || typeof p.headRefOid !== "string" || typeof p.baseRefName !== "string")) return null;
      return { peer, fp, repo, branch, remoteHead: remote.head, pr: p ? { number: p.number as number, url: p.url as string,
        repo, branch: p.headRefName as string, head: p.headRefOid as string, base: p.baseRefName as string } : null };
    },
    async isAncestor(repo, from, to) {
      const lab = labGitRoot();
      if (lab) {
        const r = await runBounded(["git", "--git-dir", join(lab, `${repo}.git`), "merge-base", "--is-ancestor", from, to], { timeoutMs: 15_000 });
        return r.code === 0 ? true : r.code === 1 ? false : null;
      }
      const r = await gh(["api", `repos/${repo}/compare/${from}...${to}`, "--jq", ".status"]);
      return r.code === 0 && !r.timedOut ? ["ahead", "identical"].includes(r.stdout.trim()) : null;
    },
  };
}
