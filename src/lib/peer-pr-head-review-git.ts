/**
 * merge-arch-PEERHEAD1 · how a peer PR's new head relates to the reviewed one, read from the peer repository (peer-prs.json repoDir)
 * by `ledger peer-pr-observe` before their transaction, never trusted from the caller. The tick fetched the new head
 * first (peer-pr-github.ts fetchHead). Any object missing = "missing"; a clean merge of a main commit into the old head = "main_merge"
 * (main-carry's own proof, scheduler-main-merge-carry.ts); otherwise "successor" or "force". Tests swap `headLineage.read`.
 */
import type { Lineage } from "./peer-pr-head-review.js";
import { runBounded } from "./run-bounded.js";
import { MAIN_REF, mainMergeCarry } from "./scheduler-main-merge-carry.js";

const env = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

async function read(repoDir: string, oldHead: string, newHead: string): Promise<Lineage> {
  const git = (args: string[]) => runBounded(["git", "-C", repoDir, ...args], { env: env(), timeoutMs: 30_000 });
  for (const sha of [oldHead, newHead]) {
    if ((await git(["cat-file", "-e", `${sha}^{commit}`])).code !== 0) return "missing";
  }
  const anc = await git(["merge-base", "--is-ancestor", oldHead, newHead]);
  if (anc.code === 1) return "force";
  if (anc.code !== 0) return "missing";
  try {
    const out = async (...args: string[]) => {
      const r = await git(args);
      if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] ?? "git 失败");
      return r.stdout;
    };
    const carry = await mainMergeCarry(out, runBounded, repoDir, oldHead, newHead, MAIN_REF);
    if (carry.ok) return "main_merge";
  } catch { /* main unreadable or the diff undecidable: nothing proves a pure main merge, so it is the author's change */ }
  return "successor";
}

export const headLineage = { read };
