/**
 * ONB-2 验收 6：`ledger local-merge` 在真 git 临时仓库上（lib/local-merge-run.ts）。卡由真实台账 CLI 走到 merge（审查通过、head 是仓库里
 * 真实的提交），合并由 runLocalMerge 做：快进 / 干净合并提交（检查跑在合并后的树上）/ 冲突、检查失败、检查期间 main 变了、主目录不干净都拒且
 * main 不动；head 不对、不在 merge、审查不是这个 head、调用者不是 PM 都拒且台账不动；重跑返回原记录；同一项目并发第二次报 busy；
 * head 已在 main 只补记。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { runLocalMerge, type LocalMergeOutcome } from "../src/lib/local-merge-run.js";
import { autoFixture, toBuild } from "./scheduler-auto-helpers.js";

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};
const commit = (repo: string, file: string, body: string, msg: string) => {
  writeFileSync(join(repo, file), body);
  git(repo, "add", file);
  git(repo, "commit", "-qm", msg);
  return git(repo, "rev-parse", "HEAD");
};

let tmp: string, repo: string, base: string, head: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "onb2-merge-"));
  repo = join(tmp, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@t");
  base = commit(repo, "a.txt", "a\n", "base");
  git(repo, "checkout", "-qb", "feat/t1");
  head = commit(repo, "feat.txt", "feat\n", "card");
  git(repo, "checkout", "-q", "main");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** The real auto flow up to `merge` at the repository's own card head, reviewed by the other family. */
async function atMerge(at = head) {
  const f = autoFixture();
  await toBuild(f);
  await f.tick();
  const d = await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", at);
  if (d.ok !== true) throw new Error(JSON.stringify(d));
  await f.tick();
  await f.tick();
  await f.review("pass", at, []);
  expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  return f;
}

type F = Awaited<ReturnType<typeof atMerge>>;
const merge = (f: F, o: { actor?: string; head?: string; checks?: string[]; timeoutMs?: number } = {}) =>
  runLocalMerge(f.db, { actor: o.actor ?? "pm", now: Date.now() }, { repoDir: repo, checks: o.checks ?? ["test -f feat.txt"] },
    { taskId: "T1", head: o.head ?? head }, { checkTimeoutMs: o.timeoutMs ?? 30_000, tmpRoot: tmp });
const records = (f: F) => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "local_merge");
const mainSha = () => git(repo, "rev-parse", "main");
const worktrees = () => git(repo, "worktree", "list").split("\n").length;

/** A refusal leaves main, the card and the record list exactly as they were (and no temporary worktree behind). */
async function refused(f: F, run: () => Promise<LocalMergeOutcome>, why: RegExp) {
  const before = { main: mainSha(), rev: f.task().rev, events: listEvents(f.db, { project: "p", target: "T1" }).length };
  await expect(run()).rejects.toThrow(why);
  expect({ main: mainSha(), rev: f.task().rev, events: listEvents(f.db, { project: "p", target: "T1" }).length }).toEqual(before);
  expect(f.task().stage).toBe("merge");
  expect(worktrees()).toBe(1);
}

describe("local-merge：合进本地 main", () => {
  test("main 没动：快进到 head，检查在临时 worktree 里跑，记一条 local_merge、进 live、释放文件锁", async () => {
    const f = await atMerge();
    try {
      const r = await merge(f, { checks: ["test -f feat.txt", "test -f a.txt"] });
      expect(r).toMatchObject({ ok: true, duplicate: false, mode: "ff", head, mergeSha: head, base });
      expect(r.checks.map((c) => [c.check, c.code, c.timedOut])).toEqual([["test -f feat.txt", 0, false], ["test -f a.txt", 0, false]]);
      expect(mainSha()).toBe(head);
      expect(worktrees()).toBe(1);
      expect(f.task().stage).toBe("live");
      const [rec] = records(f);
      expect(rec).toMatchObject({ actor: "pm", kind: "decision", data: { op: "local_merge", head, mergeSha: head, base, mode: "ff" } });
      const moved = listEvents(f.db, { project: "p", target: "T1" }).findLast((e) => e.kind === "stage")!;
      expect(moved.data).toMatchObject({ from: "merge", to: "live", head, mergeSha: head, localMergeSeq: rec!.seq });
      expect(f.db.query("SELECT * FROM scheduler_resources WHERE taskId = 'T1'").all()).toEqual([]);
      expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
    } finally { f.close(); }
  });

  test("main 动过但能干净合并：合并提交的父提交是（原 main、head），检查跑在合并后的树上", async () => {
    const f = await atMerge();
    try {
      const moved = commit(repo, "main2.txt", "m\n", "main moved");
      const r = await merge(f, { checks: ["test -f main2.txt", "test -f feat.txt"] });
      expect(r).toMatchObject({ mode: "merge", base: moved, head });
      expect(mainSha()).toBe(r.mergeSha);
      expect(git(repo, "rev-list", "--parents", "-n", "1", r.mergeSha).split(" ").slice(1)).toEqual([moved, head]);
      expect(r.checks.every((c) => c.code === 0)).toBe(true);
      expect(f.task().stage).toBe("live");
    } finally { f.close(); }
  });

  test("重跑返回原记录、不再合并；head 已在 main 但没记账时只补记", async () => {
    const f = await atMerge();
    try {
      const first = await merge(f);
      const again = await merge(f);
      expect(again).toEqual({ ...first, duplicate: true });
      expect(records(f)).toHaveLength(1);
    } finally { f.close(); }
    const g = await atMerge();
    try {
      git(repo, "reset", "-q", "--hard", base); // the first fixture's merge moved main: start this one from base again
      git(repo, "merge", "-q", "--ff-only", head); // merged by hand (or the record write after the ff failed)
      const r = await merge(g, { checks: ["false"] });
      expect(r).toMatchObject({ mode: "backfill", mergeSha: head, checks: [], duplicate: false });
      expect(g.task().stage).toBe("live");
    } finally { g.close(); }
  });
});

