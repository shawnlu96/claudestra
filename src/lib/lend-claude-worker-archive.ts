/** 清理配置前用既有归档保存会话，和 adapter 的路径读取分层，避免 runtime 反向依赖归档。 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { archiveSession } from "./session-archive.js";
import { CLAUDE_LEND_ROOT } from "./lend-claude-worker-session.js";
import type { ClaudeWorkerPlan } from "./lend-claude-worker.js";

/** fork 的实际 id 由 Claude 决定，所以按本代目录归档；复用 archiveSession 保留子会话与既有记账布局。 */
export async function archiveClaudeWorker(plan: ClaudeWorkerPlan, log: (s: string) => void): Promise<void> {
  await archiveConfig(plan.agent, plan.dir, log);
}

async function archiveConfig(agent: string, dir: string, log: (s: string) => void): Promise<void> {
  const projects = join(dir, "config", "projects");
  if (!existsSync(projects)) return;
  for (const project of readdirSync(projects, { withFileTypes: true }).filter((p) => p.isDirectory())) {
    const path = join(projects, project.name);
    for (const file of readdirSync(path, { withFileTypes: true }).filter((f) => f.isFile() && /^[\w-]+\.jsonl$/.test(f.name))) {
      const r = await archiveSession(agent, undefined, file.name.slice(0, -6), { srcPath: join(path, file.name), runtime: "claude-code", kind: "worker" });
      if (!r.ok) log(`Claude worker 会话归档失败：${r.note}`);
    }
  }
}

/** 服务在杀窗口之前留快照，避免窗口消失与宿主自行删目录并发；宿主退出时会补最后一段。 */
export async function archiveClaudeWorkerName(agent: string): Promise<void> {
  if (!/^agent-lend-[\w-]+$/.test(agent)) return;
  const parent = join(CLAUDE_LEND_ROOT, agent);
  if (!existsSync(parent)) return;
  try {
    for (const run of readdirSync(parent, { withFileTypes: true }).filter((r) => r.isDirectory())) {
      await archiveConfig(agent, join(parent, run.name), console.error);
    }
  } catch (e) { console.error(`[lend] Claude 归档失败，仍停止 worker：${(e as Error).message}`); }
}
