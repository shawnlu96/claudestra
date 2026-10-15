#!/usr/bin/env bun
/** Explicit maintenance entry. State retains STATE2's owner/grant/runner chain.
 * Runtime/config CLI is read-only; SERVICES supplies authorized adapters for production on.
 */
import { cmdStateMaintenance } from "../../src/manager/state-maintenance.js";
import { migrateConfig, migrateRuntime, type ConfigAdapter } from "../../src/lib/floka-config/items.js";
import type { ItemOptions } from "../../src/lib/floka-config/transaction.js";
import type { RuntimeAliasInput } from "../../src/lib/floka-migration/runtime/types.js";
import { object } from "../../src/lib/floka-config/values.js";

interface CommandDeps {
  state: (argv: string[]) => Promise<unknown>;
  config: unknown;
  configAdapter: ConfigAdapter;
  runtime: Omit<RuntimeAliasInput, "mode">;
  journalDir: string;
}

export async function stateCommand(argv: string[], d: CommandDeps): Promise<unknown> {
  const [item, action] = argv;
  if (item === "state") return d.state(argv.slice(1));
  if ((item !== "config" && item !== "runtime") || action !== "observe" || argv.length !== 2) {
    throw new Error("usage: state <STATE2 command and grant> | config observe | runtime observe; production on requires SERVICES grant");
  }
  const cfg = object(d.config), modes = object(cfg.rename);
  // CLI cannot promote off to observe or on. With a configured on, it still only plans.
  const mode = modes[item] === "on" || modes[item] === "observe" ? "observe" : "off";
  const o: ItemOptions = { config: { ...cfg, rename: { ...modes, [item]: mode } }, txId: `${item}-observe`, journalDir: d.journalDir };
  return item === "config" ? migrateConfig({ ...o, io: d.configAdapter }) : migrateRuntime({ ...o, input: d.runtime });
}

async function main(argv: string[]): Promise<void> {
  if (argv[0] === "state") { await cmdStateMaintenance(argv.slice(1)); return; }
  const { CONFIG_PATH, RUNTIME_DIR, DEFAULT_RUNTIME_DIR, TMUX_SOCK } = await import("../../src/lib/paths.js");
  const { readJsonState } = await import("../../src/lib/state-file.js");
  const { nodeAliasFs, tmuxServerProbe } = await import("../../src/lib/floka-migration/runtime/adapters.js");
  const { tmuxRaw } = await import("../../src/lib/tmux-helper.js");
  const { maintenanceRoot } = await import("../../src/lib/state-maintenance/paths.js");
  const { join, basename } = await import("node:path");
  const { runtimeRoots } = await import("../../src/lib/floka-env/roots.js");
  const read = async () => {
    const r = await readJsonState(CONFIG_PATH);
    if (r.status === "corrupt") throw new Error("config is corrupt; refusing maintenance");
    return r.status === "ok" ? r.data : {};
  };
  const result = await stateCommand(argv, {
    state: cmdStateMaintenance, config: await read(), journalDir: join(maintenanceRoot(), "journals", "preview"),
    configAdapter: { path: CONFIG_PATH, read, write: async () => { throw new Error("CLI preview cannot write configuration"); } },
    runtime: { currentDir: RUNTIME_DIR, aliasDir: runtimeRoots(DEFAULT_RUNTIME_DIR)[1]!, socketName: basename(TMUX_SOCK), fs: nodeAliasFs, probe: tmuxServerProbe(tmuxRaw) },
  });
  console.log(JSON.stringify(result));
}

if (import.meta.main) await main(process.argv.slice(2));
