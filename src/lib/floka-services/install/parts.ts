import { basename, join } from "node:path";
import { migrateConfig, migrateRuntime } from "../../floka-config/items.js";
import { nodeAliasFs, tmuxServerProbe } from "../../floka-migration/runtime/adapters.js";
import { writeJsonStateGuarded } from "../../state-file.js";
import { CONFIG_PATH, RUNTIME_DIR, TMUX_SOCK } from "../../paths.js";
import { tmuxRawStrict } from "../../tmux-helper.js";
import type { Grant } from "../../state-maintenance/grant.js";
import { rawConfig, runtimeAliasDir } from "./production.js";

/** CONFIG1 owns each transaction. This module supplies STATE2's consumed grant and separate item txIds. */
export async function runPart(item: "runtime" | "config", txId: string, root: string, grant?: Grant) {
  const config = rawConfig();
  const options = { config, txId, journalDir: join(root, "item-journals", item),
    authorize: async (part: "runtime" | "config", id: string) => !!grant && grant.action === part && grant.binding.txId === id &&
      part === item && id === txId && Date.now() <= grant.expiresAt };
  if (item === "runtime") return migrateRuntime({ ...options, input: { currentDir: RUNTIME_DIR, aliasDir: runtimeAliasDir(),
    socketName: basename(TMUX_SOCK), fs: nodeAliasFs, probe: tmuxServerProbe(tmuxRawStrict) } });
  let before: Record<string, unknown> | undefined;
  return migrateConfig({ ...options, io: { path: CONFIG_PATH,
    read: async () => (before = rawConfig()),
    write: async value => {
      if (JSON.stringify(rawConfig()) !== JSON.stringify(before)) throw new Error("Configuration changed during maintenance; retry");
      await writeJsonStateGuarded(CONFIG_PATH, value, { mode: 0o600 });
    },
  } });
}
