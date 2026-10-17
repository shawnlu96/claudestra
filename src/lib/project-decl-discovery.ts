/**
 * generality-PROJSCAN1 · deterministic, read-only discovery for a declaration draft. Everything comes from the fixed target
 * commit's Git objects (project-decl-git.ts): a path whitelist, a depth limit and a byte cap; symlinks and submodules are listed
 * as rejected, never followed. Candidates come only from fixed generators below: a model may regroup or drop them, never add argv.
 */
import { createHash } from "node:crypto";
import { DeclReadError, readDeclBlob, type DeclRepository } from "./project-decl-git.js";

export const DISCOVERY_MAX_DEPTH = 2;
const MANIFESTS = ["package.json", "Makefile", "pyproject.toml", "go.mod", "Cargo.toml"];
const WORKFLOW_DIR = ".github/workflows";
const MAX_FILE_BYTES = 256 * 1024;
const MAX_SOURCES = 32;
const SKIP_DIRS = new Set(["node_modules", "vendor", "third_party", "dist", "target", "build", "out"]);
/** Only these task names are ever proposed; anything else (deploy, release, publish …) is not a candidate. */
const SAFE_TASKS = ["test", "lint", "typecheck", "check", "build", "vet"];
const OUTBOUND_WORDS = ["deploy", "publish", "release", "upload", "push", "curl", "wget", "ssh", "scp", "rsync", "twine", "gh "];
const DEFAULT_TIMEOUT_SEC = 600;

