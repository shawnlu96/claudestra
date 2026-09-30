/** Data-only workflows (v2 all templates, v3 code only). The interpreter in scheduler-plan.ts owns conditions and side effects. */
import type { LedgerEvent, LedgerTask, Stage, StepName } from "./ledger-stages.js";
import type { WorkflowTemplate } from "./ledger-scheduler.js";

type NodeAction = "dispatch" | "review" | "stage" | "ask" | "merge" | "verify" | "retire";
export interface FlowNode {
  id: string;
  stage: Stage;
  action: NodeAction;
  step?: StepName;
  next?: Stage;
  gate?: "pm_restate" | "restate_recorded" | "owner_screenshot" | "ci_and_review";
}
export interface FlowTemplate {
  id: WorkflowTemplate;
  version: 2 | 3;
  reviewMode: "adversarial";
  crossFamily: true;
  uiGate: boolean;
  nodes: readonly FlowNode[];
}

const CODE_NODES: readonly FlowNode[] = [
  { id: "restate", stage: "spec", action: "dispatch", step: "restate" },
  { id: "approve_restate", stage: "restate", action: "stage", next: "build", gate: "pm_restate" },
  { id: "write", stage: "build", action: "dispatch", step: "write" },
  { id: "adversarial_review", stage: "review", action: "review", step: "review" },
  { id: "fix", stage: "fix", action: "dispatch", step: "fix" },
  { id: "merge_deploy", stage: "merge", action: "merge", gate: "ci_and_review" },
  { id: "verify", stage: "live", action: "verify" },
  { id: "retire", stage: "verified", action: "retire", next: "done" },
];

export const FLOW_TEMPLATES: Record<WorkflowTemplate, FlowTemplate> = {
  code: { id: "code", version: 2, reviewMode: "adversarial", crossFamily: true, uiGate: false, nodes: CODE_NODES },
  ui: { id: "ui", version: 2, reviewMode: "adversarial", crossFamily: true, uiGate: true, nodes: CODE_NODES },
  security: { id: "security", version: 2, reviewMode: "adversarial", crossFamily: true, uiGate: false, nodes: CODE_NODES },
};

/** code v3: the executor's own restate record releases build; PM steps in only via restate-hold. ui / security stay on v2. */
const CODE_V3_NODES: readonly FlowNode[] = CODE_NODES.map((n) => n.id === "approve_restate" ? { ...n, gate: "restate_recorded" as const } : n);
const FLOW_TEMPLATES_V3: Partial<Record<WorkflowTemplate, FlowTemplate>> = {
  code: { ...FLOW_TEMPLATES.code, version: 3, nodes: CODE_V3_NODES },
};

/** null = no such (template, version); callers treat that as drift / invalid, never as a default. */
export function templateFor(template: WorkflowTemplate, version: number): FlowTemplate | null {
  if (version === 2) return FLOW_TEMPLATES[template] ?? null;
  if (version === 3) return FLOW_TEMPLATES_V3[template] ?? null;
  return null;
}

/**
 * restate_recorded: the stage event that put the card in restate (enteredSeq) must be for this specRev and carry the restate
 * text (normally "复述见 reviews/<task>-restate.md"); without it the card goes to PM, since the executor can't restate twice.
 * An open restate-hold (no restate-approve after it) waits.
 */
export function restateRecordedGate(task: LedgerTask, events: readonly LedgerEvent[], enteredSeq: number):
  { kind: "wait" | "escalate"; code: string; reason: string } | null {
  const entered = events.find((e) => e.seq === enteredSeq && e.kind === "stage" && e.data.to === "restate");
  if (!entered || entered.data.specRev !== task.specRev || !entered.text.trim()) {
    return { kind: "escalate", code: "restate_missing", reason: "没有本规格版本的复述记录，不开工" };
  }
  const since = events.findLast((e) => e.kind === "decision" && e.data.op === "restate_approved" && e.data.specRev === task.specRev)?.seq ?? 0;
  const hold = events.findLast((e) => e.kind === "decision" && e.data.op === "restate_hold" && e.data.specRev === task.specRev && e.seq > since);
  return hold ? { kind: "wait", code: "restate_hold", reason: `PM 拦住了复述：${hold.text || "等 PM 放行"}` } : null;
}

/** The stage machine remains canonical; templates only choose work within its legal states. */
export const nodeAt = (template: FlowTemplate, stage: Stage): FlowNode | null => template.nodes.find((n) => n.stage === stage) ?? null;
