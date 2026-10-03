/** Bind memory evidence to the observed project's configured clone, never the CLI installation repository. */
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { collectPrStage, realFactsDeps, type FactsDeps } from "./ledger-verify-facts.js";
import { LedgerError } from "./ledger-store.js";
import type { AutoDeps } from "./memory-auto.js";
import { mainHasPath } from "./review-converge-followup.js";
import { runBounded } from "./run-bounded.js";
import { readSchedulerConfig } from "./scheduler-config.js";

type RepoEvidence = Pick<AutoDeps, "files" | "hasPath">;
const declaredScope = (): RepoEvidence => {
  console.warn("[memory-auto] project repository unavailable; using declared scope");
  return { files: async () => null, hasPath: () => false };
};

/** Auth and lease checks precede repo/config IO; an absent or unusable clone explicitly returns declared-scope callbacks. */
export async function memoryAutoRepoDeps(project: string, actor: string, assertLease?: () => void,
  factsFactory?: () => FactsDeps): Promise<RepoEvidence> {
  if (actor !== "scheduler" || !assertLease) throw new LedgerError("forbidden", "自动记忆只由有租约的调度服务写入");
  assertLease();
  let candidate: string | undefined;
  try {
    candidate = readSchedulerConfig().projects[project]?.repoDir;
    if (!candidate || !isAbsolute(candidate) || !statSync(candidate).isDirectory()) return declaredScope();
  } catch { return declaredScope(); /* Invalid/missing local configuration or directory cannot authorize using another repo. */ }
  const probe = await runBounded(["git", "-C", candidate, "rev-parse", "--show-toplevel"], { cwd: candidate, timeoutMs: 5000 });
  assertLease();
  if (probe.code !== 0 || !probe.stdout.trim()) return declaredScope();
  const root = resolve(probe.stdout.trim());
  const facts = factsFactory?.() ?? realFactsDeps(root);
  if (resolve(facts.repoRoot) !== root) return declaredScope();
  const hasPath = mainHasPath(root);
  hasPath(""); // Prime the tracked-file snapshot before observeMemory can acquire its write transaction.
  assertLease();
  return { hasPath, files: async (task) => {
    if (task.project !== project || !task.pr) return null;
    assertLease();
    const stage = await collectPrStage(facts, task.pr);
    assertLease();
    return stage.pr?.files ?? null;
  } };
}
