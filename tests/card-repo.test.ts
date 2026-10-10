/**
 * i28-SECPOOL2 card-repo.ts：fileGlobs 的 repo: 前缀解析、按 origin 找 clone、卡的仓库（订单 repo 六处）、出单去前缀、交付范围比对、
 * 本机放置选目录。公共仓卡（没有前缀）各处和改动前逐字一致。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardGlobs, cardRepo, privateCardRepo, repoDirFor, repoOfGlobs, stripRepoPrefix, type RepoDirIO } from "../src/lib/card-repo.js";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { ensureDeliverScope } from "../src/lib/order-deliver-scope.js";
import { orderFileScope } from "../src/lib/order-wire-file-scope.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { reserveFinishing } from "../src/lib/scheduler-agent-pool-reserve.js";
import { localAuthorPlan } from "../src/lib/scheduler-local-author-plan.js";
import type { PlacementFacts } from "../src/lib/scheduler-placement.js";
import { poolFacts, prCoordinates } from "../src/lib/scheduler-pool-facts.js";

const PRIV = "floka-ai/cloud", PUB = "shawnlu96/claudestra";
const PRIV_GLOBS = [`repo:${PRIV}/src/app/*.ts`, `repo:${PRIV}/docs/x.md`];
const task = (extra: Record<string, unknown>, pr: string | null = null) => ({ pr, extra });

describe("解析", () => {
  test("repoOfGlobs：同一仓库的前缀 → owner/name；没前缀 → null；混用 / 写法不对 → 报错", () => {
    expect(repoOfGlobs(PRIV_GLOBS)).toBe(PRIV);
    expect(repoOfGlobs(["src/a.ts", "tests/*.test.ts"])).toBeNull();
    expect(repoOfGlobs([])).toBeNull();
    expect(repoOfGlobs([`repo:${PRIV}/a.ts`, "repo:Floka-AI/Cloud/b.ts"])).toBe(PRIV);
    expect(() => repoOfGlobs([`repo:${PRIV}/a.ts`, "repo:o/r/b.ts"])).toThrow(/混了 2 个仓库/);
    expect(() => repoOfGlobs([`repo:${PRIV}/a.ts`, "src/b.ts"])).toThrow(/混在一起/);
    expect(() => repoOfGlobs(["repo:floka-ai"])).toThrow(/repo:<owner>\/<name>\/<仓库内路径>/);
  });

  test("stripRepoPrefix：去掉本仓库前缀（不分大小写），别的原样", () => {
    expect(stripRepoPrefix(PRIV_GLOBS, PRIV)).toEqual(["src/app/*.ts", "docs/x.md"]);
    expect(stripRepoPrefix(["repo:Floka-AI/cloud/a.ts", "repo:o/r/b.ts", "c.ts"], PRIV)).toEqual(["a.ts", "repo:o/r/b.ts", "c.ts"]);
  });

  test("repoDirFor：按 dirs 顺序找 origin 对得上、是 git 目录的那个；找不到 null", () => {
    const origins: Record<string, string | null> = { "/pub": PUB, "/plain": null, "/priv": "Floka-AI/Cloud", "/priv2": PRIV, "/nogit": PRIV };
    const io: RepoDirIO = { dirs: () => ["/pub", "/plain", "/nogit", "/priv", "/priv2"], origin: (d) => origins[d] ?? null, exists: (p) => !p.startsWith("/nogit") };
    expect(repoDirFor("p", PRIV, io)).toBe("/priv");
    expect(repoDirFor("p", PUB, io)).toBe("/pub");
    expect(repoDirFor("p", "o/missing", io)).toBeNull();
  });
});

describe("卡的仓库（验收线 4）", () => {
  const remote = { repo: PUB };
  test("私仓卡没有 PR：extra.repo，其次前缀；有 PR 按 PR", () => {
    expect(cardRepo(task({ fileGlobs: PRIV_GLOBS, repo: PRIV }), remote)).toBe(PRIV);
    expect(cardRepo(task({ fileGlobs: PRIV_GLOBS }), remote)).toBe(PRIV);
    expect(cardRepo(task({ fileGlobs: PRIV_GLOBS, repo: PRIV }, "https://github.com/other/x/pull/3"), remote)).toBe("other/x");
  });

  test("公共仓卡：PR ?? remote.repo，和改动前一样不看 extra.repo", () => {
    expect(cardRepo(task({ fileGlobs: ["src/a.ts"], repo: "ShawnLu96/Claudestra" }), remote)).toBe(PUB);
    expect(cardRepo(task({ fileGlobs: ["src/a.ts"] }, "https://github.com/o/r/pull/1"), remote)).toBe("o/r");
    expect(cardRepo(task({}), {})).toBeNull();
    expect(cardRepo(null, remote)).toBe(PUB);
    expect(prCoordinates("https://github.com/o/r/pull/12")).toEqual({ repo: "o/r", pr: 12 });
  });
});

describe("出单与交付范围（验收线 5）", () => {
  const lt = (extra: Record<string, unknown>) => ({ extra }) as unknown as LedgerTask;
  test("私仓卡出单的 fileGlobs 不带前缀；公共仓卡逐字不变", () => {
    const priv = orderFileScope(lt({ fileGlobs: PRIV_GLOBS, repo: PRIV }));
    expect(JSON.parse(priv.sources[0][1])).toEqual(["src/app/*.ts", "docs/x.md"]);
    expect(priv.sources[0][1]).not.toContain("repo:");
    const globs = ["tests/Z*.test.ts", "src/lib/**"];
    expect(orderFileScope(lt({ fileGlobs: globs })).sources[0][1]).toBe(JSON.stringify(globs, null, 2));
    expect(cardGlobs(lt({ fileGlobs: globs }))).toEqual(globs);
  });

  let dir: string, path: string, db: Database;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "card-repo-")); path = join(dir, "ledger.db"); db = openLedger(path);
    setMeta(db, { actor: "owner" }, { project: "p", key: "pms", value: ["agent-pm"] });
  });
  afterEach(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });

  test("私仓卡交付：范围内的不记规格外，范围外的照记；共改只算同一个仓库的卡", async () => {
    createTask(db, { actor: "owner" }, { id: "T1", project: "p", title: "私仓", kind: "code", extra: { fileGlobs: PRIV_GLOBS, repo: PRIV } });
    createTask(db, { actor: "owner" }, { id: "T2", project: "p", title: "公共仓", kind: "code", extra: { fileGlobs: ["src/**"] } });
    createTask(db, { actor: "owner" }, { id: "T3", project: "p", title: "同私仓", kind: "code", extra: { fileGlobs: [`repo:${PRIV}/lib/*.ts`] } });
    db.run("UPDATE tasks SET stage = 'build' WHERE id IN ('T2', 'T3')");
    const files = [{ path: "src/app/a.ts", added: 1, deleted: 0 }, { path: "docs/x.md", added: 2, deleted: 0 },
      { path: "src/other.ts", added: 3, deleted: 1 }, { path: "lib/z.ts", added: 1, deleted: 1 }];
    await ensureDeliverScope(db, getTask(db, "T1")!, "a".repeat(40), async () => ({ base: "b".repeat(40), files }));
    const ev = listEvents(db, { target: "T1" }).find((e) => e.data.op === "deliver_scope")!;
    expect(ev.data.files).toEqual([{ path: "src/other.ts", added: 3, deleted: 1, sharedWith: [] }, { path: "lib/z.ts", added: 1, deleted: 1, sharedWith: ["T3"] }]);
  });

  test("公共仓卡交付范围比对不变", async () => {
    createTask(db, { actor: "owner" }, { id: "T1", project: "p", title: "公共", kind: "code", extra: { fileGlobs: ["src/inside.ts"] } });
    createTask(db, { actor: "owner" }, { id: "T2", project: "p", title: "公共共改", kind: "code", extra: { fileGlobs: ["src/*.ts"] } });
    db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T2'");
    const files = [{ path: "src/inside.ts", added: 1, deleted: 0 }, { path: "src/shared.ts", added: 1, deleted: 0 }];
    await ensureDeliverScope(db, getTask(db, "T1")!, "a".repeat(40), async () => ({ base: "b".repeat(40), files }));
    const ev = listEvents(db, { target: "T1" }).find((e) => e.data.op === "deliver_scope")!;
    expect(ev.data.files).toEqual([{ path: "src/shared.ts", added: 1, deleted: 0, sharedWith: ["T2"] }]);
  });

  test("订单 repo：poolFacts 写单取私仓、审查取 PR；reserveFinishing 按卡取", () => {
    const remote: RemotePolicy = { mode: "balance", roles: ["write", "review"], repo: PUB, poolTimeoutMin: 15 };
    createTask(db, { actor: "owner" }, { id: "T1", project: "p", title: "私仓", kind: "code", extra: { fileGlobs: PRIV_GLOBS, repo: PRIV } });
    createTask(db, { actor: "owner" }, { id: "T2", project: "p", title: "公共", kind: "code", extra: { fileGlobs: ["src/a.ts"] } });
    for (const id of ["T1", "T2"]) {
      const t = getTask(db, id)!;
      setWorkflow(db, { actor: "owner" }, { taskId: id, taskRev: t.rev, template: "code", templateVersion: 3, mode: "auto", authorFamily: "claude", fallback: "PM" });
    }
    db.run("UPDATE tasks SET stage = 'build' WHERE id IN ('T1', 'T2')");
    const cfg = { remote, borrow: [], now: 1 };
    expect(poolFacts(db, getTask(db, "T1")!, cfg).repo).toBe(PRIV);
    expect(poolFacts(db, getTask(db, "T2")!, cfg).repo).toBe(PUB);
    db.run("UPDATE tasks SET stage = 'review' WHERE id = 'T1'");
    expect(poolFacts(db, getTask(db, "T1")!, cfg).repo).toBeNull();
    db.run("UPDATE tasks SET pr = 'https://github.com/floka-ai/cloud/pull/4' WHERE id = 'T1'");
    expect(poolFacts(db, getTask(db, "T1")!, cfg).repo).toBe(PRIV);

    db.run("UPDATE tasks SET stage = 'fix', pr = NULL WHERE id = 'T1'");
    db.run("UPDATE tasks SET stage = 'fix' WHERE id = 'T2'");
    // peer 只授权了私仓：私仓修复单按卡的仓库能占到它的 claude 座位，公共仓的那张占不到
    const facts = { remote, repo: PUB, pin: null, tried: [], lastPeer: null, writeLeasePeer: null, locksFree: true,
      local: { running: 0, room: true, pool: { totals: { claude: 0, codex: 0 }, running: { claude: 0, codex: 0 } } },
      peers: [{ peer: "mate", open: 0, maxOpen: 2, roles: ["write", "review"],
        v2: { why: null, slots: { claude: 1, codex: 1 }, roles: ["write", "review"], repos: [PRIV] } }] } as unknown as PlacementFacts;
    expect(reserveFinishing(db, "p", facts).peers[0].v2!.slots.claude).toBe(0);
    db.run("UPDATE tasks SET extra = ? WHERE id = 'T1'", [JSON.stringify({ fileGlobs: ["src/b.ts"] })]);
    expect(reserveFinishing(db, "p", facts).peers[0].v2!.slots.claude).toBe(1);
  });
});

describe("本机放置（验收线 6）", () => {
  let dir: string, path: string, db: Database;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "card-repo-local-")); path = join(dir, "ledger.db"); db = openLedger(path); });
  afterEach(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });

  function setup(dirs: string[], fileGlobs: string[]) {
    const pub = join(dir, "pub"), configPath = join(dir, "scheduler.json"), projectsPath = join(dir, "projects.json"), spec = join(dir, "T1.md");
    for (const [d, origin] of [[pub, `https://github.com/${PUB}.git`], [join(dir, "priv"), `git@github.com:${PRIV}.git`]]) {
      mkdirSync(d, { recursive: true });
      Bun.spawnSync(["git", "init", "-q", d]);
      Bun.spawnSync(["git", "-C", d, "remote", "add", "origin", origin]);
    }
    writeFileSync(spec, "# spec\n");
    writeFileSync(configPath, JSON.stringify({ enabled: true, autoDispatch: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: pub,
      remote: { mode: "balance", roles: ["write"], repo: PUB, poolTimeoutMin: 15 } } } }));
    writeFileSync(projectsPath, JSON.stringify({ projects: [{ id: "p", dirs }] }));
    setMeta(db, { actor: "owner" }, { project: "p", key: "pms", value: ["pm"] });
    createTask(db, { actor: "owner" }, { id: "T1", project: "p", title: "t", kind: "code", branch: "feat/t1", spec, extra: { fileGlobs } });
    const t = getTask(db, "T1")!;
    setWorkflow(db, { actor: "owner" }, { taskId: "T1", taskRev: t.rev, template: "code", templateVersion: 3, mode: "auto", authorFamily: "claude", fallback: "PM" });
    return { configPath, projectsPath, pub, priv: join(dir, "priv") };
  }

  test("私仓卡选私仓目录；公共仓卡照旧选 policy.repoDir；没有 clone 给原因", async () => {
    const o = setup([join(dir, "pub"), join(dir, "priv")], PRIV_GLOBS);
    const plan = await localAuthorPlan(db, getTask(db, "T1")!, join(dir, "wt"), o);
    expect(typeof plan === "string" ? plan : plan.repo).toBe(o.priv);
    expect(privateCardRepo(getTask(db, "T1"))).toBe(PRIV);
    writeFileSync(o.projectsPath, JSON.stringify({ projects: [{ id: "p", dirs: [o.pub] }] }));
    expect(await localAuthorPlan(db, getTask(db, "T1")!, join(dir, "wt"), o)).toBe(`项目 dirs 里没有 ${PRIV} 的 clone`);
    db.run("UPDATE tasks SET extra = ? WHERE id = 'T1'", [JSON.stringify({ fileGlobs: ["src/a.ts"] })]);
    writeFileSync(o.projectsPath, JSON.stringify({ projects: [{ id: "p", dirs: [o.priv, o.pub] }] }));
    const pubPlan = await localAuthorPlan(db, getTask(db, "T1")!, join(dir, "wt"), o);
    expect(typeof pubPlan === "string" ? pubPlan : pubPlan.repo).toBe(o.pub);
  });
});
