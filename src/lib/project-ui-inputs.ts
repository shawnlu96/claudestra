/**
 * UIINPUT1 · the render inputs a UI screenshot is bound to, read from the project's own declaration (`.floka/project.json`
 * ui.renderInputs at the carry's target head) instead of the fixed web/ rules. A declaration counts as complete only when it is
 * the target's own (or Floka's built-in), names at least one input that exists, is bound to its repository, its basis still
 * hashes the same at the target and no capability in it is inferred; fileGlobs are added to the inputs but never prove them
 * complete. Dependency manifests / lockfiles in any directory above a declared input join the inputs automatically, so a shared
 * dependency change refuses an old screenshot. The summary binds repo, declaration / basis, evidence head and target head.
 * Floka keeps its old rules as a built-in declaration of the same shape (FLOKA_UI_INPUTS), so a Floka carry digests the same set.
 * Switch `projectUiInputs` (safety, default observe): on = this judgment decides the review / owner / own-globs carries and the
 * owner-fresh compare; observe = the old judgment acts and every disagreement is one recordObserved; off = as before.
 * Nothing here turns a missing declaration, unknown evidence or a manual state into a pass. docs/architecture/project-decl-uiinput1.md;
 * tests/project-ui-inputs.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { parseProjectDeclaration, parseProjectJson, remoteIdentity, type DeclProvenance, type ProjectDeclaration } from "./project-decl-schema.js";
import { recordObserved, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { gitIn, type GitRead } from "./scheduler-ui-carry-proof.js";

const KEY = "projectUiInputs";
const DECL_PATH = ".floka/project.json";
/** Floka's old fixed render inputs (scheduler-ui-review-carry.ts RENDER_DIRS / RENDER_FILES) as a declaration of the target's shape. */
export const FLOKA_UI_INPUTS: ProjectDeclaration["ui"] = Object.freeze({ renderInputs: Object.freeze([
  "web/**", "src/bridge/**", "assets/**", "public/**", "static/**", "styles/**", "i18n/**", "locales/**",
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "bun.lock", "bun.lockb", "yarn.lock", "pnpm-lock.yaml", "pnpm-workspace.yaml",
  "bunfig.toml", ".npmrc", ".nvmrc", ".node-version", ".bun-version", ".gitattributes", ".gitmodules", "tsconfig*.json",
  "?*.config.js", "?*.config.cjs", "?*.config.mjs", "?*.config.ts", "?*.config.cts", "?*.config.mts", "?*.config.json",
]) as string[] });
/** The input Floka's built-in requires at every head (the old "缺 web/" rule). */
const FLOKA_REQUIRED = "web/";
/** Dependency manifests and lockfiles: one sitting in a directory above a declared input is part of what the screenshot renders from. */
const DEP_FILES = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json", "bun.lock", "bun.lockb", "yarn.lock", "pnpm-lock.yaml",
  "pnpm-workspace.yaml", ".npmrc", ".nvmrc", ".node-version", "go.mod", "go.sum", "go.work", "go.work.sum", "pyproject.toml", "poetry.lock",
  "uv.lock", "pipfile", "pipfile.lock", "requirements.txt", "setup.py", "setup.cfg", "cargo.toml", "cargo.lock", "gemfile", "gemfile.lock",
  "composer.json", "composer.lock", ".gitmodules"]);
const UI_MANUAL_ENTRY = "manager project-decl <project> explain";

/**
 * Case-insensitive path glob over `/` segments: `**` is any number of segments (so `dir/**` covers dir itself), `*` any run of
 * characters inside one segment, `?` exactly one. The declaration schema already rejects brace, bracket and negation forms.
 */
export function uiGlobMatch(glob: string, path: string): boolean {
  const g = glob.toLowerCase().split("/"), p = path.toLowerCase().split("/");
  const seg = (pat: string, s: string): boolean => {
    let i = 0, j = 0, star = -1, mark = 0;
    while (j < s.length) {
      if (i < pat.length && (pat[i] === "?" || pat[i] === s[j])) { i++; j++; }
      else if (i < pat.length && pat[i] === "*") { star = i++; mark = j; }
      else if (star >= 0) { i = star + 1; j = ++mark; }
      else return false;
    }
    while (pat[i] === "*") i++;
    return i === pat.length;
  };
  const walk = (a: number, b: number): boolean => {
    if (a === g.length) return b === p.length;
    if (g[a] === "**") { for (let k = b; k <= p.length; k++) if (walk(a + 1, k)) return true; return false; }
    return b < p.length && seg(g[a]!, p[b]!) && walk(a + 1, b + 1);
  };
  return walk(0, 0);
}

