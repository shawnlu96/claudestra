/** Data-only workflows: v2 and v3 for every template, v3 differing only at approve_restate. The interpreter in scheduler-plan.ts owns conditions and side effects. */
import type { LedgerEvent, LedgerTask, Stage, StepName } from "./ledger-stages.js";
import type { SchedulerIntent, WorkflowTemplate } from "./ledger-scheduler.js";

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

/**
 * v3 of every template: the executor's own restate record releases build; PM steps in only via restate-hold. It differs from v2
 * only at approve_restate's gate — the ui screenshot gate and security's local-only review key off the template name, not the version.
 */
const CODE_V3_NODES: readonly FlowNode[] = CODE_NODES.map((n) => n.id === "approve_restate" ? { ...n, gate: "restate_recorded" as const } : n);
const FLOW_TEMPLATES_V3: Record<WorkflowTemplate, FlowTemplate> = {
  code: { ...FLOW_TEMPLATES.code, version: 3, nodes: CODE_V3_NODES },
  ui: { ...FLOW_TEMPLATES.ui, version: 3, nodes: CODE_V3_NODES },
  security: { ...FLOW_TEMPLATES.security, version: 3, nodes: CODE_V3_NODES },
};
/** What a newly opened auto card gets (start_node, scheduler autostart): read the version here, never hard-code it. */
export const LATEST_TEMPLATE_VERSION: Record<WorkflowTemplate, 3> = { code: 3, ui: 3, security: 3 };

/** null = no such (template, version); callers treat that as drift / invalid, never as a default. */
export function templateFor(template: WorkflowTemplate, version: number): FlowTemplate | null {
  if (version === 2) return FLOW_TEMPLATES[template] ?? null;
  if (version === 3) return FLOW_TEMPLATES_V3[template] ?? null;
  return null;
}

type GateDecision = { kind: "wait" | "escalate"; code: string; reason: string };
const RELEASES = new Set(["restate_approved", "restate_released"]);

/** A restate-hold for this specRev with no restate-approve / restate-release after it. */
function openHold(task: LedgerTask, events: readonly LedgerEvent[]): GateDecision | null {
  const released = events.findLast((e) => e.kind === "decision" && RELEASES.has(String(e.data.op)) && e.data.specRev === task.specRev)?.seq ?? 0;
  const hold = events.findLast((e) => e.kind === "decision" && e.data.op === "restate_hold" && e.data.specRev === task.specRev && e.seq > released);
  return hold ? { kind: "wait", code: "restate_hold", reason: `PM 拦住了复述：${hold.text || "等 PM 放行"}` } : null;
}

/** True once a write order for this specRev left pending (submitted / done / unknown) — past that point a hold stops nothing. */
const writeOrderSent = (task: LedgerTask, intents: readonly SchedulerIntent[]): boolean =>
  intents.some((i) => i.node === "write" && i.action === "dispatch" && i.specRev === task.specRev && i.status !== "pending" && i.status !== "cancelled");

/**
 * v3 only. restate: the executor's own spec→restate event for this specRev must carry the restate text; a blocked→restate
 * recovery is PM bookkeeping, never a restatement. No record → PM (the executor can't restate twice). An open restate-hold
 * waits here and again in build until the write order is sent. v2 returns null, so its pm_restate path is untouched.
 */
export function restateGate(template: FlowTemplate, node: FlowNode, task: LedgerTask, events: readonly LedgerEvent[],
  intents: readonly SchedulerIntent[]): GateDecision | null {
  if (template.version !== 3) return null;
  if (node.gate === "restate_recorded") {
    const record = events.findLast((e) => e.kind === "stage" && e.data.from === "spec" && e.data.to === "restate" && e.data.specRev === task.specRev);
    if (!record?.text.trim()) return { kind: "escalate", code: "restate_missing", reason: "没有本规格版本的复述记录，不开工" };
    return openHold(task, events);
  }
  return node.id === "write" && !writeOrderSent(task, intents) ? openHold(task, events) : null;
}

/** The stage machine remains canonical; templates only choose work within its legal states. */
export const nodeAt = (template: FlowTemplate, stage: Stage): FlowNode | null => template.nodes.find((n) => n.stage === stage) ?? null;
