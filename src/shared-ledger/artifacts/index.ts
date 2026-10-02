import {
  assertFence, assertTransactionContext, fail, id, parseArtifact, parseCommand, v2ObjectDigest,
  type V2Artifact, type V2Command, type V2DomainModule, type V2TransactionContext,
} from "../../lib/shared-ledger-contract-v2.js";
import { assertArtifactApproval, type ArtifactReaders } from "./approval.js";
import { assertArtifactPaths } from "./paths.js";
import { installArtifactSchema } from "./schema.js";
import { readArtifactSpec } from "./spec.js";

export type ArtifactPutCommand = Extract<V2Command, { type: "artifact.put" }>;
interface ArtifactResult { artifact: V2Artifact; inserted: boolean }
export interface ArtifactDomain extends V2DomainModule<ArtifactPutCommand, ArtifactResult> {
  readInTransaction(context: V2TransactionContext, artifactId: string): V2Artifact;
  readSpecInTransaction(context: V2TransactionContext, taskId: string): ReturnType<typeof readArtifactSpec>;
}
function findArtifact(context: V2TransactionContext, artifactId: string): V2Artifact | null {
  const rows = context.all("artifacts.get", { artifactId: id(artifactId) });
  return rows.length ? parseArtifact(rows[0]) : null;
}
/** Both foreign ids and missing ids yield only not_found. Scope comes from authenticated X12 identity. */
function readInTransaction(context: V2TransactionContext, artifactId: string): V2Artifact {
  assertTransactionContext(context);
  if (!context.scope.actor.projects.includes(context.scope.projectId)) fail("not_found");
  return findArtifact(context, artifactId) ?? fail("not_found");
}
export function createArtifactDomain(readers: ArtifactReaders): ArtifactDomain {
  return {
    installSchema: installArtifactSchema,
    readInTransaction,
    readSpecInTransaction: (context, taskId) => readArtifactSpec(context, taskId, readers, readInTransaction),
    applyInTransaction(context, input) {
      assertTransactionContext(context);
      const command = parseCommand(input);
      if (command.type !== "artifact.put") fail();
      if (command.teamId !== context.scope.teamId || command.projectId !== context.scope.projectId
        || !context.scope.actor.actions.includes("artifact.put")) fail("forbidden");
      const { serviceGeneration, epoch, bootId } = context.scope;
      assertFence({ serviceGeneration, epoch, bootId }, {
        serviceGeneration: command.serviceGeneration, epoch: command.epoch, bootId: command.bootId,
      });
      const artifact = command.payload.artifact;
      assertArtifactPaths(artifact);
      const existing = findArtifact(context, artifact.artifactId);
      if (existing) {
        if (v2ObjectDigest(existing) !== v2ObjectDigest(artifact)) fail("dedup_mismatch");
        // A retry reads the committed result; it does not grant new sharing after approval expires.
        return { artifact: existing, inserted: false };
      }
      assertArtifactApproval(context, artifact, readers);
      const { approvalAskId, originalDigest, sharedDigest, redactionVersion, taskId, specRev, head, approvedBy } = artifact;
      // Even a faulty upstream replacement of an answered ask cannot rebind a previously used approval.
      if (context.all("artifacts.approvalConflict", {
        approvalAskId, originalDigest, sharedDigest, redactionVersion, taskId, specRev, head, approvedBy,
      }).length) fail("authorization_mismatch");
      const { teamId: _team, projectId: _project, ...bindings } = artifact;
      context.run("artifacts.put", bindings);
      return { artifact, inserted: true };
    },
  };
}