type UiInputsSource = "target" | "builtin" | "none";
type UiInputsTrust = "verified" | "inferred" | "unverified" | "unknown";
/** Why a declaration cannot carry a screenshot. Every one requires acceptance on the new head. */
type UiInputsReason = "UNDECLARED" | "INVALID_DECLARATION" | "REPOSITORY_UNKNOWN" | "REPOSITORY_MISMATCH" | "INPUTS_EMPTY" |
  "INFERRED" | "UNVERIFIED" | "BASIS_MISSING" | "BASIS_STALE" | "DEPENDENCY_UNKNOWN" | "READ_FAILED";
const REASON_TEXT: Record<UiInputsReason, string> = {
  UNDECLARED: "项目没有声明 ui.renderInputs（不按目录名推定有无界面）", INVALID_DECLARATION: "项目声明读不懂或不合 version 1",
  REPOSITORY_UNKNOWN: "核不了本项目的仓库身份", REPOSITORY_MISMATCH: "声明的仓库与本项目不符", INPUTS_EMPTY: "ui.renderInputs 为空，未声明完整输入",
  INFERRED: "声明里有 inferred 能力，输入可信度未核实", UNVERIFIED: "声明的核实 head 不在目标 head 的祖先链上", BASIS_MISSING: "声明没有 basis，可信度无从核对",
  BASIS_STALE: "声明 basis 在目标 head 已变（过期）", DEPENDENCY_UNKNOWN: "渲染输入依赖不明", READ_FAILED: "渲染输入读不了",
};

/** The project's repository identity, established outside the declaration (the scheduler config's repoDir and its origin). */
export interface UiRepoIdentity { remote: string | null; isFloka: (targetHead: string) => boolean }
type UiIdentityPort = (project: string) => UiRepoIdentity;
export interface UiInputsDeps { identity?: UiIdentityPort; read?: (project: string) => GitRead }

const configRepo = (project: string): string | null => { try { return readSchedulerConfig().projects[project]?.repoDir ?? null; } catch { return null; } };
/**
 * project-decl-builtin.ts isFlokaDeclRepository's two facts (canonical remote, shipped verification commit in the target's ancestry),
 * re-read here through gitIn so the scheduler pass gains no new effect file; tests/project-ui-inputs.test.ts pins both to the built-in.
 */
export const FLOKA_DECL_REMOTE = "shawnlu96/claudestra", FLOKA_DECL_VERIFIED_HEAD = "21719e92853414b98ba8863691d341967b54116e";
/** Default: the configured repoDir's origin; Floka only through the built-in's remote + shipped-ancestry check. */
const defaultUiIdentity: UiIdentityPort = (project) => {
  const root = configRepo(project);
  let remote: string | null = null;
  try { if (root) remote = remoteIdentity(gitIn(root)("remote", "get-url", "origin").toString().trim()); } catch { remote = null; /* no origin: unknown */ }
  return { remote, isFloka: (targetHead) => !!root && remote === FLOKA_DECL_REMOTE && isAncestor(gitIn(root), FLOKA_DECL_VERIFIED_HEAD, targetHead) };
};
const defaultUiRead = (project: string): GitRead => {
  const root = configRepo(project);
  if (!root) throw new Error("调度配置里没有本项目的 repoDir");
  return gitIn(root);
};

interface UiInputsSummary {
  repo: string | null; source: UiInputsSource; decl: string | null; basis: "ok" | "stale" | "missing" | "builtin" | "none";
  trust: UiInputsTrust; evidenceHeads: string[]; targetHead: string; inputs: string | null; count: number; digest: string;
}
export type UiInputsVerdict = { ok: true; same: boolean; changed: string[]; heads: Record<string, string>; summary: UiInputsSummary } |
  { ok: false; reason: UiInputsReason; why: string; summary: UiInputsSummary };

