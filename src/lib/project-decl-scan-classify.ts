/**
 * generality-PROJSCAN1 · runtime failure classification for declared commands. Only explicit evidence of a missing command or
 * script proposes a rescan; failing tests, assertions, timeouts and network or dependency trouble never touch configuration.
 * The rescan itself opens a separate PR (project-decl-scan.ts); until it merges the affected items are degraded, not rewritten.
 */
import type { DeclCapability } from "./project-decl-capabilities.js";

export interface DeclRuntimeFailure {
  exitCode: number | null; timedOut?: boolean;
  /** Spawn error code such as ENOENT, when the process never started. */
  errorCode?: string;
  /** Classified locally only; callers must not persist or log it. */
  stderr?: string;
}
export type DeclFailureClass = "PASSED" | "COMMAND_MISSING" | "SCRIPT_MISSING" | "TIMEOUT" | "COMMAND_FAILED";
export interface DeclFailureVerdict { failureClass: DeclFailureClass; rescan: boolean }

/** Lower-cased markers printed by shells, npm / bun / pnpm / yarn, make and cargo for an absent command or script. */
const COMMAND_MISSING_MARKERS = ["command not found", "no such file or directory", "enoent"];
const SCRIPT_MISSING_MARKERS = ["missing script", "no rule to make target", "no such command", "script not found", "couldn't find a script"];

export function classifyDeclFailure(f: DeclRuntimeFailure): DeclFailureVerdict {
  if (f.timedOut) return { failureClass: "TIMEOUT", rescan: false };
  if (f.exitCode === 0) return { failureClass: "PASSED", rescan: false };
  const err = (f.stderr ?? "").toLowerCase();
  // A wrapper (the execution boundary) that cannot exec the command reports it as an execvp failure with its own exit code.
  const execFailed = err.includes("execvp") && err.includes("no such file or directory");
  if (f.errorCode === "ENOENT" || f.exitCode === 127 || execFailed || (f.exitCode === null && COMMAND_MISSING_MARKERS.some((m) => err.includes(m)))) {
    return { failureClass: "COMMAND_MISSING", rescan: true };
  }
  if (SCRIPT_MISSING_MARKERS.some((m) => err.includes(m))) return { failureClass: "SCRIPT_MISSING", rescan: true };
  return { failureClass: "COMMAND_FAILED", rescan: false };
}

/** Rescan pending: affected capabilities become unavailable with a reason, the declaration itself stays untouched. */
export function degradeForRescan(caps: DeclCapability[], fields: string[]): { capabilities: DeclCapability[]; reasons: { field: string; reason: string }[] } {
  const affected = new Set(fields);
  return {
    capabilities: caps.map((c) => affected.has(c.field) ? { ...c, available: false, wouldBeAvailable: false } : c),
    reasons: caps.filter((c) => affected.has(c.field)).map((c) => ({ field: c.field, reason: "RESCAN_PENDING" })),
  };
}
