/**
 * The per-card reviewer checkouts the scheduler creates (statePath("worktrees","rv-<task>")). Until retire removes them,
 * this is where they are counted: one whose reviewer agent is gone is leftover. Read-only; the fix is a plain
 * `git worktree remove`, which refuses a dirty checkout instead of losing a reviewer's notes.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Check } from "./doctor.js";
import { statePath } from "./paths.js";
import { readRegistryAgents } from "./registry.js";

export function reviewWorktreeChecks(dirs: readonly string[], agents: ReadonlySet<string>, root: string): Check[] {
  const rv = dirs.filter((d) => d.startsWith("rv-"));
  if (!rv.length) return [];
  const orphan = rv.filter((d) => !agents.has(`agent-${d}`));
  const detail = orphan.length
    ? `${rv.length} 个审查 worktree，其中 ${orphan.length} 个的审查员已不在：${orphan.slice(0, 8).join(", ")}${orphan.length > 8 ? " 等" : ""}`
    : `${rv.length} 个审查 worktree，审查员都还在`;
  const one = join(root, orphan[0] ?? "");
  return [{ group: "调度引擎", name: "审查 worktree", status: orphan.length ? "warn" : "ok", detail,
    ...(orphan.length ? { fix: `确认卡已收尾后逐个清理，例如 git -C ${one} worktree remove ${one}（有改动会拒绝，先看一眼）` } : {}) }];
}

export async function checkReviewWorktrees(root = statePath("worktrees")): Promise<Check[]> {
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return []; // no worktrees directory yet: the scheduler never created a reviewer checkout, nothing to count
  }
  const agents = new Set((await readRegistryAgents()).map((a) => a.name));
  return reviewWorktreeChecks(dirs, agents, root);
}
