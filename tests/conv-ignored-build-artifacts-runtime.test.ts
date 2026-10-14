import { autoFixture } from "./scheduler-auto-helpers.js";
import { convergenceProbe, repeatedFix } from "./fix-strategy-helpers.js";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { getEventByDedup, listEvents } from "../src/lib/ledger-store.js";
import { treeProofSync } from "../src/lib/recovery-fix-local-swap-run.js";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactFixture, buildPaths, command } from "./conv-ignored-build-artifacts.test.js";
import { convArtifactProof, convArtifactProofSync } from "../src/lib/conv-ignored-build-artifacts-quarantine.js";
import { convArtifactIsolationPath, convTreeCreateEdge, moveArtifactBatch } from "../src/lib/conv-ignored-build-artifacts-quarantine.js";
import { retryWorktreeDirty, retryWorktreeDirtySync } from "../src/lib/scheduler-create-retry-worktree.js";
import { git, type Git } from "../src/lib/scheduler-review-worktree.js";
import { openFixWorktree } from "../src/lib/fix-strategy-worktree.js";
import { recoveryPolicy, type RecoveryMode } from "../src/lib/recovery-policy.js";

const gitSync = (args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = (r.exitCode === 0 ? r.stdout : r.stderr).toString();
  return { code: r.exitCode, out: out.endsWith("\0") ? out : out.trim() };
};
const retained = (f: ReturnType<typeof artifactFixture>) => {
  for (const [path, bytes] of f.bytes) expect(readFileSync(join(f.dir, path)).toString("hex")).toBe(bytes.toString("hex"));
};
const batches = (f: ReturnType<typeof artifactFixture>) => readdirSync(convArtifactIsolationPath(f.context("on"))).filter((p) => p.startsWith("batch-"));

test("[验收线 1] isolation preserves every byte and relative path, with a durable receipt; repeat ticks create no second batch", async () => {
  const f = artifactFixture();
  try {
    expect(await f.open("on")).toEqual({ dir: f.dir });
    expect(await retryWorktreeDirty(git, f.dir, f.main)).toBeNull();
    expect(batches(f)).toHaveLength(1);
    const batch = join(convArtifactIsolationPath(f.context("on")), batches(f)[0]);
    const receipt = JSON.parse(readFileSync(join(batch, "receipt.json"), "utf8"));
    expect(receipt).toMatchObject({ status: "complete", taskId: "T1", intentId: "fix:T1:one", moved: buildPaths });
    for (const [path, bytes] of f.bytes) expect(readFileSync(join(batch, "artifacts", path)).toString("hex")).toBe(bytes.toString("hex"));
    expect(await f.open("on")).toEqual({ dir: f.dir }); expect(batches(f)).toHaveLength(1);
  } finally { f.close(); }
});

for (const mode of ["off", "observe"] as const) test(`[验收线 2] ${mode} retains the legacy refusal and changes no artifact or isolation directory`, async () => {
  const f = artifactFixture();
  try {
    for (let i = 0; i < 2; i++) expect(await f.open(mode)).toHaveProperty("manual");
    retained(f); expect(existsSync(f.quarantineRoot)).toBe(false);
    expect(f.observed).toHaveLength(mode === "observe" ? 1 : 0);
    if (mode === "observe") expect(f.observed[0]).toMatchObject({ mechanism: "convIgnoredBuildArtifacts", action: "本会挪走 6 项", data: { paths: buildPaths, count: 6 } });
  } finally { f.close(); }
});

for (const path of [".env", ".review-tmp/probe", ".review-env/config", "web/other.tsbuildinfo", "web/unknown.bin", "ordinary.txt"]) {
  test(`[验收线 3] ${path} blocks the whole batch before any move`, async () => {
    const f = artifactFixture();
    try {
      mkdirSync(join(f.dir, path, ".."), { recursive: true }); writeFileSync(join(f.dir, path), "preserve me");
      expect(await f.open("on")).toHaveProperty("manual"); retained(f); expect(existsSync(f.quarantineRoot)).toBe(false);
      expect(readFileSync(join(f.dir, path), "utf8")).toBe("preserve me");
    } finally { f.close(); }
  });
}

