/**
 * 网页「归档 agent」= 在手动归档区建 archived/<name>/ 当分类标记：列表见到它就隐藏 agent，恢复路由删掉它。
 * 标记里必须写 .meta.json：恢复路由读 kind / sessionId，pruneArchives 见 kind=agent 就不清它也不删目录——
 * 只建空目录的话，每日清理顺手删空目录，归档的 agent 下一轮就回到侧栏。tests/archive-sweeper.test.ts。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readRegistryAgents } from "./registry.js";
import { USER_ARCHIVE_ROOT } from "./session-archive.js";

/** 目录名用裸名：列表（api-routes / agent-info-routes）判已归档时也是先去掉 agent- 前缀再查 */
export async function markAgentArchived(name: string, root: string = USER_ARCHIVE_ROOT, registryPath?: string): Promise<string> {
  const bare = name.replace(/^agent-/, "");
  const info = (await readRegistryAgents(registryPath)).find((a) => a.name.replace(/^agent-/, "") === bare);
  const dir = join(root, bare);
  await mkdir(dir, { recursive: true });
  const meta = {
    kind: "agent", name: bare, sessionId: info?.sessionId ?? null, cwd: info?.cwd ?? null, runtime: info?.runtime ?? null,
    archivedAt: new Date().toISOString(),
  };
  await writeFile(join(dir, ".meta.json"), JSON.stringify(meta, null, 2));
  return dir;
}
