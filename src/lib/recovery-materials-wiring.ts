/**
 * dispatch-recovery-MATW: the two real fix-order entries (`ledger lend-offer` and the scheduler's pool step) hand MAT's
 * writeMaterials the one CFG reader, `recoveryPolicy(project, "materials")`. CFG is not on main yet, so it is loaded at run
 * time from its frozen location (SRC_DIR/lib/recovery-policy.ts) by a non-literal import (typecheck and every entry build stay green without it).
 * The two entries take that location from `cfgReaderPath` imported `with { type: "macro" }`: Bun runs it when it transpiles the
 * entry (source run) or bundles it, so a bundle carries the source tree's src/lib path, not `<outdir>/../lib` (SRC_DIR inside a bundle):
 * - no file there = reader not installed → no port, writeMaterials observes (the order keeps the full text), with a diagnostic;
 * - a file that fails to import or lacks the export, a read that throws or answers anything but on / observe / off → off
 *   (fix-materials' own catch), with a diagnostic.
 * The policy is read afresh on every writeMaterials call; nothing here stores, defaults or hard-codes a mode.
 * tests/recovery-materials-wiring*.test.ts.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { MaterialsPolicy } from "./fix-materials.js";
import { SRC_DIR } from "./repo-root.js";

/** CFG's frozen reader (src/lib/recovery-policy.ts, export recoveryPolicy), located from the repo's one SRC_DIR, never the cwd. Macro-safe: no arguments, returns a string. */
export function cfgReaderPath(): string {
  return join(SRC_DIR, "lib", "recovery-policy.ts");
}
const CFG_EXPORT = "recoveryPolicy";
const MODES: readonly unknown[] = ["on", "observe", "off"];

export interface MaterialsPolicyRead {
  /** undefined = reader not installed (observe); otherwise the port writeMaterials reads, throwing whenever the read is unusable. */
  policy?: MaterialsPolicy;
  reader: "missing" | "loaded" | "broken";
  /** Why the result is not a plain read of the configured mode; null when the reader loaded. */
  diag: string | null;
}

/** Diagnostics go to stderr once per process and reason (the scheduler runs the pool step every tick). */
const told = new Set<string>();
function tell(line: string): void {
  if (told.has(line)) return;
  told.add(line);
  console.error(`[materials] ${line}`);
}

/** Load the reader at `at` (default: CFG's location as this module sees it). Per-call read failures are reported through the same diagnostic sink. */
export async function materialsPolicyPort(where: string | URL = cfgReaderPath()): Promise<MaterialsPolicyRead> {
  const at = typeof where === "string" ? pathToFileURL(where) : where;
  if (at.protocol !== "file:" || !existsSync(fileURLToPath(at))) {
    const diag = `CFG recoveryPolicy 读取未安装（${at.pathname}）：materials 按 observe，修复单照旧发报告全文，只记 would-send`;
    tell(diag);
    return { reader: "missing", diag };
  }
  let read: unknown;
  try {
    read = ((await import(at.href)) as Record<string, unknown>)[CFG_EXPORT];
  } catch (e) {
    return broken(`CFG recoveryPolicy 读取加载失败，materials 按 off：${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof read !== "function") return broken(`CFG 模块没有导出函数 ${CFG_EXPORT}，materials 按 off`);
  const fn = read as (project: string, mechanism: "materials") => unknown;
  const policy: MaterialsPolicy = (project, mechanism) => {
    let p: unknown;
    try {
      p = fn(project, mechanism);
    } catch (e) {
      tell(`项目 ${project} 读 materials 策略失败，按 off：${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
      throw e;
    }
    const mode = p && typeof p === "object" ? (p as { mode?: unknown }).mode : undefined;
    if (!MODES.includes(mode)) {
      const why = `项目 ${project} 的 materials 策略值不合法，按 off：${(JSON.stringify(p) ?? String(p)).slice(0, 200)}`;
      tell(why);
      throw new Error(why);
    }
    return { mode: mode as string };
  };
  return { policy, reader: "loaded", diag: null };
}

function broken(diag: string): MaterialsPolicyRead {
  const line = diag.slice(0, 300);
  tell(line);
  return { policy: () => { throw new Error(line); }, reader: "broken", diag: line };
}
