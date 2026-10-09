import { reconcileFileScope } from "../lib/ledger-resource-scope.js";
import { extendLiveWriterScope } from "../lib/ledger-writer-scope-extend.js";
import { LedgerError, LEDGER_SCHEMA_VERSION, schemaVersion } from "../lib/ledger-store.js";
import { LedgerReader } from "../lib/ledger-read.js";
import { REGISTRY_PATH } from "../lib/registry.js";
import { readJsonStateSync } from "../lib/state-file.js";
import { intFlag } from "./ledger-identity.js";
import type { CommandSpec } from "./ledger-write-cmds.js";
import type { Registry } from "./core.js";

/** Unlike loadRegistry, an unavailable registry must never be created as a side effect of a preview/refusal. */
export function fileScopeRegistry(): Registry {
  const state = readJsonStateSync(REGISTRY_PATH, v => {
    const agents = (v as { agents?: unknown } | null)?.agents;
    return !!agents && typeof agents === "object" && !Array.isArray(agents) &&
      Object.values(agents).every(a => !!a && typeof a === "object" && !Array.isArray(a));
  });
  if (state.status !== "ok") throw new LedgerError("conflict", `registry 无法核实：${state.status}`);
  return state.data as Registry;
}

/** Reuse the canonical non-migrating reader; only explicit apply enables writes on this connection. */
export function fileScopeLedger(apply: boolean) {
  const db = new LedgerReader().get();
  if (!db) throw new LedgerError("not_found", "台账不存在；对账不创建或迁移台账");
  if (schemaVersion(db) !== LEDGER_SCHEMA_VERSION) throw new LedgerError("conflict", "台账版本不匹配；先经正式升级再对账");
  if (apply) db.exec("PRAGMA foreign_keys = ON; PRAGMA query_only = OFF");
  return db;
}

const LIVE_FLAGS = ["order", "gen", "peer"] as const;

export const FILE_SCOPE_COMMAND: CommandSpec = {
  valued: ["project", "rev", "workflow-rev", "reason", ...LIVE_FLAGS], bools: ["dry-run", "apply", "live-extend"],
  usage: "scheduler-file-scope <task> --project <id> --rev N --workflow-rev N --reason <依据> [--live-extend --order <单号> --gen N --peer <名>] " +
    "[--dry-run|--apply]（默认预演；--live-extend 只给活跃出借作者追加已批准 fileGlobs）",
  run(c) {
    if (c.p.pos.length !== 2) throw new LedgerError("invalid", "只接受一个 task");
    if (c.p.bools.has("dry-run") && c.p.bools.has("apply")) throw new LedgerError("invalid", "dry-run 与 apply 互斥");
    const rev = intFlag(c.p, "rev"), workflowRev = intFlag(c.p, "workflow-rev");
    if (!Number.isSafeInteger(rev) || !Number.isSafeInteger(workflowRev)) throw new LedgerError("invalid", "必须提供 rev 和 workflow-rev");
    if (c.p.bools.has("live-extend")) {
      const gen = intFlag(c.p, "gen");
      if (!Number.isSafeInteger(gen) || gen! < 1) throw new LedgerError("invalid", "--live-extend 必须提供 --gen（正整数）");
      return extendLiveWriterScope(c.db, c.ctx(), { taskId: c.p.pos[1] ?? "", project: c.project(), taskRev: rev!, workflowRev: workflowRev!,
        reason: c.need("reason"), apply: c.p.bools.has("apply"), orderId: c.need("order"), gen: gen!, peer: c.need("peer"),
        registryPath: c.deps.registryPath });
    }
    if (LIVE_FLAGS.some(f => c.p.flags[f] !== undefined)) throw new LedgerError("invalid", "--order / --gen / --peer 只用于 --live-extend");
    return reconcileFileScope(c.db, c.ctx(), { taskId: c.p.pos[1] ?? "", project: c.project(), taskRev: rev!, workflowRev: workflowRev!,
      reason: c.need("reason"), apply: c.p.bools.has("apply"), registryPath: c.deps.registryPath });
  },
};

/** Dependency failures precede runLedger's catch; preserve structured errors without changing other commands. */
export async function withFileScopeErrors<T>(args: string[], resolve: () => Promise<T>): Promise<T | { error: string; code: string }> {
  if (args[0] !== "scheduler-file-scope") return resolve();
  try { return await resolve(); }
  catch (error) {
    process.exitCode = 1;
    return { error: (error as Error).message, code: error instanceof LedgerError ? error.code : "invalid" };
  }
}
