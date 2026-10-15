import { readFileSync } from "node:fs";
import { ServiceStore, readStored } from "./store.js";
import { object, renameMode } from "../../floka-config/values.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
export const WRAPPER_POLICY_PATH = fileURLToPath(new URL("./wrapper-policy.ts", import.meta.url));

/** Read-only policy: an interrupted/rolled-back switch cannot revive the opposite registration. */
export function wrapperLabels(root: string, configPath: string): string[] {
  const store = new ServiceStore(root), active = store.active(), journal = store.journal();
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const mode = renameMode(object(object(config).rename).services);
  if (active && (!journal || journal.status === "running")) throw new Error("服务维护未完成，请恢复维护事务");
  const current = readStored<{ side: "old" | "new" }>(join(root, "services-current.json"));
  const side = active && !active.cliOnly ? journal?.status === "committed" ? "new" : "old" : current?.side ?? "old";
  if (mode === "on" && side === "old" && journal?.status !== "rolled-back") throw new Error("服务切换尚未批准执行");
  return ["bridge", "cron", "scheduler", "launcher"].map(n => `${side === "new" ? "ai.floka" : "com.claudestra"}.${n}`);
}

if (import.meta.main) {
  try { console.log(wrapperLabels(process.argv[2]!, process.argv[3]!).join(" ")); }
  catch (e) { console.error((e as Error).message); process.exit(1); }
}
