/** 自动批独立的路径保护集合；peer PR 的整目录口径保持在 peer-pr-surface。 */
import { scopeWireProtected } from "./ask-scope-registry.js";
import { FILE_PATTERNS, FILES, KEYWORDS } from "./peer-pr-surface.js";
import { REPO_ROOT } from "./repo-root.js";
import type { AutoHit, AutoReason } from "./center-proposal-auto.js";
import { globSpellingProof } from "./proposal-glob-protection.js";
import type { RecoveryMode } from "./recovery-policy.js";

const KNOWN_ROOTS = ["src/", "tests/", "docs/", "web/", "scripts/"];
const nameExempt = (g: string) => ["tests/", "docs/"].some(r => g.toLowerCase().startsWith(r));
const AUTO_FILE_PATTERNS = FILE_PATTERNS.map(([, re]) => new RegExp(re.source, re.flags.includes("i") ? re.flags : `${re.flags}i`));
const DATA_SCHEMA = /ledger-store|ledger-schema|migrat|\.sql(?:$|[^a-z])|shared-ledger-contract|recovery-key-(?:class|defaults)/i;
const PERMISSION_FILES = [
  "src/lib/peer-scope-gate.ts", "src/lib/peer-secret-gate.ts", "src/lib/order-tool-route.ts", "src/lib/caller-identity.ts",
  "src/bridge/api-auth.ts", "src/bridge/terminal-auth.ts", "src/bridge/interrupt-gate.ts", "src/bridge/web-gateway.ts",
  "src/bridge/local-api/control.ts", "src/bridge/local-api/shared-projects-auth.ts", "src/lib/ledger-checks.ts",
  "src/lib/ask-scope-registry.ts", "src/lib/order-ask.ts", "src/lib/order-deliver-scope.ts",
];
const DATA_FILES = [
  "src/lib/ledger-store.ts", "src/lib/ledger-schema.ts", "src/lib/sqlite-migrate.ts", "src/lib/ledger-feature-migrate.ts",
  "src/lib/shared-ledger-v2-migration.ts", "src/lib/shared-ledger-contract.ts", "src/lib/shared-ledger-contract-v2.ts",
  "src/lib/recovery-key-class.ts", "src/lib/recovery-key-defaults.ts", "src/bridge/startup-migrations.ts", "src/lib/acp/migration.ts",
];
/** FILE_PATTERNS 每条的代表路径（tests 核过每条都命中对应规则） */
export const PATTERN_PROBES = ["CLAUDE.md", "web/next.config.js", "web/public/sw.js"];

type Hit = Exclude<AutoReason, "nodes_empty" | "glob_empty" | "glob_invalid" | "glob_outside_roots" | "glob_wide" | "glob_unresolved"
  | "text_sensitive_word" | "auto_unconfirmed" | "auto_center_refused">;
const CONCRETE: readonly (readonly [string, Hit])[] = [
  ...FILES.map(f => [f, "glob_security_surface"] as const),
  ...PATTERN_PROBES.map(f => [f, "glob_security_surface"] as const),
  ...PERMISSION_FILES.map(f => [f, "glob_permission_gate"] as const),
  ...DATA_FILES.map(f => [f, "glob_data_schema"] as const),
];
const PROTECTED_DIRS: readonly (readonly [string, Hit])[] = [
  ...[".github/", "scripts/guard/", "deploy/", "native/", "desktop/", "master/", "roles/", "skills/", "src/hooks/", "src/cli/",
    "src/relay/", "src/bridge/local-api/", "src/bridge/fleet/", "src/lib/e2e/", "web/lib/api/", ".claude/"]
    .map(d => [d, "glob_security_surface"] as const),
  ["src/lib/floka-migration/", "glob_data_schema"],
];
const WILD = /[*?[\]{}!]/;
const malformed = (g: string) => g.length > 500 || g.startsWith("/") || g.startsWith("~") || /[\\\x00-\x1f]/.test(g)
  || g.split("/").some(s => s === ".." || s === ".") || g.includes("//");

