/**
 * i28-SECPOOL1：security 卡审查进统一池的开关。off（含缺键）= 和改动前一样只在本机审；on = 和 code 卡一样进池，仍跨模型；
 * observe = 派单同 off，放置说明多一句按统一池的去处。开关文件非法取值按 off + 警告一次，命令收到非法值直接报错。
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliOfferFamily } from "../src/lib/lend-cli-author-family.js";
import type { LedgerEvent, LedgerTask, Stage } from "../src/lib/ledger-stages.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { planIntent, setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { epochPeerRefusal, explainPlacement, reviewPlacement } from "../src/lib/scheduler-placement-plan.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";
import { poolTarget, type PoolFacts } from "../src/lib/scheduler-pool-plan.js";
import { planPoolRefusal, type PlanFacts } from "../src/lib/scheduler-refusal-pool.js";
import { SEC_REVIEW_NO_ROOM, secReviewNoRoom } from "../src/lib/scheduler-sec-review.js";
import { bindSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { securityPoolMode, securityReviewLocalOnly, setSecurityPoolMode, type SecurityPoolMode } from "../src/lib/security-pool.js";
import { SECURITY_POOL_CMDS } from "../src/manager/security-pool-cmds.js";

const HEAD = "a".repeat(40);
const REMOTE: RemotePolicy = { mode: "balance", roles: ["review"], poolTimeoutMin: 15 };
const author: WorkerRef = { agent: "agent-author", sessionId: "s-a", taskId: "T1", family: "codex", source: "local" };
const ev = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown> = {}): LedgerEvent =>
  ({ seq, kind, data, ts: seq, actor: "x", project: "p", target: "T1", text: "x", dedupKey: null });
const v2 = (claude: number) => ({ why: null, slots: { codex: 1, claude }, roles: ["review" as const], repos: ["o/r"] });
const pool = (over: Partial<PoolFacts> = {}, claude = 1): PoolFacts => ({ remote: REMOTE, localReviewers: 0, repo: "o/r", lastPeer: null,
  peers: [{ peer: "mate", open: 0, maxOpen: 2, roles: ["review"], v2: v2(claude) }], ...over });
const agents = (claude: number, codex = 2): RemotePolicy => ({ ...REMOTE, agents: { claude, codex } });
const snap = (template: "code" | "security", over: Partial<PlannerSnapshot> = {}, stage: Stage = "review"): PlannerSnapshot => ({
  task: { id: "T1", project: "p", itemId: null, title: "t", kind: "code", stage, stageBefore: null, round: 1, agent: author.agent, assigneeKind: "agent",
    assignee: author.agent, pm: "pm", branch: "b", pr: "https://github.com/o/r/pull/7", headSHA: HEAD, spec: null, specRev: 1, model: null, rev: 1,
    extra: {}, createdAt: 1, updatedAt: 1 } as LedgerTask,
  workflow: { taskId: "T1", project: "p", template, templateVersion: 2, mode: "auto", authorFamily: "codex", fallback: "x", specRev: 1,
    rev: 1, createdAt: 1, updatedAt: 1 },
  events: [ev(1, "task", { op: "new" }), ev(11, "stage", { from: "build", to: stage, round: 1, specRev: 1 })], intents: [], blockedBy: [], queueFrozen: false,
  fileGlobs: ["src/lib/x.ts"], heldResources: [], workerCount: 0, maxWorkers: 2, freeWorkerSlot: "slot:p:0", author, reviewer: null,
  reviewDispatches: [], uiGate: { state: "none" }, screenshotsDigest: null, pool: pool(), ...over,
});
const sec = (mode: SecurityPoolMode | undefined, over: Partial<PlannerSnapshot> = {}) => snap("security", { ...over, ...(mode ? { securityPool: mode } : {}) });

let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "secpool-")); cleanup.push(() => rmSync(d, { recursive: true, force: true })); return d; };
/** 测试进程的状态目录里写开关（tests/preload.ts 已隔离）；结束时改回 off */
const switchTo = (project: string, mode: SecurityPoolMode): void => { setSecurityPoolMode(project, mode); cleanup.push(() => setSecurityPoolMode(project, "off")); };

