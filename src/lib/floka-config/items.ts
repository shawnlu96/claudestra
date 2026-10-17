import { dirname } from "node:path";
import { runtimeAliasStep } from "../floka-migration/runtime/alias.js";
import type { RuntimeAliasInput } from "../floka-migration/runtime/types.js";
import type { Json, TxStep } from "../floka-migration/transaction/types.js";
import { autoUpdateValue, object, renameMode } from "./values.js";
import { journalOutside, runItem, type ItemOptions } from "./transaction.js";
import { withConfigWriteLock } from "./write-lock.js";

export interface ConfigAdapter {
  path: string;
  read(): Promise<unknown>;
  /** Must atomically write the entire document. apply / compensate hold the config write lock (write-lock.ts) around read → write. */
  write(value: Record<string, unknown>): Promise<void>;
}

function brandFields(raw: unknown): { claudestra: boolean | null; floka: boolean | null } {
  const au = object(object(raw).autoUpdate);
  autoUpdateValue(au, true);
  return { claudestra: au.claudestra ?? null, floka: au.floka ?? null };
}

function configStep(io: ConfigAdapter): TxStep<unknown> {
  const changed = async () => {
    const b = brandFields(await io.read());
    return b.floka !== null || b.claudestra === null;
  };
  return {
    id: "config.brand", item: "rename.config", recovery: "restore only original brand keys; preserve subsequent non-brand edits",
    read: async () => brandFields(await io.read()),
    done: changed,
    apply: () => withConfigWriteLock(io.path, async () => {
      const raw = object(await io.read()), before = brandFields(raw);
      if (before.claudestra !== null) await io.write({ ...raw, autoUpdate: { ...object(raw.autoUpdate), floka: before.claudestra } });
    }),
    verify: changed,
    compensate: (_adapter, value: Json) => withConfigWriteLock(io.path, async () => {
      const before = value as ReturnType<typeof brandFields>;
      const raw = object(await io.read()), now = brandFields(raw);
      // Do not erase an operator's later change under cover of an older transaction.
      if (now.floka !== before.floka && now.floka !== before.claudestra) throw new Error("config brand value changed since migration; refusing rollback");
      const au = { ...object(raw.autoUpdate) };
      if (before.floka === null) delete au.floka;
      else au.floka = before.floka;
      await io.write({ ...raw, autoUpdate: au });
    }),
  };
}

export async function migrateConfig(o: ItemOptions & { io: ConfigAdapter }) {
  if (renameMode(object(object(o.config).rename).config) !== "off") journalOutside(o.journalDir, [dirname(o.io.path)]);
  return runItem("config", o, configStep(o.io));
}

export async function migrateRuntime(o: ItemOptions & { input: Omit<RuntimeAliasInput, "mode"> }) {
  if (renameMode(object(object(o.config).rename).runtime) !== "off") journalOutside(o.journalDir, [o.input.currentDir, o.input.aliasDir]);
  return runItem("runtime", o, runtimeAliasStep(o.input));
}
