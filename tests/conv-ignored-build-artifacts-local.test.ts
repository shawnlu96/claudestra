import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactFixture, buildPaths, command } from "./conv-ignored-build-artifacts.test.js";
import { BRANCH, leaked, MIN, swapFixture, toFix } from "./recovery-fix-local-swap-fixture.js";
import { FIX_LOCAL_SWAP_WAIT_MS, localSwapPorts } from "../src/lib/recovery-fix-local-swap.js";
import { convArtifactIsolationPath } from "../src/lib/conv-ignored-build-artifacts-quarantine.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { openFixWorktree } from "../src/lib/fix-strategy-worktree.js";
import { git } from "../src/lib/scheduler-review-worktree.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";

async function localArtifactSwap(mode: RecoveryMode) {
  const f = artifactFixture(), p = await swapFixture();
  command(f.dir, "branch", "-m", BRANCH);
  command(f.main, "update-ref", `refs/remotes/origin/${BRANCH}`, f.head);
  p.context.source = f.dir;
  p.probe.edit((r) => { r.agents["agent-task-one"].cwd = f.dir; });
  p.probe.deps.worktreeRoot = f.trees;
  p.probe.deps.artifacts = { repository: f.main, quarantineRoot: f.quarantineRoot, policy: f.context(mode).policy };
  p.probe.deps.authorTree = (source, target, recorded) => openFixWorktree(git, source, target, recorded, async () => ({ ok: true, head: f.head }));
  await toFix(p, leaked(), f.head);
  expect(await p.tick()).toMatchObject({ step: "pool_refused" });
  const advance = async (passes = 3) => {
    await p.later(FIX_LOCAL_SWAP_WAIT_MS + MIN);
    for (let i = 0; i < passes; i++) await p.later(MIN);
  };
  const creates = () => p.probe.effects.filter((e) => e.startsWith("create:"));
  return { f, p, advance, creates, close: () => { p.f.close(); f.close(); } };
}

for (const mode of ["on", "off", "observe"] as const) test(`[验收线 1] [验收线 2] localSwapCreate ${mode} real linked tree reaches the intended result`, async () => {
  const s = await localArtifactSwap(mode), { f, p } = s;
  try {
    await s.advance();
    const observations = p.events().filter((e) => e.data.mechanism === "convIgnoredBuildArtifacts");
    const refusal = p.events().filter((e) => e.data.op === "convergence_effect" && e.text.includes("tree-refused"));
    expect(observations.length).toBe(mode === "observe" ? 1 : 0);
    if (mode === "on") {
      expect(p.swaps()).toEqual([expect.objectContaining({ status: "done" })]);
      expect(refusal).toHaveLength(0); expect(s.creates()).toHaveLength(1);
      expect(getSchedulerSession(p.f.db, "T1", "author")?.sessionId).not.toBe("s-one");
      const intent = p.swaps()[0]!.id;
      const path = convArtifactIsolationPath({ ...f.context("on"), project: "p", intentId: intent });
      const batches = readdirSync(path).filter((v) => v.startsWith("batch-")); expect(batches).toHaveLength(1);
      const batch = join(path, batches[0]);
      expect(JSON.parse(readFileSync(join(batch, "receipt.json"), "utf8"))).toMatchObject({ status: "complete", moved: buildPaths });
      for (const [relative, bytes] of f.bytes) expect(readFileSync(join(batch, "artifacts", relative)).toString("hex")).toBe(bytes.toString("hex"));
      await p.later(MIN); expect(s.creates()).toHaveLength(1); expect(readdirSync(path).filter((v) => v.startsWith("batch-"))).toHaveLength(1);
    } else {
      expect(s.creates()).toHaveLength(0); expect(existsSync(f.quarantineRoot)).toBe(false);
      for (const [relative, bytes] of f.bytes) expect(readFileSync(join(f.dir, relative)).toString("hex")).toBe(bytes.toString("hex"));
      if (mode === "observe") {
        expect(observations[0]!.text).toMatch(/本会\s*挪走 6 项/);
        expect(observations[0]!.text.match(/本会/g)).toHaveLength(1);
        expect(observations[0]!.data).toMatchObject({ paths: buildPaths, count: 6 });
      }
    }
  } finally { s.close(); }
});

for (const late of ["tracked", "ignored", "quota"] as const) test(`[验收线 5] localSwapCreate ${late} drift during the post-isolation quota await still blocks create`, async () => {
  const s = await localArtifactSwap("on"), { f, p } = s;
  try {
    const quota = localSwapPorts(p.f.db).quota!;
    let tripped = false;
    localSwapPorts(p.f.db).quota = async (family) => {
      if (!tripped && !existsSync(join(f.dir, "web/out"))) {
        tripped = true;
        if (late === "tracked") writeFileSync(join(f.dir, "source.txt"), "late source edit");
        if (late === "ignored") writeFileSync(join(f.dir, "web/next-env.d.ts"), "regenerated cache");
        if (late === "quota") p.state.quota = new Error("quota unavailable after isolation");
      }
      return quota(family);
    };
    await s.advance(1); expect(tripped).toBe(true); expect(s.creates()).toHaveLength(0);
    expect(p.swaps()).not.toEqual([expect.objectContaining({ status: "done" })]);
    expect(getSchedulerSession(p.f.db, "T1", "author")?.sessionId).toBe("s-one");
    expect(p.events().some((e) => String(e.data.reason ?? "").includes(late === "quota" ? "额度" : "有改动"))).toBe(true);
  } finally { s.close(); }
});

for (const late of ["switch", "old-session"] as const) test(`[验收线 5] localSwapCreate ${late} drift before candidate proof prevents isolation`, async () => {
  const s = await localArtifactSwap("on"), { f, p } = s;
  try {
    const tree = p.probe.deps.authorTree!;
    let tripped = false;
    p.probe.deps.authorTree = async (...args) => {
      tripped = true;
      if (late === "switch") p.state.mode = "off";
      else p.probe.edit((r) => { r.agents["agent-task-one"].status = "active"; });
      return tree(...args);
    };
    await s.advance(1); expect(tripped).toBe(true); expect(s.creates()).toHaveLength(0);
    expect(existsSync(f.quarantineRoot)).toBe(false);
    for (const [relative, bytes] of f.bytes) expect(readFileSync(join(f.dir, relative)).toString("hex")).toBe(bytes.toString("hex"));
  } finally { s.close(); }
});
