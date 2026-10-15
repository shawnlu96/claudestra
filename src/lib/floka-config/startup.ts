import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { maintenanceBarrierPresent } from "./default-root.js";
import { stateDirIn } from "../state-dir.js";
import { SRC_DIR } from "../repo-root.js";

const PRODUCT_ENTRIES = ["bridge", "launcher", "cron", "scheduler", "manager", "channel-server"].map(n => join(SRC_DIR, `${n}.ts`));

function refuseStartup(): never {
  console.error("状态迁移维护未完成，请到维护页恢复");
  process.exit(1);
}

/** Maintenance paths are for recovery, never permission for startup writers to recreate a missing root. */
export function maintenanceStartupRoot(root: string, entryPath: string = Bun.main): string {
  const home = homedir();
  if (![stateDirIn(home), join(home, ".floka")].includes(root) || !maintenanceBarrierPresent(home)) return root;
  // Bun eval has no file to resolve; imported libraries retain their own writer barriers.
  if (entryPath === Bun.main && Bun.main === join(process.cwd(), "[eval]")) return root;
  let entry: string, entries: string[];
  try {
    entry = realpathSync(entryPath);
    entries = PRODUCT_ENTRIES.map(path => realpathSync(path));
  } catch {
    // An unresolved entry cannot prove it is outside the guarded list; keep the barrier closed.
    return refuseStartup();
  }
  if (!entries.includes(entry)) return root; // Library imports leave refusal to the identity/config writer itself.
  const [command, action] = process.argv.slice(2);
  if (entry === entries[4] && command === "state-maintenance"
    && ["status", "recover", "note-retry"].includes(action ?? "")) return root;
  return refuseStartup();
}
