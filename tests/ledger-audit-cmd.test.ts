/** 台账巡检的取数（lib/ledger-audit-snapshot.ts）、CLI（ledger audit）与 bridge 定时器（bridge/ledger-audit-service.ts） */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerAuditTicker, type LedgerAuditDeps } from "../src/bridge/ledger-audit-service.js";
import type { Envelope } from "../src/bridge/router.js";
import { projectsSlug } from "../src/lib/jsonl-cost.js";
import { parseReviewDescription, runningReviewers } from "../src/lib/ledger-audit-reviewers.js";
import { auditLedger } from "../src/lib/ledger-audit.js";
import { collectAuditSnapshots, type SnapshotSources } from "../src/lib/ledger-audit-snapshot.js";
import { addDep, setDep } from "../src/lib/ledger-deps-write.js";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { AUDIT_SCHEMA_VERSION, closeLedger, LEDGER_MIGRATIONS, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createTask, moveStage, recordReview, recordVerify, setFrozen, setMeta } from "../src/lib/ledger-write.js";
import type { Stage } from "../src/lib/ledger-stages.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import type { Registry } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";
import { isWriteInvocation } from "../src/manager/write-commands.js";
import { baselineAudit, tempLedgerPath } from "./ledger-test-helpers.js";

const MIN = 60_000;
const NOW = 1_000 * MIN;
const PM = "agent-claudestra";
const EXE = "agent-task-t1";
const P = "claude-orchestrator";

let dir: string;
let db: Database;
let path: string;

function sources(over: Partial<SnapshotSources> = {}): SnapshotSources {
  const reg: RegistryAgent[] = [
    { name: PM, channelId: "c-pm", projectId: P, cwd: dir, sessionId: "s-pm" },
    { name: EXE, channelId: "c-exe", projectId: P, cwd: dir, sessionId: "s-exe" },
  ];
  return {
    registry: async () => reg,
    windows: async () => ["master", PM, EXE],
    turn: async () => "idle",
    fileTimes: async () => ({ lastWriteAt: NOW - 60 * MIN, startedAt: 0 }),
    reviewers: () => [],
    heldPath: join(dir, "held-messages.json"),
    ...over,
  };
}

/** T1 在 review（进阶段 30 分钟前），PM 名单 = [PM]，docsDir = <dir>/ledger/docs */
function seed(): void {
  const owner = { actor: "owner", now: 0 };
  createTask(db, owner, { project: P, id: "T1", title: "巡检", kind: "code", agent: EXE, pm: PM, stage: "build" });
  moveStage(db, { actor: "owner", now: NOW - 30 * MIN }, { taskId: "T1", from: "build", to: "review" });
  setMeta(db, owner, { project: P, key: "pms", value: [PM] });
  mkdirSync(join(dir, "ledger", "docs"), { recursive: true });
  setMeta(db, owner, { project: P, key: "docsDir", value: join(dir, "ledger", "docs") });
  baselineAudit(db, P); // 首轮静默另有专门的测试（ledger-audit-store.test.ts）
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-audit-cmd-"));
  path = tempLedgerPath("ledger-audit-cmd-db-");
  db = openLedger(path);
  seed();
});
afterEach(() => closeLedger(path));

