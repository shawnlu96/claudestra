/**
 * dispatch-recovery-AUDLEND1 第 1 轮审查的回归（src/lib/ledger-audit-idle.ts、ledger-audit.ts registryRules）：
 * - bg-tail：后台 shell 的启动记录后面会话又写了超过 512 KB，仍要认得出（真 jsonl、真 .output、真取数）。
 * - relay-retained：出借卡的复述会话还留在 task.agent 上（远端交付只改 assignee），卡 verified 后照样报回收；普通本机任务不变。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLedger, type AuditRule, type AuditSnapshot } from "../src/lib/ledger-audit.js";
import { bgShellRunning, type IdleFactInputs } from "../src/lib/ledger-audit-idle.js";
import { collectAuditSnapshots, type SnapshotSources } from "../src/lib/ledger-audit-snapshot.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import { baselineAudit, tempLedgerPath } from "./ledger-test-helpers.js";

const MIN = 60_000;
const NOW = 100_000 * MIN;
const P = "p", PM = "agent-pm", PEER = "HedeMacBook-Pro", EXE = "agent-task-x";
const MODES: readonly RecoveryMode[] = ["off", "observe", "on"];
type Snap = AuditSnapshot & IdleFactInputs;

let db: Database, path: string, dir: string, lastWriteAt: number;
beforeEach(() => {
  path = tempLedgerPath("ledger-audit-idle-fix1-");
  dir = mkdtempSync(join(tmpdir(), "ledger-audit-idle-fix1-"));
  db = openLedger(path);
  setMeta(db, { actor: "owner", now: 0 }, { project: P, key: "pms", value: [PM] });
  baselineAudit(db, P);
  lastWriteAt = NOW - 40 * MIN;
});
afterEach(() => closeLedger(path));

const jsonl = () => join(dir, "main.jsonl"), root = () => join(dir, "shells", "proj-slug");
const sources = (): SnapshotSources => ({
  registry: async () => [PM, EXE].map((name): RegistryAgent => ({ name, projectId: P, cwd: join(dir, name), sessionId: "sess-now" })),
  windows: async () => ["master", PM, EXE], turn: async () => "idle",
  fileTimes: async () => ({ lastWriteAt, startedAt: NOW - 180 * MIN }), reviewers: () => [], heldPath: join(dir, "held.json"),
  bgShell: async () => bgShellRunning(jsonl(), root()),
});
const policy = (mode: RecoveryMode): RecoveryPolicyPort => (_p, key) => ({ mode: key === "auditIdleFacts" ? mode : "observe", manualAfterMs: null, source: "config" });
const snapshot = async (now = NOW): Promise<Snap> => (await collectAuditSnapshots(db, [P], now, sources()))[0] as Snap;
const of = (s: Snap, mode: RecoveryMode, rule: AuditRule, now = NOW) => auditLedger(s, now, policy(mode)).findings.filter((f) => f.rule === rule);
const card = (id: string, agent: string | null) =>
  void createTask(db, { actor: "owner", now: NOW - 120 * MIN }, { project: P, id, title: id, kind: "code", agent, pm: PM, stage: "build" });

/** 一条 CC 的后台 shell 启动记录 + 它的 .output */
function launch(id: string, output: string): string {
  mkdirSync(join(root(), "sess-old", "tasks"), { recursive: true });
  writeFileSync(join(root(), "sess-old", "tasks", `${id}.output`), output);
  const text = `Command running in background with ID: ${id}. Output is being written to: /tmp/claude-501/proj-slug/sess-old/tasks/${id}.output`;
  return `${JSON.stringify({ type: "user", toolUseResult: { backgroundTaskId: id }, message: { content: [{ type: "tool_result", content: text }] } })}\n`;
}
/** n 条约 2 KB 的普通会话记录 */
const chatter = (n: number) => Array.from({ length: n }, (_, i) => `${JSON.stringify({ type: "assistant", message: { content: `${i} ${"x".repeat(2000)}` } })}\n`).join("");

