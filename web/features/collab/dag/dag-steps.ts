/**
 * 节点里的那条进度条（纯函数，单测 tests/web-collab-dag-layout.test.ts）：复述、写、审第 N 轮、修、合并、验证六格，
 * 按 L4 节点上的 stepLine（src/lib/ledger-step-line.ts 的 active + steps）画。这些步骤只是节点内部的进度，不画成节点。
 * 初审、终审并进「审」一格（轮次取大的）；看界面并进「合并」（合并前的截图闸）。没 stepLine = 全空。
 */
import type { StepLineLite } from "./dag-types";

export const STEP_SLOTS = [
  { key: "restate", label: "复述", steps: ["restate"] },
  { key: "write", label: "写", steps: ["write"] },
  { key: "review", label: "审", steps: ["review", "final_review"] },
  { key: "fix", label: "修", steps: ["fix"] },
  { key: "merge", label: "合并", steps: ["ui_check", "merge"] },
  { key: "verify", label: "验证", steps: ["verify"] },
] as const;

export type SlotState = "done" | "cur" | "todo";
export interface NodeStep { key: string; label: string; state: SlotState; round: number }

const slotOf = (step: string) => STEP_SLOTS.findIndex((s) => (s.steps as readonly string[]).includes(step));
/** 步骤名（write / final_review …）落在哪一格；不认识 = undefined */
export const slotOfStep = (step: string | null): (typeof STEP_SLOTS)[number] | undefined => STEP_SLOTS[slotOf(step ?? "")];

export function nodeSteps(sl: StepLineLite | null | undefined): { slots: NodeStep[]; current: NodeStep | null } {
  const rows = Array.isArray(sl?.steps) ? sl.steps.filter((r) => r && typeof r.step === "string") : [];
  const cur = sl?.active && typeof sl.active.step === "string" ? slotOf(sl.active.step) : -1;
  const slots = STEP_SLOTS.map((s, i): NodeStep => {
    const mine = rows.filter((r) => slotOf(r.step) === i);
    const round = Math.max(0, ...mine.map((r) => Number(r.round) || 0), i === cur ? Number(sl?.active?.round) || 0 : 0);
    const finished = mine.some((r) => r.state === "done" || r.state === "delivered");
    const state: SlotState = i === cur ? "cur" : (cur >= 0 && i < cur && mine.length > 0) || (cur < 0 && finished) ? "done" : "todo";
    return { key: s.key, label: s.label, state, round };
  });
  return { slots, current: cur >= 0 ? slots[cur]! : null };
}
