/**
 * PMHAND1 9补2: a card whose author PM dispatched by hand (no bound author session, no lend order, no peer PR) still gets its
 * reviewer: createReviewer falls back to the project's repoDir, takes the head there and adds the usual detached review worktree.
 * A private-repo card keeps the old refusal. Real git through the production autoTickDeps wiring; HOME / TMPDIR / git config temporary.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { statePath } from "../src/lib/paths.js";
import { autoTickDeps } from "../src/lib/scheduler-auto-deps.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { git, gitHeadSync } from "../src/lib/scheduler-review-worktree.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["HOME", "TMPDIR", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];
let sandbox = "";

beforeAll(() => {
  if (statePath("x").startsWith(join(homedir(), ".claude-orchestrator"))) throw new Error("测试落到了生产状态目录，拒绝继续");
  sandbox = mkdtempSync(join(tmpdir(), "pmhand1-home-"));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  mkdirSync(join(sandbox, "tmp"));
  writeFileSync(join(sandbox, "gitconfig"), "[user]\n\tname = t\n\temail = t@t\n[init]\n\tdefaultBranch = main\n");
  Object.assign(process.env, { HOME: sandbox, TMPDIR: join(sandbox, "tmp"), GIT_CONFIG_GLOBAL: join(sandbox, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" });
});
afterAll(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(sandbox, { recursive: true, force: true });
});

async function must(...args: string[]): Promise<string> {
  const r = await git(args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.out}`);
  return r.out;
}

/** The project clone holds the PM-dispatched author's head (pushed from the author's own local checkout); nothing on a lend branch. */
async function setup() {
  const root = mkdtempSync(join(sandbox, "tmp", "rd-")), project = join(root, "project");
  await must("init", "-q", project);
  writeFileSync(join(project, "a.ts"), "one\n");
  await must("-C", project, "add", "a.ts");
  await must("-C", project, "commit", "-q", "-m", "one");
  const head = await must("-C", project, "rev-parse", "HEAD");
  const f = autoFixture(), checkout = join(root, "worktrees", "rv-t1");
  const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
  delete reg.agents["agent-rv-t1"]; // no reviewer yet: ensure creates one
  writeFileSync(f.registryPath, JSON.stringify(reg));
  f.db.query("UPDATE tasks SET headSHA = ?, stage = 'review' WHERE id = 'T1'").run(head);
  const cfg = (): SchedulerConfig => ({ projects: { p: { repoDir: project } } }) as unknown as SchedulerConfig;
  const create = async (...args: string[]) => {
    if (args[0] !== "create") return { ok: false, error: "unexpected" };
    const r = JSON.parse(readFileSync(f.registryPath, "utf8"));
    r.agents["agent-rv-t1"] = { runtime: "codex", transport: "acp", sessionId: "s-rv2", cwd: checkout };
    writeFileSync(f.registryPath, JSON.stringify(r));
    return { ok: true };
  };
  const d = autoTickDeps(f.db, { registryPath: f.registryPath, worktreeRoot: join(root, "worktrees"), readConfig: cfg, create });
  const samples = () => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "pm_handback");
  return { f, d, head, checkout, samples, close: () => { f.close(); rmSync(root, { recursive: true, force: true }); } };
}

describe("[验收线 2] no bound author, no remote head: the reviewer checkout comes from the project repository", () => {
  test("own-repo card: reviewer created at the head, one review_dir_fallback sample", async () => {
    const { f, d, head, checkout, samples, close } = await setup();
    try {
      expect(await d.ensure(getTask(f.db, "T1")!, "reviewer", "codex")).toMatchObject({ kind: "ready", created: true });
      expect(gitHeadSync(checkout)).toBe(head);
      expect(samples().map((e) => [e.data.type, e.data.head])).toEqual([["review_dir_fallback", head]]);
    } finally { close(); }
  });

  test("private-repo card: refused as before, no local reviewer, no sample", async () => {
    const { f, d, samples, close } = await setup();
    try {
      f.db.query(`UPDATE tasks SET extra = json_set(extra, '$.fileGlobs', json('["repo:o/priv:src/x.ts"]'), '$.repo', 'o/priv') WHERE id = 'T1'`).run();
      expect(await d.ensure(getTask(f.db, "T1")!, "reviewer", "codex"))
        .toEqual({ kind: "manual", reason: expect.stringContaining("找不到执行者的工作目录") });
      expect(samples()).toEqual([]);
    } finally { close(); }
  });
});