for (const change of ["staged", "unstaged", "deleted", "executable", "assume-unchanged", "skip-worktree", "tracked-candidate"] as const) {
  test(`[验收线 3] ${change} remains a refusal without moving candidates`, async () => {
    const f = artifactFixture();
    try {
      if (change === "tracked-candidate") command(f.dir, "add", "-f", "web/next-env.d.ts");
      else if (change === "deleted") rmSync(join(f.dir, "source.txt"));
      else if (change === "executable") command(f.dir, "update-index", "--chmod=+x", "source.txt");
      else {
        if (change === "assume-unchanged" || change === "skip-worktree") command(f.dir, "update-index", `--${change}`, "source.txt");
        writeFileSync(join(f.dir, "source.txt"), "local source edits\n");
        if (change === "staged") command(f.dir, "add", "source.txt");
      }
      expect(await f.open("on")).toHaveProperty("manual"); retained(f); expect(existsSync(f.quarantineRoot)).toBe(false);
      expect((await convArtifactProof(git, f.dir, f.main, f.context("on"))).reason).not.toBeNull();
      expect(convArtifactProofSync(gitSync, f.dir, f.main, f.context("on"))).not.toBeNull();
    } finally { f.close(); }
  });
}

for (const link of ["wrong-dependency", "physical-dependency", "artifact-link", "ancestor-link", "nested-link"] as const) {
  test(`[验收线 4] ${link} is refused without touching external targets`, async () => {
    const f = artifactFixture();
    try {
      const outside = join(f.root, "external"); mkdirSync(outside); writeFileSync(join(outside, "untouched"), "external bytes");
      if (link.endsWith("dependency")) {
        rmSync(join(f.dir, "node_modules"));
        if (link === "wrong-dependency") symlinkSync(outside, join(f.dir, "node_modules"));
        else { mkdirSync(join(f.dir, "node_modules")); writeFileSync(join(f.dir, "node_modules", "cache"), "dependency bytes"); }
      } else if (link === "artifact-link") {
        rmSync(join(f.dir, "web/next-env.d.ts")); symlinkSync(join(outside, "untouched"), join(f.dir, "web/next-env.d.ts"));
      } else if (link === "ancestor-link") {
        renameSync(join(f.dir, "web/lib"), join(outside, "lib")); symlinkSync(join(outside, "lib"), join(f.dir, "web/lib"));
      } else symlinkSync(join(outside, "untouched"), join(f.dir, "web/out/nested/linked"));
      expect(await f.open("on")).toHaveProperty("manual"); expect(existsSync(f.quarantineRoot)).toBe(false);
      expect(readFileSync(join(outside, "untouched"), "utf8")).toBe("external bytes");
    } finally { f.close(); }
  });
}

test("[验收线 3] a foreign repository, insufficient tracked evidence, or a non-ignored candidate cannot use the list", async () => {
  for (const change of ["repository", "evidence", "ignored"] as const) {
    const f = artifactFixture(), other = artifactFixture();
    try {
      const target = f.target("on");
      if (change === "repository") target.artifacts!.repository = other.main;
      if (change === "evidence") {
        writeFileSync(join(f.dir, "web/package.json"), '{"name":"other","scripts":{"build":"next build"}}');
        command(f.dir, "add", "web/package.json"); command(f.dir, "commit", "-qm", "different build");
        target.head = command(f.dir, "rev-parse", "HEAD"); command(f.main, "update-ref", "refs/remotes/origin/feat/T1", target.head);
      }
      if (change === "ignored") writeFileSync(join(f.dir, "web/.gitignore"), "!next-env.d.ts\n");
      expect(await openFixWorktree(git, f.dir, target, f.dir, async () => ({ ok: true, head: target.head! }))).toHaveProperty("manual");
      retained(f); expect(existsSync(f.quarantineRoot)).toBe(false);
    } finally { f.close(); other.close(); }
  }
});