describe("判定", () => {
  test("security 卡只在 on 时不限本机；非 security 卡、没有流程一律 false", () => {
    for (const m of [undefined, null, "off", "observe"] as const) expect(securityReviewLocalOnly({ template: "security" }, m)).toBe(true);
    expect(securityReviewLocalOnly({ template: "security" }, "on")).toBe(false);
    for (const m of [undefined, "on", "off"] as const) expect(securityReviewLocalOnly({ template: "code" }, m)).toBe(false);
    expect(securityReviewLocalOnly(null, "off")).toBe(false);
  });
});

describe("开关文件与命令", () => {
  test("缺文件 / 缺键 = off；写入后按项目读回", () => {
    const path = join(tmp(), "security-pool.json");
    expect(securityPoolMode("p", path)).toBe("off");
    expect(setSecurityPoolMode("p", "observe", path)).toEqual({ from: "off", mode: "observe" });
    expect(setSecurityPoolMode("p", "on", path)).toEqual({ from: "observe", mode: "on" });
    expect(securityPoolMode("p", path)).toBe("on");
    expect(securityPoolMode("q", path)).toBe("off");
  });

  test("非法取值按 off，并打一次带项目名的警告", () => {
    const path = join(tmp(), "security-pool.json"), err = spyOn(console, "error").mockImplementation(() => {});
    cleanup.push(() => err.mockRestore());
    writeFileSync(path, JSON.stringify({ projects: { proj9: "yes" } }));
    expect(securityPoolMode("proj9", path)).toBe("off");
    expect(securityPoolMode("proj9", path)).toBe("off");
    const warns = err.mock.calls.map((c) => String(c[0])).filter((t) => t.includes("security-pool"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("proj9");
  });

  test("损坏文件读按 off、写拒绝覆盖；setter 收到非法值直接报错", () => {
    const path = join(tmp(), "security-pool.json"), err = spyOn(console, "error").mockImplementation(() => {});
    cleanup.push(() => err.mockRestore());
    writeFileSync(path, "[]");
    expect(securityPoolMode("p", path)).toBe("off");
    expect(() => setSecurityPoolMode("p", "on", path)).toThrow(/损坏/);
    expect(() => setSecurityPoolMode("p", "maybe", join(tmp(), "x.json"))).toThrow(/on \/ observe \/ off/);
  });

  test("命令：不带参数打印当前值；非法值报错；只有项目 PM / master / owner 能切", async () => {
    const run = SECURITY_POOL_CMDS["security-pool"].run;
    let pm = true;
    const cli = (pos: string[]) => ({ p: { pos, flags: {} }, project: () => "cmdproj",
      requireRealPm: () => { if (!pm) throw new Error("forbidden"); } }) as never;
    switchTo("cmdproj", "off");
    expect(await run(cli(["security-pool"]))).toEqual({ ok: true, project: "cmdproj", mode: "off" });
    await expect(run(cli(["security-pool", "sure"]))).rejects.toThrow(/on \/ observe \/ off/);
    pm = false;
    await expect(run(cli(["security-pool", "on"]))).rejects.toThrow(/forbidden/);
    expect(securityPoolMode("cmdproj")).toBe("off");
    pm = true;
    expect(await run(cli(["security-pool", "on"]))).toEqual({ ok: true, project: "cmdproj", from: "off", mode: "on" });
    expect(securityPoolMode("cmdproj")).toBe("on");
  });
});

describe("放置（验收线 2 / 7 / 8）", () => {
  test("on：池里有对面家族空位的 peer → reviewPlacement 返回该 peer；off / 缺键 → 本机或等待", () => {
    expect(reviewPlacement(sec("on"), 0)).toMatchObject({ peer: "mate" });
    expect(planScheduler(sec("on"))).toMatchObject({ kind: "intent", action: "review", recipient: "peer:mate" });
    for (const m of [undefined, "off"] as const) {
      expect(reviewPlacement(sec(m), 0)).toBeNull();
      expect(planScheduler(sec(m))).toMatchObject({ kind: "intent", action: "ensure_session", sessionRole: "reviewer" });
    }
    // agents 模式同理（统一池）
    const ag = { pool: pool({ remote: agents(1) }) };
    expect(reviewPlacement(sec("on", ag), 0)).toMatchObject({ peer: "mate" });
    expect(reviewPlacement(sec("off", ag), 0)).toBeNull();
  });

  test("on：池里放到 peer 的仍是跨模型（codex 作者 → claude 审）", () => {
    expect(reviewPlacement(sec("on"), 0)).toMatchObject({ reason: expect.stringContaining("claude") });
    expect(poolTarget(sec("on", { pool: pool({ remote: { ...REMOTE, mode: "overflow" }, localReviewers: 2 }) }), 0)).toBeNull(); // 只借 codex（R9 原样）
    const claudeAuthor = sec("on");
    claudeAuthor.workflow = { ...claudeAuthor.workflow!, authorFamily: "claude" };
    expect(poolTarget({ ...claudeAuthor, pool: pool({ remote: { ...REMOTE, mode: "overflow" }, localReviewers: 2 }) }, 0)).toMatchObject({ peer: "mate", family: "codex" });
    expect(poolTarget({ ...claudeAuthor, securityPool: "off", pool: pool({ remote: { ...REMOTE, mode: "overflow" }, localReviewers: 2 }) }, 0)).toBeNull();
  });

  test("SR1：本机对面家族名额 0、池里有空位 → on 不报；池里也没空位 → 照旧报；off / observe 照旧报", () => {
    const room = { pool: pool({ remote: agents(0) }) }, none = { pool: pool({ remote: agents(0) }, 0) };
    expect(reviewPlacement(sec("on", room), 0)).toMatchObject({ peer: "mate" });
    expect(planScheduler(sec("on", room))).toMatchObject({ kind: "intent", recipient: "peer:mate" });
    expect(reviewPlacement(sec("on", none), 0)).toMatchObject({ wait: expect.stringContaining(SEC_REVIEW_NO_ROOM), code: "sec_review_no_room" });
    for (const m of [undefined, "off", "observe"] as const) {
      expect(reviewPlacement(sec(m, room), 0)).toMatchObject({ wait: expect.stringContaining(SEC_REVIEW_NO_ROOM) });
    }
    expect(secReviewNoRoom(sec("on", room), true)).toBeNull();
    expect(secReviewNoRoom(sec("off", room), true)).toMatchObject({ code: "sec_review_no_room" });
  });

  test("observe：派单结果同 off；lend-orders 说明多一句按统一池的去处", () => {
    for (const over of [{}, { pool: pool({ remote: agents(0) }) }]) {
      expect(planScheduler(sec("observe", over))).toEqual(planScheduler(sec("off", over)));
      expect(reviewPlacement(sec("observe", over), 0)).toEqual(reviewPlacement(sec("off", over), 0));
    }
    const off = explainPlacement(sec("off")), obs = explainPlacement(sec("observe"));
    expect(obs.where).toBe(off.where);
    expect(off.reason).not.toContain("按统一池");
    expect(obs.reason).toBe(`${off.reason}；按统一池会放到 mate（claude）`);
    expect(explainPlacement(sec("observe", { pool: pool({}, 0) })).reason).toContain("按统一池");
    expect(explainPlacement(snap("code", { securityPool: "observe" })).reason).not.toContain("按统一池");
  });

  test("池单拒审 epoch 的去处 peer：on 时按现值核，off 时照旧只在本机", () => {
    expect(epochPeerRefusal(sec("off"), 0, "mate", "claude")).toBe("安全卡只在本机审");
    expect(epochPeerRefusal(sec("on"), 0, "mate", "claude")).toBeNull();
  });
});

describe("审查者独立性（验收线 3）", () => {
  const peerReviewer: WorkerRef = { agent: "peer:mate", sessionId: "s-peer", taskId: "T1", family: "claude", source: "peer_claim" };
  const independence = (s: PlannerSnapshot) => {
    const d = planScheduler(s);
    return d.kind === "escalate" && d.code === "reviewer_independence";
  };

  test("on：peer 交回的审查 session（source 不是 local）不再触发；off 照旧触发", () => {
    expect(independence(sec("off", { reviewer: peerReviewer }))).toBe(true);
    expect(independence(sec(undefined, { reviewer: peerReviewer }))).toBe(true);
    expect(independence(sec("on", { reviewer: peerReviewer }))).toBe(false);
  });

  test("on：审查家族 = 作者家族照旧触发", () => {
    expect(independence(sec("on", { reviewer: { ...peerReviewer, family: "codex" } }))).toBe(true);
  });
});

describe("池单拒审换审查人（验收线 6）", () => {
  const facts = (over: Partial<PlanFacts>): PlanFacts => ({ mode: "on", authorFamily: "claude", security: true,
    order: { orderId: "lend:T1:s1:r2:a0", taskId: "T1", step: "review", family: "codex", peer: "HedeMacBook-Pro", state: "started", head: HEAD,
      specRev: 1, round: 2, exempt: false },
    confirmed: { kind: "confirmed", refusal: "cyber_policy", message: "x" },
    placements: [{ machine: "peer-b", family: "claude", free: true }, { machine: "local", family: "claude", free: true }],
    prior: [], informed: new Set(), ...over });
  const to = (f: PlanFacts) => { const d = planPoolRefusal(f); return d.kind === "plan" && d.plan.kind === "replace" ? d.plan.to : undefined; };

  test("on 可以换到别的 peer；off / 缺键照旧只许本机", () => {
    expect(to(facts({ securityPool: "on" }))).toEqual({ machine: "peer-b", family: "claude" });
    expect(to(facts({ securityPool: "off" }))).toEqual({ machine: "local", family: "claude" });
    expect(to(facts({}))).toEqual({ machine: "local", family: "claude" });
    expect(to(facts({ security: false }))).toEqual({ machine: "peer-b", family: "claude" });
  });
});

/** 有台账库的两处（session 绑定、手动 lend offer）读状态目录里的开关 */
function ledgerFixture(project: string) {
  const dir = tmp(), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  cleanup.push(() => closeLedger(path));
  const registryPath = join(dir, "registry.json");
  writeFileSync(registryPath, JSON.stringify({ socket: "", agents: { "agent-one": { runtime: "claude-code" } } }));
  const ctx = { actor: "owner", now: 100 };
  createTask(db, ctx, { project, id: "T1", title: "one", kind: "code", agent: "agent-one" });
  setWorkflow(db, ctx, { taskId: "T1", taskRev: 1, template: "security", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "缩小范围" });
  return { db, ctx, registryPath };
}

describe("有台账库的两处（验收线 4 / 5）", () => {
  test("scheduler-sessions：on 收 security 卡 transport=peer 的审查 session；off 照旧拒", () => {
    const bind = (project: string) => {
      const f = ledgerFixture(project);
      const seq = (f.db.query("SELECT COALESCE(MAX(seq),0) AS seq FROM events").get() as { seq: number }).seq;
      const intent = planIntent(f.db, f.ctx, { taskId: "T1", node: "adversarial_review", action: "ensure_session", id: "peer-reviewer",
        taskRev: getTask(f.db, "T1")!.rev, workflowRev: 1, causalSeq: seq, reason: "ensure" }).intent;
      settleIntent(f.db, f.ctx, { id: intent.id, from: "pending", to: "submitted", receipt: "effect started" });
      f.db.query("UPDATE tasks SET extra=? WHERE id='T1'").run(JSON.stringify({ reviewer: "reviewer@remote" }));
      return () => bindSchedulerSession(f.db, f.ctx, { taskId: "T1", role: "reviewer", intentId: "peer-reviewer",
        agent: "reviewer@remote", sessionId: "peer-session", family: "codex", transport: "peer", registryPath: f.registryPath });
    };
    expect(bind("sess-off")).toThrow(/跨模型审查规则/);
    switchTo("sess-on", "on");
    expect(bind("sess-on")().session).toMatchObject({ transport: "peer", family: "codex" });
  });

  test("lend-cli-author-family：on 允许借出 security 卡的审查，跨模型检查照旧", () => {
    const at = (project: string) => {
      const f = ledgerFixture(project);
      f.db.run("UPDATE tasks SET stage = 'review' WHERE id = 'T1'");
      return { db: f.db, task: getTask(f.db, "T1")! };
    };
    const off = at("lend-off");
    expect(() => cliOfferFamily(off.db, off.task, "codex")).toThrow(/只在本机做/);
    switchTo("lend-on", "on");
    const on = at("lend-on");
    expect(cliOfferFamily(on.db, on.task, "codex")).toBe("codex");
    expect(() => cliOfferFamily(on.db, on.task, "claude")).toThrow(/跨模型/);
  });
});
