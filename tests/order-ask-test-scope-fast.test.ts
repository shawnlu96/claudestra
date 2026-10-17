/**
 * ASKSCOPE3 快路（恢复键 askScopeTests）：被规格替代的旧断言的测试类扩围，on 时不通知 PM、下一次扫描就批准并追加 fileGlobs、tell 执行者，
 * 卡上记 op ask_scope_tests；observe 照旧通知、15 分钟，另记 recovery_observe；off 照旧。文件名含权限类字样、带 extra.held / risk、
 * reason = new_test、文件在 base 不存在一律不走快路（ASK4 原路照旧）。自动定原文按 PM 定 4。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAsk, openAskFull, patchAsk, type Ask } from "../src/lib/ledger-asks.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createTask, setMeta, setTask } from "../src/lib/ledger-write.js";
import { openOrderAsk, type AskDeps } from "../src/lib/order-ask.js";
import { ASK_DEFAULT_MS, sweepAskDefaults } from "../src/lib/order-ask-default.js";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";

let db: Database, dir: string, dbPath: string, spec: string;
let told: { id: string; text: string }[], notified: string[], mode: RecoveryMode, inBase: Set<string>;
const now = 1_000_000;
const original = "# 原规格\n";
const policy: RecoveryPolicyPort = (_p, key) => ({ mode: key === "askScopeTests" ? mode : "off", manualAfterMs: null, source: "config" });
const deps = (): Omit<AskDeps, "db"> => ({ open: (x) => openAskFull(db, x, now),
  notify: async (_to, _text, id) => (notified.push(id), { handed: true, note: "queued" }),
  markHanded: (id) => patchAsk(db, id, { extra: { notice: "handed", handedAt: now } }, now), record: (ctx, x) => void appendEvent(db, ctx, x),
  policy, baseHas: async (_db, _task, files) => files.every((f) => inBase.has(f)) });
const tell = async (a: Ask, text: string) => (told.push({ id: a.id, text }), true);
const globs = () => getTask(db, "T1")!.extra.fileGlobs;
const ops = (op: string) => listEvents(db, { project: "p" }).filter((e) => e.data.op === op);

async function ask(q: Record<string, unknown> = {}) {
  const r = await openOrderAsk(db, deps(), { task: getTask(db, "T1")!, orderId: "pool", from: "worker@peer", keyPrefix: "lend-ask:g1" },
    { question: "tests/a.test.ts 第 3 条断言被本规格替代", options: [], files: ["tests/a.test.ts"], reason: "superseded_assertion", ...q } as never);
  if (!("askId" in r)) throw new Error(JSON.stringify(r));
  return { r, a: getAsk(db, r.askId)! };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ask-scope-fast-")); dbPath = join(dir, "ledger.db"); spec = join(dir, "T1.md");
  writeFileSync(spec, original); db = openLedger(dbPath); told = []; notified = []; mode = "on";
  inBase = new Set(["tests/a.test.ts", "tests/b.test.ts", "tests/peer-auth.test.ts", "tests/merge-gate.test.ts"]);
  setMeta(db, { actor: "owner" }, { project: "p", key: "pms", value: ["agent-pm"] });
  createTask(db, { actor: "owner" }, { id: "T1", project: "p", title: "扩围", kind: "code", agent: "agent-author", pm: "agent-pm", spec });
  setTask(db, { actor: "owner" }, { id: "T1", rev: getTask(db, "T1")!.rev, patch: { extra: { fileGlobs: ["src/lib/x*.ts"] } } });
  db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T1'");
  db.run("DROP TABLE IF EXISTS lend_orders");
  db.run("CREATE TABLE lend_orders (orderId TEXT PRIMARY KEY, step TEXT)");
  db.run("INSERT INTO lend_orders (orderId, step) VALUES ('pool', 'write')");
});
afterEach(() => { closeLedger(dbPath); rmSync(dir, { recursive: true, force: true }); });

describe("askScopeTests 快路", () => {
  test("[验收线 1] on：不通知 PM，下一次扫描就批准、追加 fileGlobs、tell 执行者，卡上记 ask_scope_tests；规格追加新的自动定原文", async () => {
    const { r, a } = await ask();
    expect(notified).toEqual([]);
    expect(r).toMatchObject({ notified: false });
    expect(a.extra).toMatchObject({ notice: "skipped", testScopeFast: true });
    expect(await sweepAskDefaults(db, now + 60_000, { tell, notify: deps().notify })).toBe(1);
    expect(notified).toEqual([]); // 扫描也不补投 PM
    expect(getAsk(db, a.id)).toMatchObject({ state: "answered", extra: { autoScope: true, tell: "told" } });
    expect(globs()).toEqual(["src/lib/x*.ts", "tests/a.test.ts"]);
    expect(told).toHaveLength(1);
    expect(told[0].text).toContain("按快路（askScopeTests）");
    expect(told[0].text).not.toContain("15 分钟");
    expect(ops("ask_scope_tests")).toHaveLength(1);
    expect(ops("ask_scope_tests")[0].data).toMatchObject({ askId: a.id, files: ["tests/a.test.ts"] });
    const text = readFileSync(spec, "utf8");
    expect(text).toContain("被规格替代的旧断言：允许最小改动，优先改夹具让旧测试继续保护原意图；交付说明逐条列出改了哪些断言、对应规格哪一条；审查员核");
    // 同一问题重试：还是那一条，不通知
    const again = await ask();
    expect(again.r).toMatchObject({ askId: a.id, duplicate: true });
    expect(notified).toEqual([]);
  });

  test("[验收线 1] observe：照旧通知 PM、15 分钟才批，另记 recovery_observe（askId、文件、本会走快路）", async () => {
    mode = "observe";
    const { a } = await ask();
    expect(notified).toEqual([`ledger-ask:${a.id}`]);
    expect(getAsk(db, a.id)!.extra.testScopeFast).toBeUndefined();
    const obs = ops("recovery_observe").filter((e) => e.data.mechanism === "askScopeTests");
    expect(obs).toHaveLength(1);
    expect(obs[0].data).toMatchObject({ askId: a.id, files: ["tests/a.test.ts"], would: "fast" });
    await sweepAskDefaults(db, now + 60_000, { tell });
    expect(getAsk(db, a.id)!.state).toBe("open");
    await sweepAskDefaults(db, now + ASK_DEFAULT_MS, { tell });
    expect(getAsk(db, a.id)!.state).toBe("answered");
    expect(told[0].text).toContain("PM 15 分钟没回");
    expect(ops("ask_scope_tests")).toEqual([]);
  });

  test("off：和改前一样，不判也不记观察", async () => {
    mode = "off";
    const { a } = await ask();
    expect(notified).toEqual([`ledger-ask:${a.id}`]);
    expect(ops("recovery_observe")).toEqual([]);
    await sweepAskDefaults(db, now + 60_000, { tell });
    expect(getAsk(db, a.id)!.state).toBe("open");
  });

  test("[验收线 2] 文件名含 auth / gate、reason = new_test、文件在 base 不存在、带 risk、带 extra.held：一律不走快路（ASK4 原路照旧）", async () => {
    const cases = [
      { question: "q-auth", files: ["tests/peer-auth.test.ts"] },
      { question: "q-gate", files: ["tests/a.test.ts", "tests/merge-gate.test.ts"] },
      { question: "q-new", reason: "new_test" },
      { question: "q-missing", files: ["tests/new.test.ts"] },
      { question: "q-risk", risk: "permission" },
    ];
    const opened = [];
    for (const c of cases) opened.push((await ask(c)).a);
    for (const a of opened) {
      expect(a.extra.testScopeFast).toBeUndefined();
      expect(notified).toContain(`ledger-ask:${a.id}`);
    }
    await sweepAskDefaults(db, now + 60_000, { tell });
    for (const a of opened) expect(getAsk(db, a.id)!.state).toBe("open");
    // ASK4 原路：15 分钟后照旧批（risk 那条按原规则同样批，held 才永远等 PM）
    await sweepAskDefaults(db, now + ASK_DEFAULT_MS, { tell });
    expect(getAsk(db, opened[2].id)!.state).toBe("answered");
    expect(ops("ask_scope_tests")).toEqual([]);
  });

  test("[验收线 2] extra.held（risk / security 模板）：快路不判，扫描也永远不批", async () => {
    writeFileSync(spec, "# T1 卡\n模板：security\n\n## 范围\n");
    const { a } = await ask();
    expect(a.extra.testScopeFast).toBeUndefined();
    expect(notified).toEqual([`ledger-ask:${a.id}`]);
    patchAsk(db, a.id, { extra: { held: "卡是 security 模板", testScopeFast: true } }); // 就算标了快路，held 也挡住
    await sweepAskDefaults(db, now + ASK_DEFAULT_MS * 2, { tell });
    expect(getAsk(db, a.id)!.state).toBe("open");
    expect(globs()).toEqual(["src/lib/x*.ts"]);
  });

  test("new_test 的自动定原文不带旧断言那段", async () => {
    mode = "off";
    const { a } = await ask({ reason: "new_test" });
    await sweepAskDefaults(db, now + ASK_DEFAULT_MS, { tell });
    expect(getAsk(db, a.id)!.state).toBe("answered");
    const text = readFileSync(spec, "utf8");
    expect(text).toContain("为本卡新行为补测试");
    expect(text).not.toContain("允许最小改动");
  });
});
