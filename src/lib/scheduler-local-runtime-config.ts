/** Pure parser kept below scheduler-config to avoid a config reader import cycle. */
export type LocalAuthorRuntime = "claude" | "codex";
function parseLocalAuthorRuntime(raw: unknown): LocalAuthorRuntime | undefined {
  if (raw === undefined) return undefined;
  if (raw !== "claude" && raw !== "codex") throw new Error("localAuthorRuntime must be claude|codex");
  return raw;
}

/** Omit the key entirely when absent so hand-built/default project policies keep their original shape. */
export function localRuntimeFields(raw: unknown): { localAuthorRuntime?: LocalAuthorRuntime } {
  const runtime = parseLocalAuthorRuntime(raw);
  return runtime === undefined ? {} : { localAuthorRuntime: runtime };
}

/** Validate the new field even when another local setting is present; legacy empty patches still refuse. */
export function hasLocalRuntimeSlot(set: { localAuthorRuntime?: unknown; localPriority?: unknown; maxActiveWorkers?: unknown }): boolean {
  const runtime = parseLocalAuthorRuntime(set.localAuthorRuntime);
  return runtime !== undefined || set.localPriority !== undefined || set.maxActiveWorkers !== undefined;
}

/** The audited local-slots writer includes the old value in its event and changes only this raw field. */
export function localRuntimePatch(p: Record<string, unknown>, raw: unknown): { localAuthorRuntime?: LocalAuthorRuntime } {
  const runtime = parseLocalAuthorRuntime(raw);
  if (runtime === undefined) return {};
  const from = parseLocalAuthorRuntime(p.localAuthorRuntime) ?? "claude";
  if (from !== runtime) p.localAuthorRuntime = runtime;
  return { localAuthorRuntime: from };
}
