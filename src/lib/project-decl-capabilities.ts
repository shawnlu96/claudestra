import type { DeclCommand, DeclProvenance, ProjectDeclaration, ProjectDeclRestrictions } from "./project-decl-schema.js";
import { projectDeclRestrictionsSchema } from "./project-decl-schema.js";

export interface DeclCapability {
  field: string; provenance: DeclProvenance; command?: DeclCommand; available: boolean; wouldBeAvailable: boolean;
}
export function declarationCapabilities(d: ProjectDeclaration): DeclCapability[] {
  const result: DeclCapability[] = [];
  const add = (field: string, p: DeclProvenance, command?: DeclCommand) => result.push({ field, provenance: p, command,
    available: false, wouldBeAvailable: false });
  for (const group of ["author", "review", "build"] as const) {
    for (const c of d.validation[group]) add(`validation.${group}.${c.id}`, c.provenance, c);
  }
  for (const r of d.tests.rules) {
    const { dir, fullWhen: _fullWhen, classifier, ...c } = r;
    add(`tests.rules.${r.id}`, r.provenance, { ...c, cwd: dir });
    if (classifier) add(`tests.rules.${r.id}.classifier`, classifier.provenance, classifier);
  }
  if (d.ci.testAdapter) add("ci.testAdapter", d.ci.testAdapter.provenance, d.ci.testAdapter);
  for (const p of d.verification.probes) add(`verification.probes.${p.id}`, p.provenance, p);
  if (d.deploy.adapter !== "none") add("deploy", d.deploy.provenance);
  return result;
}
export function declarationPaths(d: ProjectDeclaration): { path: string; glob: boolean }[] {
  const plain = [...d.basis.map((b) => b.path), ...d.ci.workflows, ...(d.ci.proof ?? []).map((b) => b.path),
    ...declarationCapabilities(d).flatMap((c) => c.command ? [c.command.cwd] : [])];
  const globs = [...d.tests.globs, ...d.tests.rules.flatMap((r) => r.fullWhen), ...d.ci.reports,
    ...(d.ci.fullScope ?? []), ...d.ui.renderInputs];
  return [...plain.map((path) => ({ path, glob: false })), ...globs.map((path) => ({ path, glob: true }))];
}
/** No object merge: only explicit restrictions with unambiguous field identities are accepted. */
export function restrictDeclaration(raw: unknown, caps: DeclCapability[]): { restriction?: ProjectDeclRestrictions; error?: string } {
  if (raw === undefined) return {};
  const parsed = projectDeclRestrictionsSchema.safeParse(raw);
  if (!parsed.success) return { error: "projectDecl" };
  const r = parsed.data;
  const keys = new Set(caps.map((c) => c.field));
  if ((r.deny ?? []).some((f) => !keys.has(f))) return { error: "projectDecl.deny" };
  for (const [field, timeout] of Object.entries(r.timeoutSec ?? {})) {
    const cap = caps.find((c) => c.field === field);
    if (!cap?.command || timeout > cap.command.timeoutSec) return { error: "projectDecl.timeoutSec" };
  }
  for (const cap of caps) {
    if (cap.command && r.timeoutSec?.[cap.field]) cap.command = { ...cap.command, timeoutSec: r.timeoutSec[cap.field] };
  }
  return { restriction: r };
}
