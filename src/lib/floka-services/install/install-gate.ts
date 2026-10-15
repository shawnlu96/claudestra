import { CONFIG_PATH, STATE_DIR, RUNTIME_DIR } from "../../paths.js";
import { readJsonStateSync } from "../../state-file.js";
import { maintenanceRoot, prepareMaintenanceRoot } from "../../state-maintenance/paths.js";
import { takeExecutorLock } from "../../state-maintenance/run-store.js";
import { isTestProcess } from "../../test-guard.js";
import { object, renameMode } from "../../floka-config/values.js";
import type { InstallCliResult } from "../../cli-install.js";
import { readStored, ServiceStore } from "./store.js";
import { join } from "node:path";

/** Legacy installs retain their old behavior in off. Other modes never fall through to legacy reload. */
export function renameInstallGate(configPath = CONFIG_PATH, root = maintenanceRoot()): InstallCliResult | null {
  const raw = readJsonStateSync(configPath);
  const rename = object(object(raw.status === "ok" ? raw.data : {}).rename);
  const services = renameMode(rename.services), cli = renameMode(rename.cli);
  const store = new ServiceStore(root);
  const current = readStored<{ side: string }>(join(root, "services-current.json"));
  if (services === "off" && cli === "off" && !store.active() && current?.side !== "new") return null;
  const observe = services === "observe" || cli === "observe";
  return {
    cliWrapper: "", daemons: [], pm2Stopped: [], removedOldAutostartWrapper: false, migratedHookCommand: false,
    web: { staticDir: "", built: false },
    errors: observe ? [] : [services === "on" && cli !== "on" ? "先把 cli 切到 on" : "服务改名须通过 state-maintenance services 的单次批准执行"],
    warnings: observe ? [`rename.services=${services}, rename.cli=${cli}: observe 只报告，不安装、不加载`] : [],
  };
}

/** Serialize legacy installers with STATE2 and service transactions; recheck modes after acquiring ownership. */
export async function withRenameInstallGate(install: () => Promise<InstallCliResult>): Promise<InstallCliResult> {
  const root = maintenanceRoot(), before = renameInstallGate(CONFIG_PATH, root);
  if (before) return before;
  if (process.platform !== "darwin" || isTestProcess()) return install();
  prepareMaintenanceRoot(root, [STATE_DIR, RUNTIME_DIR]);
  const lock = takeExecutorLock(root);
  if ("error" in lock) return { cliWrapper: "", daemons: [], pm2Stopped: [], removedOldAutostartWrapper: false,
    migratedHookCommand: false, web: { staticDir: "", built: false }, errors: [lock.error], warnings: [] };
  try { return renameInstallGate(CONFIG_PATH, root) ?? await install(); } finally { lock.release(); }
}