describe("取数", () => {
  test("押后队列：按频道认出收件 PM；bridge 自己的通知不算；领走的带 leaseAt", async () => {
    writeFileSync(join(dir, "held-messages.json"), JSON.stringify({
      "c-pm": [
        { env: { from: { kind: "local", agentName: "agent-task-t9" }, meta: { messageId: "m1" } }, heldAt: 5, lease: { batchId: "b", at: 7 } },
        { env: { from: { kind: "bridge", label: "ledger-audit" }, meta: { messageId: "m2" } }, heldAt: 6 },
      ],
      "c-unknown": [{ env: { from: { kind: "local", agentName: "x" }, meta: { messageId: "m3" } }, heldAt: 1 }],
    }));
    const [s] = await collectAuditSnapshots(db, [P], NOW, sources());
    expect(s.held).toEqual([{ to: PM, from: "agent-task-t9", messageId: "m1", heldAt: 5, leaseAt: 7 }]);
  });

  test("开了编排班子：常规 pass 停 31 分钟、规格卡要求对抗式 → 只对调度助理报「派对抗式」；dispatcher 按 meta.team 认", async () => {
    const owner = { actor: "owner", now: 0 };
    const disp = "agent-helper"; // 名字里没有 dispatch：按名字猜会猜错
    setMeta(db, owner, { project: P, key: "pms", value: ["agent-pm-dispatch", disp] });
    setMeta(db, owner, { project: P, key: "team", value: { dispatcher: disp, audit: true } });
    mkdirSync(join(dir, "ledger", "docs", "tasks"), { recursive: true });
    writeFileSync(join(dir, "ledger", "docs", "tasks", "T1.md"), "# T1\n- 审查：Claude 审查员一轮；最后一轮对抗式\n");
    // T1 在 NOW - 30 分钟进 review；派审、pass 在那之后，巡检在 pass 之后 31 分钟跑
    appendEvent(db, { actor: disp, now: NOW - 29 * MIN }, { project: P, target: "T1", kind: "dispatch", data: { reviewer: "regular", round: 1, head: null } });
    recordReview(db, { actor: disp, now: NOW - 28 * MIN }, { taskId: "T1", reviewer: "r", verdict: "pass", p0: 0, p1: 0, p2: 0 });
    const at = NOW + 3 * MIN;
    const [s] = await collectAuditSnapshots(db, [P], at, sources());
    expect(s.team).toEqual({ dispatcher: disp });
    expect(s.tasks.find((t) => t.task.id === "T1")?.specPolicy).toBe("Claude 审查员一轮；最后一轮对抗式");
    const f = auditLedger(s, at).findings;
    expect(f.map((x) => [x.rule, x.notify, x.suggestion])).toEqual([["review_no_reviewer", disp, "还欠对抗式，派对抗式"]]);
  });

  test("依赖：前置任务还没上线 → 后续任务带 blockedBy；前置上线后清空", async () => {
    const owner = { actor: "owner", now: 0 };
    createTask(db, owner, { project: P, id: "T0", title: "前置", kind: "code", agent: EXE, pm: PM, stage: "review" });
    addDep(db, owner, { from: "T0", to: "T1", kind: "blocks", when: "T0 上线后" });
    const blocked = (await collectAuditSnapshots(db, [P], NOW, sources()))[0].tasks.find((t) => t.task.id === "T1");
    expect(blocked?.blockedBy).toEqual(["T0"]);
    expect(blocked?.unblockedAt).toBeNull();
    moveStage(db, owner, { taskId: "T0", from: "review", to: "merge" });
    moveStage(db, { actor: "owner", now: 5_000 }, { taskId: "T0", from: "merge", to: "live" });
    const freed = (await collectAuditSnapshots(db, [P], NOW, sources()))[0].tasks.find((t) => t.task.id === "T1");
    expect(freed?.blockedBy).toEqual([]);
    expect(freed?.unblockedAt).toBe(5_000); // 前置进 live 的那一刻
  });

  test("依赖放行时刻取这一段连续满足的起点：进出 blocked、live → verified 不重新计时，退回 fix 再上线才重算", async () => {
    createTask(db, { actor: "owner", now: 0 }, { project: P, id: "T0", title: "前置", kind: "code", agent: EXE, pm: PM, stage: "merge" });
    addDep(db, { actor: "owner", now: 0 }, { from: "T0", to: "T1", kind: "blocks", when: "T0 上线后" });
    const at = async () => (await collectAuditSnapshots(db, [P], NOW, sources()))[0].tasks.find((t) => t.task.id === "T1")?.unblockedAt;
    const move = (now: number, from: Stage, to: Stage) => moveStage(db, { actor: "owner", now }, { taskId: "T0", from, to });
    move(5_000, "merge", "live");
    move(6_000, "live", "blocked");
    move(7_000, "blocked", "live");
    expect(await at()).toBe(5_000);
    move(8_000, "live", "fix");
    expect(await at()).toBeNull();
    move(9_000, "fix", "review");
    move(10_000, "review", "merge");
    move(11_000, "merge", "live");
    recordVerify(db, { actor: "owner", now: 12_000 }, { taskId: "T0", result: "pass", data: { checks: [{ id: "pr-merged", status: "pass" }] } });
    expect(await at()).toBe(11_000);
  });

  test("依赖放行时刻：PM 手动定 done 的边取边的更新时间", async () => {
    const owner = { actor: "owner", now: 0 };
    createTask(db, owner, { project: P, id: "T0", title: "前置", kind: "code", agent: EXE, pm: PM, stage: "build" });
    const dep = addDep(db, owner, { from: "T0", to: "T1", kind: "blocks", when: "T0 上线后" }).row;
    setDep(db, { actor: "owner", now: 7_000 }, { from: "T0", to: "T1", rev: dep?.rev ?? 1, patch: { state: "done" } });
    const t1 = (await collectAuditSnapshots(db, [P], NOW, sources()))[0].tasks.find((t) => t.task.id === "T1");
    expect(t1?.blockedBy).toEqual([]);
    expect(t1?.unblockedAt).toBe(7_000);
  });

  test("解冻时刻取最后一条 unfreeze 事件；从没冻结过 = null", async () => {
    expect((await collectAuditSnapshots(db, [P], NOW, sources()))[0].unfrozenAt).toBeNull();
    setFrozen(db, { actor: "owner", now: 1_000 }, { project: P, frozen: true });
    setFrozen(db, { actor: "owner", now: 2_000 }, { project: P, frozen: false });
    const [s] = await collectAuditSnapshots(db, [P], NOW, sources());
    expect([s.queueFrozen, s.unfrozenAt]).toEqual([false, 2_000]);
  });

  test("押后文件不存在 = 空；坏了 = null（规则不跑）", async () => {
    expect((await collectAuditSnapshots(db, [P], NOW, sources()))[0].held).toEqual([]);
    writeFileSync(join(dir, "held-messages.json"), "{坏");
    expect((await collectAuditSnapshots(db, [P], NOW, sources()))[0].held).toBeNull();
  });

  test("ownerInbox：ledger.json 不存在 → null，并写明原因", async () => {
    const [s] = await collectAuditSnapshots(db, [P], NOW, sources());
    expect(s.ownerInbox).toBeNull();
    expect(s.unavailable?.ownerInbox).toContain("ledger.json 不存在");
  });

  test("ownerInbox 从 docsDir 旁边的 ledger.json 读，带时区的时间照解析", async () => {
    writeFileSync(join(dir, "ledger", "ledger.json"), JSON.stringify({ ownerInbox: [{ ts: "2026-09-28T17:00:32+0900", text: "t", status: "doing", to: "T8" }] }));
    const [s] = await collectAuditSnapshots(db, [P], NOW, sources());
    expect(s.ownerInbox).toEqual([{ ts: Date.parse("2026-09-28T08:00:32Z"), text: "t", status: "doing", to: "T8" }]);
  });

  test("registry 读不到 → agents / reviewers / held 都是 null", async () => {
    const [s] = await collectAuditSnapshots(db, [P], NOW, sources({ registry: async () => { throw new Error("坏了"); } }));
    expect([s.agents, s.reviewers, s.held]).toEqual([null, null, null]);
    expect(s.unavailable?.agents).toBe("registry 读不了：坏了");
  });

  test("tmux 没列出窗口 → windowAlive 为 null；只给 build/fix 执行者和 PM 抓屏", async () => {
    const asked: string[] = [];
    const [s] = await collectAuditSnapshots(db, [P], NOW, sources({ windows: async () => null, turn: async (a) => (asked.push(a.name), "busy") }));
    expect(s.agents?.every((a) => a.windowAlive === null)).toBe(true);
    expect(s.unavailable?.windows).toBe("tmux 没列出窗口");
    expect(asked).toEqual([PM]); // T1 在 review，执行者不用抓屏
  });

  test("审查员扫描：本项目所有 agent 加 PM 名单；PM 读失败 → reviewers 为 null 并写明原因", async () => {
    const scanned: string[] = [];
    await collectAuditSnapshots(db, [P], NOW, sources({ reviewers: (a) => (scanned.push(a.name), []) }));
    expect(scanned.sort()).toEqual([PM, EXE].sort());
    const [s] = await collectAuditSnapshots(db, [P], NOW, sources({ reviewers: (a) => (a.name === PM ? { error: "读不了" } : []) }));
    expect(s.reviewers).toBeNull();
    expect(s.unavailable?.reviewers).toBe("读不了");
  });

  test("review 步骤：本轮显式派的带进快照，派给 peer 不再报 review_no_reviewer；上一轮派的、已记结论的不算；本机审查员会抓屏", async () => {
    const owner = { actor: "owner", now: NOW - 29 * MIN };
    const step = async () => (await collectAuditSnapshots(db, [P], NOW, sources()))[0];
    assignStep(db, owner, { taskId: "T1", step: "review", round: 0, executor: "w@mate", executorKind: "peer" });
    expect((await step()).tasks.find((t) => t.task.id === "T1")?.reviewStep).toBeNull(); // T1 在第 1 轮，第 0 轮派的不算
    assignStep(db, owner, { taskId: "T1", step: "review", executor: "pm-codex@Shawn", executorKind: "peer" });
    const s = await step();
    expect(s.tasks.find((t) => t.task.id === "T1")?.reviewStep).toEqual({ executor: "pm-codex@Shawn", executorKind: "peer", at: NOW - 29 * MIN });
    expect(auditLedger(s, NOW).findings.map((f) => f.rule)).toEqual([]);
    assignStep(db, owner, { taskId: "T1", step: "review", executor: "agent-review-pi", executorKind: "agent" });
    const asked: string[] = [];
    await collectAuditSnapshots(db, [P], NOW, sources({ turn: async (a) => (asked.push(a.name), "idle"),
      registry: async () => [{ name: PM, projectId: P }, { name: "agent-review-pi", projectId: P }] }));
    expect(asked.sort()).toEqual(["agent-review-pi", PM].sort());
    db.query("UPDATE task_steps SET state = 'done' WHERE taskId = 'T1' AND step = 'review'").run();
    expect((await step()).tasks.find((t) => t.task.id === "T1")?.reviewStep).toBeNull();
  });

  test("合并队列冻结状态带进快照", async () => {
    expect((await collectAuditSnapshots(db, [P], NOW, sources()))[0].queueFrozen).toBe(false);
  });

  describe("审查员 description 的写法", () => {
    test("约定写法、中文、round N、Recheck、复验、一次审两个；任务号一律小写", () => {
      expect(parseReviewDescription("Review T29 r1")).toEqual([{ taskId: "t29", round: 1 }]);
      expect(parseReviewDescription("Adversarial review T13a r3")).toEqual([{ taskId: "t13a", round: 3 }]);
      expect(parseReviewDescription("审查 T29 r1")).toEqual([{ taskId: "t29", round: 1 }]);
      expect(parseReviewDescription("Review T12b round 3")).toEqual([{ taskId: "t12b", round: 3 }]);
      expect(parseReviewDescription("T8G 复验 第2轮").map((r) => r.taskId)).toContain("t8g");
      expect(parseReviewDescription("Recheck T8b P1 fixes").map((r) => r.taskId)).toEqual(["t8b", "p1"]); // p1 对不上台账 id，规则里自然忽略
      expect(parseReviewDescription("Review T8h+T11a r1")).toEqual([{ taskId: "t8h", round: 1 }, { taskId: "t11a", round: 1 }]);
    });
    test("带连字符的任务号、reviewer / Reviews / Reviewing、不像任务号的 id；尾巴上的 -rN 是轮次", () => {
      expect(parseReviewDescription("Review T2b-2 r1")).toEqual([{ taskId: "t2b-2", round: 1 }]);
      expect(parseReviewDescription("Review HF-182 r1")).toEqual([{ taskId: "hf-182", round: 1 }]);
      expect(parseReviewDescription("审查 T29-r1")).toEqual([{ taskId: "t29", round: 1 }]);
      expect(parseReviewDescription("reviewer T12C").map((r) => r.taskId)).toEqual(["t12c"]);
      expect(parseReviewDescription("Reviews T5 round 3")).toEqual([{ taskId: "t5", round: 3 }]); // 纯数字 3 不当任务号
      expect(parseReviewDescription("Reviewing T40").map((r) => r.taskId)).toEqual(["t40"]);
      expect(parseReviewDescription("Review release-v2.32.0").map((r) => r.taskId)).toEqual(["release-v2.32.0"]);
    });
    test("不像审查的不算：Explore、previews 里的 review", () => {
      expect(parseReviewDescription("Explore the repo for T29")).toEqual([]);
      expect(parseReviewDescription("Build previews for T29")).toEqual([]);
    });
  });

  describe("审查员（会话的 subagents）", () => {
    const home = process.env.HOME;
    const sid = "sess-1";
    let sub: string;
    beforeEach(() => {
      process.env.HOME = dir;
      const proj = join(dir, ".claude", "projects", projectsSlug(dir));
      sub = join(proj, sid, "subagents");
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(proj, `${sid}.jsonl`), "");
    });
    afterEach(() => {
      process.env.HOME = home;
    });
    function subagent(id: string, description: string, msg: Record<string, unknown>, mtime = Date.now()) {
      const f = join(sub, `agent-${id}.jsonl`);
      writeFileSync(f, `${JSON.stringify({ type: "assistant", message: { id: `m-${id}`, ...msg } })}\n`);
      writeFileSync(join(sub, `agent-${id}.meta.json`), JSON.stringify({ description, agentType: "general-purpose" }));
      utimesSync(f, mtime / 1000, mtime / 1000);
    }
    const running = { content: [{ type: "tool_use", name: "Bash" }], stop_reason: null };
    test("按 07c 的 description 约定认任务 id；已答完 / 30 分钟没动静 / 不是审查的都不算", () => {
      subagent("a", "Review T29 r1", running);
      subagent("b", "Adversarial review T13a r3", running);
      subagent("c", "Review T30 r1", { content: [{ type: "text", text: "结论" }], stop_reason: "end_turn" });
      subagent("d", "Review T31 r2", running, Date.now() - 31 * MIN);
      subagent("e", "Explore the repo", running);
      const got = runningReviewers({ name: PM, cwd: dir, sessionId: sid }, Date.now()) as { taskId: string }[];
      expect(got.map((x) => x.taskId).sort()).toEqual(["t13a", "t29"]);
    });
    test("没派过 subagent（目录不存在）→ 空；缺会话信息 → error", () => {
      expect(runningReviewers({ name: PM, cwd: dir, sessionId: "other" }, Date.now())).toEqual([]);
      expect(runningReviewers({ name: PM }, Date.now())).toEqual({ error: expect.stringContaining("缺 cwd / sessionId") });
    });
    test("近期的 subagent 缺 .meta.json 或损坏 → error（判不出是不是审查员，不能当没有）", () => {
      subagent("a", "Review T29 r1", running);
      writeFileSync(join(sub, "agent-a.meta.json"), "{坏");
      expect(runningReviewers({ name: PM, cwd: dir, sessionId: sid }, Date.now())).toEqual({ error: expect.stringContaining("读不了") });
      writeFileSync(join(sub, "agent-b.jsonl"), "");
      expect(runningReviewers({ name: PM, cwd: dir, sessionId: sid }, Date.now())).toEqual({ error: expect.any(String) });
    });
    test("早就结束的旧 subagent 缺 meta 不影响（不读它的 meta）", () => {
      const f = join(sub, "agent-old.jsonl");
      writeFileSync(f, "");
      const old = (Date.now() - 60 * MIN) / 1000;
      utimesSync(f, old, old);
      expect(runningReviewers({ name: PM, cwd: dir, sessionId: sid }, Date.now())).toEqual([]);
    });
  });
});

