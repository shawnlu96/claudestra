/** Shared deterministic checkout names; never infer ownership from an arbitrary registry cwd. */
import { join } from "node:path";

/** The two checkouts the scheduler makes per card: the executor's and the reviewer's. */
export function worktreeDirs(root: string, taskId: string): string[] {
  const low = taskId.toLowerCase();
  if (!/^[\w.-]+$/.test(low) || /^\.+$/.test(low)) return [];
  return [join(root, low), join(root, `rv-${low}`)];
}
