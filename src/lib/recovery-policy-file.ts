/**
 * The recovery policy file's strict reader (recovery-policy.ts re-exports it): a parse that never reaches the ledger writer, so a
 * gate below that writer (scheduler-review-fallback.ts) reads the switch with the very same rules. tests/recovery-policy*.test.ts.
 */
import { readFileSync } from "node:fs";
import { RECOVERY_KEYS } from "./recovery-keys.js";

export type RecoveryMode = "on" | "observe" | "off";
export const RECOVERY_MODES: readonly RecoveryMode[] = ["on", "observe", "off"];
export const isRecoveryMode = (v: unknown): v is RecoveryMode => RECOVERY_MODES.includes(v as RecoveryMode);
export type RecoveryKey = (typeof RECOVERY_KEYS)[number];
export const isRecoveryKey = (v: unknown): v is RecoveryKey => RECOVERY_KEYS.includes(v as RecoveryKey);
export const MANUAL_STALL_HOURS_MAX = 720;
export const validHours = (h: unknown): h is number => Number.isInteger(h) && (h as number) >= 1 && (h as number) <= MANUAL_STALL_HOURS_MAX;

/** rev = seq of the audit whose change this entry is; written in the same atomic rename, so it is the proof of publish. */
export interface ProjectRecovery { mode?: RecoveryMode; manualStallHours?: number; keys?: Partial<Record<RecoveryKey, RecoveryMode>>; rev?: number }
interface RecoveryFile { projects: Record<string, ProjectRecovery>; machine?: Record<string, unknown> }
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Strict: unknown names and bad values make the whole file invalid, so a typo never silently means "observe". */
function parseRecoveryFile(data: unknown, parseMachine?: (m: Record<string, unknown>) => unknown): RecoveryFile {
  if (!isObj(data) || !isObj(data.projects) || Object.keys(data).some((k) => k !== "projects" && k !== "machine")) throw new Error("顶层要是 { projects: {...}, machine?: {...} }");
  if (data.machine !== undefined) { if (!isObj(data.machine)) throw new Error("machine 要是对象"); parseMachine?.(data.machine); } // LCFG1W: recovery-machine-policy.ts
  for (const [id, p] of Object.entries(data.projects)) {
    if (!isObj(p) || Object.keys(p).some((k) => !["mode", "manualStallHours", "keys", "rev"].includes(k))) throw new Error(`项目 ${id} 只能有 mode / manualStallHours / keys / rev`);
    if (p.rev !== undefined && !(Number.isSafeInteger(p.rev) && (p.rev as number) >= 1)) throw new Error(`项目 ${id} 的 rev 要是正整数`);
    if (p.mode !== undefined && !isRecoveryMode(p.mode)) throw new Error(`项目 ${id} 的 mode 要是 ${RECOVERY_MODES.join(" / ")}`);
    if (p.manualStallHours !== undefined && !validHours(p.manualStallHours)) throw new Error(`项目 ${id} 的 manualStallHours 要是 1..${MANUAL_STALL_HOURS_MAX} 的整数`);
    if (p.keys !== undefined && (!isObj(p.keys) || Object.entries(p.keys).some(([k, m]) => !isRecoveryKey(k) || !isRecoveryMode(m)))) {
      throw new Error(`项目 ${id} 的 keys 只能是 { ${RECOVERY_KEYS.join(" / ")}: ${RECOVERY_MODES.join(" / ")} }`);
    }
  }
  return data as unknown as RecoveryFile;
}

type FileRead = { status: "missing" } | { status: "ok"; data: RecoveryFile; raw: string } | { status: "corrupt"; error: string };
export function readRecoveryFile(path: string, parseMachine?: (m: Record<string, unknown>) => unknown): FileRead {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { status: "missing" } : { status: "corrupt", error: (e as Error).message }; }
  try { return { status: "ok", data: parseRecoveryFile(JSON.parse(raw), parseMachine), raw }; }
  catch (e) { return { status: "corrupt", error: (e as Error).message }; }
}