export type CandidateGroup = "author" | "review" | "build" | "tests";
interface DiscoveredSource { path: string; kind: string; sha256: string; text: string }
export interface DeclCandidate {
  id: string; argv: string[]; cwd: string; group: CandidateGroup; timeoutSec: number;
  /** Relative path of the file that produced this candidate (its basis entry). */
  source: string;
  /** Set when the definition looks like an outbound action: never executed, stays inferred. */
  blocked?: "OUTBOUND_SUSPECT";
  /** Redacted definition text for the summary material only. */
  definition: string;
}
export interface DiscoveryResult {
  sources: DiscoveredSource[]; candidates: DeclCandidate[]; workflows: string[];
  rejected: { path: string; reason: string }[]; testGlobs: string[]; renderInputs: string[];
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const REDACTIONS: [RegExp, string][] = [
  [new RegExp("\\$\\{\\{[^}]*\\}\\}", "g"), "<expr>"],
  [new RegExp("://[^/@\\s]+@", "g"), "://<redacted>@"],
  [new RegExp("\\b([A-Z][A-Z0-9_]{1,63})=(\"[^\"]*\"|'[^']*'|\\S+)", "g"), "$1=<redacted>"],
  [new RegExp("(?:/Users|/home|/root)/[^\\s'\"]*", "g"), "<path>"],
  [new RegExp("\\b(?=[A-Za-z0-9+/_=-]*[0-9])(?=[A-Za-z0-9+/_=-]*[A-Za-z])[A-Za-z0-9+/_=-]{20,}\\b", "g"), "<redacted>"],
];
/** Masks expressions, assignments, URL credentials, home paths and long token-like strings before any text leaves discovery. */
export function redactMaterial(text: string): string {
  return REDACTIONS.reduce((s, [re, to]) => s.replace(re, to), text).slice(0, 2000);
}

const outbound = (body: string) => OUTBOUND_WORDS.some((w) => body.toLowerCase().includes(w));
const slug = (dir: string) => dir === "." ? "" : `${dir.split("/").join("-").split(".").join("-")}-`;
const join = (dir: string, name: string) => dir === "." ? name : `${dir}/${name}`;

function candidate(dir: string, id: string, argv: string[], group: CandidateGroup, source: string, body: string): DeclCandidate {
  const c: DeclCandidate = { id: `${slug(dir)}${id}`.slice(0, 120), argv, cwd: dir, group, timeoutSec: DEFAULT_TIMEOUT_SEC, source,
    definition: redactMaterial(body) };
  if (outbound(body)) c.blocked = "OUTBOUND_SUSPECT";
  return c;
}
const taskGroup = (task: string): CandidateGroup => task === "test" ? "tests" : task === "build" ? "build" : task === "check" ? "author" : "review";

function packageManager(tree: Map<string, string>, dir: string): string {
  if (tree.has(join(dir, "bun.lock")) || tree.has(join(dir, "bun.lockb"))) return "bun";
  if (tree.has(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  return tree.has(join(dir, "yarn.lock")) ? "yarn" : "npm";
}
function fromPackageJson(text: string, dir: string, source: string, tree: Map<string, string>): DeclCandidate[] {
  let scripts: unknown;
  try { scripts = (JSON.parse(text) as { scripts?: unknown })?.scripts; }
  catch { return []; /* An unparsable manifest yields no candidate; the draft simply has fewer inferred items. */ }
  if (!scripts || typeof scripts !== "object") return [];
  const pm = packageManager(tree, dir);
  return SAFE_TASKS.flatMap((task) => {
    const body = (scripts as Record<string, unknown>)[task];
    return typeof body === "string" ? [candidate(dir, `${pm}-${task}`, [pm, "run", task], taskGroup(task), source, body)] : [];
  });
}
function fromMakefile(text: string, dir: string, source: string): DeclCandidate[] {
  const lines = text.split("\n");
  const out: DeclCandidate[] = [];
  lines.forEach((line, i) => {
    const colon = line.indexOf(":");
    if (colon <= 0 || line.startsWith("\t") || line.startsWith("#") || line[colon + 1] === "=" || line.includes("=")) return;
    for (const target of line.slice(0, colon).trim().split(" ").filter(Boolean)) {
      if (!SAFE_TASKS.includes(target) || out.some((c) => c.argv[1] === target)) continue;
      const recipe: string[] = [];
      for (let j = i + 1; j < lines.length && lines[j].startsWith("\t"); j++) recipe.push(lines[j].trim());
      out.push(candidate(dir, `make-${target}`, ["make", target], taskGroup(target), source, recipe.join("\n")));
    }
  });
  return out;
}
function fromPyproject(text: string, dir: string, source: string): DeclCandidate[] {
  const out: DeclCandidate[] = [];
  if (text.includes("[tool.pytest") || text.includes("pytest")) out.push(candidate(dir, "pytest", ["python3", "-m", "pytest"], "tests", source, "pytest"));
  if (text.includes("[tool.ruff")) out.push(candidate(dir, "ruff", ["python3", "-m", "ruff", "check", "."], "review", source, "ruff check"));
  if (text.includes("[tool.mypy")) out.push(candidate(dir, "mypy", ["python3", "-m", "mypy", "."], "review", source, "mypy"));
  return out;
}
function fromGoMod(text: string, dir: string, source: string): DeclCandidate[] {
  if (!text.split("\n").some((l) => l.startsWith("module "))) return [];
  return [candidate(dir, "go-test", ["go", "test", "./..."], "tests", source, "go test"),
    candidate(dir, "go-vet", ["go", "vet", "./..."], "review", source, "go vet"),
    candidate(dir, "go-build", ["go", "build", "./..."], "build", source, "go build")];
}
function fromCargo(text: string, dir: string, source: string): DeclCandidate[] {
  if (!text.includes("[package]") && !text.includes("[workspace]")) return [];
  return [candidate(dir, "cargo-test", ["cargo", "test"], "tests", source, "cargo test"),
    candidate(dir, "cargo-build", ["cargo", "build"], "build", source, "cargo build")];
}
const GENERATORS: Record<string, (text: string, dir: string, source: string, tree: Map<string, string>) => DeclCandidate[]> = {
  "package.json": fromPackageJson, Makefile: fromMakefile, "pyproject.toml": fromPyproject, "go.mod": fromGoMod, "Cargo.toml": fromCargo,
};

/** Whitelisted paths only: manifests up to DISCOVERY_MAX_DEPTH directories deep, and direct workflow files. */
function classify(path: string): "manifest" | "workflow" | null {
  const parts = path.split("/");
  if (path.startsWith(`${WORKFLOW_DIR}/`) && parts.length === 3 && (path.endsWith(".yml") || path.endsWith(".yaml"))) return "workflow";
  if (!MANIFESTS.includes(parts.at(-1) ?? "") || parts.length - 1 > DISCOVERY_MAX_DEPTH) return null;
  return parts.slice(0, -1).some((p) => p.startsWith(".") || SKIP_DIRS.has(p)) ? null : "manifest";
}
const isLink = (mode: string) => mode === "120000" || mode === "160000";

function workflowMaterial(text: string): string {
  return text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("run:") || l.startsWith("- run:")).join("\n");
}
function testGlobs(tree: Map<string, string>, candidates: DeclCandidate[]): string[] {
  const globs = ["tests", "test", "__tests__"].filter((d) => tree.get(d) === "040000").map((d) => `${d}/**`);
  if (candidates.some((c) => c.argv[0] === "go")) globs.push("**/*_test.go");
  return globs;
}

/** Reads only the whitelisted blobs of the fixed target commit; the worktree and anything outside the repository are never opened. */
export function discoverProject(repo: DeclRepository): DiscoveryResult {
  const result: DiscoveryResult = { sources: [], candidates: [], workflows: [], rejected: [], testGlobs: [], renderInputs: [] };
  const paths = [...repo.tree.keys()].sort();
  for (const path of paths) {
    const mode = repo.tree.get(path) ?? "";
    const kind = classify(path);
    if (isLink(mode)) {
      if (kind || path.split("/").length <= DISCOVERY_MAX_DEPTH) result.rejected.push({ path, reason: "LINK_REJECTED" });
      continue;
    }
    if (!kind || mode === "040000") continue;
    if (result.sources.length >= MAX_SOURCES) { result.rejected.push({ path, reason: "SOURCE_LIMIT" }); continue; }
    let data: Buffer;
    try { data = readDeclBlob(repo.root, repo.targetHead, path, repo.tree); }
    catch (error) { result.rejected.push({ path, reason: error instanceof DeclReadError ? error.reasonCode : "READ_FAILED" }); continue; }
    if (data.length > MAX_FILE_BYTES) { result.rejected.push({ path, reason: "TOO_LARGE" }); continue; }
    const text = data.toString("utf8");
    const name = path.split("/").at(-1) ?? "";
    result.sources.push({ path, kind: kind === "workflow" ? "workflow" : name, sha256: sha256(data),
      text: redactMaterial(kind === "workflow" ? workflowMaterial(text) : text) });
    if (kind === "workflow") { result.workflows.push(path); continue; }
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
    for (const c of GENERATORS[name](text, dir, path, repo.tree)) {
      if (!result.candidates.some((x) => x.id === c.id)) result.candidates.push(c);
    }
  }
  result.testGlobs = testGlobs(repo.tree, result.candidates);
  result.renderInputs = repo.tree.get("web") === "040000" ? ["web/**"] : [];
  return result;
}
