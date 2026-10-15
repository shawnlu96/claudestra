/** Ledger writer for SHA-bound owner authorization. Open asks supersede the project's older unanswered request. */
import type { Database } from "bun:sqlite";
import { bindHash } from "./ask-bind.js";
import { openAskFull, type Ask } from "./ledger-asks.js";
import type { CenterProof } from "./center-deploy-proof.js";

const CENTER_APPROVE = "scheduler_center_deploy_approve";
export function openCenterDeployAsk(db: Database, proof: CenterProof, version: string, now: number): Ask {
  const bind = { action: "center_deploy", params: proof, version, approve: [CENTER_APPROVE] };
  return openAskFull(db, { project: proof.project, source: "system", kind: "authorize", fromAgent: "scheduler", createdBy: "system:scheduler",
    taskId: proof.cards[0], blocking: true, title: `中心部署 ${proof.sha.slice(0, 12)}`,
    body: `包含卡：${proof.cards.join("、")}\nSHA：${proof.sha.slice(0, 12)}\n批准后调度器先核对并 dry-run，再部署。`,
    dedupKey: `center-deploy:${proof.project}:${proof.repo}:${proof.sha}`, askKey: `center_deploy:${proof.project}`,
    options: [{ type: "buttons", buttons: [{ id: CENTER_APPROVE, label: "批准部署", style: "success" },
      { id: "scheduler_center_deploy_reject", label: "不批准", style: "danger" }] }],
    bind: { ...bind, paramsHash: bindHash(bind, "scheduler") } }, now).ask;
}
