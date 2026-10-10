/**
 * i28-SECPOOL4 review stale-origin: the deploy tick's repository check reads repoDir's origin as it is now, never the planner's
 * cached value. A real git repository is the repoDir; the origin is changed in place after the cache was filled.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { projectRepo, setForeignRepoLookupForTest } from "../src/lib/scheduler-foreign-repo.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { deployTick } from "../src/lib/scheduler-deploy-tick.js";
import { getDeployRun } from "../src/lib/scheduler-deploy.js";
import type { DeployJobs } from "../src/lib/scheduler-deploy-job.js";
import { ledgerAs, mergedCard } from "./deploy-test-kit.js";

const git = (dir: string, ...args: string[]) => expect(spawnSync("git", args, { cwd: dir }).status).toBe(0);
let dirs: string[] = [];
afterEach(() => {
  setForeignRepoLookupForTest({ project: null, origin: null });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** A repoDir whose origin starts at example/repo (the card's repository) and the cache filled with it, then moved in place. */
function movedRepoDir() {
  const repoDir = mkdtempSync(join(tmpdir(), "secpool4-origin-"));
  dirs.push(repoDir);
  git(repoDir, "init", "-q");
  git(repoDir, "remote", "add", "origin", "git@github.com:example/repo.git");
  const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir,
    deploy: { restartLabels: ["x.fake"], timeoutMs: 60_000 } } } });
  expect(projectRepo(config.projects.p)).toBe("example/repo"); // the planner's read: cached
  git(repoDir, "remote", "set-url", "origin", "https://github.com/shawnlu96/claudestra.git");
  return config;
}

function jobs() {
  const log: string[] = [];
  const j: DeployJobs = { label: () => "com.claudestra.scheduler.deploy.x", submit: async () => { log.push("submit"); return "x"; },
    observe: async () => null, remove: async () => true };
  return { j, log };
}
const deps = (db: Database, j: DeployJobs) => ({ manager: ledgerAs(db, "scheduler"), jobs: j, assertActive: () => {}, now: () => 1000 });

describe("i28-SECPOOL4 review stale-origin", () => {
  test("repoDir's origin moved in place within the cache window: the merged example/repo card is not claimed or submitted", async () => {
    setForeignRepoLookupForTest({ origin: null });
    const config = movedRepoDir(), c = mergedCard(), { j, log } = jobs(); // its PR is example/repo
    try {
      await deployTick(c.db, config, deps(c.db, j));
      expect(log).toEqual([]);
      expect(getDeployRun(c.db, c.intent)).toBeNull();
    } finally { c.close(); }
  });

  test("a claimed row recovered after the origin moved in place is not submitted either", async () => {
    setForeignRepoLookupForTest({ origin: null });
    const config = movedRepoDir(), c = mergedCard(), { j, log } = jobs();
    try {
      expect((await ledgerAs(c.db, "scheduler")("ledger", "scheduler-deploy-begin", c.intent)).ok).toBe(true);
      await deployTick(c.db, config, deps(c.db, j));
      expect(log).toEqual([]);
      expect(getDeployRun(c.db, c.intent)).toMatchObject({ phase: "unknown",
        reason: expect.stringContaining("不是项目仓库，不走自动部署：PR 在 example/repo") });
    } finally { c.close(); }
  });

  test("an unmoved origin still deploys the project's own card", async () => {
    setForeignRepoLookupForTest({ origin: null });
    const repoDir = mkdtempSync(join(tmpdir(), "secpool4-origin-"));
    dirs.push(repoDir);
    git(repoDir, "init", "-q");
    git(repoDir, "remote", "add", "origin", "https://github.com/example/repo.git");
    const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir,
      deploy: { restartLabels: ["x.fake"], timeoutMs: 60_000 } } } });
    const c = mergedCard(), { j, log } = jobs();
    try {
      await deployTick(c.db, config, deps(c.db, j));
      expect(log).toEqual(["submit"]);
      expect(getDeployRun(c.db, c.intent)?.phase).toBe("running");
    } finally { c.close(); }
  });
});
