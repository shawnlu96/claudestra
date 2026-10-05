/** Read-only owner approval for MODEL; AUD supplies the ledger when composing the runtime ports. */
import type { Database } from "bun:sqlite";
import { OWNER_PRINCIPAL_ID } from "./devices.js";
import { hasAsksTable, listAsks, ownerAnswered } from "./ledger-asks.js";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import type { RefusalApproval, RefusalApprovalPort } from "./scheduler-model-outcome.js";

const ASK_KEYS = new Set(["policy-refusal-rule", "refusal_rule_exec"]);
const APPROVE_BUTTONS = new Set(["policy_refusal_rule_go", "refusal_rule_keep_supervisor"]);

/** Keep raw extra validation here: the general task reader normalizes unreadable shapes to an empty object. */
function cardFacts(db: Database, project: string, taskId: string): Pick<RefusalApproval, "content" | "ownerHold"> | null {
  const task = db.query("SELECT project, stage, headSHA, specRev, extra FROM tasks WHERE id = ?").get(taskId) as
    { project: string; stage: string; headSHA: unknown; specRev: unknown; extra: unknown } | null;
  if (!task || task.project !== project) return null;
  if (typeof task.extra !== "string" || !task.extra) throw new Error("refusal approval: missing task extra");
  const extra: unknown = JSON.parse(task.extra);
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) throw new Error("refusal approval: invalid task extra");
  // The latest work ticket wins; an older matching review cannot authorize a newer dispatch or stale review.
  const intent = db.query(`SELECT action, head, specRev FROM scheduler_intents
    WHERE project = ? AND taskId = ? AND action IN ('review', 'dispatch') ORDER BY eventSeq DESC LIMIT 1`)
    .get(project, taskId) as Pick<SchedulerIntent, "action" | "head" | "specRev"> | null;
  const allowed = task.stage === "review" && typeof task.headSHA === "string" && task.headSHA.length > 0 &&
    typeof task.specRev === "number" && Number.isInteger(task.specRev) && task.specRev > 0 &&
    intent?.action === "review" && intent.head === task.headSHA && intent.specRev === task.specRev;
  return { content: allowed ? "allowed" : "uncertain", ownerHold: (extra as Record<string, unknown>).refusalHold === true };
}

/** No config, credentials, writes or notifications. Read errors deliberately reach MODEL's approvalDiag path. */
export function createRefusalApprovalPort(db: Database): RefusalApprovalPort {
  return (project, taskId) => {
    if (!hasAsksTable(db)) return null;
    const answers = listAsks(db, { project, states: ["answered"] }).filter((a) =>
      ASK_KEYS.has(a.askKey ?? "") && ownerAnswered(a.answer) && a.answer?.principal === OWNER_PRINCIPAL_ID);
    // An undated owner answer could be a newer revocation: never silently fall back to an older approval.
    if (answers.some((a) => typeof a.answer!.at !== "number" || !Number.isFinite(a.answer!.at))) {
      throw new Error("refusal approval: missing answer time");
    }
    answers.sort((a, b) => b.answer!.at - a.answer!.at);
    const latest = answers[0];
    if (!latest) return null;
    if (answers[1]?.answer!.at === latest.answer!.at) throw new Error("refusal approval: ambiguous latest answer");
    const facts = cardFacts(db, project, taskId);
    if (!facts) return null;
    const choices = latest.answer!.choices;
    const button = Array.isArray(choices) && choices.length === 1 && typeof choices[0] === "string"
      ? /^\[button:([^\]]+)\]$/.exec(choices[0])?.[1] : undefined;
    return { approvalId: latest.id, source: `askKey=${latest.askKey}; button=${button ?? "unavailable"}; answer.at=${latest.answer!.at}`,
      scope: "routine_readonly_review", ...facts, revoked: !button || !APPROVE_BUTTONS.has(button) };
  };
}
