/** peer-MIGASK1 · `ledger shared-exec migration-ask`: freeze the batch once, then ask the center for the owner's migration
 * authorization through an ordinary `ask.create` (center rule CMIGAUTH1): kind authorize, taskId null, actions ["migration"],
 * featureIds = the batch, actionDigest over the frozen manifest. The center's ask id goes back into the frozen manifest, and a
 * local authorize card shows the owner what is being approved; the answer is forwarded by shared-ledger-v2-migration-ask-answer.
 */
import { randomUUID } from "node:crypto";
import {
  fail, parseAuthorizationBind, parseCommand, type V2AuthorizationBind, type V2Command, type V2MigrationManifest,
} from "./shared-ledger-contract-v2.js";
import type { NewAsk } from "./ledger-asks.js";
import { runExecutionMigration, type MigrationCenter, type MigrationPlan } from "./shared-ledger-v2-migration.js";
import type { MemberPort, MigrationFinding } from "./shared-ledger-v2-migration-local.js";
import { frozenManifestPath, migrationActionDigest, writeFrozenManifest } from "./shared-ledger-v2-migration-ask-frozen.js";
import { MIGRATION_APPROVE, MIGRATION_REJECT, type MigrationAskRecord } from "./shared-ledger-v2-migration-ask-answer.js";

interface MigrationAskRequest { bind: V2AuthorizationBind; command: Extract<V2Command, { type: "ask.create" }>; title: string; context: string }
/** The center checks title + context name the source instance and every feature, and that the options are exactly approve /
 * reject. The anchor is the batch's first feature: its V1 version is baseVersion and its V1 epoch fences the command. */
function migrationAskRequest(m: V2MigrationManifest, bootId: string, expiresAt: number, requestId = `migration-ask-${randomUUID()}`): MigrationAskRequest {
  const anchorId = m.featureIds[0]!, anchor = m.features.find(f => f.id === anchorId) ?? fail("invalid_field");
  const actionDigest = migrationActionDigest(m);
  const bind = parseAuthorizationBind({ taskId: null, featureId: anchorId, taskRev: null, specRev: null, workflowRev: null,
    baseVersion: anchor.currentVersion, proposalDigest: null, head: null, originalDigest: m.snapshotDigest, sharedDigest: m.snapshotDigest,
    actionDigest, redactionVersion: 1, actions: ["migration"], featureIds: [...m.featureIds], homeInstanceId: m.sourceInstanceId, expiresAt });
  const title = `迁移授权：批次 ${m.batchId}（${m.featureIds.length} 个 feature）`;
  const context = [`批次 ${m.batchId}，源实例 ${m.sourceInstanceId}，${m.authorityFrom} → ${m.authorityTo}`,
    `feature（${m.featureIds.length}）：${m.featureIds.join("、")}`, `有效期至 ${new Date(expiresAt).toISOString()}`,
    `actionDigest ${actionDigest.slice(0, 12)}`, "批准 = 中心按这份冻结清单 dry-run 并提交迁移；清单任何改动都要重新批准。"].join("\n");
  const command = parseCommand({ teamId: m.teamId, projectId: m.projectId, serviceGeneration: m.serviceGeneration, epoch: anchor.epoch,
    bootId, requestId, type: "ask.create", payload: { featureId: anchorId, taskId: null, expiresAt, kind: "authorize", blocking: true,
      title, context, options: [{ id: MIGRATION_APPROVE, label: "批准" }, { id: MIGRATION_REJECT, label: "驳回" }], allowText: false, bind } });
  return { bind, command: command as MigrationAskRequest["command"], title, context };
}

export interface MigrationAskOptions {
  root: string; plan: MigrationPlan; center: Pick<MigrationCenter, "command">; expiresAt: number;
  members?: MemberPort[]; now?: () => number;
}
export type MigrationAskOutcome =
  | { status: "refused"; findings: MigrationFinding[]; report: string }
  | { status: "asked"; record: MigrationAskRecord; title: string; context: string; expiresAt: number;
    manifestPath: string; manifestDigest: string; report: string };

/** Same local checks as dry-run (pause, backup, findings), then one ask.create. A center refusal propagates unchanged and
 * leaves the frozen manifest on the pending ask id, which dry-run / commit refuse to send. */
export async function createMigrationAsk(o: MigrationAskOptions): Promise<MigrationAskOutcome> {
  const prepared = await runExecutionMigration({ root: o.root, plan: o.plan, center: o.center as MigrationCenter, mode: "prepare",
    ...(o.members ? { members: o.members } : {}), ...(o.now ? { now: o.now } : {}) });
  if (prepared.status === "refused") return prepared;
  if (prepared.status !== "prepared") return fail("invalid_field");
  const m = prepared.manifest, req = migrationAskRequest(m, o.plan.homeBootId, o.expiresAt);
  const receipt = await o.center.command(req.command);
  if (receipt.command !== "ask.create" || receipt.requestId !== req.command.requestId) fail("dedup_mismatch");
  const sealed = writeFrozenManifest(o.root, m, receipt.result.entityId), c = req.command;
  const record: MigrationAskRecord = { teamId: c.teamId, projectId: c.projectId, centerAskId: receipt.result.entityId,
    centerFeatureId: req.bind.featureId, batchId: m.batchId, featureIds: [...m.featureIds], actionDigest: req.bind.actionDigest,
    fence: { serviceGeneration: c.serviceGeneration, epoch: c.epoch, bootId: c.bootId }, displayOnly: true, authoritative: false };
  return { status: "asked", record, title: req.title, context: req.context, expiresAt: o.expiresAt,
    manifestPath: frozenManifestPath(o.root, m.batchId), manifestDigest: sealed.manifestDigest, report: prepared.report };
}

/** The owner's card for the center ask: answered only through the bridge's owner path, never routed to an agent. */
export function migrationAskCard(project: string, out: Extract<MigrationAskOutcome, { status: "asked" }>, actor: string): NewAsk {
  return { project, source: "system", kind: "authorize", createdBy: `system:migration-ask:${actor}`, blocking: true,
    title: out.title, context: out.context, body: `冻结清单 manifestDigest ${out.manifestDigest.slice(0, 12)}，中心 ask ${out.record.centerAskId}`,
    options: [{ type: "buttons", buttons: [{ id: MIGRATION_APPROVE, label: "批准", style: "success" }, { id: MIGRATION_REJECT, label: "驳回", style: "danger" }] }],
    allowText: false, expiresAt: out.expiresAt, dedupKey: `migration-ask:${out.record.teamId}:${out.record.projectId}:${out.record.centerAskId}`,
    extra: { migrationAsk: out.record } };
}
