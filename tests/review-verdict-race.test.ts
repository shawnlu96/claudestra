/**
 * T97 交结论的并发：另一个独立进程拿着写锁、改动还没提交时交结论。判定要在拿到写锁之后做，才看得见对方提交的结果。
 * 1. PM 换审查员的事务先提交 → 旧审查员的结论拒（no_order），不记；
 * 2. 同一张单的另一个结论先提交 → 这次回 conflict，不当成同结论重试。
 * 子进程是真的另一个 bun 进程、另一条 SQLite 连接（WAL），不 mock 事务。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallerIdentity } from "../src/lib/caller-identity.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { createTask, deliver, setMeta, setTask } from "../src/lib/ledger-write.js";
import { submitVerdict, type VerdictDeps } from "../src/lib/review-verdict.js";

const P = "claude-orchestrator";
const PM = { actor: "agent-pm", now: 1_100 };
const H1 = "a".repeat(40);
const SRC = join(import.meta.dir, "../src/lib");
let db: Database, dir: string, dbPath: string, deps: VerdictDeps, report: string;

const me: CallerIdentity = { agent: "agent-y", sessionId: "sess-agent-y", family: "codex", verified: true };
const wire = (over: Record<string, unknown> = {}) => ({ v: 1, orderId: "T50:review:r1", head: H1, verdict: "pass", p0: 0, p1: 0, p2: 0, findings: [], reportPath: report, ...over });
const reviews = () => listEvents(db, { project: P, target: "T50" }).filter((e) => e.kind === "review");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "t97-race-"));
  const reviewsDir = join(dir, "reviews");
  mkdirSync(reviewsDir, { recursive: true });
  report = join(reviewsDir, "T50-r1.md");
  writeFileSync(report, "# 结论\n");
  deps = { registry: [{ name: "agent-x", runtime: "claude-code" }, { name: "agent-y", runtime: "codex" }], reviewsDir, now: 2_000 };
  dbPath = join(dir, "ledger.sqlite");
  db = openLedger(dbPath);
  setMeta(db, { actor: "owner", now: 1_000 }, { project: P, key: "pms", value: ["agent-pm"] });
  createTask(db, { actor: "owner", now: 1_000 }, { project: P, id: "T50", title: "卡", kind: "code" });
  setTask(db, { actor: "owner", now: 1_000 }, { id: "T50", rev: 1, patch: { agent: "agent-x" } });
  assignStep(db, PM, { taskId: "T50", step: "write", executor: "agent-x", executorKind: "agent" });
  db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T50'");
  deliver(db, { actor: "agent-x", now: 1_200 }, { taskId: "T50", headSHA: H1, moveFrom: "build" });
  assignStep(db, PM, { taskId: "T50", step: "review", executor: "agent-y", executorKind: "agent" });
});
afterEach(() => {
  closeLedger(dbPath);
  rmSync(dir, { recursive: true, force: true });
});

/** 另起一个进程：在 IMMEDIATE 事务里做 body，写好标记文件后再拖 1.5 秒才提交；等标记出现再返回 */
async function holdWriteLock(body: string): Promise<Bun.Subprocess> {
  const script = join(dir, "holder.ts");
  const marker = join(dir, "holding");
  writeFileSync(script, [
    `import { writeFileSync } from "node:fs";`,
    `import { openLedger } from ${JSON.stringify(join(SRC, "ledger-store.ts"))};`,
    `import { assignStep } from ${JSON.stringify(join(SRC, "ledger-steps-write.ts"))};`,
    `import { submitVerdict } from ${JSON.stringify(join(SRC, "review-verdict.ts"))};`,
    `void assignStep; void submitVerdict;`,
    `const db = openLedger(${JSON.stringify(dbPath)});`,
    `db.transaction(() => { ${body}; writeFileSync(${JSON.stringify(marker)}, "1"); Bun.sleepSync(1500); }).immediate();`,
  ].join("\n"));
  const proc = Bun.spawn([process.execPath, script], { env: { ...process.env, CLAUDESTRA_STATE_DIR: dir }, stdout: "pipe", stderr: "pipe" });
  for (let i = 0; i < 400 && !existsSync(marker); i++) await Bun.sleep(25);
  if (!existsSync(marker)) throw new Error(`子进程没拿到写锁：${await new Response(proc.stderr).text()}`);
  return proc;
}

test("PM 换审查员的事务先提交：旧审查员的结论在写锁内重判，拒且不记", async () => {
  const proc = await holdWriteLock(`assignStep(db, { actor: "agent-pm", now: 1_500 }, { taskId: "T50", step: "review", executor: "agent-z", executorKind: "agent" })`);
  const r = submitVerdict(db, me, wire(), deps);
  expect(await proc.exited).toBe(0);
  expect(r).toMatchObject({ ok: false, error: "no_order" });
  expect(reviews()).toEqual([]);
}, 20_000);

test("同一张单的另一个结论先提交：这次回 conflict，不当成同结论重试", async () => {
  const block = wire({ verdict: "block", p0: 1, findings: [{ findingId: "F1", family: "gate", severity: "P0", probe: "复现", description: "说明" }] });
  const proc = await holdWriteLock(`const r = submitVerdict(db, ${JSON.stringify(me)}, ${JSON.stringify(block)}, ${JSON.stringify(deps)}); if (!r.ok) throw new Error(JSON.stringify(r))`);
  const r = submitVerdict(db, me, wire(), deps);
  expect(await proc.exited).toBe(0);
  expect(r).toMatchObject({ ok: false, error: "conflict" });
  expect(reviews().map((e) => e.data.verdict)).toEqual(["block"]);
}, 20_000);
