/**
 * ONB-3 `team onboard`（src/manager/team-onboard.ts）：dry-run 零写入、新增项目段带审计事件、无 origin 不带 --local-merge 拒、
 * 重跑无副作用、只出 team up 提案不写 pms、非 PM / owner 拒、已有段只列差异不覆盖。临时台账 / scheduler.json / 提案文件。
 */
import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { Database as RawDb } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, getMeta, LEDGER_SCHEMA_VERSION, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { readSchedulerConfig } from "../src/lib/scheduler-config.js";
import { readProposals, updateProposals, type TeamProposal } from "../src/lib/team-proposal.js";
import { onboardDb, planOnboard, runOnboard, splitChecks, type OnboardFacts, type OnboardInput } from "../src/manager/team-onboard.js";
import { planUp, propose, repost } from "../src/manager/team-up.js";

const team = { planUp, propose, repost };
import { tempLedgerPath } from "./ledger-test-helpers.js";

const P = "dn";
const NOW = 9_000_000;
const SCHED = { enabled: true, autoDispatch: true, futureTop: 1, projects: { claudestra: { maxActiveWorkers: 4, requiredChecks: ["ci"], repoDir: "/r/c" } } };
let db: Database;
let dir: string;
let schedulerPath: string;
let proposalsPath: string;
let posted: TeamProposal[];
/** 非空 = 桩当作 bridge 贴卡失败，返回这段错误 */
let postFail: string | null;

const agents = { "agent-dn-pm": { status: "active", projectId: P }, "agent-exec": { status: "active", projectId: P } };
const input = (o: Partial<OnboardInput> = {}): OnboardInput => ({
  project: P, dir: "/repos/dn", git: "no-origin", actor: "agent-dn-pm", agents, dryRun: false,
  flags: { localMerge: true, checks: ["cargo test"] }, ...o,
});
/** 贴卡桩：同 bridge postProposalCard，贴成功才在提案上记 posted */
async function post(p: TeamProposal): Promise<string | null> {
  posted.push(p);
  if (postFail) return postFail;
  await updateProposals((m) => void (m[p.id]!.posted = { chatId: "c", messageIds: [] }), NOW, proposalsPath);
  return null;
}
const run = (o: Partial<OnboardInput> = {}) =>
  runOnboard(input(o), { db, now: NOW, schedulerPath, team, proposals: { path: proposalsPath, post } }) as Promise<Record<string, any>>;
const snap = () => ({
  sched: readFileSync(schedulerPath, "utf8"), mtime: statSync(schedulerPath).mtimeMs,
  proposals: existsSync(proposalsPath) ? readFileSync(proposalsPath, "utf8") : null, events: listEvents(db, { project: P }).length,
});

beforeEach(() => {
  db = openLedger(tempLedgerPath("team-onboard-"));
  dir = mkdtempSync(join(tmpdir(), "team-onboard-"));
  schedulerPath = join(dir, "scheduler.json");
  proposalsPath = join(dir, "proposals.json");
  writeFileSync(schedulerPath, JSON.stringify(SCHED, null, 2) + "\n");
  posted = [];
  postFail = null;
  setMeta(db, { actor: "owner", now: 1 }, { project: P, key: "pms", value: ["agent-dn-pm"] });
});

