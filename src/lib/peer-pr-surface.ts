/**
 * Does a peer PR touch the security surface (i28-A2 §1)? Pure, rules are data. One hit on any changed path (a rename's old
 * path counts too) makes it "security"; so does anything the rules cannot judge: a path outside the known roots, a file list
 * that is incomplete or too long. extraSecurityGlobs only adds rules. The verdict only picks the reviewer's P1 line; every
 * peer PR is reviewed either way. tests/peer-pr-surface.test.ts (fixtures are real peer PR file lists).
 */

export interface SurfaceVerdict { surface: "security" | "plain"; reasons: string[] }
/** A changed file as the files API lists it; `previous` = the old path of a rename. */
export interface ChangedFile { path: string; previous?: string }
/** null = the list could not be read in full (API failure, wrong fields): always "security". */
export type FileList = ChangedFile[] | null;

export const MAX_FILES = 300;

const DIRS = [
  ".github/", "scripts/", "deploy/", "native/", "desktop/", "master/", "roles/", "skills/", "src/hooks/", "src/cli/", "src/relay/",
  "src/bridge/local-api/", "src/bridge/fleet/", "src/lib/acp/", "src/lib/runtimes/", "src/lib/e2e/", "web/lib/api/",
];
const ROOT_FILES = ["package.json", "bun.lock", "bunfig.toml", "tsconfig.json", "install.sh", "ecosystem.config.cjs", "AGENTS.md"];
const FILES = [
  "web/package.json", "web/package-lock.json", "web/bun.lock", "web/pnpm-lock.yaml", "web/yarn.lock",
  "tests/preload.ts", "tests/test-env.ts", "src/bridge.ts", "src/relay.ts", "src/setup.ts", "src/launcher.ts", "src/acp-host.ts", "src/channel-server.ts", "src/scheduler.ts", "src/manager.ts",
  ...["api-routes", "api-auth", "web-terminal", "term-viewer", "term-fit", "web-shell", "web-gateway", "caller-identity", "order-tools", "devices", "credential-revocation", "http-peer"]
    .map((f) => `src/bridge/${f}.ts`),
];
const FILE_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["根目录 CLAUDE*.md", /^CLAUDE[^/]*\.md$/],
  ["web/next.config.*", /^web\/next\.config\.[^/]+$/],
  ["web/public 的 service worker", /^web\/public\/(?:[^/]+\/)*(?:sw|service-worker|workbox-[^/]*)\.[cm]?js$/i],
];
const KEYWORDS = [
  "auth", "token", "key", "trust", "secret", "credential", "principal", "scope", "signature", "sandbox", "permission", "invite", "pair",
  "e2e", "relay", "peer", "lend", "redact", "guard", "deploy", "merge", "update", "install", "launch", "ingress", "cors",
];
const KNOWN_ROOTS = ["src/", "tests/", "docs/", "web/"];
/** Tests and docs never run in production: their names alone (tests/peer-*.test.ts) do not make a PR security. */
const NO_KEYWORD_ROOTS = ["tests/", "docs/"];
const ROOT_DOCS = /^(?:README|SETUP)[^/]*$/;

/** Which built-in rule this one path trips, or null; the order only decides which reason is reported first. */
function ruleHit(path: string): string | null {
  if (path.split("/").includes(".claude")) return "目录 .claude/";
  const dir = DIRS.find((d) => path.startsWith(d));
  if (dir) return `目录 ${dir}`;
  if (ROOT_FILES.includes(path) || FILES.includes(path)) return `文件 ${path}`;
  const pattern = FILE_PATTERNS.find(([, re]) => re.test(path));
  if (pattern) return pattern[0];
  const name = (path.split("/").pop() ?? "").toLowerCase();
  const word = NO_KEYWORD_ROOTS.some((r) => path.startsWith(r)) ? undefined : KEYWORDS.find((k) => name.includes(k));
  if (word) return `文件名含 ${word}`;
  if (!KNOWN_ROOTS.some((r) => path.startsWith(r)) && !ROOT_DOCS.test(path)) return "不在 src/ tests/ docs/ web/ 下";
  return null;
}

const extraHit = (extra: readonly (readonly [string, Bun.Glob])[], path: string): string | null => {
  const g = extra.find(([, glob]) => glob.match(path));
  return g ? `额外规则 ${g[0]}` : null;
};

const malformed = (path: string): boolean => !path || path.length > 500 || path.startsWith("/") || path.split("/").includes("..");

/** Pure: same list + extra globs → same verdict, reasons in file order. */
export function peerPrSurface(files: FileList, extraGlobs: readonly string[] = []): SurfaceVerdict {
  if (files === null) return { surface: "security", reasons: ["文件清单读不全：按碰了安全面算"] };
  if (files.length > MAX_FILES) return { surface: "security", reasons: [`改动超过 ${MAX_FILES} 个文件：按碰了安全面算`] };
  if (!files.length) return { surface: "security", reasons: ["文件清单是空的：按碰了安全面算"] };
  const extra = extraGlobs.map((g) => [g, new Bun.Glob(g)] as const);
  const reasons: string[] = [];
  for (const f of files) {
    for (const path of [f.path, ...(f.previous && f.previous !== f.path ? [f.previous] : [])]) {
      const hit = malformed(path) ? "路径格式不对" : ruleHit(path) ?? extraHit(extra, path);
      if (hit) reasons.push(`${hit}：${path.slice(0, 200)}`);
    }
  }
  return reasons.length ? { surface: "security", reasons: reasons.slice(0, 40) } : { surface: "plain", reasons: [] };
}
