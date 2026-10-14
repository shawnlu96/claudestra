import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixTreePath, openFixWorktree, type FixTreeTarget } from "../src/lib/fix-strategy-worktree.js";
import { git } from "../src/lib/scheduler-review-worktree.js";
import { REPO_ROOT } from "../src/lib/repo-root.js";
import type { ObservedAction, RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";

setDefaultTimeout(60_000);
export const buildPaths = ["web/out", "web/.next", "web/lib/build-info.ts", "web/public/build-info.json", "web/next-env.d.ts", "web/tsconfig.tsbuildinfo"];
export function command(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" },
    stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}
export function artifactFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "conv-artifacts-"))), main = join(root, "repo"), trees = join(root, "trees");
  mkdirSync(main); command(main, "init", "-q", "-b", "main");
  const evidence = ["package.json", "web/package.json", "web/next.config.ts", "web/tsconfig.json", "web/.gitignore", "web/scripts/gen-build-info.mjs"];
  for (const path of evidence) {
    mkdirSync(join(main, path, ".."), { recursive: true });
    writeFileSync(join(main, path), readFileSync(join(REPO_ROOT, path)));
  }
  writeFileSync(join(main, ".gitignore"), "/node_modules\n.env*\n.review-tmp/\n.review-env/\n");
  writeFileSync(join(main, "source.txt"), "reviewed source\n"); command(main, "add", "."); command(main, "commit", "-qm", "fixture");
  const first = command(main, "rev-parse", "HEAD");
  writeFileSync(join(main, "source.txt"), "reviewed source revision two\n");
  command(main, "add", "source.txt"); command(main, "commit", "-qm", "reviewed revision two");
  const head = command(main, "rev-parse", "HEAD"); command(main, "branch", "feat/T1");
  command(main, "update-ref", "refs/remotes/origin/feat/T1", head);
  const dir = fixTreePath(trees, "T1")!; command(main, "worktree", "add", "-q", dir, "feat/T1");
  for (const sub of ["node_modules", "web/node_modules"]) {
    mkdirSync(join(main, sub), { recursive: true }); symlinkSync(join(main, sub), join(dir, sub));
  }
  const bytes = new Map<string, Buffer>();
  for (const path of buildPaths) {
    const file = path === "web/out" || path === "web/.next" ? `${path}/nested/cache.bin` : path;
    mkdirSync(join(dir, file, ".."), { recursive: true });
    const content = Buffer.from([0, 255, ...Buffer.from(file)]); bytes.set(file, content); writeFileSync(join(dir, file), content);
  }
  const observed: ObservedAction[] = [], quarantineRoot = join(root, "quarantine");
  const context = (mode: RecoveryMode) => ({ project: "claude-orchestrator", taskId: "T1", intentId: "fix:T1:one", repository: main, quarantineRoot,
    policy: (() => ({ mode, source: "config", manualAfterMs: null })) as RecoveryPolicyPort,
    observe: (a: ObservedAction) => { if (!observed.some((x) => x.actionKey === a.actionKey)) observed.push(a); }, gate: () => null });
  const target = (mode: RecoveryMode): FixTreeTarget => ({ taskId: "T1", branch: "feat/T1", head, root: trees, artifacts: context(mode) } as FixTreeTarget);
  const open = (mode: RecoveryMode) => openFixWorktree(git, dir, target(mode), dir, async () => ({ ok: true, head }));
  return { root, main, dir, head, heads: [first, head], trees, bytes, observed, quarantineRoot, context, target, open,
    close: () => rmSync(root, { recursive: true, force: true }) };
}

test("[验收线 1] on reuses a linked fix tree containing only the six ignored build artifacts", async () => {
  const f = artifactFixture();
  try {
    expect(await f.open("on")).toEqual({ dir: f.dir });
    for (const path of buildPaths) expect(existsSync(join(f.dir, path))).toBe(false);
  } finally { f.close(); }
});
