import type { FleetActionKind, FleetOutcome } from "@/lib/api/fleet";
import { LP_WORDS } from "@/lib/owner-words";

/** registry 名去掉 agent- 前缀：界面上显示、以及发给 bridge 的 select.agents 都用它（bridge 两种写法都认） */
export const bare = (n: string) => n.replace(/^agent-/, "");

/** 分段按钮上的短名 + 选中时那一行说明（行为以 bridge/fleet 为准，见 docs/architecture/fleet-ops.md） */
export const ACTION_META: Record<FleetActionKind, { label: string; hint: string }> = {
  "lp-compact": { label: LP_WORDS.compactLabel, hint: LP_WORDS.compactLpHint },
  "lp-off": { label: LP_WORDS.offLabel, hint: LP_WORDS.offHint },
  compact: { label: "压缩", hint: LP_WORDS.compactHint },
  "lp-on": { label: LP_WORDS.onLabel, hint: LP_WORDS.onHint },
  "save-compact": { label: "存记忆再压缩", hint: "先存记忆再压缩；worktree 里的执行者改发 /compact。" },
  text: { label: "发一段话", hint: "逐个投递，开头带「批量指令」来源头。" },
};

/** 最常用的三个排在分段按钮上，其余收进「更多」 */
export const PRIMARY_ACTIONS: FleetActionKind[] = ["lp-compact", "lp-off", "compact"];
export const MORE_ACTIONS: FleetActionKind[] = ["lp-on", "save-compact", "text"];

/** 每行后面的结果小标：daisyUI badge 的 soft 变体，颜色只用主题 token */
export const OUTCOME_META: Record<FleetOutcome, { label: string; badge: string }> = {
  done: { label: "已执行", badge: "badge-soft badge-success" },
  queued: { label: "已排队", badge: "badge-soft badge-info" },
  skipped: { label: "已跳过", badge: "badge-soft" },
  failed: { label: "失败", badge: "badge-soft badge-error" },
};
