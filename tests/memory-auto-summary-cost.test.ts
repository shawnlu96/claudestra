/**
 * PMEMTUNE1 验收线 4（成本样本）：总结模型调用保留 usage、算出 costUsd 落到总结写入事件；没有模型调用的写 costUsd: null + no_model_call，
 * 调了但算不出的写 cost_unknown（两者分开）；memory-metrics 的成本口径因此不再是 0 样本。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { ledgerOrigin } from "../src/lib/ledger-origin.js";
import { projectMemories } from "../src/lib/memory-auto-common.js";
import { configuredLesson, lessonCostUsd, prepareSummary, saveSummary } from "../src/lib/memory-auto-summary.js";
import { costLatency, summaryCostSamples } from "../src/lib/memory-metrics.js";

const P = "demo", H = "a".repeat(40);
let db: Database, now: number;
const at = () => ({ actor: "owner", now: ++now });
const add = (kind: "stage" | "review" | "deliver", data: Record<string, unknown>, target: string) =>
  insertEvent(db, at(), { project: P, target, kind, data, text: "" }, false);
function card(id: string, complex: boolean) {
  createTask(db, at(), { id, project: P, kind: "code", title: `Transaction boundaries ${id}` });
  db.query("UPDATE tasks SET stage = 'verified', round = 2, headSHA = ?, extra = ? WHERE id = ?")
    .run(H, JSON.stringify({ fileGlobs: complex ? ["src/lib/x.ts", "src/lib/y.ts", "tests/x.test.ts"] : ["src/lib/x.ts"] }), id);
  if (complex) add("review", { round: 1, p1: 1, findings: [{ severity: "P1", family: "widget-tx", probe: "读 revision 跳号" }] }, id);
  return add("stage", { to: "verified" }, id);
}
const writeEvents = () => listEvents(db, { project: P }).filter((e) => e.kind === "memory");
const usage = { input_tokens: 1000, output_tokens: 100 };
const priced = Object.assign(async () => "Keep writes atomic.", {
  withUsage: async () => ({ text: "Keep writes atomic.", called: true, model: "claude-haiku-4-5", usage }) });

beforeEach(() => { db = openLedger(":memory:"); now = 1000; ledgerOrigin(db, () => "ab12"); setMeta(db, at(), { project: P, key: "pms", value: ["agent-pm"] }); });
afterEach(() => closeLedger(":memory:"));

test("usage → costUsd：Haiku 4.5 按 $1 / $5 每百万 token；认不出的模型或没有 usage = null（不猜）", () => {
  expect(lessonCostUsd({ model: "claude-haiku-4-5-20251001", usage })).toBeCloseTo((1000 * 1 + 100 * 5) / 1e6, 12);
  expect(lessonCostUsd({ model: "claude-haiku-4-5", usage: { ...usage, cache_read_input_tokens: 1000 } })).toBeCloseTo((1000 + 500 + 100) / 1e6, 12);
  expect(lessonCostUsd({ model: "mystery-model", usage })).toBeNull();
  expect(lessonCostUsd({ model: "claude-haiku-4-5" })).toBeNull();
});

test("configuredLesson.withUsage 保留响应里的 usage 与模型；文本口仍只返回文本", async () => {
  const env = { ANTHROPIC_API_KEY: "fixture", ANTHROPIC_BASE_URL: "https://model.example.test" };
  const fake = async () => new Response(JSON.stringify({ model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "Keep writes atomic." }], usage }));
  expect(await configuredLesson.withUsage("facts", env, fake)).toEqual({ text: "Keep writes atomic.", called: true, model: "claude-haiku-4-5-20251001", usage });
  expect(await configuredLesson("facts", env, fake)).toBe("Keep writes atomic.");
  expect(await configuredLesson.withUsage("facts", { ...env, CLAUDE_CODE_USE_BEDROCK: "1" }, fake)).toEqual({ text: null, called: false });
});

test("[验收线 4] 有模型调用：总结写入事件带数值 costUsd；没调模型：costUsd null + no_model_call；调了算不出：cost_unknown", async () => {
  const withCall = card("A", true);
  saveSummary(db, withCall, (await prepareSummary(db, withCall, { lesson: priced }))!);
  const simple = card("B", false);
  saveSummary(db, simple, (await prepareSummary(db, simple, { lesson: priced }))!);
  const plain = card("C", true);
  saveSummary(db, plain, (await prepareSummary(db, plain, { lesson: async () => "Keep writes atomic." }))!);
  const noPort = card("D", true);
  saveSummary(db, noPort, (await prepareSummary(db, noPort, {}))!);

  const byTask = new Map(writeEvents().map((e) => [e.target, e.data]));
  expect(byTask.get("A")).toMatchObject({ kind: "summary", costUsd: (1000 + 500) / 1e6 });
  expect(byTask.get("A")!.costReason).toBeUndefined();
  expect(byTask.get("B")).toMatchObject({ costUsd: null, costReason: "no_model_call", costDetail: "simple_card" });
  expect(byTask.get("C")).toMatchObject({ costUsd: null, costReason: "cost_unknown" });
  expect(byTask.get("D")).toMatchObject({ costUsd: null, costReason: "no_model_call", costDetail: "no_lesson_port" });

  const input = { events: listEvents(db, { project: P }), tasks: [], since: 0, until: Number.MAX_SAFE_INTEGER,
    memories: projectMemories(db, P).map((m) => ({ id: m.id, kind: m.kind, family: m.family, files: m.files, createdAt: m.createdAt })) };
  expect(costLatency(input)).toMatchObject({ summaryCards: 1, summaryUsdPerCard: (1000 + 500) / 1e6 });
  expect(summaryCostSamples(input)).toEqual({ priced: 1, noModelCall: 2, costUnknown: 1, unmarked: 0 });
});

test("模型调用失败（请求抛错）：调过 = cost_unknown，不当成没调", async () => {
  const e = card("A", true);
  const failing = Object.assign(async () => null, { withUsage: async () => { throw new Error("offline"); } });
  const m = await prepareSummary(db, e, { lesson: failing });
  expect(m!.cost).toEqual({ costUsd: null, reason: "cost_unknown", detail: "usage_missing" });
});
