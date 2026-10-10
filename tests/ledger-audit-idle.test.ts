/**
 * dispatch-recovery-AUDLEND1：巡检判执行者空闲 / 孤儿时认出借在途和后台 shell（src/lib/ledger-audit-idle.ts）。
 * 夹具是真台账库 + 真取数（collectAuditSnapshots 读 lend_orders、事件；后台 shell 用真的 jsonl 和 .output 文件）+ 真规则（auditLedger），
 * 开关用注入的恢复策略 auditIdleFacts。「改动前」= 同一份快照去掉 lendTransit / bgShells 再跑一遍（原路径），另把 detail 写死核对。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLedger, type AuditFinding, type AuditRule, type AuditSnapshot } from "../src/lib/ledger-audit.js";
import { bgShellRunning, type IdleFactInputs } from "../src/lib/ledger-audit-idle.js";
import { collectAuditSnapshots, type SnapshotSources } from "../src/lib/ledger-audit-snapshot.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, deliver, setMeta } from "../src/lib/ledger-write.js";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { RECOVERY_KEYS, recoveryPolicy } from "../src/lib/recovery-policy.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import { baselineAudit, tempLedgerPath } from "./ledger-test-helpers.js";

const MIN = 60_000;
const NOW = 100_000 * MIN;
const P = "p", PM = "agent-pm", PEER = "HedeMacBook-Pro", ORDER = "lend:X:s1:r0:a0";
const EXE = "agent-task-x";
const MODES: readonly RecoveryMode[] = ["off", "observe", "on"];
type Snap = AuditSnapshot & IdleFactInputs;

let db: Database, path: string, dir: string;
/** 本机会话：registry 里有谁、会话文件最近写入时刻、哪些会话读得到后台 shell 夹具 */
let agents: string[], lastWriteAt: number, shellFor: Record<string, { jsonl: string; root: string }>;
beforeEach(() => {
  path = tempLedgerPath("ledger-audit-idle-");
  dir = mkdtempSync(join(tmpdir(), "ledger-audit-idle-"));
  db = openLedger(path);
  db.run("PRAGMA foreign_keys = OFF"); // 夹具直接写出借单，不造 peer / 推送队列
  setMeta(db, { actor: "owner", now: 0 }, { project: P, key: "pms", value: [PM] });
  baselineAudit(db, P);
  agents = [PM, EXE];
  lastWriteAt = NOW - 40 * MIN;
  shellFor = {};
});
afterEach(() => closeLedger(path));

const sources = (): SnapshotSources => ({
  registry: async () => agents.map((name): RegistryAgent => ({ name, projectId: P, cwd: join(dir, name), sessionId: "sess-now" })),
  windows: async () => ["master", ...agents], turn: async () => "idle",
  fileTimes: async () => ({ lastWriteAt, startedAt: NOW - 180 * MIN }), reviewers: () => [], heldPath: join(dir, "held.json"),
  // 真判定（bgShellRunning）读夹具文件；没给夹具的会话 = 会话读不到
  bgShell: async (a) => bgShellRunning(shellFor[a.name]?.jsonl ?? join(dir, "absent.jsonl"), shellFor[a.name]?.root ?? join(dir, "absent")),
});
/** 只有 auditIdleFacts 用被测模式，其余开关固定 observe */
const policy = (mode: RecoveryMode): RecoveryPolicyPort => (_p, key) => ({ mode: key === "auditIdleFacts" ? mode : "observe", manualAfterMs: null, source: "config" });

