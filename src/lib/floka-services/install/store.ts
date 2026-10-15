import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { writeJsonAtomicSync } from "../../state-file.js";
import type { DaemonPlistInput } from "../../daemon-plist.js";
import type { Journal, ServicePlan } from "../plan/types.js";
import type { CliBefore } from "./cli.js";

export interface Snapshot {
  version: 1;
  plan: ServicePlan;
  input: Omit<DaemonPlistInput, "daemon">;
  cli: boolean;
  before: CliBefore[];
  cliOnly?: boolean;
  proof?: string;
  wrapperContext?: { root: string; stateDir: string; runtimeDir: string };
}
export const digest = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** Use the repository atomic writer, then flush both file and rename before acknowledging a checkpoint. */
export function durableJson(path: string, value: unknown): void {
  writeJsonAtomicSync(path, { value, checksum: digest(value) }, { mode: 0o600 });
  for (const p of [path, dirname(path)]) {
    const fd = openSync(p, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}

export function readStored<T>(path: string): T | null {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const v = JSON.parse(text);
  if (!v || typeof v.checksum !== "string" || digest(v.value) !== v.checksum) throw new Error("Service recovery snapshot checksum mismatch");
  return v.value as T;
}

export class ServiceStore {
  constructor(readonly root: string) {}
  activePath() { return join(this.root, "services", "active.json"); }
  active() { return readStored<Snapshot>(this.activePath()); }
  journalPath() { return join(this.root, "services", "journal.json"); }
  journal() { return readStored<Journal>(this.journalPath()); }
  save(j: Journal) { durableJson(this.journalPath(), j); }
  prepare(s: Snapshot) { durableJson(this.activePath(), s); }
  retire(): void {
    const s = this.active(), j = this.journal();
    if (!s || !j || !["committed", "rolled-back"].includes(j.status)) throw new Error("Only a terminal service transaction can retire");
    durableJson(join(this.root, "services", "archive", `${s.plan.id}.json`), { snapshot: s, journal: j });
    // Moving the whole live directory makes retirement recoverable after either rename has landed.
    renameSync(join(this.root, "services"), join(this.root, `retired-${s.plan.id}`));
    const fd = openSync(this.root, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
