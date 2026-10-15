import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { maintenanceBarrierPresent } from "./default-root.js";
import { stateDirIn } from "../state-dir.js";
import { SRC_DIR } from "../repo-root.js";

const PRODUCT_ENTRIES = new Set(["bridge", "launcher", "cron", "scheduler", "manager", "channel-server"].map(n => join(SRC_DIR, `${n}.ts`)));

/** Maintenance paths are for recovery, never permission for startup writers to recreate a missing root. */
export function maintenanceStartupRoot(root: string): string {
  const entry = resolve(Bun.main);
  if (!PRODUCT_ENTRIES.has(entry)) return root; // Library imports must leave refusal to the identity/config writer itself.
  const home = homedir();
  if (![stateDirIn(home), join(home, ".floka")].includes(root) || !maintenanceBarrierPresent(home)) return root;
  const [command, action] = process.argv.slice(2);
  if (entry === join(SRC_DIR, "manager.ts") && command === "state-maintenance" && ["status", "recover"].includes(action ?? "")) return root;
  console.error("状态迁移维护未完成，请到维护页恢复");
  process.exit(1);
}