/** 卡 id 在 at 时刻进 build，task.agent = agent */
function card(id: string, agent: string | null, at = NOW - 120 * MIN): void {
  createTask(db, { actor: "owner", now: at }, { project: P, id, title: id, kind: "code", agent, pm: PM, stage: "build" });
}
function order(taskId: string, status: string, lastActivityAt: number | null, step = "write", orderId = ORDER): void {
  const beat = lastActivityAt === null ? null : JSON.stringify({ gen: 1, phase: "working", lastActivityAt, excerpt: "", at: NOW, since: NOW });
  db.query(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256, status, leaseMs, leaseUntil,
    createdBy, createdAt, updatedAt, beatAt, beat) VALUES (?, ?, ?, ?, 'claude', ?, 1, 0, 'h', 'o/r', '{}', '', '', ?, ?, ?, 'owner', ?, ?, ?, ?)`)
    .run(orderId, taskId, P, PEER, step, status, 10 * MIN, NOW + 10 * MIN, NOW - 100 * MIN, NOW, beat ? NOW : null, beat);
}
function registerAuthor(taskId: string, agent: string, at = NOW - 119 * MIN): void {
  insertEvent(db, { actor: "owner", now: at }, { project: P, target: taskId, kind: "scheduler", text: `登记 author agent ${agent}`,
    data: { op: "worker_register", agent, sessionId: "s", role: "author", createdBy: "owner" } }, false);
}
/** 卡派给 peer：task.agent 清空，assignee 是 peer_agent */
const toPeer = (taskId: string) => void db.query("UPDATE tasks SET agent = NULL, assigneeKind = 'peer_agent', assignee = ? WHERE id = ?").run(PEER, taskId);
function jump(taskId: string, from: string, to: string, at: number): void {
  db.query("UPDATE tasks SET stage = ? WHERE id = ?").run(to, taskId);
  insertEvent(db, { actor: "owner", now: at }, { project: P, target: taskId, kind: "stage", text: "", data: { from, to } }, false);
}
/** 夹具会话：主会话 jsonl 里登记一个后台 shell，.output 写 output */
function bgShell(agent: string, output: string): void {
  const root = join(dir, "shells", "proj-slug"), id = "bg1";
  mkdirSync(join(root, "sess-old", "tasks"), { recursive: true });
  writeFileSync(join(root, "sess-old", "tasks", `${id}.output`), output);
  const jsonl = join(dir, `${agent}.jsonl`);
  const text = `Command running in background with ID: ${id}. Output is being written to: /tmp/claude-501/proj-slug/sess-old/tasks/${id}.output`;
  writeFileSync(jsonl, `${JSON.stringify({ type: "user", toolUseResult: { backgroundTaskId: id }, message: { content: [{ type: "tool_result", content: text }] } })}\n`);
  shellFor[agent] = { jsonl, root };
}

const snapshot = async (now = NOW): Promise<Snap> => (await collectAuditSnapshots(db, [P], now, sources()))[0] as Snap;
const of = (s: Snap, mode: RecoveryMode, rule: AuditRule, now = NOW) => auditLedger(s, now, policy(mode)).findings.filter((f) => f.rule === rule);
/** 改动前的输出：快照不带出借 / 后台 shell 事实 */
const before = (s: Snap, mode: RecoveryMode, now = NOW) => { const { lendTransit: _l, bgShells: _b, ...rest } = s; return auditLedger(rest, now, policy(mode)); };
const brief = (f: AuditFinding) => ({ taskId: f.taskId, since: f.since, detail: f.detail, suggestion: f.suggestion });
const IDLE_40 = { taskId: "X", since: NOW - 40 * MIN, detail: `X 在 build，执行者 ${EXE} 已空闲 40 分钟，还没交付`, suggestion: "问执行者卡在哪（可能在等你回复）" };
const ORPHAN = (name: string) => `${name} 属于本项目，台账里没有它的任务`;

describe("[验收线 2] 出借：卡在 build，task.agent 是本机会话（idle、40 分钟没写），有一张 claimed 的 write 单", () => {
  beforeEach(() => card("X", EXE));
  test("取数：只带出借在途的单（write / fix、活单），lastActivityAt 取自心跳摘要", async () => {
    order("X", "claimed", NOW - 5 * MIN);
    card("R", EXE); order("R", "claimed", NOW, "review", "lend:R:s2:r0:a0"); // 审查单不算出借在途
    card("D", EXE); order("D", "done", NOW, "write", "lend:D:s1:r0:a0"); // 已结的单不算
    expect((await snapshot()).lendTransit).toEqual({
      X: { orderId: ORDER, peer: PEER, step: "write", status: "claimed", leaseUntil: NOW + 10 * MIN, lastActivityAt: NOW - 5 * MIN } });
  });
  test("lastActivityAt 5 分钟前：on 不报；observe 照报，detail 末尾带 peer 和单号", async () => {
    order("X", "claimed", NOW - 5 * MIN);
    const s = await snapshot();
    expect(of(s, "on", "executor_idle")).toEqual([]);
    const note = `（出借在途：${PEER} 单 ${ORDER}，对方最近活动 5 分钟前）`;
    expect(of(s, "observe", "executor_idle").map(brief)).toEqual([{ ...IDLE_40, detail: IDLE_40.detail + note }]);
    expect(of(s, "observe", "executor_idle")[0].key).toBe(of(s, "off", "executor_idle")[0].key);
  });
  test("lastActivityAt 20 分钟前：on 报，since 等于 lastActivityAt，detail 含 peer 和单号，suggestion 含 ledger lend-orders <卡>", async () => {
    order("X", "claimed", NOW - 20 * MIN);
    const f = of(await snapshot(), "on", "executor_idle");
    expect(f.map(brief)).toEqual([{ taskId: "X", since: NOW - 20 * MIN,
      detail: `X 在 build，出借给 ${PEER}（单 ${ORDER}），对方 worker 已 20 分钟没有活动，还没交付`,
      suggestion: "ledger lend-orders X 看单子，再问对方 worker 卡在哪" }]);
    expect(f[0].notify).toBe(PM);
  });
  test("on：不看本机会话——task.agent 为空（卡已派给 peer）照样按心跳判；刚满阈值不报；本阶段已交付不报", async () => {
    order("X", "claimed", NOW - 15 * MIN);
    toPeer("X");
    expect(of(await snapshot(), "on", "executor_idle")).toEqual([]);
    expect(of(await snapshot(NOW + 1), "on", "executor_idle", NOW + 1).map((f) => f.since)).toEqual([NOW - 15 * MIN]);
    expect(of(await snapshot(NOW + 1), "observe", "executor_idle", NOW + 1)).toEqual([]); // observe 照原样：没有 task.agent 本来就不报
    deliver(db, { actor: "owner", now: NOW }, { taskId: "X" });
    expect(of(await snapshot(NOW + 30 * MIN), "on", "executor_idle", NOW + 30 * MIN)).toEqual([]);
  });
  test("还没有心跳：on 从进本阶段起算", async () => {
    order("X", "claimed", null);
    expect(of(await snapshot(), "on", "executor_idle").map((f) => f.since)).toEqual([NOW - 120 * MIN]);
    expect(of(await snapshot(), "observe", "executor_idle")[0].detail.endsWith(`（出借在途：${PEER} 单 ${ORDER}，还没有心跳）`)).toBe(true);
  });
  test("单子是 pooled / unknown：on 不报；observe 照报并注明", async () => {
    order("X", "pooled", null);
    expect(of(await snapshot(), "on", "executor_idle")).toEqual([]);
    expect(of(await snapshot(), "observe", "executor_idle").map(brief)).toEqual([{ ...IDLE_40, detail: `${IDLE_40.detail}（出借在途：${PEER} 单 ${ORDER}，等领单）` }]);
    db.query("UPDATE lend_orders SET status = 'unknown'").run();
    expect(of(await snapshot(), "on", "executor_idle")).toEqual([]);
    expect(of(await snapshot(), "observe", "executor_idle")[0].detail.endsWith("单子未知）")).toBe(true);
  });
  test("别的项目的出借单、审查单不算：三种开关都照原样报", async () => {
    order("X", "claimed", NOW - 5 * MIN, "review");
    for (const m of MODES) expect(of(await snapshot(), m, "executor_idle").map(brief)).toEqual([IDLE_40]);
    db.query("UPDATE lend_orders SET step = 'write', project = 'q'").run();
    expect((await snapshot()).lendTransit).toEqual({});
    for (const m of MODES) expect(of(await snapshot(), m, "executor_idle").map(brief)).toEqual([IDLE_40]);
  });
});

describe("[验收线 3] 后台 shell：本机执行者主回合 idle，会话里有一个已登记的后台 shell", () => {
  beforeEach(() => card("X", EXE));
  const at = (ago: number) => ({ ...IDLE_40, since: NOW - ago * MIN, detail: `X 在 build，执行者 ${EXE} 已空闲 ${ago} 分钟，还没交付` });
  test(".output 还没有退出行：on 下 40 分钟不报，61 分钟报，detail 带『后台 shell 在跑』", async () => {
    bgShell(EXE, "running 1200 tests...\n");
    const s = await snapshot();
    expect(s.bgShells).toEqual([EXE]);
    expect(of(s, "on", "executor_idle")).toEqual([]);
    expect(of(s, "observe", "executor_idle").map(brief)).toEqual([{ ...IDLE_40, detail: `${IDLE_40.detail}（后台 shell 在跑）` }]);
    expect(of(await snapshot(NOW + 20 * MIN), "on", "executor_idle", NOW + 20 * MIN)).toEqual([]); // 刚满 60 分钟
    const late = of(await snapshot(NOW + 21 * MIN), "on", "executor_idle", NOW + 21 * MIN);
    expect(late.map(brief)).toEqual([{ ...IDLE_40, detail: `X 在 build，执行者 ${EXE} 已空闲 61 分钟，还没交付（后台 shell 在跑）` }]);
    expect(late[0].key).toBe(of(s, "off", "executor_idle")[0].key);
  });
  test(".output 已有退出行（或被结束）：on 下 16 分钟照报，和现在一样", async () => {
    lastWriteAt = NOW - 16 * MIN;
    for (const tail of ["ok\n[exited with code 0]\n", "ok\n[exited with code 1]", "Terminated\n[killed]\n"]) {
      bgShell(EXE, tail);
      const s = await snapshot();
      expect(s.bgShells).toEqual([]);
      for (const m of MODES) expect(of(s, m, "executor_idle").map(brief)).toEqual([at(16)]);
    }
  });
  test("退出行后面还有输出 / 只是日志里提到：不算结束，仍按在跑", async () => {
    for (const tail of ["[exited with code 0]\nmore\n", "log: [exited with code 0] seen\n", ""]) {
      bgShell(EXE, tail);
      expect((await snapshot()).bgShells).toEqual([EXE]);
    }
  });
  test("会话读不到 / 登记了但找不到 .output / jsonl 里只是正文提到：on 下 16 分钟照报", async () => {
    lastWriteAt = NOW - 16 * MIN;
    expect(of(await snapshot(), "on", "executor_idle").map(brief)).toEqual([at(16)]); // 没有夹具 = 会话读不到
    bgShell(EXE, "running\n");
    shellFor[EXE].root = join(dir, "shells", "elsewhere"); // slug 对不上：认不出
    expect(of(await snapshot(), "on", "executor_idle").map(brief)).toEqual([at(16)]);
    bgShell(EXE, "running\n");
    writeFileSync(shellFor[EXE].jsonl, `${JSON.stringify({ message: { content: "Output is being written to: /tmp/x/proj-slug/sess-old/tasks/bg1.output" } })}\n`);
    expect(of(await snapshot(), "on", "executor_idle").map(brief)).toEqual([at(16)]);
  });
  test("只给本来要被报空闲的执行者查：没满 15 分钟、主回合在忙、出借在途的卡都不读", async () => {
    bgShell(EXE, "running\n");
    let reads = 0;
    const counting = (turn: "idle" | "busy"): SnapshotSources => ({ ...sources(), turn: async () => turn, bgShell: async () => (reads++, true) });
    lastWriteAt = NOW - 15 * MIN;
    await collectAuditSnapshots(db, [P], NOW, counting("idle"));
    lastWriteAt = NOW - 40 * MIN;
    await collectAuditSnapshots(db, [P], NOW, counting("busy"));
    expect(reads).toBe(0);
    await collectAuditSnapshots(db, [P], NOW, counting("idle"));
    expect(reads).toBe(1);
    order("X", "claimed", NOW - 5 * MIN);
    await collectAuditSnapshots(db, [P], NOW, counting("idle"));
    expect(reads).toBe(1);
  });
});

describe("[验收线 4] 孤儿与回收：本机 agent-task- 会话在卡 X 上登记过作者，X 派给 peer、在 build、task.agent 为空", () => {
  const NEVER = "agent-task-n", OLD = "agent-task-y";
  beforeEach(() => {
    agents = [PM, EXE, NEVER, OLD, "agent-local2"];
    card("X", EXE); registerAuthor("X", EXE); toPeer("X");
    card("Y", OLD); registerAuthor("Y", OLD); // Y 后来改派给别的本机 agent
    db.query("UPDATE tasks SET agent = 'agent-local2', assigneeKind = 'agent', assignee = 'agent-local2' WHERE id = 'Y'").run();
  });
  const orphans = (fs: AuditFinding[]) => fs.map((f) => f.detail).sort();
  test("on：X 的复述会话不报孤儿；没登记过的、Y 上登记过的旧会话照报", async () => {
    const s = await snapshot();
    expect(orphans(of(s, "on", "orphan_executor"))).toEqual([ORPHAN(NEVER), ORPHAN(OLD)]);
    expect(of(s, "on", "reclaim_executor")).toEqual([]);
  });
  test("off 照原样三个都报；observe 照报，X 的复述会话那条末尾加注", async () => {
    const s = await snapshot();
    expect(orphans(of(s, "off", "orphan_executor"))).toEqual([ORPHAN(NEVER), ORPHAN(EXE), ORPHAN(OLD)]);
    expect(orphans(of(s, "observe", "orphan_executor"))).toEqual([ORPHAN(NEVER), `${ORPHAN(EXE)}（复述会话：X 出借在途）`, ORPHAN(OLD)]);
    expect(of(s, "observe", "orphan_executor").map((f) => f.key).sort()).toEqual(of(s, "off", "orphan_executor").map((f) => f.key).sort());
  });
  test("X 转 verified 31 分钟后窗口还在：on 报 reclaim_executor（taskId 为 X）；宽限内 / 窗口不在不报", async () => {
    jump("X", "build", "verified", NOW);
    expect(of(await snapshot(NOW + 30 * MIN), "on", "reclaim_executor", NOW + 30 * MIN)).toEqual([]);
    const s = await snapshot(NOW + 31 * MIN);
    expect(of(s, "on", "reclaim_executor", NOW + 31 * MIN).map(brief)).toEqual([
      { taskId: "X", since: NOW, detail: `${EXE} 的任务 X 已 verified，窗口还在`, suggestion: "回收执行者（kill）" }]);
    expect(orphans(of(s, "on", "orphan_executor", NOW + 31 * MIN))).toEqual([ORPHAN(NEVER), ORPHAN(OLD)]);
    expect(orphans(of(s, "observe", "orphan_executor", NOW + 31 * MIN))).toContain(`${ORPHAN(EXE)}（复述会话：X 已 verified）`);
    const gone = { ...s, agents: s.agents?.map((a) => (a.name === EXE ? { ...a, windowAlive: false } : a)) ?? null };
    expect(of(gone, "on", "reclaim_executor", NOW + 31 * MIN)).toEqual([]);
  });
  test("卡没派给 peer 但出借在途（先本机后出借，task.agent 还是它）：on 不报孤儿也不报回收", async () => {
    card("Z", "agent-task-z"); registerAuthor("Z", "agent-task-z"); order("Z", "claimed", NOW, "write", "lend:Z:s1:r0:a0");
    db.query("UPDATE tasks SET agent = NULL WHERE id = 'Z'").run();
    agents.push("agent-task-z");
    const s = await snapshot();
    expect(orphans(of(s, "on", "orphan_executor"))).not.toContain(ORPHAN("agent-task-z"));
    expect(orphans(of(s, "off", "orphan_executor"))).toContain(ORPHAN("agent-task-z"));
  });
  test("最后一条作者登记是别人：前一个会话照报孤儿", async () => {
    registerAuthor("X", "agent-task-x2", NOW - 60 * MIN);
    agents.push("agent-task-x2");
    expect(orphans(of(await snapshot(), "on", "orphan_executor"))).toEqual([ORPHAN(NEVER), ORPHAN(EXE), ORPHAN(OLD)]);
  });
});

describe("[验收线 1] off：第 2~4 条的夹具输出和改动前逐字一致", () => {
  test("出借（claimed 5 / 20 分钟前、pooled）、后台 shell、孤儿与回收", async () => {
    agents = [PM, EXE, "agent-task-b", "agent-task-r"];
    card("X", EXE); order("X", "claimed", NOW - 20 * MIN);
    card("B", "agent-task-b"); bgShell("agent-task-b", "running\n");
    card("R", "agent-task-r"); registerAuthor("R", "agent-task-r"); toPeer("R");
    for (const now of [NOW, NOW + 21 * MIN]) {
      const s = await snapshot(now);
      expect(Object.keys(s.lendTransit ?? {})).toEqual(["X"]);
      expect(s.bgShells).toEqual(["agent-task-b"]);
      expect(auditLedger(s, now, policy("off"))).toEqual(before(s, "off", now));
      expect(auditLedger(s, now, policy("off"))).toEqual(before(s, "on", now));
    }
    const off = auditLedger(await snapshot(), NOW, policy("off")).findings;
    expect(off.filter((f) => f.rule === "executor_idle").map((f) => f.detail).sort()).toEqual([
      "B 在 build，执行者 agent-task-b 已空闲 40 分钟，还没交付", IDLE_40.detail]);
    expect(off.filter((f) => f.rule === "orphan_executor").map((f) => f.detail)).toEqual([ORPHAN("agent-task-r")]);
  });
});

describe("[验收线 5] lend_orders 表不存在：三种开关下输出都和改动前一致", () => {
  test("出借 / 后台 shell / 孤儿夹具", async () => {
    agents = [PM, EXE, "agent-task-b", "agent-task-r"];
    card("X", EXE);
    card("B", "agent-task-b"); bgShell("agent-task-b", "running\n");
    card("R", "agent-task-r"); registerAuthor("R", "agent-task-r"); toPeer("R");
    db.run("DROP TABLE lend_orders");
    const s = await snapshot();
    expect(s.lendTransit).toBeUndefined();
    expect(s.bgShells).toEqual([]);
    for (const m of MODES) {
      expect(auditLedger(s, NOW, policy(m))).toEqual(before(s, m));
      expect(of(s, m, "executor_idle").map((f) => f.detail).sort()).toEqual(["B 在 build，执行者 agent-task-b 已空闲 40 分钟，还没交付", IDLE_40.detail]);
      expect(of(s, m, "orphan_executor").map((f) => f.detail)).toEqual([ORPHAN("agent-task-r")]);
    }
  });
});

describe("[验收线 6] 开关登记", () => {
  test("auditIdleFacts 登记一次，缺省 observe；策略读不了按 off", async () => {
    expect(RECOVERY_KEYS.filter((k) => k === "auditIdleFacts")).toHaveLength(1);
    expect(recoveryPolicy(P, "auditIdleFacts", join(dir, "none.json")).mode).toBe("observe");
    card("X", EXE); order("X", "claimed", NOW - 5 * MIN);
    const s = await snapshot();
    const broken: RecoveryPolicyPort = () => { throw new Error("策略读不了"); };
    expect(auditLedger(s, NOW, broken).findings.filter((f) => f.rule === "executor_idle").map(brief)).toEqual([IDLE_40]);
  });
});
