/** Shared fixtures for POST /v1/teams/{teamId}/source-dags. Tests compute digests from these; no digest literal lives here. */
import type { SourceDagUpload, SourceDagUploadError } from "./shared-ledger-contract-source-dag.js";

export const SOURCE_DAG_UPLOAD_FIXTURE: SourceDagUpload = {
  schemaVersion: 1, projectId: "project-a", featureId: "feature-global-a", sourceInstanceId: "instance-home",
  dag: {
    version: 17,
    nodes: [
      { key: "A1", oneLine: "契约", deps: [], fileGlobs: ["src/lib/a.ts"], estimate: "S" },
      { key: "A2", oneLine: "实现", deps: ["A1"], fileGlobs: ["src/b/**"], estimate: "M" },
    ],
    bindings: [{ nodeKey: "A1", taskId: "task-source-a" }, { nodeKey: "A2", taskId: "task-source-unmapped" }],
    reason: "本机 v17：新增实现节点",
  },
};

/** digest is filled by the caller (center or test) from sourceDagUploadDigest(SOURCE_DAG_UPLOAD_FIXTURE). */
export const SOURCE_DAG_UPLOAD_RESULT_FIXTURE = {
  schemaVersion: 1, featureId: "feature-global-a", version: 17, droppedBindings: 1,
} as const;

export const SOURCE_DAG_UPLOAD_ERROR_FIXTURES: Record<SourceDagUploadError["code"], SourceDagUploadError> = {
  conflict: { schemaVersion: 1, code: "conflict", status: 409, message: "version 17 already exists with different content", currentVersion: 18 },
  forbidden: { schemaVersion: 1, code: "forbidden", status: 403, message: "not the home instance of a source feature" },
  invalid_field: { schemaVersion: 1, code: "invalid_field", status: 400, message: "invalid_field" },
};
