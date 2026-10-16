/**
 * ASKSCOPE3 PM 定 3：经测试类扩围（reason = superseded_assertion）自动批进来的测试文件，交付登记时按 blob 核尺寸——增删合计 > 40 行，
 * 或整段删掉的 describe / test / it 块多于 1 个，卡上的 deliver_scope note 记「规格外尺寸超限，审查员判」、审查单「已自动核准」小节标红；
 * 40 行、删 1 个块不记。不拒交付。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removedTestBlocks } from "../src/lib/ask-scope-auto-diff.js";
import { describeDeliveredScope, TEST_SCOPE_HEADER } from "../src/lib/ask-scope-auto-display.js";
import { answerAsk, openAskFull, patchAsk } from "../src/lib/ledger-asks.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta, setTask } from "../src/lib/ledger-write.js";
import { checkTestScopeSize, judgeTestScopeSize } from "../src/lib/order-ask-test-scope-size.js";
import { ensureDeliverScope, scopeInputs } from "../src/lib/order-deliver-scope.js";
import type { ScopeDiff } from "../src/lib/order-deliver-scope-git.js";
import type { RecoveryPolicyPort } from "../src/lib/recovery-policy.js";

const HEAD = "b".repeat(40);
const policy: RecoveryPolicyPort = () => ({ mode: "off", manualAfterMs: null, source: "config" });
let db: Database, dir: string, dbPath: string;

const block = (name: string) => [`test("${name}", () => {`, `  expect(f("${name}")).toBe(1);`, "});"];
const file = (names: string[], extra = 0) => ["import { test, expect } from \"bun:test\";", ...names.flatMap(block),
  ...Array.from({ length: extra }, (_, i) => `const pad${i} = ${i};`)].join("\n") + "\n";
const BASE = file(["a", "b", "c", "d"]);

function diffOf(head: string, added: number, deleted: number, path = "tests/a.test.ts"): ScopeDiff {
  const blobs: Record<string, string> = { [`mb:${path}`]: BASE, [`${HEAD}:${path}`]: head };
  return { base: "main", filesComplete: true, files: [{ path, added, deleted }, { path: "src/lib/x.ts", added: 1, deleted: 0 }],
    objects: { show: async (c, p) => { const t = blobs[`${c}:${p}`]; if (t === undefined) throw new Error("missing"); return t; },
      list: async () => [], mergeBase: async () => "mb", prHead: async () => HEAD } };
}

function approve(files: string[], reason = "superseded_assertion", autoScope = true): string {
  const { ask } = openAskFull(db, { project: "p", taskId: "T1", fromAgent: "worker@peer", source: "reply", kind: "decide", title: "t", body: "q",
    assignee: "agent-pm", dedupKey: `k:${files.join(",")}:${reason}`, extra: { via: "mcp_ask", orderId: "pool", files, reason } }, 1);
  answerAsk(db, ask.id, { choices: [], labels: [], text: "ok", principal: "system:ask-default", via: "terminal", at: 2, final: true });
  if (autoScope) patchAsk(db, ask.id, { extra: { autoScope: true } });
  return ask.id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ask-scope-size-")); dbPath = join(dir, "ledger.db"); db = openLedger(dbPath);
  setMeta(db, { actor: "owner" }, { project: "p", key: "pms", value: ["agent-pm"] });
  createTask(db, { actor: "owner" }, { id: "T1", project: "p", title: "扩围", kind: "code", agent: "agent-author", pm: "agent-pm" });
  setTask(db, { actor: "owner" }, { id: "T1", rev: getTask(db, "T1")!.rev, patch: { extra: { fileGlobs: ["src/lib/x*.ts", "tests/a.test.ts"] } } });
});
afterEach(() => { closeLedger(dbPath); rmSync(dir, { recursive: true, force: true }); });

describe("尺寸判定", () => {
  test("[验收线 3] 41 行超限、40 行不超；删 2 个块超限、删 1 个不超", () => {
    expect(judgeTestScopeSize(20, 20, 0)).toBeNull();
    expect(judgeTestScopeSize(21, 20, 0)).toContain("41 行");
    expect(judgeTestScopeSize(1, 3, 1)).toBeNull();
    expect(judgeTestScopeSize(0, 6, 2)).toContain("2 个");
    expect(judgeTestScopeSize(null, null, 0)).not.toBeNull();
    expect(judgeTestScopeSize(1, 1, null)).not.toBeNull(); // 核不了按超限
  });

  test("removedTestBlocks：只数可执行行上的开头；改期望不算删块，注释 / 字符串里的不算", () => {
    expect(removedTestBlocks(BASE, BASE.replace('toBe(1);', 'toBe(2);'))).toBe(0);
    expect(removedTestBlocks(BASE, file(["a", "b", "c"]))).toBe(1);
    expect(removedTestBlocks(BASE, file(["a", "b"]))).toBe(2);
    expect(removedTestBlocks(`${BASE}// test("x", () => {});\nconst s = "it(1)";\n`, BASE)).toBe(0);
    expect(removedTestBlocks('describe("g", () => {\n  it.each([1])("x %d", () => {});\n});\n', "")).toBe(2);
  });
});

describe("交付登记", () => {
  test("[验收线 3] 改动 41 行：卡上 deliver_scope note 记超限，审查单「已自动核准」小节标红；不拒交付", async () => {
    const askId = approve(["tests/a.test.ts"]);
    await ensureDeliverScope(db, getTask(db, "T1")!, HEAD, async () => diffOf(file(["a", "b", "c", "d"], 37), 37, 4), 10, policy);
    const ev = listEvents(db, { target: "T1" }).find((e) => e.data.op === "deliver_scope")!;
    expect(ev.kind).toBe("note");
    expect(ev.data.askScopeTests).toMatchObject({ files: [{ path: "tests/a.test.ts", askId, added: 37, deleted: 4, over: true }] });
    expect(ev.text).toContain(TEST_SCOPE_HEADER);
    expect(ev.text).toContain("🔴 \"tests/a.test.ts\"：+37 / -4（41 行）");
    expect(ev.text).toContain("规格外尺寸超限，审查员判");
    const review = scopeInputs(db, getTask(db, "T1")!, HEAD, policy).join("\n");
    expect(review.split("\n").filter((l) => l === TEST_SCOPE_HEADER)).toHaveLength(1); // 出单时重写不重复
    expect(review.split("\n").filter((l) => l.startsWith("🔴 "))).toHaveLength(1);
  });

  test("[验收线 3] 删掉 2 个 test 块：超限；删 1 个、40 行以内：不记", async () => {
    approve(["tests/a.test.ts"]);
    const two = await checkTestScopeSize(db, getTask(db, "T1")!, HEAD, diffOf(file(["a", "b"]), 0, 6));
    expect(two.askScopeTests!.files[0]).toMatchObject({ removedBlocks: 2, over: true });
    const one = await checkTestScopeSize(db, getTask(db, "T1")!, HEAD, diffOf(file(["a", "b", "c"], 37), 37, 3));
    expect(one.askScopeTests!.files[0]).toMatchObject({ removedBlocks: 1, over: false, reason: null });
    expect(describeDeliveredScope("规格外文件：无（相对 PR base）", one)).toBe("规格外文件：无（相对 PR base）");
  });

  test("不在这条里的不核：new_test、PM 自己答的（没有 autoScope）、交付没改这个文件", async () => {
    approve(["tests/a.test.ts"], "new_test");
    approve(["tests/a.test.ts"], "superseded_assertion", false);
    expect(await checkTestScopeSize(db, getTask(db, "T1")!, HEAD, diffOf(file(["a"]), 0, 9))).toEqual({});
    approve(["tests/b.test.ts"]);
    expect(await checkTestScopeSize(db, getTask(db, "T1")!, HEAD, diffOf(file(["a"]), 0, 9))).toEqual({});
  });

  test("核不了（没有 Git 对象）：按超限标红，交审查员自己核", async () => {
    approve(["tests/a.test.ts"]);
    const r = await checkTestScopeSize(db, getTask(db, "T1")!, HEAD, { ...diffOf(BASE, 1, 1), objects: undefined });
    expect(r.askScopeTests!.files[0]).toMatchObject({ removedBlocks: null, over: true, reason: "未能按 blob 核删块" });
  });
});
