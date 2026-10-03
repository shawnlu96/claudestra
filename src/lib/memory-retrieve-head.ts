/** 当前目标树的文件列表：事务外读本机 git，不 fetch、不切分支；失败保留图路和目录前缀退化。 */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { readRegistryAgentsSync } from "./registry.js";
import { runBounded } from "./run-bounded.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { getSchedulerSession } from "./scheduler-sessions.js";

export async function memoryHeadFiles(db: Database, task: LedgerTask, head: string | null, repoDir?: string): Promise<string[] | null> {
  try {
    const dir = repoDir ?? readSchedulerConfig().projects[task.project]?.repoDir ??
      readRegistryAgentsSync().find((a) => a.name === (getSchedulerSession(db, task.id, "author")?.agent ?? task.agent))?.cwd;
    if (!dir) return null;
    if (head !== null && !/^[0-9a-f]{40}$/i.test(head)) throw new Error("目标 head 不是完整 SHA");
    const tree = head ?? (task.branch ? `refs/heads/${task.branch}` : "HEAD");
    const r = await runBounded(["git", "ls-tree", "-r", "--name-only", "-z", tree, "--"], { cwd: dir, timeoutMs: 2000 });
    if (r.code !== 0 || r.timedOut || Buffer.byteLength(r.stdout) >= 1024 * 1024 || (r.stdout && !r.stdout.endsWith("\0"))) {
      throw new Error("目标树文件列表不可用或不完整");
    }
    return r.stdout.split("\0").filter(Boolean);
  } catch (e) {
    console.error(`⚠️ ${task.id} 记忆文件列表读取失败，按目录前缀退化：${(e as Error).message}`);
    return null;
  }
}