async function cli(actor: string, ...args: string[]) {
  return runLedger(["audit", ...args], {
    db, actor, actorProject: P, projectIds: [P], now: () => NOW, auditSources: sources(),
    loadRegistry: async () => ({ agents: {} }) as unknown as Registry, saveRegistry: async () => {},
  }) as Promise<Record<string, any>>;
}

describe("ledger audit", () => {
  test("第一次跑：落库并给出 pending；再跑一次仍开着但不再算新开", async () => {
    const a = await cli("owner", "--json");
    expect(a.ok).toBe(true);
    expect(a.projects[0]).toMatchObject({ project: P, opened: 1, resolved: 0, silenced: 0 });
    expect(a.pending.map((f: any) => [f.rule, f.taskId, f.notify])).toEqual([["review_no_reviewer", "T1", PM]]);
    const b = await cli("owner", "--json");
    expect(b.projects[0]).toMatchObject({ opened: 0, resolved: 0 });
    expect(b.projects[0].skipped).toEqual([{ rule: "owner_inbox_stale", reason: expect.stringContaining("ledger.json 不存在") }]);
  });

  test("--ack 之后 pending 清空；执行者不能 ack", async () => {
    const a = await cli("owner", "--json");
    const key = a.pending[0].key as string;
    expect((await cli(EXE, "--ack", key)).ok).toBe(false);
    expect(await cli(PM, "--ack", key)).toEqual({ ok: true, acked: 1 });
    expect((await cli("owner", "--json")).pending).toEqual([]);
  });

  test("--dry-run 只算不写；不带 --json 只给摘要", async () => {
    const d = await cli("owner", "--dry-run");
    expect(d.projects[0].open).toEqual([{ project: P, rule: "review_no_reviewer", taskId: "T1", detail: expect.stringContaining("T1"), suggestion: "派审查员" }]);
    expect(db.query("SELECT COUNT(*) AS n FROM audit_findings").get()).toEqual({ n: 0 });
    expect(isWriteInvocation("ledger", ["audit", "--dry-run"])).toBe(false);
    expect(isWriteInvocation("ledger", ["audit"])).toBe(true);
  });

  test("没有 PM 名单的项目不巡检；--project 指定照跑", async () => {
    createTask(db, { actor: "owner", now: 0 }, { project: "other", id: "T9", title: "x", kind: "code", stage: "build" });
    expect((await cli("owner")).projects.map((p: any) => p.project)).toEqual([P]);
  });
});

