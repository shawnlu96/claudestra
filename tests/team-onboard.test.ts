/**
 * ONB-3 `team onboard`（src/manager/team-onboard.ts）：dry-run 零写入、新增项目段带审计事件、无 origin 不带 --local-merge 拒、
 * 重跑无副作用、只出 team up 提案不写 pms、非 PM / owner 拒、已有段只列差异不覆盖。临时台账 / scheduler.json / 提案文件。
 */
import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMeta, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { readSchedulerConfig } from "../src/lib/scheduler-config.js";
import { readProposals, type TeamProposal } from "../src/lib/team-proposal.js";
import { planOnboard, runOnboard, splitChecks, type OnboardFacts, type OnboardInput } from "../src/manager/team-onboard.js";
import { planUp, propose } from "../src/manager/team-up.js";

const team = { planUp, propose };
import { tempLedgerPath } from "./ledger-test-helpers.js";

const P = "dn";
const NOW = 9_000_000;
const SCHED = { enabled: true, autoDispatch: true, futureTop: 1, projects: { claudestra: { maxActiveWorkers: 4, requiredChecks: ["ci"], repoDir: "/r/c" } } };
let db: Database;
let dir: string;
let schedulerPath: string;
let proposalsPath: string;
let posted: TeamProposal[];

const agents = { "agent-dn-pm": { status: "active", projectId: P }, "agent-exec": { status: "active", projectId: P } };
const input = (o: Partial<OnboardInput> = {}): OnboardInput => ({
  project: P, dir: "/repos/dn", git: "no-origin", actor: "agent-dn-pm", agents, dryRun: false,
  flags: { localMerge: true, checks: ["cargo test"] }, ...o,
});
const run = (o: Partial<OnboardInput> = {}) =>
  runOnboard(input(o), { db, now: NOW, schedulerPath, team, proposals: { path: proposalsPath, post: async (p) => (posted.push(p), null) } }) as Promise<Record<string, any>>;
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

  test("新增段缺 --checks、scheduler.json 不存在：拒", async () => {
    expect(await run({ flags: { localMerge: true } })).toMatchObject({ ok: false, code: "blocked" });
    const missing = join(dir, "none.json");
    const r = await runOnboard(input(), { db, now: NOW, schedulerPath: missing, team, proposals: { path: proposalsPath, post: async () => null } });
    expect(r).toMatchObject({ ok: false, code: "blocked" });
    expect(existsSync(missing)).toBe(false);
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