describe("team onboard", () => {
  test("--dry-run 不写任何文件：scheduler.json 字节与修改时间不变、不出提案、台账不加事件", async () => {
    const before = snap();
    const r = await run({ dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.items.map((x: { key: string; status: string }) => `${x.key}:${x.status}`)).toEqual(["project:ok", "git:ok", "scheduler:todo", "team:todo"]);
    expect(snap()).toEqual(before);
    expect(posted).toEqual([]);
  });

  test("新增项目段：只加这一段、带审计事件，全局开关和别的项目原样；调度器读得出", async () => {
    const r = await run();
    expect(r.ok).toBe(true);
    const doc = JSON.parse(readFileSync(schedulerPath, "utf8"));
    expect(doc.projects.claudestra).toEqual(SCHED.projects.claudestra);
    expect(doc.futureTop).toBe(1);
    expect(doc.projects[P]).toEqual({ maxActiveWorkers: 2, requiredChecks: ["cargo test"], repoDir: "/repos/dn", supervise: false, localMerge: true });
    expect(readSchedulerConfig(schedulerPath).projects[P]).toMatchObject({ localMerge: true, remote: { mode: "off" } });
    const audit = listEvents(db, { project: P }).filter((e) => e.data.op === "scheduler_project_add");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: "agent-dn-pm", kind: "decision" });
    expect(r.items.find((x: { key: string }) => x.key === "scheduler").status).toBe("done");
  });

  test("只出 team up 提案，不直接写 pms / team", async () => {
    const r = await run({ flags: { localMerge: true, checks: ["cargo test"], pm: "agent-exec" } });
    expect(r.ok).toBe(true);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ kind: "up", project: P, pm: "agent-exec", status: "pending" });
    expect(posted[0].pms).toContain("agent-exec");
    expect(getMeta(db, P).pms).toEqual(["agent-dn-pm"]);
    expect(getMeta(db, P).team).toBeNull();
    expect(Object.keys(await readProposals(proposalsPath))).toEqual([r.proposal]);
  });

  test("重跑没有副作用：段已在、提案还在等确认，都不再写", async () => {
    await run();
    const before = snap();
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.items.map((x: { key: string; status: string }) => `${x.key}:${x.status}`)).toEqual(["project:ok", "git:ok", "scheduler:ok", "team:todo"]);
    expect(snap()).toEqual(before);
    expect(posted).toHaveLength(1);
  });

  test("无 origin 又没带 --local-merge：拒，什么都不写", async () => {
    const before = snap();
    const r = await run({ flags: { localMerge: false, checks: ["cargo test"] } });
    expect(r).toMatchObject({ ok: false, code: "blocked" });
    expect(r.error).toContain("--local-merge");
    expect(snap()).toEqual(before);
    expect(posted).toEqual([]);
  });

  test("非 PM / owner 调用被拒（dry-run 也一样）；owner / master 可以", async () => {
    for (const dryRun of [true, false]) expect(await run({ actor: "agent-exec", dryRun })).toMatchObject({ ok: false, code: "forbidden" });
    expect((await run({ actor: "owner", dryRun: true })).ok).toBe(true);
    expect((await run({ actor: "master", dryRun: true })).ok).toBe(true);
  });

  test("已有项目段但值不同：列差异，不覆盖", async () => {
    await run();
    const before = snap();
    const r = await run({ flags: { localMerge: true, checks: ["cargo test", "cargo clippy"], maxWorkers: 3 } });
    const item = r.items.find((x: { key: string }) => x.key === "scheduler");
    expect(item.status).toBe("diff");
    expect(item.text).toContain("requiredChecks");
    expect(item.text).toContain("maxActiveWorkers");
    expect(snap()).toEqual(before);
  });

  test("r1 proposal-card-retry：卡片第一次没贴出去 → 报未完成；重跑重贴同一份提案；贴出后再跑不再贴", async () => {
    postFail = "bridge 不在";
    const first = await run();
    expect(first.ok).toBe(false);
    expect(first.items.find((x: { key: string }) => x.key === "team").status).toBe("todo");
    const id = first.proposal;
    postFail = null;
    const second = await run();
    expect(second).toMatchObject({ ok: true, proposal: id });
    expect(second.items.find((x: { key: string }) => x.key === "team").status).toBe("done");
    expect(posted.map((p) => p.id)).toEqual([id, id]);
    expect(Object.keys(await readProposals(proposalsPath))).toEqual([id]);
    const third = await run();
    expect(third.ok).toBe(true);
    expect(third.items.find((x: { key: string }) => x.key === "team").text).toContain("在等 owner 确认");
    expect(posted).toHaveLength(2);
  });

  test("r1 concurrent-segment-mismatch：两个接入同时规划、参数不同，后进锁的那个列差异，不报成已按自己的参数接入", async () => {
    const [a, b] = await Promise.all([run(), run({ flags: { localMerge: true, checks: ["cargo clippy"] } })]);
    const sched = (r: Record<string, any>) => r.items.find((x: { key: string }) => x.key === "scheduler");
    expect([sched(a).status, sched(b).status].sort()).toEqual(["diff", "done"]);
    const loser = sched(a).status === "diff" ? sched(a) : sched(b);
    expect(loser.text).toContain("requiredChecks");
    expect(listEvents(db, { project: P }).filter((e) => e.data.op === "scheduler_project_add")).toHaveLength(1);
  });

  test("新增段缺 --checks、scheduler.json 不存在：拒", async () => {
    expect(await run({ flags: { localMerge: true } })).toMatchObject({ ok: false, code: "blocked" });
    const missing = join(dir, "none.json");
    const r = await runOnboard(input(), { db, now: NOW, schedulerPath: missing, team, proposals: { path: proposalsPath, post: async () => null } });
    expect(r).toMatchObject({ ok: false, code: "blocked" });
    expect(existsSync(missing)).toBe(false);
  });
});