describe("ledger audit 的权限与只读", () => {
  test("写巡检结果：执行者不行；PM 只能 --project 自己的项目；owner 随便跑", async () => {
    expect(await cli(EXE)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await cli(PM)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await cli(PM, "--project", P)).toMatchObject({ ok: true });
    expect(await cli(EXE, "--dry-run")).toMatchObject({ ok: true, dryRun: true });
  });

  test("真实入口 --dry-run 用只读连接：巡检之前版本的库不被迁移（分支代码不会把线上库版本抬上去）", async () => {
    const state = mkdtempSync(join(tmpdir(), "ledger-audit-ro-"));
    const raw = new Database(join(state, "ledger.sqlite"));
    raw.exec("PRAGMA journal_mode = WAL");
    // 用真实迁移建到「巡检之前」那一版（表齐、版本号对得上），只读侧才不会先撞上「版本号到了表却缺」
    for (const step of LEDGER_MIGRATIONS.slice(0, AUDIT_SCHEMA_VERSION - 1)) {
      if (typeof step === "function") step(raw);
      else for (const sql of step) raw.prepare(sql).run();
    }
    raw.exec(`PRAGMA user_version = ${AUDIT_SCHEMA_VERSION - 1}`);
    raw.close();
    const env: Record<string, string | undefined> = { ...process.env, CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(state, "run") };
    delete env.DISCORD_CHANNEL_ID;
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/manager.ts"), "ledger", "audit", "--dry-run"], { env, stdout: "pipe", stderr: "pipe" });
    const out = JSON.parse((await new Response(proc.stdout).text()).trim().split("\n").at(-1) ?? "");
    expect(out).toMatchObject({ ok: true, dryRun: true });
    const check = new Database(join(state, "ledger.sqlite"), { readonly: true });
    expect(check.query("PRAGMA user_version").get()).toEqual({ user_version: AUDIT_SCHEMA_VERSION - 1 });
    expect(check.query("SELECT name FROM sqlite_master WHERE name = 'audit_findings'").get()).toBeNull();
    check.close();
  }, 30_000);
});

