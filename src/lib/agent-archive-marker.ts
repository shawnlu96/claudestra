/**
 * 网页「归档 agent」= 在手动归档区建 archived/<name>/ 当分类标记：列表见到它就隐藏 agent，恢复路由删掉它。
 * 标记里必须写 .meta.json：恢复路由读 kind / sessionId，pruneArchives 见 kind=agent 就不清它也不删目录——
 * 只建空目录的话，每日清理顺手删空目录，归档的 agent 下一轮就回到侧栏。tests/archive-sweeper.test.ts。
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readRegistryAgents } from "./registry.js";
import { USER_ARCHIVE_ROOT, agentArchiveDir } from "./session-archive.js";
import { writeJsonAtomic } from "./state-file.js";

/**
 * 目录名用裸名：列表（api-routes / agent-info-routes）判已归档时也是先去掉 agent- 前缀再查。
 * 归一后要重新校验：路由放行的 `agent-..` 去掉前缀就是 `..`。agentArchiveDir 只认归档根下一层、真实路径也在那儿的目录
 * （拒 `.` `..` 空名 带 `/` 的名字和预先放好的目录软链），建目录前后各核一次；meta 不跟随软链写。
 */
export async function markAgentArchived(name: string, root: string = USER_ARCHIVE_ROOT, registryPath?: string): Promise<string> {
  const bare = name.replace(/^agent-/, "");
  const bad = () => new Error(`归档标记目录不合法，拒绝写入: ${JSON.stringify(bare).slice(0, 80)}`);
  if (!agentArchiveDir(bare, root)) throw bad();
  const info = (await readRegistryAgents(registryPath)).find((a) => a.name.replace(/^agent-/, "") === bare);
  await mkdir(join(root, bare), { recursive: true });
  const dir = agentArchiveDir(bare, root);
  if (!dir) throw bad();
  const meta = {
    kind: "agent", name: bare, sessionId: info?.sessionId ?? null, cwd: info?.cwd ?? null, runtime: info?.runtime ?? null,
    archivedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(join(dir, ".meta.json"), meta, { noFollow: true });
  return dir;
}
