/** Data-only v2 workflows. The interpreter in scheduler-plan.ts owns conditions and side effects. */
import type { Stage, StepName } from "./ledger-stages.js";
import type { WorkflowTemplate } from "./ledger-scheduler.js";

type NodeAction = "dispatch" | "review" | "stage" | "ask" | "merge" | "verify" | "retire";
export interface FlowNode {
  id: string;
  stage: Stage;
  action: NodeAction;
  step?: StepName;
  next?: Stage;
  gate?: "pm_restate" | "owner_screenshot" | "ci_and_review";
}
export interface FlowTemplate {
  id: WorkflowTemplate;
  version: 2;
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

/** The stage machine remains canonical; templates only choose work within its legal states. */
export const nodeAt = (template: FlowTemplate, stage: Stage): FlowNode | null => template.nodes.find((n) => n.stage === stage) ?? null;
