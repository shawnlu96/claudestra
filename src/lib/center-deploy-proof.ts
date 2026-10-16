/** Resolve the registered private checkout and hash the script from the fetched commit, without publishing git output. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { repoDirFor } from "./card-repo.js";
import { runBounded } from "./run-bounded.js";
import { centerScriptPath, type CenterDeployConfig } from "./center-deploy-config.js";

export interface CenterProof { project: string; repo: string; sha: string; scriptDigest: string; cards: string[] }
export interface CenterProofPorts { run?: typeof runBounded; repoDir?: typeof repoDirFor }
export const scriptDigest = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
export const centerConfigVersion = (cfg: CenterDeployConfig): string => scriptDigest(JSON.stringify(cfg));

export async function centerProof(project: string, cfg: CenterDeployConfig, cards: string[], ports: CenterProofPorts = {}): Promise<CenterProof> {
  const dir = (ports.repoDir ?? repoDirFor)(project, cfg.repo);
  if (!dir) throw new Error("中心部署私仓未登记");
  const script = centerScriptPath(cfg.script), run = ports.run ?? runBounded;
  const git = async (...args: string[]) => {
    const r = await run(["git", "-C", dir, ...args], { timeoutMs: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "" } });
    if (r.code !== 0 || r.timedOut || r.truncated) throw new Error("中心部署版本核对失败");
    return r.stdout;
  };
  await git("fetch", "--quiet", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main");
  const sha = (await git("rev-parse", "refs/remotes/origin/main")).trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("中心部署版本无效");
  const mode = (await git("ls-tree", sha, "--", script)).split(/\s/)[0];
  if (mode !== "100755" && mode !== "100644") throw new Error("中心部署脚本不是普通仓内文件");
  return { project, repo: cfg.repo, sha, scriptDigest: scriptDigest(await git("show", `${sha}:${script}`)), cards: [...new Set(cards)].sort() };
}

/** The executable bytes must still be the authorized blob; symlinks escaping the checkout are refused. */
export function verifyCenterScript(dir: string, script: string, digest: string): void {
  const root = realpathSync(dir), path = realpathSync(join(root, centerScriptPath(script))), rel = relative(root, path);
  if (!rel || rel.startsWith("..") || scriptDigest(readFileSync(path)) !== digest) throw new Error("中心部署脚本已变更");
}