interface Decl { source: UiInputsSource; inputs: readonly string[]; decl: string | null; basis: UiInputsSummary["basis"]; trust: UiInputsTrust;
  extra: string[]; problem?: { reason: UiInputsReason; detail?: string } }
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const blobAt = (read: GitRead, head: string, path: string): Buffer | null => {
  const entry = read("ls-tree", "-z", head, "--", path).toString().split("\0").filter(Boolean);
  if (!entry.length) return null;
  if (entry.length !== 1 || !/^100(644|755) blob /.test(entry[0]!)) throw new Error(`${path.slice(0, 120)} 不是普通文件`);
  return read("cat-file", "blob", `${head}:${path}`);
};
const isAncestor = (read: GitRead, a: string, b: string): boolean => { try { read("merge-base", "--is-ancestor", a, b); return true; } catch { return false; } };
const provenances = (d: ProjectDeclaration): DeclProvenance[] => [
  ...[...d.validation.author, ...d.validation.review, ...d.validation.build, ...d.verification.probes].map((c) => c.provenance),
  ...d.tests.rules.flatMap((r) => [r.provenance, ...(r.classifier ? [r.classifier.provenance] : [])]),
  ...(d.ci.testAdapter ? [d.ci.testAdapter.provenance] : []), d.deploy.provenance];

/** The declaration at the target head and how far it can be trusted. Throws only on unreadable git. */
function readDecl(read: GitRead, target: string, id: UiRepoIdentity): Decl {
  const none = (reason: UiInputsReason, detail?: string, source: UiInputsSource = "target", decl: string | null = null): Decl =>
    ({ source, inputs: [], decl, basis: "none", trust: "unknown", extra: [], problem: { reason, detail } });
  const raw = blobAt(read, target, DECL_PATH);
  if (!raw) {
    if (id.isFloka(target)) return { source: "builtin", inputs: FLOKA_UI_INPUTS.renderInputs, decl: "builtin:floka", basis: "builtin", trust: "verified", extra: [] };
    return none("UNDECLARED", undefined, "none");
  }
  const declDigest = sha(raw);
  let d: ProjectDeclaration | null;
  try { d = parseProjectDeclaration(parseProjectJson(raw.toString())).declaration; } catch { d = null; }
  if (!d) return none("INVALID_DECLARATION", undefined, "target", declDigest);
  if (!id.remote) return none("REPOSITORY_UNKNOWN", undefined, "target", declDigest);
  if (remoteIdentity(d.repository.remote) !== id.remote) return none("REPOSITORY_MISMATCH", undefined, "target", declDigest);
  const base: Decl = { source: "target", inputs: d.ui.renderInputs, decl: declDigest, basis: "ok", trust: "verified",
    extra: [DECL_PATH, ...d.basis.map((b) => b.path)] };
  if (!d.basis.length) return { ...base, basis: "missing", trust: "unverified", problem: { reason: "BASIS_MISSING" } };
  const stale = d.basis.find((b) => { try { const blob = blobAt(read, target, b.path); return !blob || sha(blob) !== b.sha256; } catch { return true; } });
  if (stale) return { ...base, basis: "stale", trust: "unverified", problem: { reason: "BASIS_STALE", detail: stale.path } };
  const prov = provenances(d);
  if (prov.some((p) => p.status === "inferred")) return { ...base, trust: "inferred", problem: { reason: "INFERRED" } };
  if (prov.some((p) => !p.verifiedHead || !isAncestor(read, p.verifiedHead, target))) return { ...base, trust: "unverified", problem: { reason: "UNVERIFIED" } };
  if (!d.ui.renderInputs.length) return { ...base, problem: { reason: "INPUTS_EMPTY" } };
  return base;
}