for (const failure of ["interrupted", "conflict"] as const) test(`[验收线 5] ${failure} preserves partial batches and refuses retries`, async () => {
  const f = artifactFixture();
  try {
    const context = f.context("on"), proof = await convArtifactProof(git, f.dir, f.main, context), path = convArtifactIsolationPath(context);
    expect(proof.reason).toBeNull(); mkdirSync(path, { recursive: true });
    let moved = 0;
    expect(() => moveArtifactBatch(f.dir, path, proof.candidates, context, {
      rename: (from, to) => { if (failure === "interrupted" && moved++ === 1) throw new Error("injected move interruption"); renameSync(from, to); },
      beforeMove: (_sub, dest) => { if (failure === "conflict") { mkdirSync(join(dest, ".."), { recursive: true }); writeFileSync(dest, "old isolation bytes"); } },
    })).toThrow();
    expect(batches(f)).toHaveLength(1);
    const batch = join(path, batches(f)[0]), receipt = JSON.parse(readFileSync(join(batch, "receipt.json"), "utf8"));
    expect(receipt.status).toBe("failed");
    for (const [file, bytes] of f.bytes) {
      const dest = join(batch, "artifacts", file), source = join(f.dir, file);
      expect(readFileSync(existsSync(source) ? source : dest).toString("hex")).toBe(bytes.toString("hex"));
    }
    expect(await f.open("on")).toHaveProperty("manual"); expect(batches(f)).toHaveLength(1);
    expect(await f.open("observe")).toHaveProperty("manual"); expect(f.observed).toHaveLength(0);
    if (failure === "conflict") expect(readFileSync(join(batch, "artifacts", proof.candidates[0].path), "utf8")).toBe("old isolation bytes");
  } finally { f.close(); }
});

test("[验收线 5] dirty content created during the final awaited check remains a refusal after quarantine", async () => {
  const f = artifactFixture();
  try {
    let introduced = false;
    const port: Git = async (args) => {
      if (!introduced && !existsSync(join(f.dir, "web/out")) && args.includes("status")) {
        introduced = true; writeFileSync(join(f.dir, ".env"), "new dirty bytes");
      }
      return git(args);
    };
    expect(await openFixWorktree(port, f.dir, f.target("on"), f.dir, async () => ({ ok: true, head: f.head }))).toHaveProperty("manual");
    expect(introduced).toBe(true); expect(readFileSync(join(f.dir, ".env"), "utf8")).toBe("new dirty bytes");
    expect(convTreeCreateEdge(f.dir, "feat/T1", f.head)).not.toBeNull();
    const batch = join(convArtifactIsolationPath(f.context("on")), batches(f)[0]);
    for (const [file, bytes] of f.bytes) expect(readFileSync(join(batch, "artifacts", file)).toString("hex")).toBe(bytes.toString("hex"));
    expect(await f.open("on")).toHaveProperty("manual");
  } finally { f.close(); }
});

test("[验收线 5] async and synchronous preflight agree; a strict synchronous create edge rejects regenerated caches", async () => {
  const f = artifactFixture();
  try {
    for (const mode of ["off", "observe", "on"] as RecoveryMode[]) {
      expect((await convArtifactProof(git, f.dir, f.main, f.context(mode))).reason === null)
        .toBe(convArtifactProofSync(gitSync, f.dir, f.main, f.context(mode)) === null);
    }
    retained(f); expect(existsSync(f.quarantineRoot)).toBe(false);
    expect(await f.open("on")).toEqual({ dir: f.dir });
    expect(convTreeCreateEdge(f.dir, "feat/T1", f.head)).toBeNull();
    writeFileSync(join(f.dir, "web/tsconfig.tsbuildinfo"), "regenerated");
    expect(convTreeCreateEdge(f.dir, "feat/T1", f.head)).not.toBeNull();
    expect(retryWorktreeDirtySync(gitSync, f.dir, f.main)).not.toBeNull();
  } finally { f.close(); }
});

