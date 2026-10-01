/** 将隔离目录里的 Claude 会话接回原有 watcher / 归档 / 用量读取；清理前只保留会话快照，不保留配置。 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { statePath } from "./paths.js";

export const CLAUDE_LEND_ROOT = statePath("lend", "claude-config");

export function claudeWorkerSessionPath(session: string, agent?: string): string | null {
  if (!/^[\w-]+$/.test(session) || !existsSync(CLAUDE_LEND_ROOT)) return null;
  const agents = agent ? [agent] : readdirSync(CLAUDE_LEND_ROOT);
  for (const name of agents.filter((n) => /^agent-lend-[\w-]+$/.test(n))) {
    const parent = join(CLAUDE_LEND_ROOT, name);
    if (!existsSync(parent)) continue;
    for (const run of readdirSync(parent, { withFileTypes: true }).filter((r) => r.isDirectory())) {
      const projects = join(parent, run.name, "config", "projects");
      if (!existsSync(projects)) continue;
      const slugs = readdirSync(projects, { withFileTypes: true }).filter((p) => p.isDirectory()).map((p) => p.name);
      for (const slug of slugs) {
        const file = join(projects, slug, `${session}.jsonl`);
        if (existsSync(file)) return file;
      }
    }
  }
  return null;
}