describe("local-merge：重跑（r1 审查 P1）", () => {
  test("已合并后重跑也先认调用者和项目：非 PM、项目不再是 localMerge 都拒，不交回原记录", async () => {
    const f = await atMerge();
    try {
      await merge(f);
      const events = listEvents(f.db, { project: "p", target: "T1" }).length;
      await expect(merge(f, { actor: "agent-task-one" })).rejects.toThrow(/PM/);
      await expect(runLocalMerge(f.db, { actor: "pm", now: Date.now() }, null, { taskId: "T1", head })).rejects.toThrow(/不是 localMerge 项目/);
      expect(listEvents(f.db, { project: "p", target: "T1" })).toHaveLength(events);
    } finally { f.close(); }
  });

  test("同一 head 第二次进 merge（live → fix → review → merge）：再合一次进 live，不拿第一次的记录顶替", async () => {
    const f = await atMerge();
    try {
      const first = await merge(f);
      const stage = async (from: string, to: string) => {
        const r = await f.cli("pm", "stage", "T1", "--from", from, "--to", to, "--text", "回滚后重走");
        if (r.ok !== true) throw new Error(JSON.stringify(r));
      };
      await stage("live", "fix");
      await stage("fix", "review");
      await f.review("pass", head, []);
      await stage("review", "merge");
      const second = await merge(f);
      expect(second).toMatchObject({ duplicate: false, mode: "backfill", head, mergeSha: head });
      expect(second.seq).not.toBe(first.seq);
      expect(f.task().stage).toBe("live");
      expect(records(f)).toHaveLength(2);
      expect(await merge(f)).toEqual({ ...second, duplicate: true });
    } finally { f.close(); }
  });
});

describe("local-merge：git 一侧的拒绝，main 不动", () => {
  test("有冲突", async () => {
    git(repo, "checkout", "-q", "feat/t1");
    head = commit(repo, "a.txt", "card side\n", "card edits a");
    git(repo, "checkout", "-q", "main");
    commit(repo, "a.txt", "main side\n", "main edits a");
    const f = await atMerge();
    try { await refused(f, () => merge(f), /冲突/); } finally { f.close(); }
  });

  test("检查失败（含超时）", async () => {
    const f = await atMerge();
    try {
      await refused(f, () => merge(f, { checks: ["test -f feat.txt", "false", "true"] }), /检查没过：false（exit 1）/);
      await refused(f, () => merge(f, { checks: ["sleep 5"], timeoutMs: 200 }), /检查没过：sleep 5（超时）/);
    } finally { f.close(); }
  });

  test("检查期间 main 变了", async () => {
    const f = await atMerge();
    try {
      // the check itself moves main in the repository's main directory (no shell: one git argv)
      await expect(merge(f, { checks: [`git -C ${repo} commit -q --allow-empty -m moved`] })).rejects.toThrow(/检查期间 main 变了/);
      expect(mainSha()).not.toBe(head);
      expect(Bun.spawnSync(["git", "merge-base", "--is-ancestor", head, "main"], { cwd: repo }).exitCode).toBe(1); // head never reached main
      expect(f.task().stage).toBe("merge");
      expect(records(f)).toEqual([]);
    } finally { f.close(); }
  });

  test("主目录不干净 / 不在 main 上", async () => {
    const f = await atMerge();
    try {
      writeFileSync(join(repo, "junk.txt"), "x");
      await refused(f, () => merge(f), /未提交的改动/);
      rmSync(join(repo, "junk.txt"));
      git(repo, "checkout", "-q", "feat/t1");
      await refused(f, () => merge(f), /不在 main 分支/);
    } finally { f.close(); }
  });

  test("同一项目同时跑第二次报 busy，第一次照常合并", async () => {
    const f = await atMerge();
    try {
      const slow = merge(f, { checks: ["sleep 1"] });
      await Bun.sleep(100);
      await expect(merge(f)).rejects.toMatchObject({ code: "busy" });
      expect((await slow).mode).toBe("ff");
      expect(records(f)).toHaveLength(1);
    } finally { f.close(); }
  });
});

describe("local-merge：台账一侧的拒绝，台账和 main 都不动", () => {
  test("head 不对 / 调用者不是 PM", async () => {
    const f = await atMerge();
    try {
      await refused(f, () => merge(f, { head: "2".repeat(40) }), /不是台账 head/);
      await refused(f, () => merge(f, { actor: "agent-task-one" }), /PM/);
    } finally { f.close(); }
  });

  test("卡不在 merge", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      await expect(merge(f)).rejects.toThrow(/不在 merge/);
      expect(mainSha()).toBe(base);
    } finally { f.close(); }
  });

  test("本轮审查不是这个 head", async () => {
    const f = await atMerge();
    try {
      const other = commit(repo, "x.txt", "x\n", "unreviewed");
      git(repo, "reset", "-q", "--hard", base);
      f.db.query("UPDATE tasks SET headSHA = ? WHERE id = 'T1'").run(other); // the ledger head moved past the reviewed one
      await refused(f, () => merge(f, { head: other }), /审查/);
      expect(records(f)).toEqual([]);
    } finally { f.close(); }
  });

  test("不是 localMerge 项目：拒，不碰仓库", async () => {
    const f = await atMerge();
    try {
      await expect(runLocalMerge(f.db, { actor: "pm", now: Date.now() }, null, { taskId: "T1", head })).rejects.toThrow(/不是 localMerge 项目/);
      expect(mainSha()).toBe(base);
    } finally { f.close(); }
  });
});
