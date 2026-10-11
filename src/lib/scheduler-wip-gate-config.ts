/**
 * WIP 闸（dispatch-recovery-WIPGATE1）的配置与队列深度：档位 / 阈值存在项目 meta 的 autostart JSON（wipGate / wipGateThreshold），
 * 由 `ledger autostart-set --wip-gate on|observe|off --wip-gate-threshold N` 合并写入、沿用它的权限与审计。
 * 未配置 = observe、阈值 15；读开关抛错、档位或阈值非法、队列读取抛错一律按 off（不伪造深度 0）。
 * 深度 = 项目合并队列的张数（ledger-merge-queue-view.ts mergeQueueCards，即 merge-queue 命令的 rows），不数人工合并请求。
 */
import type { Database } from "bun:sqlite";
import { mergeQueueCards } from "./ledger-merge-queue-view.js";
import { LedgerError } from "./ledger-store.js";
import { readSwitch, type AutostartSwitch } from "./scheduler-autostart.js";

type WipGateMode = "on" | "observe" | "off";
export interface WipGateConfig { mode: WipGateMode; threshold: number }

const WIP_GATE_DEFAULT_THRESHOLD = 15;
const MODES: readonly string[] = ["on", "observe", "off"];
const OFF: WipGateConfig = { mode: "off", threshold: WIP_GATE_DEFAULT_THRESHOLD };

/** 项目此刻的闸档位与阈值；任何读不准的情况都按 off */
export function wipGateConfig(db: Database, project: string): WipGateConfig {
  let sw: AutostartSwitch;
  try { sw = readSwitch(db, project); } catch { return OFF; }
  // 只有字段缺省才用缺省值；写了 null 等非法值按 off
  const mode: unknown = sw.wipGate === undefined ? "observe" : sw.wipGate;
  const threshold: unknown = sw.wipGateThreshold === undefined ? WIP_GATE_DEFAULT_THRESHOLD : sw.wipGateThreshold;
  if (typeof mode !== "string" || !MODES.includes(mode) || typeof threshold !== "number" || !Number.isSafeInteger(threshold) || threshold <= 0) return OFF;
  return { mode: mode as WipGateMode, threshold };
}

/** autostart-set 的两个新旗标：非法整笔拒（调用方在写库前调），合法的只返回给了的字段，其余字段不动 */
export function wipGateInput(mode?: string, threshold?: string): Pick<AutostartSwitch, "wipGate" | "wipGateThreshold"> {
  if (mode !== undefined && !MODES.includes(mode)) throw new LedgerError("invalid", "--wip-gate 只能是 on / observe / off");
  const n = threshold === undefined ? undefined : /^[1-9]\d*$/.test(threshold.trim()) ? Number(threshold.trim()) : NaN;
  if (n !== undefined && !Number.isSafeInteger(n)) throw new LedgerError("invalid", `--wip-gate-threshold 要是正整数，收到 ${threshold}`);
  return { ...(mode !== undefined ? { wipGate: mode as WipGateMode } : {}), ...(n !== undefined ? { wipGateThreshold: n } : {}) };
}

/** 合并队列深度；读取抛错为 null（调用方按 off 处理） */
export function wipGateDepth(db: Database, project: string): number | null {
  try { return mergeQueueCards(db, project).length; } catch { return null; }
}

export const wipGateHoldText = (depth: number, threshold: number): string =>
  `合并队列 ${depth} 张，已到 WIP 闸阈值 ${threshold}（wip-gate on）：先收尾，暂不开新卡，队列降到阈值以下自动恢复`;

/** on 且深度 ≥ 阈值时的等待原因，否则 null；只读、不记日志（重核点用：claim 事务、本机建作者、挂新 write 单） */
export function wipGateHold(db: Database, project: string, firstAdmission: () => boolean = () => true): string | null {
  const cfg = wipGateConfig(db, project);
  if (cfg.mode !== "on" || !firstAdmission()) return null;
  const depth = wipGateDepth(db, project);
  return depth !== null && depth >= cfg.threshold ? wipGateHoldText(depth, cfg.threshold) : null;
}