test("[验收线 5] stop / policy drift and unsafe isolation roots prevent any move", async () => {
  for (const change of ["stop", "policy", "location", "dot-location", "main-dot-location"] as const) {
    const f = artifactFixture();
    try {
      const target = f.target("on");
      if (change === "stop") target.artifacts!.gate = () => "old author is running";
      if (change === "policy") target.artifacts!.policy = () => ({ mode: "off", source: "error", manualAfterMs: null, diagnostic: "invalid configuration" });
      if (change === "location") target.artifacts!.quarantineRoot = join(f.dir, "isolation");
      if (change === "dot-location") target.artifacts!.quarantineRoot = join(f.dir, "..quarantine");
      if (change === "main-dot-location") target.artifacts!.quarantineRoot = join(f.main, "..quarantine");
      expect(await openFixWorktree(git, f.dir, target, f.dir, async () => ({ ok: true, head: f.head }))).toHaveProperty("manual");
      retained(f); expect(existsSync(f.quarantineRoot)).toBe(false); expect(existsSync(join(f.dir, "isolation"))).toBe(false);
      expect(existsSync(join(f.dir, "..quarantine"))).toBe(false); expect(existsSync(join(f.main, "..quarantine"))).toBe(false);
    } finally { f.close(); }
  }
});

for (const mode of ["off", "observe", "on"] as const) test(`[验收线 1] [验收线 2] real fix_swap under ${mode} finishes or keeps the original unknown intent path`, async () => {
  const f = artifactFixture(), ledger = await repeatedFix(f.heads);
  try {
    ledger.db.run("UPDATE tasks SET branch = 'feat/T1' WHERE id = 'T1'");
    const p = convergenceProbe(ledger);
    p.edit((r) => { r.agents["agent-task-one"].cwd = f.dir; });
    p.deps.worktreeRoot = f.trees;
    p.deps.artifacts = { repository: f.main, quarantineRoot: f.quarantineRoot, policy: f.context(mode).policy };
    p.deps.authorTree = (source, target, recorded) => openFixWorktree(git, source, target, recorded, async () => ({ ok: true, head: f.head }));
    const intent = p.plan();
    await fixSwapStep(ledger.db, ledger.at("scheduler"), intent.id, p.deps);
    const result = await fixSwapStep(ledger.db, ledger.at("scheduler"), intent.id, p.deps);
    const refusal = getEventByDedup(ledger.db, `scheduler:${intent.id}:tree-refused`);
    if (mode === "on") {
      expect(result).toMatchObject({ step: "session" }); expect(getIntent(ledger.db, intent.id)?.status).toBe("done");
      expect(refusal).toBeNull(); expect(getSchedulerSession(ledger.db, "T1", "author")?.sessionId).not.toBe("s-one");
      expect(p.effects.filter((e) => e.startsWith("create:"))).toHaveLength(1);
    } else {
      expect(result).toMatchObject({ step: "waiting" }); expect(getIntent(ledger.db, intent.id)?.status).toBe("unknown");
      expect(refusal).not.toBeNull(); expect(p.effects.filter((e) => e.startsWith("create:"))).toHaveLength(0);
      retained(f); expect(existsSync(f.quarantineRoot)).toBe(false);
    }
    const observations = listEvents(ledger.db, { project: "p", target: "T1" }).filter((e) => e.data.mechanism === "convIgnoredBuildArtifacts");
    expect(observations).toHaveLength(mode === "observe" ? 1 : 0);
  } finally { ledger.close(); f.close(); }
});

test("[验收线 5] the wired local-swap reclaim proof permits on candidates read-only, while its create proof remains strict", () => {
  const f = artifactFixture(), ledger = autoFixture();
  try {
    const p = convergenceProbe(ledger), task = { ...ledger.task(), branch: "feat/T1", headSHA: f.head };
    p.deps.worktreeRoot = f.trees;
    p.deps.artifacts = { repository: f.main, policy: f.context("on").policy };
    expect(treeProofSync(ledger.db, task, f.dir, p.deps)).toBeNull();
    expect(treeProofSync(ledger.db, task, f.dir, p.deps, false)).not.toBeNull();
    retained(f); expect(existsSync(f.quarantineRoot)).toBe(false);
    writeFileSync(join(f.dir, ".env"), "late content");
    expect(treeProofSync(ledger.db, task, f.dir, p.deps)).not.toBeNull();
    expect(treeProofSync(ledger.db, task, f.dir, p.deps, false)).not.toBeNull();
  } finally { ledger.close(); f.close(); }
});

