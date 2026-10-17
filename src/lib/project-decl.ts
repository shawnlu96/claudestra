/** Read-only trust boundary. No declaration executes here, and no cache survives a target / basis / policy change. */
import { createHash } from "node:crypto";
import type { ProjectDef } from "./projects.js";
import { recoveryPolicy, type ObservedAction, type RecoveryMode } from "./recovery-policy.js";
import { builtinProjectDeclaration, isFlokaDeclRepository } from "./project-decl-builtin.js";
import { declarationCapabilities, declarationPaths, restrictDeclaration, type DeclCapability } from "./project-decl-capabilities.js";
import { assertObjectPath, DeclReadError, isDeclAncestor, objectMode, readDeclBlob, readDeclTree, resolveDeclRepository, type DeclRepository } from "./project-decl-git.js";
import { declarationDiagnostic, parseProjectDeclaration, parseProjectJson, remoteIdentity, type DeclDiagnostic, type ProjectDeclaration,
  type ProjectDeclRestrictions } from "./project-decl-schema.js";

export interface ProjectDeclResult {
  source: DeclDiagnostic["source"]; targetHead: string | null; mode: RecoveryMode; declaration: ProjectDeclaration | null;
  restrictions?: ProjectDeclRestrictions; capabilities: DeclCapability[]; diagnostics: DeclDiagnostic[]; valid: boolean;
}
export interface ProjectDeclOptions {
  project: ProjectDef; repoDir: string;
  /** Trusted task branch on origin, never supplied by a declaration or PR head. Absent uses origin/HEAD. */
  targetBranch?: string;
  mode?: RecoveryMode; now?: number;
  /** Optional observation sink. CLI leaves it absent to remain strictly read-only. Receives no argv or environment. */
  observe?: (action: ObservedAction) => void;
}
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
function loadSelected(repo: DeclRepository): { declaration: ProjectDeclaration | null; source: ProjectDeclResult["source"]; diagnostics: DeclDiagnostic[] } {
  const mode = objectMode(repo.root, repo.targetHead, ".floka", repo.tree);
  if (mode && mode !== "040000") throw new DeclReadError("PATH_ESCAPE", ".floka");
  const declared = mode && objectMode(repo.root, repo.targetHead, ".floka/project.json", repo.tree);
  if (!declared) return { declaration: builtinProjectDeclaration(repo), source: "builtin", diagnostics: [] };
  let raw: unknown;
  try { raw = parseProjectJson(readDeclBlob(repo.root, repo.targetHead, ".floka/project.json", repo.tree).toString()); }
  catch (error) {
    if (error instanceof DeclReadError) throw error;
    throw new DeclReadError(error instanceof Error && error.message === "AMBIGUOUS_JSON" ? "AMBIGUOUS_JSON" : "CORRUPT_DECLARATION", ".floka/project.json");
  }
  const parsed = parseProjectDeclaration(raw);
  return { ...parsed, source: "target", diagnostics: parsed.diagnostics.map((d) => ({ ...d, targetHead: repo.targetHead })) };
}
function verifyBasis(repo: DeclRepository, d: ProjectDeclaration, now: number, caps: DeclCapability[]): { field: string; reason: string }[] {
  const issues: { field: string; reason: string }[] = [];
  const trees = new Map([[repo.targetHead, repo.tree]]), hashes = new Map<string, string>(), ancestors = new Map<string, boolean>();
  const contentHash = (head: string, path: string) => {
    const key = `${head}:${path}`;
    if (!trees.has(head)) trees.set(head, readDeclTree(repo.root, head));
    if (!hashes.has(key)) hashes.set(key, digest(readDeclBlob(repo.root, head, path, trees.get(head))));
    return hashes.get(key);
  };
  const ancestor = (head: string) => {
    if (!ancestors.has(head)) ancestors.set(head, isDeclAncestor(repo.root, head, repo.targetHead));
    return ancestors.get(head);
  };
  for (const { path, sha256 } of [...d.basis, ...(d.ci.proof ?? [])]) {
    if (contentHash(repo.targetHead, path) !== sha256) issues.push({ field: `basis.${path}`, reason: "BASIS_CHANGED" });
  }
  for (const cap of caps) {
    const p = cap.provenance;
    if (p.status === "inferred") { issues.push({ field: cap.field, reason: "INFERRED_CAPABILITY" }); continue; }
    if (!d.basis.length || !p.verifiedHead || p.verifiedHead.length !== repo.targetHead.length || !p.verifiedAt || Date.parse(p.verifiedAt) > now
      || !ancestor(p.verifiedHead)) {
      issues.push({ field: cap.field, reason: "UNTRUSTED_PROVENANCE" }); continue;
    }
    for (const b of d.basis) {
      try {
        if (contentHash(p.verifiedHead, b.path) !== b.sha256) issues.push({ field: cap.field, reason: "VERIFICATION_BASIS_MISMATCH" });
      } catch { issues.push({ field: cap.field, reason: "VERIFICATION_BASIS_MISSING" }); /* A missing historic basis invalidates this verification. */ }
    }
  }
  return issues;
}
function finish(result: ProjectDeclResult, o: ProjectDeclOptions): ProjectDeclResult {
  const global = result.diagnostics.some((d) => !["INFERRED_CAPABILITY", "UNTRUSTED_PROVENANCE", "VERIFICATION_BASIS_MISMATCH",
    "VERIFICATION_BASIS_MISSING", "LOCAL_CAPABILITY_DISABLED", "UNSUPPORTED_DEPLOY_ADAPTER", "OBSERVE_ONLY"].includes(d.reasonCode));
  for (const cap of result.capabilities) {
    cap.wouldBeAvailable = !global && !result.diagnostics.some((d) => d.field === cap.field);
    cap.available = result.mode === "on" && cap.wouldBeAvailable;
  }
  result.valid = !!result.declaration && !result.diagnostics.some((d) => d.reasonCode !== "OBSERVE_ONLY");
  if (result.mode === "observe") {
    result.diagnostics.push(declarationDiagnostic("OBSERVE_ONLY", "recovery.projectDecl", result.source, result.targetHead));
    o.observe?.({ project: o.project.id, mechanism: "projectDecl", target: result.targetHead ?? "", actionKey: "declaration",
      action: "compare project declaration availability", data: { previous: "unchanged", candidate: result.valid,
        reasonCodes: result.diagnostics.map((d) => d.reasonCode) } });
  }
  return result;
}
export function loadProjectDeclaration(o: ProjectDeclOptions): ProjectDeclResult {
  const result: ProjectDeclResult = { source: "none", targetHead: null, mode: o.mode ?? recoveryPolicy(o.project.id, "projectDecl").mode,
    declaration: null, capabilities: [], diagnostics: [], valid: false };
  const reason = (code: string, field: string, source = result.source) => result.diagnostics.push(declarationDiagnostic(code, field, source, result.targetHead));
  if (result.mode === "off") { reason("RECOVERY_OFF", "recovery.projectDecl"); return result; }
  try {
    let repo: DeclRepository;
    try { repo = resolveDeclRepository(o.project, o.repoDir, o.targetBranch); }
    catch (error) {
      if (error instanceof DeclReadError && error.reasonCode !== "GIT_READ_FAILED") throw error;
      throw new DeclReadError("TARGET_HEAD_UNAVAILABLE", "repository");
    }
    result.targetHead = repo.targetHead;
    result.source = "target";
    const selected = loadSelected(repo);
    Object.assign(result, selected);
    const d = result.declaration;
    if (!d) { if (!result.diagnostics.length) { result.source = "none"; reason("UNDECLARED", ".floka/project.json"); } return finish(result, o); }
    if (remoteIdentity(d.repository.remote) !== repo.remote || d.repository.targetBranch !== repo.targetBranch) {
      reason("DECLARATION_REPOSITORY_MISMATCH", "repository"); return finish(result, o);
    }
    for (const p of declarationPaths(d)) assertObjectPath(repo.root, repo.targetHead, p.path, p.glob, repo.tree);
    result.capabilities = declarationCapabilities(d);
    if (d.deploy.adapter === "floka" && !isFlokaDeclRepository(repo)) reason("UNSUPPORTED_DEPLOY_ADAPTER", "deploy");
    for (const cap of result.capabilities) {
      const cwd = cap.command?.cwd;
      if (cwd && cwd !== "." && objectMode(repo.root, repo.targetHead, cwd, repo.tree) !== "040000") reason("DIRECTORY_REQUIRED", cap.field);
    }
    for (const issue of verifyBasis(repo, d, o.now ?? Date.now(), result.capabilities)) reason(issue.reason, issue.field);
    const restricted = restrictDeclaration(o.project.projectDecl, result.capabilities);
    if (restricted.error) reason("INVALID_RESTRICTION", restricted.error, "local");
    result.restrictions = restricted.restriction;
    const paths = result.restrictions?.paths;
    if (paths && declarationPaths(d).some(({ path }) => !paths.some((p) => p === "." || path === p || path.startsWith(p + "/")))) {
      reason("LOCAL_PATH_RESTRICTION", "projectDecl.paths", "local");
    }
    for (const cap of result.capabilities) {
      const r = result.restrictions;
      if (r?.disabled || r?.deny?.includes(cap.field) || (r?.deploy === "none" && cap.field === "deploy")) reason("LOCAL_CAPABILITY_DISABLED", cap.field, "local");
    }
  } catch (error) {
    reason(error instanceof DeclReadError ? error.reasonCode : "DECLARATION_READ_FAILED", error instanceof DeclReadError ? error.field : "repository");
  }
  return finish(result, o);
}
