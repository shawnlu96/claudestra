/**
 * ONB-1 验收 3：localMerge 项目的 MCP deliver 按本机分支 refs/heads/<branch> 核对 head，origin / PR 一次都不查，task.pr 保持为空；
 * 对不上报 head_mismatch。localBranchHead 用真 git 临时仓库；gh 用 PATH 上的假 gh 记调用，证明整次交付（含规格外登记）没调过 gh。
 */
import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.ts";
import { setMeta } from "../src/lib/ledger-write.ts";
import { deliverOrder, localBranchHead, type DeliverDeps, type RemoteHead } from "../src/lib/order-deliver.ts";
import type { LedgerRun } from "../src/lib/order-ledger-exit.ts";
import type { VerifiedCall } from "../src/lib/order-tool-route.ts";
import { runBounded } from "../src/lib/run-bounded.ts";
import type { Registry } from "../src/manager/core.ts";
import { runLedger } from "../src/manager/ledger.ts";

const PROJ = "p1", LEAD = "agent-lead", DEV = "agent-task-l1", BR = "feat/l1";
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};

let tmp: string, repo: string, head: string, ghLog: string, oldPath: string | undefined;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "onb1-deliver-"));
  repo = join(tmp, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  git(repo, "checkout", "-qb", BR);
  writeFileSync(join(repo, "b.txt"), "b\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "card");
  head = git(repo, "rev-parse", "HEAD");
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  ghLog = join(tmp, "gh.log");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${ghLog}"\nexit 1\n`);
  chmodSync(join(bin, "gh"), 0o755);
  oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
});
afterAll(() => {
  process.env.PATH = oldPath;
  rmSync(tmp, { recursive: true, force: true });
});

describe("localBranchHead：真 git", () => {
  test("本机分支 → 完整 sha；没有的分支 / 不合法分支名 → 拒", async () => {
    expect(await localBranchHead(repo, BR, runBounded)).toEqual({ ok: true, head });
    expect((await localBranchHead(repo, "feat/none", runBounded)).ok).toBe(false);
    expect((await localBranchHead(repo, "--all", runBounded)).ok).toBe(false);
  });

  test("假 gh 在 PATH 上生效（下面「gh 零调用」的前提）", () => {
    Bun.spawnSync(["gh", "probe"], { env: process.env });
    expect(existsSync(ghLog)).toBe(true);
    rmSync(ghLog);
  });
});

let db: Database, calls: string[];
const channels: Record<string, string> = { "c-lead": LEAD, "c-dev": DEV };
const ledger = (actor: string, ...args: string[]) => {
  const reg = { socket: "", agents: { [LEAD]: { status: "active", projectId: PROJ }, [DEV]: { status: "active", projectId: PROJ } } } as unknown as Registry;
  return runLedger(args, { db, actor, actorProject: PROJ, projectIds: [PROJ], loadRegistry: async () => structuredClone(reg), saveRegistry: async () => {},
    now: () => Date.now() }) as Promise<Record<string, any>>;
};
const viaCli: LedgerRun = (args, ch) => ledger(channels[ch] ?? "unknown", ...args.slice(1));
const me: VerifiedCall = { agent: DEV, sessionId: "s1", family: "claude-code", channelId: "c-dev" };
const order = (h: string) => ({ v: 1, orderId: "L1:write:r0", head: h, evidence: "docs/tasks/L1.report.md", summary: "交付", selfCheck: "过" });
const deps = (local: { repoDir: string } | null, o: Partial<DeliverDeps> = {}): DeliverDeps => ({
  db, run: viaCli,
  remoteHead: async (): Promise<RemoteHead> => (calls.push("remoteHead"), { ok: true, head }),
  findPr: async () => (calls.push("findPr"), { ok: true, rows: [] }),
  localMerge: () => local, localHead: (dir, b) => (calls.push("localHead"), localBranchHead(dir, b, runBounded)), ...o,
});
const card = () => getTask(db, "L1")!;

beforeEach(async () => {
  calls = [];
  db = openLedger(":memory:");
  setMeta(db, { actor: "owner", now: 1 }, { project: PROJ, key: "pms", value: [LEAD] });
  await ledger(LEAD, "item-new", "i1", "--title", "底座");
  expect(await ledger(LEAD, "task-new", "L1", "--title", "本地交付", "--kind", "code", "--item", "i1", "--agent", "task-l1", "--branch", BR)).toMatchObject({ ok: true });
  await ledger(DEV, "stage", "L1", "--from", "spec", "--to", "restate");
  await ledger(LEAD, "stage", "L1", "--from", "restate", "--to", "build");
});
afterEach(() => closeLedger(":memory:"));

describe("deliverOrder：localMerge 项目", () => {
  test("按本机分支核对 head、到 review；origin / PR 都不查，gh 零调用，task.pr 为空", async () => {
    expect(await deliverOrder(me, order(head), deps({ repoDir: repo }))).toMatchObject({ ok: true, stage: "review" });
    expect(card()).toMatchObject({ stage: "review", headSHA: head, pr: null });
    expect(calls).toEqual(["localHead"]);
    expect(existsSync(ghLog)).toBe(false);
  });

  test("head 和本机分支对不上 → head_mismatch，台账不动", async () => {
    const before = card().rev;
    expect(await deliverOrder(me, order("e".repeat(40)), deps({ repoDir: repo }))).toMatchObject({ ok: false, code: "head_mismatch" });
    expect(card()).toMatchObject({ stage: "build", rev: before, headSHA: null });
    expect(calls).toEqual(["localHead"]);
  });

  test("没接本机分支核对 / 仓库里没这个分支 → head_unverifiable，不回落到 origin", async () => {
    expect(await deliverOrder(me, order(head), deps({ repoDir: repo }, { localHead: undefined }))).toMatchObject({ code: "head_unverifiable" });
    expect(await deliverOrder(me, order(head), deps({ repoDir: tmp }))).toMatchObject({ code: "head_unverifiable" });
    expect(calls.filter((c) => c !== "localHead")).toEqual([]);
  });

  test("非 localMerge 项目照旧查 origin 与 PR（没有 PR 被拒）", async () => {
    expect(await deliverOrder(me, order(head), deps(null))).toMatchObject({ ok: false, code: "pr_missing" });
    expect(calls).toEqual(["remoteHead", "findPr"]);
  });
});
