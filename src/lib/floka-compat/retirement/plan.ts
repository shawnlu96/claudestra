/**
 * 分项退出计划：观察样本的退出理由（floka-observation/exit.ts）按项分摊（items.ts），再叠上允许表状态与阶段顺序。
 * 只出数据、不写任何东西；一项被挡不影响另一项的判定，可退出也只是「可以交 PM 核」，真正收掉要 on 档且逐项点名。
 */
import { createHash } from "node:crypto";
import { exitReasons } from "../../floka-observation/exit.js";
import type { ExitReason, ObservationSample } from "../../floka-observation/types.js";
import type { CompatAllowlist } from "./allowlist.js";
import type { RetireGear } from "./gear.js";
import { PHASE, reasonsFor, RETIRE_ITEMS, type RetireItem } from "./items.js";

/** 一次实际删除的规模上限（规格：超过三小时或十二条另拆执行卡）；只报告，不替 PM 拆 */
const DELETE_BUDGET = 12;

export interface ItemPlan {
  item: RetireItem;
  phase: 1 | 2;
  /** active = 允许表里还有它的条目；retired = 已全部收掉；empty = 表里从没登记过它 */
  state: "active" | "retired" | "empty";
  retirable: boolean;
  reasons: ExitReason[];
  entries: string[];
  files: string[];
  restore: string;
}

export interface RetirementPlan {
  v: 1;
  gear: Exclude<RetireGear, "off">;
  generatedAt: number;
  allowlistSha256: string;
  items: ItemPlan[];
  retain: { id: string; protects: string[] }[];
  budget: { retirableEntries: number; limit: number; splitRequired: boolean };
}

export const sha256Text = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

const restoreHint = (item: RetireItem): string =>
  `把 retired 里 item=${item} 的条目原样搬回 entries（去掉 retiredAt）；或用 on 档目标目录里的 compat-allowlist.recovery.json 整份覆盖`;

export function buildPlan(
  sample: ObservationSample, list: CompatAllowlist, allowlistText: string, gear: Exclude<RetireGear, "off">, now: number,
): RetirementPlan {
  const all = exitReasons(sample, now);
  const draft = RETIRE_ITEMS.map((item): ItemPlan => {
    const active = list.entries.filter((e) => e.item === item);
    const state = active.length ? "active" : list.retired.some((e) => e.item === item) ? "retired" : "empty";
    const reasons = reasonsFor(item, all);
    return {
      item, phase: PHASE[item], state, retirable: state === "active" && reasons.length === 0, reasons,
      entries: active.map((e) => e.id), files: [...new Set(active.flatMap((e) => e.files))].sort(), restore: restoreHint(item),
    };
  });
  // 阶段 1 还有项没收：阶段 2 一律记 phase_order，不跳级；同一次 on 把它们一起点名时由 run.ts 抵消
  const stuck = draft.filter((p) => p.phase === 1 && p.state === "active").map((p) => p.item);
  const items = draft.map((p) => p.phase === 2 && p.state === "active" && stuck.length
    ? { ...p, retirable: false, reasons: [...p.reasons, ...stuck.map((s) => ({ code: "phase_order", subject: s }))] }
    : p);
  const retirableEntries = items.filter((p) => p.retirable).reduce((n, p) => n + p.entries.length, 0);
  return {
    v: 1, gear, generatedAt: now, allowlistSha256: sha256Text(allowlistText), items,
    retain: list.retain.map((r) => ({ id: r.id, protects: [...r.protects] })),
    budget: { retirableEntries, limit: DELETE_BUDGET, splitRequired: retirableEntries > DELETE_BUDGET },
  };
}
