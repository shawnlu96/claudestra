/** 台账读侧测试共用：临时目录里的真实文件库 + 一条走过审查一轮的任务（ledger-read / local-api-ledger 两个测试用） */
import type { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLedger } from "../src/lib/ledger-audit.js";
import { reconcileFindings } from "../src/lib/ledger-audit-store.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createItem, createTask, deliver, moveStage, recordReview, setFrozen, setMeta } from "../src/lib/ledger-write.js";

export function tempLedgerPath(prefix = "ledger-read-"): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), "ledger.sqlite");
}

/** 项目 p：事项 i1、任务 T1（执行者 agent-exec，code，已交付两次、审过两轮，停在 merge）、T2（done）、T3（别的项目 q） */
export function seedLedger(path: string, opts: { docsDir?: string } = {}): void {
  const db = openLedger(path);
  const owner = (now: number) => ({ actor: "owner", now });
  createItem(db, owner(0), { project: "p", id: "i1", title: "台账", status: "doing", ownerWords: "随时更新" });
  createTask(db, owner(0), { project: "p", id: "T1", title: "读接口", kind: "code", itemId: "i1", agent: "agent-exec", pm: "agent-pm" });
  moveStage(db, { actor: "agent-exec", now: 100 }, { taskId: "T1", from: "spec", to: "restate" });
  moveStage(db, owner(200), { taskId: "T1", from: "restate", to: "build" });
  deliver(db, { actor: "agent-exec", now: 300 }, { taskId: "T1", headSHA: "s1", moveFrom: "build" });
  recordReview(db, owner(450), { taskId: "T1", reviewer: "r", verdict: "changes", p0: 0, p1: 1, p2: 2, move: { from: "review", to: "fix" } });
  deliver(db, { actor: "agent-exec", now: 500 }, { taskId: "T1", headSHA: "s2", moveFrom: "fix" });
  recordReview(db, owner(520), { taskId: "T1", reviewer: "r", verdict: "pass", p0: 0, p1: 0, p2: 1, move: { from: "review", to: "merge" } });
  createTask(db, owner(600), { project: "p", id: "T2", title: "已完成", kind: "ops", agent: "agent-exec", stage: "done" });
  createTask(db, owner(700), { project: "q", id: "T3", title: "别的项目", kind: "code", agent: "other" });
  setFrozen(db, owner(800), { project: "p", frozen: true, reason: "等 T1 上线" });
  if (opts.docsDir) setMeta(db, owner(900), { project: "p", key: "docsDir", value: opts.docsDir });
  closeLedger(path);
}

/**
 * 读侧测试造 verify 事件：appendEvent 不收 verify（进 verified 只能走 recordVerify 的系统核对），这里直接写表，
 * data 的 imported / approxTime 标记与 ledger-write.ts 的 eventData 一致。
 */
export function verifyEvent(
  db: Database,
  ctx: { actor: string; now: number; approxTime?: boolean },
  e: { project: string; target: string; text?: string; data: Record<string, unknown> },
): void {
  const data = ctx.actor === "import" ? { ...e.data, imported: true, ...(ctx.approxTime ? { approxTime: true } : {}) } : e.data;
  db.prepare("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, ?, ?, ?, 'verify', ?, ?)").run(
    ctx.now, ctx.actor, e.project, e.target, e.text ?? "", JSON.stringify(data),
  );
}

const STORE = join(import.meta.dir, "../src/lib/ledger-store.ts");
const WRITE = join(import.meta.dir, "../src/lib/ledger-write.ts");
const HELPERS = join(import.meta.dir, "ledger-test-helpers.ts");

/**
 * 在子进程里对库跑一段代码（可用 path / openLedger / closeLedger / appendEvent / seedLedger / Database）。
 * 真实场景里写者是 CLI 进程；同进程写还会和读连接共用 SQLite 的进程内锁与 shm 映射，挪文件类的用例只有跨进程才像线上。
 */
export function ledgerScript(path: string, body: string): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  const file = join(mkdtempSync(join(tmpdir(), "ledger-script-")), "s.ts");
  writeFileSync(file, [
    `import { Database } from "bun:sqlite";`,
    `import { openLedger, closeLedger } from ${JSON.stringify(STORE)};`,
    `import { appendEvent, createItem } from ${JSON.stringify(WRITE)};`,
    `import { seedLedger } from ${JSON.stringify(HELPERS)};`,
    `const path = ${JSON.stringify(path)};`,
    body,
  ].join("\n"));
  return Bun.spawn([process.execPath, file], { stdout: "pipe", stderr: "pipe" });
}

export async function runLedgerScript(path: string, body: string): Promise<void> {
  const p = ledgerScript(path, body);
  if ((await p.exited) !== 0) throw new Error(`ledger script failed: ${await new Response(p.stderr).text()}`);
}

/** 让项目的每条巡检规则都「跑过一次」（写 audit_baseline）：之后的发现照常进 pending，不被首轮静默吞掉 */
export function baselineAudit(db: Database, project: string): void {
  const all = auditLedger({ project, pms: [], tasks: [], agents: [], reviewers: [], held: [], ownerInbox: [] }, 0).evaluated;
  reconcileFindings(db, project, [], all, 0);
}
