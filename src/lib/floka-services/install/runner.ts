import { renameSync } from "node:fs";
import { join } from "node:path";
import { maintenanceRoot, prepareMaintenanceRoot } from "../../state-maintenance/paths.js";
import { STATE_DIR, RUNTIME_DIR } from "../../paths.js";
import { isTestProcess } from "../../test-guard.js";
import { serviceMaintenance } from "./maintenance.js";
import { productionHost, provePaths, rawConfig, modes, wrapperContext } from "./production.js";
import { durableJson, readStored } from "./store.js";
import type { Request } from "./entry.js";
import { runPart } from "./parts.js";
import { homedir } from "node:os";
import { claimPartExecution, finishPartJob, maintenanceJobLabel, serviceJobCommand } from "./job.js";
import type { runBounded } from "../../run-bounded.js";

export type RunnerRequestId = string;

async function execute(root: string, req: Request): Promise<unknown> {
  if (Date.now() > req.authorization.expiresAt || req.authorization.action !== req.item || req.authorization.binding.txId !== req.txId) {
    throw new Error("Request authorization expired or mismatched");
  }
  const config = rawConfig();
  if (JSON.stringify(modes(config)) !== JSON.stringify(req.config.rename)) throw new Error("Rename modes changed since approval");
  const production = productionHost(root, homedir(), req.txId);
  if (!await production.host.callerSafe(production.plan)) throw new Error("Runner is a switched daemon main PID");
  if (req.item !== "services") return production.host.withLock("floka-services", () => runPart(req.item as "runtime" | "config", req.txId, root, req.authorization));
  return serviceMaintenance({ config, root, plan: production.plan, input: req.input, cliPaths: req.cliPaths, controller: production.host,
    authorization: req.authorization, action: req.action, callerSafe: () => production.host.callerSafe(production.plan),
    provePaths: async () => provePaths(req.input), roleRefusal: () => null, wrapperContext: wrapperContext(root) });
}

/** Identity and at-most-once claims precede all transaction effects; a completed result precedes cleanup. */
export async function runRequest(root: string, id: string, ports: {
  xpc?: string; command?: typeof runBounded; execute?: (req: Request) => Promise<unknown>;
} = {}): Promise<unknown> {
  maintenanceJobLabel(id);
  const xpc = ports.xpc ?? process.env.XPC_SERVICE_NAME;
  let result: unknown;
  let claimed = false;
  try {
    claimPartExecution(root, id, xpc);
    claimed = true;
    const from = join(root, "part-requests", `${id}.json`), taken = join(root, "part-requests", `${id}.taken.json`);
    renameSync(from, taken);
    const req = readStored<Request>(taken);
    if (!req || req.version !== 1) throw new Error("Maintenance request damaged");
    result = await (ports.execute ? ports.execute(req) : execute(root, req));
  } catch (e) {
    result = { status: "blocked", error: (e as Error).message };
    console.error(`[service-maintenance] ${(e as Error).message}`);
  }
  if (!claimed) return result; // A duplicate or foreign process cannot overwrite the real job's outcome or unload it.
  try { durableJson(join(root, "part-requests", `${id}.result.json`), result); }
  finally {
    try { await finishPartJob(root, id, ports.command ?? serviceJobCommand); }
    catch (e) { durableJson(join(root, "part-requests", `${id}.cleanup.json`), { error: (e as Error).message }); }
  }
  return result;
}

if (import.meta.main) {
  if (isTestProcess()) throw new Error("Tests cannot execute the production services runner");
  const root = maintenanceRoot(), id = process.argv[2]!;
  prepareMaintenanceRoot(root, [STATE_DIR, RUNTIME_DIR]);
  console.log(JSON.stringify(await runRequest(root, id)));
}
