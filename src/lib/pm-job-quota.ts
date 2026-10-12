/**
 * PM 处理员开跑前的 Codex 额度门（agents-PMJOB1）：复用 inventory 的周窗口读数和项目既有额度线，有效线 = min(70, 项目线)。
 * 和调度器的 codexQuotaWait 不同：读不到 / 未知 / 过期 / 已重置未确认的读数不算有预算（那边是不拦），一律不上模型、升级 PM；
 * 不改项目额度线、不换 Claude、不借额度。
 */
import { readInventoryQuota, type InventoryQuota } from "./ai-quota.js";
import { codexWeeklyLineAt } from "./quota-codex-line.js";

const PM_JOB_CODEX_LINE = 70;

export type PmJobQuotaGate = { ok: true; line: number; usedPct: number } | { ok: false; kind: "over" | "unknown"; reason: string };
export type PmJobQuotaReader = () => Promise<InventoryQuota>;
const readCodex: PmJobQuotaReader = async () => (await readInventoryQuota()).codex;

export async function pmJobQuotaGate(project: string, read: PmJobQuotaReader = readCodex, now = Date.now(),
  lineOf: (project: string) => number = (p) => codexWeeklyLineAt(p)): Promise<PmJobQuotaGate> {
  let q: InventoryQuota;
  try { q = await read(); } catch (e) { return { ok: false, kind: "unknown", reason: `Codex 额度读不到：${(e as Error).message.slice(0, 200)}` }; }
  if (q.limitReached === true) return { ok: false, kind: "over", reason: "Codex 提供方明确已撞限额" };
  if (q.status !== "known") return { ok: false, kind: "unknown", reason: `Codex 额度未知${q.reason ? `：${q.reason.slice(0, 200)}` : ""}` };
  const weekly = q.windows.filter((w) => w.kind === "weekly" || w.kind === "weekly_scoped");
  const valid = weekly.filter((w) => !w.resetPassed && (w.resetsAtMs === null || w.resetsAtMs > now) && w.usedPct !== null && Number.isFinite(w.usedPct));
  // 任何一个周窗口读数无效（过期 / 应已重置未确认 / 没有数）都不冒称有预算
  if (!weekly.length || valid.length !== weekly.length) return { ok: false, kind: "unknown", reason: "Codex 周窗口读数过期或未知，不冒称有预算" };
  const line = Math.min(PM_JOB_CODEX_LINE, lineOf(project)), top = valid.reduce((a, b) => (b.usedPct! > a.usedPct! ? b : a));
  if (top.usedPct! >= line) return { ok: false, kind: "over", reason: `Codex 周额度 ${top.id} 已用 ${top.usedPct}%，达到处理员 ${line}% 线` };
  return { ok: true, line, usedPct: top.usedPct! };
}