interface Picked { digest: string; count: number; paths: Set<string> }
/** One head's inputs: declared globs, declaration + basis files, the card's fileGlobs, dependency files above a declared input. */
function pickAt(read: GitRead, head: string, decl: Decl, fileGlobs: readonly string[]): Picked {
  const globs = fileGlobs.map((g) => new Bun.Glob(g));
  const entries = read("ls-tree", "-r", "-z", "--full-tree", head).toString().split("\0").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t"), [mode, type, oid] = line.slice(0, tab).split(" ");
    if (tab < 0 || !mode || !type || !oid) throw new Error("ls-tree 输出读不懂");
    return { mode, type, oid, path: line.slice(tab + 1) };
  });
  const declared = (p: string) => decl.inputs.some((g) => uiGlobMatch(g, p));
  const dirs = new Set<string>();
  for (const e of entries) if (declared(e.path)) for (let i = e.path.lastIndexOf("/"); ; i = e.path.lastIndexOf("/", i - 1)) {
    dirs.add(i < 0 ? "" : e.path.slice(0, i).toLowerCase());
    if (i <= 0) break;
  }
  const dep = (p: string) => { const i = p.lastIndexOf("/"); return DEP_FILES.has(p.slice(i + 1).toLowerCase()) && dirs.has(i < 0 ? "" : p.slice(0, i).toLowerCase()); };
  const extra = new Set(decl.extra.map((p) => p.toLowerCase()));
  const picked = entries.filter((e) => declared(e.path) || extra.has(e.path.toLowerCase()) || dep(e.path) || globs.some((g) => g.match(e.path)));
  const odd = picked.find((e) => e.mode === "120000" || e.type !== "blob");
  if (odd) throw new UiDepError(`${odd.path.slice(0, 120)} 是符号链接或子模块，内容不可核`);
  const text = picked.map((e) => `${e.mode} ${e.type} ${e.oid}\t${e.path}`).sort().join("\n");
  return { digest: sha(text), count: picked.length, paths: new Set(picked.map((e) => e.path)) };
}
class UiDepError extends Error {}

export interface UiInputsQuery { project: string; evidenceHeads: string[]; targetHead: string; fileGlobs: readonly string[]; identity: UiRepoIdentity }
/** The new judgment: is the declaration complete and trusted at the target, and are the evidence heads' inputs those of the target. Never throws. */
export function judgeUiInputs(read: GitRead, q: UiInputsQuery): UiInputsVerdict {
  const evidence = [...new Set(q.evidenceHeads)];
  const summary = (d: Decl | null, inputs: string | null, count: number): UiInputsSummary => {
    const s = { repo: q.identity.remote, source: d?.source ?? "none", decl: d?.decl ?? null, basis: d?.basis ?? "none", trust: d?.trust ?? "unknown",
      evidenceHeads: evidence, targetHead: q.targetHead, inputs, count };
    return { ...s, digest: sha(JSON.stringify(s)) };
  };
  const fail = (reason: UiInputsReason, d: Decl | null, detail?: string): UiInputsVerdict =>
    ({ ok: false, reason, why: `${reason}：${REASON_TEXT[reason]}${detail ? `（${detail.slice(0, 160)}）` : ""}；人工入口 ${UI_MANUAL_ENTRY}`, summary: summary(d, null, 0) });
  let decl: Decl;
  try { decl = readDecl(read, q.targetHead, q.identity); } catch (e) { return fail("READ_FAILED", null, (e as Error).message.split("\n")[0]); }
  if (decl.problem) return fail(decl.problem.reason, decl, decl.problem.detail);
  try {
    const target = pickAt(read, q.targetHead, decl, q.fileGlobs);
    if (decl.source === "builtin" && ![...target.paths].some((p) => p.toLowerCase().startsWith(FLOKA_REQUIRED))) {
      return fail("DEPENDENCY_UNKNOWN", decl, `${q.targetHead.slice(0, 12)} 缺 ${FLOKA_REQUIRED}`);
    }
    if (decl.source === "target") {
      const missing = decl.inputs.find((g) => ![...target.paths].some((p) => uiGlobMatch(g, p)));
      if (missing) return fail("DEPENDENCY_UNKNOWN", decl, `声明的输入 ${missing} 在目标 head 上不存在`);
    }
    const heads: Record<string, string> = { [q.targetHead]: target.digest };
    for (const h of evidence) heads[h] ??= pickAt(read, h, decl, q.fileGlobs).digest;
    const changed = evidence.filter((h) => heads[h] !== target.digest);
    return { ok: true, same: !changed.length, changed, heads, summary: summary(decl, target.digest, target.count) };
  } catch (e) {
    return fail(e instanceof UiDepError ? "DEPENDENCY_UNKNOWN" : "READ_FAILED", decl, (e as Error).message.split("\n")[0]);
  }
}

/** Read every time through the one policy reader; an unreadable file / unknown key / throwing port is off (the old judgment). */
export function projectUiInputsMode(project: string, policy: RecoveryPolicyPort = recoveryPolicy): RecoveryMode {
  try { const p = policy(project, KEY); return p.source === "error" ? "off" : p.mode; } catch { return "off"; }
}