/** 不支持跨段 brace / 字符类及扩展否定；这些语法无法逐段证明交集，交 owner。 */
function reliable(g: string): boolean {
  if (/[+@*?!]\(/.test(g)) return false;
  let bracket = false, brace = false;
  for (const c of g) {
    if (c === "/" && (bracket || brace)) return false;
    if (c === "[" && !bracket) bracket = true;
    else if (c === "]") { if (!bracket) return false; bracket = false; }
    else if (!bracket && c === "{") { if (brace) return false; brace = true; }
    else if (!bracket && c === "}") { if (!brace) return false; brace = false; }
    else if (!bracket && c === "!") return false;
  }
  return !bracket && !brace && g.split("/").every(s => !s.includes("**") || s === "**");
}

/** 与保护目录的交集：** 可跳过零段或多段；其余段用 Bun 的同一匹配语义。 */
function reachesDir(g: string, dir: string): boolean {
  const pattern = g.split("/"), parts = dir.split("/").filter(Boolean), memo = new Map<string, boolean>();
  const visit = (i: number, j: number): boolean => {
    if (i === pattern.length || j === parts.length) return true;
    const key = `${i}:${j}`;
    if (memo.has(key)) return memo.get(key)!;
    const result = pattern[i] === "**" ? visit(i + 1, j) || visit(i, j + 1)
      : new Bun.Glob(pattern[i]!).match(parts[j]!) && visit(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return visit(0, 0);
}

function literalReasons(g: string): AutoReason[] {
  const folded = g.toLowerCase(), reasons: AutoReason[] = [], name = folded.slice(folded.lastIndexOf("/") + 1);
  if (folded.split("/").includes(".claude") || AUTO_FILE_PATTERNS.some(re => re.test(g))
    || (!nameExempt(g) && KEYWORDS.some(k => name.includes(k)))) reasons.push("glob_security_surface");
  if (!nameExempt(g) && scopeWireProtected(folded)) reasons.push("glob_permission_gate");
  if (!nameExempt(g) && DATA_SCHEMA.test(g)) reasons.push("glob_data_schema");
  return reasons;
}

let repoFilesCache: readonly string[] | null | undefined;
/** 文件清单读取失败交 owner，缓存失败避免轮询不断拉起 git。 */
export function repoFiles(): readonly string[] | null {
  if (repoFilesCache !== undefined) return repoFilesCache;
  try {
    const r = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "ignore" });
    repoFilesCache = r.exitCode === 0 ? r.stdout.toString().split("\0").filter(Boolean) : null;
  } catch { repoFilesCache = null; /* 读取失败按 unresolved 拒绝自动批，异常文本不影响结论。 */ }
  return repoFilesCache;
}

/** 保护匹配统一忽略大小写，避免在不区分大小写的文件系统漏判；目录也包含其子文件。 */
function covers(globs: readonly Bun.Glob[], path: string): boolean {
  const parts = path.split("/");
  return parts.some((_, i) => {
    const prefix = parts.slice(0, i + 1).join("/");
    return globs[0]!.match(prefix) || globs[1]!.match(prefix.toLowerCase());
  });
}

/** 固定保护路径 + 保护目录 + 已跟踪名字命中；通配本身不算风险。 */
function baselineDetails(raw: string, files: readonly string[] | null): AutoHit[] {
  const g = raw.replace(/^\.\//, ""), folded = g.toLowerCase(), hits: AutoHit[] = [];
  const add = (reason: AutoReason, path = "") => {
    if (!hits.some(h => h.reason === reason && h.path === path)) hits.push({ reason, source: raw, path });
  };
  if (!g.trim()) { add("glob_empty"); return hits; }
  if (malformed(g)) { add("glob_invalid"); return hits; }
  if (!KNOWN_ROOTS.some(r => folded.startsWith(r))) add("glob_outside_roots");
  const wild = WILD.test(g), prefix = g.split("/").findIndex(s => WILD.test(s));
  // 新文件还没进 git 也不能靠加通配绕过明确的安全名字；普通通配本身不触发名字保护。
  for (const why of literalReasons(g)) add(why, g);
  if (!reliable(g)) { add("glob_unresolved"); return hits; }
  if (wild && files === null) add("glob_unresolved");
  if (wild && !nameExempt(g) && /^(?:(?:src|scripts|web)\/)?\*\*(?:\/\*)?$/.test(g)) add("glob_unresolved");
  const globs = [g, folded].map(pattern => new Bun.Glob(pattern.replace(/\/$/, "")));
  const covered = (path: string, why: AutoReason) => {
    add(why, path);
    if (wild && path.split("/").length - 1 > prefix) add("glob_wide", path);
  };
  for (const [dir, why] of PROTECTED_DIRS) if (wild ? reachesDir(g, dir) || reachesDir(folded, dir) : `${folded}/`.startsWith(dir) || dir.startsWith(`${folded}/`)) covered(dir, why);
  for (const [path, why] of CONCRETE) if (covers(globs, path)) covered(path, why);
  for (const path of files ?? []) {
    if (!covers(globs, path)) continue;
    for (const why of literalReasons(path)) covered(path, why);
  }
  return hits;
}

/** The recovery switch changes only spelling analysis; off and observe keep the original classifier exactly. */
export function globDetails(raw: string, files: readonly string[] | null = repoFiles(), mode: RecoveryMode = "off"): AutoHit[] {
  const g = raw.replace(/^\.\//, "");
  if (mode !== "on" || !g.trim() || malformed(g)) return baselineDetails(raw, files);
  const proof = globSpellingProof(g), hits: AutoHit[] = [];
  const add = (h: AutoHit) => {
    if (!hits.some(x => x.reason === h.reason && x.path === h.path)) hits.push({ ...h, source: raw });
  };
  if (proof.unresolved) return [...baselineDetails(raw, files), { reason: "glob_unresolved", source: raw, path: `[${proof.unresolved}]` }];
  for (const pattern of proof.patterns) for (const h of baselineDetails(pattern, files)) add(h);
  for (const path of proof.witnesses) for (const reason of literalReasons(path)) add({ reason, source: raw, path });
  return hits;
}

/** 保留原 reasons API；明细分类使用 globDetails。 */
export function globHits(raw: string, files: readonly string[] | null = repoFiles()): AutoReason[] {
  return [...new Set(globDetails(raw, files).map(h => h.reason))];
}
