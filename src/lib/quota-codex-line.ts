/**
 * Codex 周额度线（i28-QL1）：项目 meta `autostart` 的 `codexWeeklyLinePct`，缺省 85，合法 50–100。
 * 读不到台账、没配、值不合法（字符串、越界、非整数）一律按 85，不抛错——额度门不能因为配置坏了而停摆。
 */
import { Database } from "bun:sqlite";
import { LEDGER_PATH, LedgerError } from "./ledger-store.js";

export const DEFAULT_CODEX_LINE = 85;
interface CodexLineSwitch { codexWeeklyLinePct?: unknown }

const valid = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 50 && v <= 100;

/** meta autostart 值（已解析）里的 Codex 线 */
export const codexLineOf = (sw: unknown): number => {
  const v = sw && typeof sw === "object" ? (sw as CodexLineSwitch).codexWeeklyLinePct : undefined;
  return valid(v) ? v : DEFAULT_CODEX_LINE;
};

/** `autostart-set --codex-line` 的校验 */
export function checkCodexLine(v: number | undefined): void {
  if (v !== undefined && !valid(v)) throw new LedgerError("invalid", "--codex-line 要是 50–100 的整数");
}

/** 按项目读 Codex 线；没项目、没这行、JSON 坏了都按 85 */
export function codexWeeklyLine(db: Database, project: string | undefined): number {
  if (!project) return DEFAULT_CODEX_LINE;
  try {
    const row = db.query("SELECT value FROM meta WHERE project = ? AND key = 'autostart'").get(project) as { value: string } | null;
    return row ? codexLineOf(JSON.parse(row.value)) : DEFAULT_CODEX_LINE;
  } catch { return DEFAULT_CODEX_LINE; }
}

/** 运行时开槽用：只读打开台账再读；台账打不开也按 85 */
export function codexWeeklyLineAt(project: string | undefined, ledgerPath = LEDGER_PATH): number {
  if (!project) return DEFAULT_CODEX_LINE;
  let db: Database | null = null;
  try {
    db = new Database(ledgerPath, { readonly: true });
    return codexWeeklyLine(db, project);
  } catch { return DEFAULT_CODEX_LINE; }
  finally { db?.close(); }
}