test("[验收线 1] this intent's saved-start tree can be reused from the main source; corrupt identity never isolates", async () => {
  for (const corrupt of [false, true]) {
    const f = artifactFixture();
    try {
      const privateDir = command(f.dir, "rev-parse", "--absolute-git-dir");
      writeFileSync(join(privateDir, "scheduler-author-start.json"), JSON.stringify({ repo: f.main, worktree: f.dir,
        branch: "feat/T1", base: f.head, sha: corrupt ? "1".repeat(40) : f.head }));
      const result = await openFixWorktree(git, f.main, f.target("on"), f.dir, async () => ({ ok: true, head: f.head }));
      if (corrupt) { expect(result).toHaveProperty("manual"); retained(f); expect(existsSync(f.quarantineRoot)).toBe(false); }
      else { expect(result).toEqual({ dir: f.dir }); expect(batches(f)).toHaveLength(1); }
    } finally { f.close(); }
  }
});

test("[验收线 2] absent policy uses observe; unreadable or invalid policy remains off", async () => {
  for (const invalid of [false, true]) {
    const f = artifactFixture();
    try {
      const path = join(f.root, "recovery-policy.json");
      if (invalid) writeFileSync(path, '{"projects":{"claude-orchestrator":{"keys":{"convIgnoredBuildArtifacts":"invalid"}}}}');
      const target = f.target("on");
      target.artifacts!.policy = (project, mechanism) => recoveryPolicy(project, mechanism, path);
      expect(await openFixWorktree(git, f.dir, target, f.dir, async () => ({ ok: true, head: f.head }))).toHaveProperty("manual");
      expect(f.observed).toHaveLength(invalid ? 0 : 1); retained(f); expect(existsSync(f.quarantineRoot)).toBe(false);
    } finally { f.close(); }
  }
});

test("[验收线 5] policy changes during candidate Git reads produce neither an observation nor a move", async () => {
  const f = artifactFixture();
  try {
    const target = f.target("observe"); let mode: RecoveryMode = "observe";
    target.artifacts!.policy = () => ({ mode, source: "config", manualAfterMs: null });
    const port: Git = async (args) => { const result = await git(args); if (args.includes("check-ignore")) mode = "off"; return result; };
    expect(await openFixWorktree(port, f.dir, target, f.dir, async () => ({ ok: true, head: f.head }))).toHaveProperty("manual");
    expect(f.observed).toHaveLength(0); retained(f); expect(existsSync(f.quarantineRoot)).toBe(false);
  } finally { f.close(); }
});

test("[验收线 5] an incomplete receipt after all files moved still prevents a clean-tree retry", async () => {
  const f = artifactFixture();
  try {
    expect(await f.open("on")).toEqual({ dir: f.dir });
    const batch = join(convArtifactIsolationPath(f.context("on")), batches(f)[0]), path = join(batch, "receipt.json");
    const receipt = JSON.parse(readFileSync(path, "utf8")); receipt.status = "prepared";
    writeFileSync(path, JSON.stringify(receipt));
    expect(await retryWorktreeDirty(git, f.dir, f.main)).toBeNull();
    expect(await f.open("on")).toHaveProperty("manual"); expect(batches(f)).toHaveLength(1);
    for (const [file, bytes] of f.bytes) expect(readFileSync(join(batch, "artifacts", file)).toString("hex")).toBe(bytes.toString("hex"));
  } finally { f.close(); }
});

test("[验收线 5] origin drift during isolation verification cannot hand out the tree", async () => {
  const f = artifactFixture();
  try {
    let reads = 0;
    const result = await openFixWorktree(git, f.dir, f.target("on"), f.dir,
      async () => ({ ok: true, head: ++reads < 3 ? f.head : "a".repeat(40) }));
    expect(result).toHaveProperty("manual"); retained(f);
    expect(readdirSync(convArtifactIsolationPath(f.context("on"))).filter((p) => p.startsWith("batch-"))).toHaveLength(0);
  } finally { f.close(); }
});

test("[验收线 5] a late symlink replacement of the proven tree is refused at the synchronous create edge", async () => {
  const f = artifactFixture();
  try {
    expect(await f.open("on")).toEqual({ dir: f.dir });
    const moved = join(f.root, "elsewhere"); renameSync(f.dir, moved); symlinkSync(moved, f.dir);
    expect(convTreeCreateEdge(f.dir, "feat/T1", f.head)).not.toBeNull();
  } finally { f.close(); }
});