describe("[验收线 3] 后台 shell 的启动记录后面会话又写了很多（审查 bg-tail）", () => {
  beforeEach(() => card("X", EXE));
  test("启动记录在尾部 512 KB 之外：首次巡检就认得出，on 下 40 分钟不报、61 分钟报，observe 带注记", async () => {
    writeFileSync(jsonl(), launch("bg1", "running 1200 tests...\n") + chatter(600));
    expect(statSync(jsonl()).size).toBeGreaterThan(2 * 512_000);
    const s = await snapshot();
    expect(s.bgShells).toEqual([EXE]);
    expect(of(s, "on", "executor_idle")).toEqual([]);
    expect(of(s, "observe", "executor_idle").map((f) => f.detail)).toEqual([`X 在 build，执行者 ${EXE} 已空闲 40 分钟，还没交付（后台 shell 在跑）`]);
    expect(of(s, "off", "executor_idle").map((f) => f.detail)).toEqual([`X 在 build，执行者 ${EXE} 已空闲 40 分钟，还没交付`]);
    const late = of(await snapshot(NOW + 21 * MIN), "on", "executor_idle", NOW + 21 * MIN);
    expect(late.map((f) => f.detail)).toEqual([`X 在 build，执行者 ${EXE} 已空闲 61 分钟，还没交付（后台 shell 在跑）`]);
  });
  test("两轮巡检之间启动记录滑出尾部窗口：第二轮仍认得出", async () => {
    writeFileSync(jsonl(), chatter(5) + launch("bg1", "running\n"));
    expect(await bgShellRunning(jsonl(), root())).toBe(true);
    appendFileSync(jsonl(), chatter(260));
    expect(await bgShellRunning(jsonl(), root())).toBe(true);
    expect((await snapshot()).bgShells).toEqual([EXE]);
  });
  test("长会话里的 shell 都结束了 / 末尾是没写完的半行：按没有后台 shell，on 下 16 分钟照报", async () => {
    lastWriteAt = NOW - 16 * MIN;
    writeFileSync(jsonl(), launch("bg1", "ok\n[exited with code 0]\n") + chatter(600) + launch("bg2", "running\n").slice(0, -1)); // bg2 的记录还没写完
    const s = await snapshot();
    expect(s.bgShells).toEqual([]);
    for (const m of MODES) expect(of(s, m, "executor_idle").map((f) => f.detail)).toEqual([`X 在 build，执行者 ${EXE} 已空闲 16 分钟，还没交付`]);
  });
  test("老的已结束、窗口外的还在跑、中间隔着跨块的大记录：认得出还在跑的那个", async () => {
    const big = `${JSON.stringify({ type: "user", message: { content: "y".repeat(5 * 1024 * 1024) } })}\n`; // 一行超过一个读块
    writeFileSync(jsonl(), launch("bg0", "done\n[exited with code 0]\n") + big + launch("bg1", "running\n") + chatter(600));
    expect(await bgShellRunning(jsonl(), root())).toBe(true);
    writeFileSync(join(root(), "sess-old", "tasks", "bg1.output"), "done\n[exited with code 0]\n");
    expect(await bgShellRunning(jsonl(), root())).toBe(false);
  });
});

describe("[验收线 4] 复述会话还留在 task.agent 上（审查 relay-retained）", () => {
  const author = (taskId: string) => insertEvent(db, { actor: "owner", now: NOW - 119 * MIN }, { project: P, target: taskId, kind: "scheduler",
    text: `登记 author agent ${EXE}`, data: { op: "worker_register", agent: EXE, sessionId: "s", role: "author", createdBy: "owner" } }, false);
  function verified(taskId: string): void {
    db.query("UPDATE tasks SET stage = 'verified' WHERE id = ?").run(taskId);
    insertEvent(db, { actor: "owner", now: NOW }, { project: P, target: taskId, kind: "stage", text: "", data: { from: "build", to: "verified" } }, false);
  }
  const reclaim = async (mode: RecoveryMode, mins: number) =>
    of(await snapshot(NOW + mins * MIN), mode, "reclaim_executor", NOW + mins * MIN).map((f) => ({ taskId: f.taskId, since: f.since, detail: f.detail }));
  const X_DONE = [{ taskId: "X", since: NOW, detail: `${EXE} 的任务 X 已 verified，窗口还在` }];

  test("卡派给 peer、task.agent 没清：verified 31 分钟后 on 报回收，和清空时一样；宽限内不报；off / observe 照原样不报", async () => {
    card("X", EXE); author("X");
    db.query("UPDATE tasks SET assigneeKind = 'peer_agent', assignee = ? WHERE id = 'X'").run(PEER); // 远端交付只改 assignee，不清 agent
    expect(await reclaim("on", 31)).toEqual([]); // 还在 build：卡在途
    verified("X");
    expect(await reclaim("on", 30)).toEqual([]);
    expect(await reclaim("on", 31)).toEqual(X_DONE);
    expect(await reclaim("off", 31)).toEqual([]);
    expect(await reclaim("observe", 31)).toEqual([]);
    db.query("UPDATE tasks SET agent = NULL WHERE id = 'X'").run();
    expect(await reclaim("on", 31)).toEqual(X_DONE);
  });
  test("它名下还有没到终态的普通本机任务：不报回收（旧规则）", async () => {
    card("X", EXE); author("X");
    db.query("UPDATE tasks SET assigneeKind = 'peer_agent', assignee = ? WHERE id = 'X'").run(PEER);
    card("L", EXE);
    verified("X"); verified("L"); // L 是普通本机任务，verified 还不是终态
    expect(await reclaim("on", 31)).toEqual([]);
  });
  test("普通本机任务（登记过作者但没派给 peer、没出借）verified：三种开关都不报回收", async () => {
    card("X", EXE); author("X");
    verified("X");
    for (const m of MODES) expect(await reclaim(m, 31)).toEqual([]);
  });
});
