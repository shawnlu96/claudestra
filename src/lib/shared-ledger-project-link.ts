import { isPersonalProject } from "./lend-policy.js";
import { STATE_DIR } from "./paths.js";
import type { ProjectDef } from "./projects.js";
import { readSharedLedgerBindings } from "./shared-ledger-gate-bindings.js";
import { sharedLedgerBindingLocalId } from "./shared-ledger-project-link-target.js";
export { newSharedLedgerProject, readSharedLedgerProjects, requireSharedLedgerProject,
  type SharedLedgerProjectDisplay } from "./shared-ledger-project-link-target.js";

/** Call before any projects/registry writes or channel side effects, under the binding lock. */
export function sharedLedgerProjectMutationError(operation: "edit" | "merge" | "remove", ids: string[],
  next?: ProjectDef, dir = STATE_DIR): string | undefined {
  const bound = readSharedLedgerBindings(dir).some(b => ids.includes(sharedLedgerBindingLocalId(b)));
  if (!bound || (operation === "edit" && next && !isPersonalProject(next))) return;
  return "已绑定共享项目：请先解除绑定，再修改为个人/伞形项目、合并或删除";
}
