/** Versioned, closed data contract: declarations describe capabilities, never authority or environment values. */
import { z } from "zod";

const clean = z.string().min(1).max(4096).refine((s) => ![...s].some((c) => c.charCodeAt(0) < 32), "control_character");
const hex = (n: number) => z.string().refine((s) => s.length === n && [...s].every((c) => "0123456789abcdef".includes(c)), "invalid_digest");
const name = clean.refine((s) => new RegExp("^[A-Za-z_][A-Za-z0-9_]*$").test(s), "invalid_variable_name");
const id = clean.max(120).refine((s) => new RegExp("^[A-Za-z0-9_-]+$").test(s), "ambiguous_capability_id");
export const declPath = clean.refine((s) => s === "." || (!s.startsWith("/") && !s.includes("\\") && !s.includes(":")
  && s.split("/").every((p) => p !== ".." && p !== "." && p !== "")), "unsafe_path");
const glob = declPath.refine((s) => !s.includes("[") && !s.includes("{") && !s.includes("!"), "ambiguous_glob");
const branch = clean.max(200).refine((s) => !s.startsWith("-") && !s.includes("..")
  && ![" ", "~", "^", ":", "?", "*", "[", "\\", "@{"].some((c) => s.includes(c)), "invalid_branch");
export const remoteIdentity = (s: string): string | null => {
  let host = "github.com", path = s;
  if (s.startsWith("https://")) {
    try {
      const url = new URL(s);
      if (url.username || url.password || url.search || url.hash || url.port) return null;
      host = url.hostname; path = url.pathname.slice(1);
    } catch { return null; /* An invalid URL cannot establish repository identity. */ }
  } else if (s.startsWith("git@")) {
    const colon = s.indexOf(":");
    if (colon < 5) return null;
    host = s.slice(4, colon); path = s.slice(colon + 1);
  }
  if (path.endsWith(".git")) path = path.slice(0, -4);
  if (!new RegExp("^[A-Za-z0-9.-]+$").test(host)
    || !new RegExp("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$").test(path)
    || path.split("/").some((p) => p === "." || p === "..")) return null;
  return host.toLowerCase() === "github.com" ? path.toLowerCase() : `${host.toLowerCase()}/${path}`;
};
const remote = clean.refine((s) => remoteIdentity(s) !== null, "unsupported_remote");
const provenance = z.strictObject({ status: z.enum(["verified", "inferred"]), verifiedHead: hex(40).optional(),
  verifiedAt: z.iso.datetime({ offset: true }).optional() }).superRefine((p, ctx) => {
  if (p.status === "verified" && (!p.verifiedHead || !p.verifiedAt)) ctx.addIssue({ code: "custom", message: "verification_metadata_required" });
});
const command = z.strictObject({ id, argv: z.array(clean).min(1).max(100), cwd: declPath,
  env: z.record(name, z.strictObject({ from: name })).optional(), timeoutSec: z.number().int().min(1).max(86400), provenance });
const rule = command.omit({ cwd: true }).extend({ dir: declPath, fullWhen: z.array(glob), classifier: command.optional() });
const deploy = z.strictObject({ adapter: z.enum(["floka", "none"]), provenance });
const projectDeclarationSchema = z.strictObject({
  version: z.literal(1),
  repository: z.strictObject({ remote, defaultBranch: branch, targetBranch: branch }),
  validation: z.strictObject({ author: z.array(command), review: z.array(command), build: z.array(command) }),
  tests: z.strictObject({ rules: z.array(rule), globs: z.array(glob) }),
  ci: z.strictObject({ provider: id, workflows: z.array(declPath), requiredChecks: z.array(clean),
    testAdapter: command.nullable(), reports: z.array(glob), fullScope: z.array(glob).optional(),
    proof: z.array(z.strictObject({ path: declPath, sha256: hex(64) })).optional() }),
  ui: z.strictObject({ renderInputs: z.array(glob) }),
  verification: z.strictObject({ probes: z.array(command) }), deploy,
  basis: z.array(z.strictObject({ path: declPath, sha256: hex(64) })),
}).superRefine((d, ctx) => {
  const groups = [d.validation.author, d.validation.review, d.validation.build, d.tests.rules, d.verification.probes];
  if (groups.some((g) => new Set(g.map((x) => x.id)).size !== g.length)
    || new Set(d.basis.map((b) => b.path)).size !== d.basis.length) ctx.addIssue({ code: "custom", message: "ambiguous_duplicate" });
});
export type ProjectDeclaration = z.infer<typeof projectDeclarationSchema>;
export type DeclCommand = z.infer<typeof command>;
export type DeclProvenance = z.infer<typeof provenance>;

/** Restriction operations are deliberately small: omission cannot turn a local file into a second declaration. */
export const projectDeclRestrictionsSchema = z.strictObject({
  disabled: z.boolean().optional(), deny: z.array(clean).optional(),
  timeoutSec: z.record(clean, z.number().int().min(1).max(86400)).optional(),
  paths: z.array(declPath).optional(), deploy: z.literal("none").optional(),
});
export type ProjectDeclRestrictions = z.infer<typeof projectDeclRestrictionsSchema>;

export interface DeclDiagnostic {
  reasonCode: string; field: string; source: "target" | "builtin" | "local" | "none";
  targetHead: string | null; manualEntry: string;
}
export function declarationDiagnostic(reasonCode: string, field: string, source: DeclDiagnostic["source"], targetHead: string | null): DeclDiagnostic {
  return { reasonCode, field, source, targetHead, manualEntry: "Review .floka/project.json on the target branch and reconfirm its basis." };
}
export function parseProjectDeclaration(raw: unknown) {
  const result = projectDeclarationSchema.safeParse(raw);
  return result.success ? { declaration: result.data, diagnostics: [] } : { declaration: null,
    diagnostics: result.error.issues.map((i) => ({ reasonCode: i.path[0] === "version" ? "UNKNOWN_VERSION" : "INVALID_SCHEMA",
      field: i.path.join("."), source: "target" as const, targetHead: null,
      manualEntry: "Correct the version 1 declaration; unknown and authority fields are forbidden." })) };
}

/** JSON.parse alone silently accepts duplicate keys; capability policy must reject that ambiguity before selection. */
export function parseProjectJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  const stack: { keys: Set<string> | null; keyExpected: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i], frame = stack.at(-1);
    if (char === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      if (frame?.keys && frame.keyExpected) {
        const key: string = JSON.parse(text.slice(start, i + 1));
        if (frame.keys.has(key)) throw new Error("AMBIGUOUS_JSON");
        frame.keys.add(key); frame.keyExpected = false;
      }
    } else if (char === "{" || char === "[") stack.push({ keys: char === "{" ? new Set() : null, keyExpected: true });
    else if (char === "}" || char === "]") stack.pop();
    else if (char === "," && frame?.keys) frame.keyExpected = true;
  }
  return parsed;
}