test("[验收线 3] a web submodule retains its original ignored-content proof and is never quarantined", async () => {
  const f = artifactFixture();
  try {
    command(f.dir, "rm", "-r", "--", "web"); rmSync(join(f.dir, "web"), { recursive: true, force: true });
    const module = join(f.root, "web-module"); mkdirSync(module); command(module, "init", "-q", "-b", "main");
    writeFileSync(join(module, ".gitignore"), "out/\n.next/\n"); writeFileSync(join(module, "source.txt"), "submodule source");
    command(module, "add", "."); command(module, "commit", "-qm", "submodule");
    command(f.dir, "-c", "protocol.file.allow=always", "submodule", "add", module, "web"); command(f.dir, "commit", "-qam", "web submodule");
    const head = command(f.dir, "rev-parse", "HEAD"); command(f.main, "update-ref", "refs/remotes/origin/feat/T1", head);
    const file = join(f.dir, "web/out/index.html"); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "keep nested output");
    mkdirSync(join(f.dir, "web/.next")); symlinkSync(join(f.dir, "source.txt"), join(f.dir, "web/.next/link"));
    const target = f.target("on"); target.head = head;
    expect(await openFixWorktree(git, f.dir, target, f.dir, async () => ({ ok: true, head }))).toEqual({ dir: f.dir });
    expect(readFileSync(file, "utf8")).toBe("keep nested output"); expect(existsSync(f.quarantineRoot)).toBe(false);
  } finally { f.close(); }
});

test("[验收线 3] comments cannot supply a missing static-export provenance fact", async () => {
  const f = artifactFixture();
  try {
    writeFileSync(join(f.dir, "web/next.config.ts"), '// output: "export"\nexport default { output: "standalone" };\n');
    command(f.dir, "add", "web/next.config.ts"); command(f.dir, "commit", "-qm", "different next output");
    const head = command(f.dir, "rev-parse", "HEAD"); command(f.main, "update-ref", "refs/remotes/origin/feat/T1", head);
    const target = f.target("on"); target.head = head;
    expect(await openFixWorktree(git, f.dir, target, f.dir, async () => ({ ok: true, head }))).toHaveProperty("manual");
    retained(f); expect(existsSync(f.quarantineRoot)).toBe(false);
  } finally { f.close(); }
});

test("[验收线 4] a symlinked isolation ancestor creates nothing outside the batch", async () => {
  const f = artifactFixture();
  try {
    const context = f.context("on"), path = convArtifactIsolationPath(context), proof = await convArtifactProof(git, f.dir, f.main, context);
    const external = join(f.root, "external-target"); mkdirSync(external); writeFileSync(join(external, "marker"), "unchanged");
    mkdirSync(path, { recursive: true });
    expect(() => moveArtifactBatch(f.dir, path, proof.candidates, context, {
      beforeMove: (_sub, dest) => { symlinkSync(external, join(dest, "../..")); },
    })).toThrow();
    expect(readdirSync(external)).toEqual(["marker"]); retained(f);
  } finally { f.close(); }
});

test("[验收线 3] root ignore proof covers non-ASCII child names but refuses a directory with only ignored children", async () => {
  for (const excludedRoot of [true, false]) {
    const f = artifactFixture();
    try {
      const special = "web/out/空 格.bin";
      writeFileSync(join(f.dir, special), "special bytes");
      if (!excludedRoot) {
        const path = join(f.dir, "web/.gitignore");
        writeFileSync(path, readFileSync(path, "utf8").replace("/out/", "/out/*"));
        command(f.dir, "add", "web/.gitignore"); command(f.dir, "commit", "-qm", "only ignore children");
      }
      const proof = await convArtifactProof(git, f.dir, f.main, f.context("on"));
      if (excludedRoot) {
        expect(proof.reason).toBeNull(); expect(await f.open("on")).toEqual({ dir: f.dir });
        const batch = join(convArtifactIsolationPath(f.context("on")), batches(f)[0]);
        expect(readFileSync(join(batch, "artifacts", special), "utf8")).toBe("special bytes");
      } else {
        expect(proof.reason).not.toBeNull(); retained(f); expect(existsSync(f.quarantineRoot)).toBe(false);
      }
    } finally { f.close(); }
  }
});
