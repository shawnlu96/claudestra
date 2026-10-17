/** Compatibility data only. Existing runners keep their own commands and never consult this declaration. */
import { CI_REUSE_CHECKS } from "./ci-proof-reuse.js";
import type { ProjectDeclaration } from "./project-decl-schema.js";
import { isDeclAncestor, type DeclRepository } from "./project-decl-git.js";

const VERIFIED_HEAD = "21719e92853414b98ba8863691d341967b54116e";
export function builtinProjectDeclaration(repo: DeclRepository): ProjectDeclaration | null {
  if (repo.remote !== "shawnlu96/claudestra" || !isDeclAncestor(repo.root, VERIFIED_HEAD, repo.targetHead)) return null;
  const provenance = { status: "verified" as const, verifiedHead: VERIFIED_HEAD, verifiedAt: "2026-10-17T03:40:22Z" };
  const command = (id: string, argv: string[]) => ({ id, argv, cwd: ".", timeoutSec: 3600, provenance });
  return {
    version: 1, repository: { remote: "shawnlu96/claudestra", defaultBranch: "main", targetBranch: repo.targetBranch },
    validation: { author: [command("check", ["bun", "run", "check"])],
      review: [command("typecheck", ["bun", "run", "typecheck"]), command("guard", ["bun", "run", "guard"])],
      build: CI_REUSE_CHECKS.build.commands.map((argv, i) => command(`entrypoint-${i}`, [...argv])) },
    tests: { rules: [{ id: "bun", argv: ["bun", "run", "test"], dir: ".", fullWhen: ["**"], timeoutSec: 3600, provenance }], globs: ["tests/**"] },
    ci: { provider: "github", workflows: [".github/workflows/ci.yml"], requiredChecks: ["typecheck + test + guard"],
      testAdapter: null, reports: [], fullScope: ["**"] },
    ui: { renderInputs: ["web/**"] }, verification: { probes: [] }, deploy: { adapter: "floka", provenance },
    basis: [{ path: "src/lib/ci-proof-reuse.ts", sha256: "9518bf223b8a85548c93467d0472ebb73abcf89499c9ec5d9845eb937b4fda00" },
      { path: "package.json", sha256: "c2399eabc115a0f9dcd9fe80e3f04b03bc09f908a29e5096352791888ab778ee" },
      { path: ".github/workflows/ci.yml", sha256: "b343984484f886e6b639c459e42131f6d3f4aae9ae0ea97861bde8294e1dad3e" }],
  };
}
