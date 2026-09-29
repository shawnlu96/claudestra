import type { FleetActionKind, FleetOutcome } from "@/lib/api/fleet";

/** registry 名去掉 agent- 前缀：界面上显示、以及发给 bridge 的 select.agents 都用它（bridge 两种写法都认） */
export const bare = (n: string) => n.replace(/^agent-/, "");

/** 分段按钮上的短名 + 选中时那一行说明（行为以 bridge/fleet 为准，见 docs/architecture/fleet-ops.md） */
export const ACTION_META: Record<FleetActionKind, { label: string; hint: string }> = {
  "lp-compact": { label: "开 LP 再压缩", hint: "撞墙中的会话：开 LP → 打断自动续跑 → 带保留清单压缩。" },
  "lp-off": { label: "关 LP", hint: "只对开着 LP 的会话发；关着的跳过。" },
  compact: { label: "压缩", hint: "带保留清单发 /compact；忙的排队，撞墙没开 LP 的不发。" },
  "lp-on": { label: "开 LP", hint: "只对撞墙中的会话；开着的跳过，忙的不发。" },
  "save-compact": { label: "存记忆再压缩", hint: "先存记忆再压缩；worktree 里的执行者改发 /compact。" },
  text: { label: "发一段话", hint: "逐个投递，开头带「批量指令」来源头；正忙的先排队，这一轮结束再投。" },
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