describe("bridge 定时器", () => {
  type Sent = { kind: "deliver" | "hold"; env: Envelope };
  function deps(over: Partial<LedgerAuditDeps> = {}) {
    const sent: Sent[] = [];
    const acks: string[][] = [];
    const sources: string[] = [];
    const store = new Map<string, boolean>(); // key → 已 ack（含 --queued）
    const pending = [
      { key: "k1", project: P, taskId: "T1", rule: "review_no_reviewer", detail: "d1", suggestion: "派审查员", notify: "agent-pm-dispatch", fallback: PM },
      { key: "k2", project: P, taskId: null, rule: "pm_held", detail: "d2", suggestion: "check_inbox 领回并处理", notify: PM },
    ];
    const d: LedgerAuditDeps = {
      clients: new Map([["c-pm", { ws: {} as never, channelId: "c-pm" }], ["c-dis", { ws: {} as never, channelId: "c-dis" }]]),
      deliver: async (env) => (sent.push({ kind: "deliver", env }), { outcome: { kind: "sent" } }),
      hold: (env) => void sent.push({ kind: "hold", env }),
      lastMessageSource: { set: (ch) => void sources.push(ch) },
      runManager: async (...args: string[]) => {
        if (args.includes("--ack")) {
          acks.push(args.slice(args.indexOf("--ack") + 1));
          for (const k of args[args.indexOf("--ack") + 1].split(",")) store.set(k, true);
          return { ok: true };
        }
        return { ok: true, projects: [], pending: pending.filter((f) => !store.get(f.key)) };
      },
      busy: async () => false,
      channelOf: (a) => ({ [PM]: "c-pm", "agent-pm-dispatch": "c-dis" })[a],
      ...over,
    };
    return { d, sent, acks, sources };
  }
  const who = (s: Sent) => [s.kind, (s.env.to as { agentName?: string }).agentName];

  test("按收件人各合成一条；推出后逐个 ack；再跑一轮不重复推", async () => {
    const { d, sent, acks, sources } = deps();
    const tick = ledgerAuditTicker(d);
    await tick();
    expect(sent.map(who)).toEqual([["deliver", "agent-pm-dispatch"], ["deliver", PM]]);
    expect(sent[0].env).toMatchObject({ from: { kind: "bridge", label: "ledger-audit" }, intent: "notification", meta: { triggerKind: "bridge_synth", waitForIdle: true } });
    expect(String(sent[1].env.content)).toContain("check_inbox");
    expect(acks).toEqual([["k1"], ["k2"]]);
    expect(sources).toEqual(["c-dis", "c-pm"]);
    await tick();
    expect(sent).toHaveLength(2);
  });

  test("收件人在忙 → 进押后队列、ack 带 --queued <messageId>，且不改最后消息来源（owner 的 @ 不丢）", async () => {
    const { d, sent, acks, sources } = deps({ busy: async (ch) => ch === "c-pm" });
    await ledgerAuditTicker(d)();
    expect(sent.map((s) => s.kind)).toEqual(["deliver", "hold"]);
    expect(acks).toEqual([["k1"], ["k2", "--queued", sent[1].env.meta.messageId]]);
    expect(sources).toEqual(["c-dis"]);
  });

  test("收件人不在线 / 投递失败 → 不 ack，下一轮再推", async () => {
    const { d, sent, acks } = deps({ channelOf: (a) => (a === PM ? "c-pm" : undefined), deliver: async (env) => (sent.push({ kind: "deliver", env }), { outcome: { kind: "error" } }) });
    const tick = ledgerAuditTicker(d);
    await tick();
    expect(acks).toEqual([]);
    await tick();
    expect(sent).toHaveLength(2);
  });

  test("调度助理连续 2 轮不在线 → 第 3 轮审查类改推 PM；它回来后又推回给它", async () => {
    let dispatcherOnline = false;
    const { d, sent, acks } = deps({ channelOf: (a) => (a === PM ? "c-pm" : dispatcherOnline ? "c-dis" : undefined) });
    const tick = ledgerAuditTicker(d);
    await tick();
    await tick();
    expect(sent.map(who)).toEqual([["deliver", PM]]);
    await tick();
    expect(sent.map(who)).toEqual([["deliver", PM], ["deliver", PM]]);
    expect(String(sent[1].env.content)).toContain("派审查员");
    expect(acks.at(-1)).toEqual(["k1"]);
    dispatcherOnline = true;
    await tick(); // 已推过：没有新的
    expect(sent).toHaveLength(2);
  });

  test("skipped 变化才打日志", async () => {
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
    try {
      const skipped = [{ rule: "owner_inbox_stale", reason: "没有 docsDir" }];
      const { d } = deps({ runManager: async () => ({ ok: true, projects: [{ project: P, skipped }], pending: [] }) });
      const tick = ledgerAuditTicker(d);
      await tick();
      await tick();
      expect(logs.filter((l) => l.includes("这些规则没跑"))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("manager 报错 → 只记日志，不推", async () => {
    const { d, sent } = deps({ runManager: async () => ({ ok: false, error: "认主守卫" }) });
    await ledgerAuditTicker(d)();
    expect(sent).toEqual([]);
  });
});