/** The outcome a carry path acts on: the same inputs (carry may go on), changed inputs, or not provable (with why). */
export type UiInputsOutcome = { status: "same"; digest: string; count: number; summary: UiInputsSummary | null } |
  { status: "changed"; summary: UiInputsSummary | null; heads?: Record<string, string>; count?: number } |
  { status: "error"; why: string; summary: UiInputsSummary | null };
export interface UiInputsDecision { mode: RecoveryMode; outcome: UiInputsOutcome; observe: () => void }
export interface UiInputsGateInput {
  db: Database; project: string; task: string; path: "review" | "owner" | "ownGlobs" | "ownerFresh"; now: number;
  read: (() => GitRead) | string | null; evidenceHeads: string[]; targetHead: string; fileGlobs: readonly string[];
  /** The old judgment, as each path computed it before (its own text kept by the caller). */
  legacy: () => UiInputsOutcome; deps?: UiInputsDeps; policy?: RecoveryPolicyPort;
}
const fromVerdict = (v: UiInputsVerdict): UiInputsOutcome => !v.ok ? { status: "error", why: v.why, summary: v.summary }
  : v.same ? { status: "same", digest: v.summary.inputs!, count: v.summary.count, summary: v.summary }
  : { status: "changed", summary: v.summary, heads: v.heads, count: v.summary.count };

/**
 * The one decision the review / owner / own-globs / owner-fresh paths share. off: the old judgment, nothing else read. observe: the
 * old judgment acts; `observe()` records one note when the new one disagrees (same vs not). on: the new judgment acts. Never throws.
 */
export function uiInputsGate(x: UiInputsGateInput): UiInputsDecision {
  const mode = projectUiInputsMode(x.project, x.policy), noop = () => {};
  const legacy = (): UiInputsOutcome => { try { return x.legacy(); } catch (e) { return { status: "error", why: (e as Error).message.split("\n")[0]!.slice(0, 160), summary: null }; } };
  if (mode === "off") return { mode, outcome: legacy(), observe: noop };
  let verdict: UiInputsVerdict;
  try {
    if (typeof x.read === "string") throw new Error(x.read);
    const read = x.read ? x.read() : (x.deps?.read ?? defaultUiRead)(x.project);
    verdict = judgeUiInputs(read, { project: x.project, evidenceHeads: x.evidenceHeads, targetHead: x.targetHead, fileGlobs: x.fileGlobs,
      identity: (x.deps?.identity ?? defaultUiIdentity)(x.project) });
  } catch (e) {
    const why = `READ_FAILED：${REASON_TEXT.READ_FAILED}（${(e as Error).message.split("\n")[0]!.slice(0, 160)}）；人工入口 ${UI_MANUAL_ENTRY}`;
    verdict = { ok: false, reason: "READ_FAILED", why, summary: { repo: null, source: "none", decl: null, basis: "none", trust: "unknown",
      evidenceHeads: x.evidenceHeads, targetHead: x.targetHead, inputs: null, count: 0, digest: sha(why) } };
  }
  const next = fromVerdict(verdict);
  if (mode === "on") return { mode, outcome: next, observe: noop };
  const old = legacy();
  return { mode, outcome: old, observe: () => {
    if ((old.status === "same") === (next.status === "same")) return;
    try {
      recordObserved(x.db, { project: x.project, mechanism: KEY, target: x.task, actionKey: `ui-inputs:${x.path}:${x.targetHead}`.slice(0, 120),
        action: `${x.path} 截图沿用：旧判断 ${old.status}，项目输入判断 ${next.status}${next.status === "error" ? `（${next.why.slice(0, 200)}）` : ""}`,
        data: { path: x.path, legacy: old.status, candidate: next.status, reason: verdict.ok ? null : verdict.reason, summary: verdict.summary } }, x.now);
    } catch { /* an observation never changes the carry */ }
  } };
}

/** The own-globs path: only whether the declaration is complete and trusted at the target (main's UI changes are allowed there). */
export function uiDeclComplete(x: Omit<UiInputsGateInput, "legacy" | "evidenceHeads">): UiInputsDecision {
  return uiInputsGate({ ...x, evidenceHeads: [], legacy: () => ({ status: "same", digest: "", count: 0, summary: null }) });
}
