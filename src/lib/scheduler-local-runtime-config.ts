/** Pure parser kept below scheduler-config to avoid a config reader import cycle. */
export type LocalAuthorRuntime = "claude" | "codex";
export function parseLocalAuthorRuntime(raw: unknown): LocalAuthorRuntime | undefined {
  if (raw === undefined) return undefined;
  if (raw !== "claude" && raw !== "codex") throw new Error("localAuthorRuntime must be claude|codex");
  return raw;
}

/** Omit the key entirely when absent so hand-built/default project policies keep their original shape. */
export function localRuntimeFields(raw: unknown): { localAuthorRuntime?: LocalAuthorRuntime } {
  const runtime = parseLocalAuthorRuntime(raw);
  return runtime === undefined ? {} : { localAuthorRuntime: runtime };
}