describe("dry-run 只读打开台账（CLI 路径 onboardDb）", () => {
  /** 落后一版 schema + 一行负责人列偏移：openLedger 打开会迁移、纠正，都是写 */
  function staleLedger(): string {
    const path = tempLedgerPath("team-onboard-stale-");
    const w = openLedger(path);
    setMeta(w, { actor: "owner", now: 1 }, { project: P, key: "pms", value: ["agent-dn-pm"] });
    createTask(w, { actor: "owner", now: 2 }, { project: P, id: "T1", title: "x", kind: "code", agent: "agent-exec" });
    closeLedger(path);
    const raw = new RawDb(path);
    raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    raw.exec("UPDATE tasks SET assigneeKind = NULL, assignee = NULL");
    raw.exec(`PRAGMA user_version = ${LEDGER_SCHEMA_VERSION - 1}`);
    raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    raw.close();
    return path;
  }
  /**
   * 目录里每个文件的字节与修改时间、有哪些子目录（迁移前的备份）。只排除台账自己的 SQLite 辅助文件 <db>-shm / <db>-wal：
   * 规格卡 ONB-3「PM 裁定（2026-10-16 03:39）」定验收线 8 不含这两个（只读打开 WAL 库必动 -shm，immutable=1 并发下会读坏）；
   * 主库和其余文件仍逐字节、mtime 比对。
   */
  const files = (path: string) => {
    const sidecars = new Set([`${basename(path)}-shm`, `${basename(path)}-wal`]);
    return Object.fromEntries(readdirSync(dirname(path)).filter((f) => !sidecars.has(f)).map((f) => {
      const full = join(dirname(path), f), st = statSync(full);
      return [f, st.isDirectory() ? "dir" : { bytes: readFileSync(full).toString("base64"), mtime: st.mtimeMs }];
    }));
  };

  test("r2 dry-run-ledger-write：旧 schema + 负责人列偏移的台账，dry-run 不改台账字节 / mtime / user_version，也不出备份", async () => {
    const path = staleLedger();
    const before = files(path);
    const ro = onboardDb(true, path);
    const r = await runOnboard(input({ dryRun: true }), { db: ro, now: NOW, schedulerPath, team, proposals: { path: proposalsPath, post } });
    ro.close();
    expect(r.ok).toBe(true);
    expect(files(path)).toEqual(before);
    const check = new RawDb(path, { readonly: true });
    expect((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(LEDGER_SCHEMA_VERSION - 1);
    check.close();
  });

  test("对照：不带 dry-run 走 openLedger，同一份台账会被改（探针有效）", () => {
    const path = staleLedger();
    const before = files(path);
    onboardDb(false, path);
    closeLedger(path);
    expect(files(path)).not.toEqual(before);
  });
});

describe("planOnboard", () => {
  const facts = (o: Partial<OnboardFacts> = {}): OnboardFacts => ({
    project: P, dir: "/repos/dn", git: "origin", actor: "owner", scheduler: { segment: null },
    meta: { pms: ["agent-dn-pm"], team: { dispatcher: null, audit: true, sinceSeq: 0 } }, agents: { "agent-dn-pm": { status: "active", role: "pm" } },
    pendingProposal: null, ...o,
  });
  test("班子已开、PM 角色已设：不出提案", () => {
    const p = planOnboard(facts(), { localMerge: false, checks: ["ci"] }, planUp);
    expect(p.draft).toBeNull();
    expect(p.items.find((x) => x.key === "team")?.status).toBe("ok");
    expect(p.segment).toEqual({ maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/repos/dn", supervise: false });
  });
  test("不是 git 仓库：拒", () => {
    expect(planOnboard(facts({ git: "not-git" }), { localMerge: true, checks: ["x"] }, planUp).items.find((x) => x.key === "git")?.status).toBe("blocked");
  });
  test("splitChecks 按逗号分条", () => {
    expect(splitChecks(" cargo test , cargo clippy -- -D warnings ,")).toEqual(["cargo test", "cargo clippy -- -D warnings"]);
  });
});
