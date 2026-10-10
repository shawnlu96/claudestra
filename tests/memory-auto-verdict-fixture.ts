/**
 * memory-auto-verdict 的每条用例自带一套私有资源：临时根目录下的文件台账（ledger-store 按路径缓存连接，
 * 共用 ":memory:" 键就会接手别的用例/文件没关的连接）、显式目录里新生成的实例钥匙（不碰默认 STATE_DIR 的那把）、
 * 审查报告目录。dispose 关连接、删目录，错误汇总抛出；setup 半路失败也先收拾干净再把原错误抛出，清理再失败就把两者一起抛（原错误在前）。
 */
import { expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { ledgerOrigin } from "../src/lib/ledger-origin.js";
import { createTask, deliver, setMeta } from "../src/lib/ledger-write.js";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { submitVerdict } from "../src/lib/review-verdict.js";
import { runLedger } from "../src/manager/ledger.js";
import { observeMemory } from "../src/lib/memory-auto.js";
import { projectMemories } from "../src/lib/memory-auto-common.js";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { InstanceKey } from "../src/lib/instance-signature.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";

export const P = "demo";
const H = "a".repeat(40), NOW = 1_000_000;
const f = { findingId: "tx", family: "widget-tx", severity: "P1", probe: "读 revision 跳号，写入未包含事务", description: "[验收线 1] 事务边界" };

export type VerdictFixture = Awaited<ReturnType<typeof verdictFixture>>;

/** seed 只给清理探针用：模拟 setup 在资源已建好之后失败 */
export function verdictFixture(opts: { seed?: (db: Database, root: string) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), "memory-verdict-"));
  const ledgerPath = join(root, "ledger.sqlite");
  let opened = false, disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    const errors: unknown[] = [];
    if (opened) try { closeLedger(ledgerPath); } catch (e) { errors.push(e); }
    try { rmSync(root, { recursive: true, force: true }); } catch (e) { errors.push(e); }
    if (errors.length) throw new AggregateError(errors, "memory-auto-verdict fixture cleanup failed");
  };
  try {
    const dir = join(root, "work"), reviews = join(dir, "reviews"), identity = join(root, "identity");
    mkdirSync(reviews, { recursive: true }); mkdirSync(identity);
    const report = join(reviews, "A.md"); writeFileSync(report, "## tx [验收线 1]\nTransaction boundary evidence\n");
    const key = instanceKeySync(identity);
    if (!key) throw new Error(`fixture instance key not generated in ${identity}`);
    const db = openLedger(ledgerPath); opened = true;
    ledgerOrigin(db, () => "ab12");
    setMeta(db, { actor: "owner" }, { project: P, key: "pms", value: ["agent-pm"] });
    createTask(db, { actor: "owner" }, { project: P, id: "A", title: "Atomic revision writes", kind: "code", spec: report,
      extra: { fileGlobs: ["src/lib/widget-store.ts"] } });
    assignStep(db, { actor: "owner" }, { taskId: "A", step: "write", executor: "agent-x", executorKind: "agent" });
    db.query("UPDATE tasks SET stage = 'build' WHERE id = 'A'").run();
    deliver(db, { actor: "owner", now: NOW - 1 }, { taskId: "A", headSHA: H, moveFrom: "build" });
    assignStep(db, { actor: "owner" }, { taskId: "A", step: "review", executor: "agent-y", executorKind: "agent" });
    opts.seed?.(db, root);
    return { root, dir, report, ledgerPath, db, key, dispose, ...chain(db, dir, report, key) };
  } catch (setupError) {
    // 清理也失败时两个都要：原 setup 错误在前，cleanup 的 AggregateError 在后，谁也不盖住谁
    try { dispose(); } catch (cleanupError) {
      throw new AggregateError([setupError, cleanupError], "memory-auto-verdict fixture setup failed and cleanup failed", { cause: setupError });
    }
    throw setupError;
  }
}

function chain(db: Database, dir: string, report: string, key: InstanceKey) {
  const wire = (orderId: string, pitfall?: unknown) => ({ v: 1, orderId, head: H, verdict: "changes", p0: 0, p1: 1, p2: 0,
    findings: [{ ...f, ...(pitfall !== undefined ? { pitfall } : {}) }], reportPath: report });
  const run = () => observeMemory(db, "scheduler", P, { assertLease: () => {} });
  const pitfalls = () => projectMemories(db, P).filter((m) => m.kind === "pitfall");
  const local = (pitfall?: unknown) => submitVerdict(db,
    { agent: "agent-y", sessionId: "sess-y", family: "codex", verified: true }, wire("A:review:r1", pitfall),
    { reviewsDir: join(dir, "reviews"), registry: [{ name: "agent-x", runtime: "claude-code" }], now: NOW });
  async function peerOrder() {
    const deps = { db, actor: "agent-pm", projectIds: [P], now: () => NOW,
      loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {},
      lend: { borrow: async () => [{ peer: "mate", projects: [P], roles: ["review" as const], maxOpen: 1 }],
        notifyPm: async () => {}, result: { reportDir: () => join(dir, "reviews"), writeReport: (p: string, body: string) => writeFileSync(p, body),
          sign: (fields: string[]) => signPurpose(RECEIPT_PURPOSE, fields, key) } } };
    const offered = await runLedger(["lend-offer", "A", "--peer", "mate", "--repo", "demo/widget", "--pr", "12"], deps);
    expect(offered.ok).toBe(true); const orderId = offered.orderId as string;
    const call = (ep: string, body: unknown) => runLedger([`lend-${ep}`, "--", "mate", JSON.stringify(body)], { ...deps, actor: "owner" });
    expect((await call("claim", { v: 1, orderId, worker: "w1" })).ok).toBe(true);
    const result = (pitfall?: unknown) => ({ v: 1, orderId, gen: 1, verdict: wire(orderId, pitfall),
      report: "## tx [验收线 1]\nUse one transaction for revision and writes", session: { id: "peer-session", family: "codex" } });
    return { call, result };
  }
  return { wire, run, pitfalls, local, peerOrder };
}
