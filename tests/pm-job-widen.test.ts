/**
 * agents-PMJOB2 验收线 1–4：放宽白名单（规格快照、去掉「像查证」硬门、候选项只过硬门、新增 specDecided）的回放夹具。
 * 提问改写自真实单子的问法（情况说明 + 请定），不带个人信息。先红：改前 specDecided 不在白名单、软门一律升级、
 * 接单后追加 PM 补就「规格在提问之后改过」、observe 草稿提示单独叫醒 PM。
 */
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pmJob } from "../src/bridge/pm-job.js";
import { getAsk } from "../src/lib/ledger-asks.js";
import { askNoticeText } from "../src/lib/order-ask.js";
import { gatesOf, judgePmJobOutput, type JudgeCtx } from "../src/lib/pm-job-rules.js";
import { A, ASKER, goodAnswer, jobWorld, ORDER, P, type JobWorld } from "./pm-job-world.test.js";

let w: JobWorld | undefined;
afterEach(() => { w?.close(); w = undefined; });
const ok = (message: string) => ({ ok: true, message, sessionId: null, elapsedMs: 5 });
const original = (askId: string, question: string) => askNoticeText({ taskId: "T1", orderId: ORDER, from: ASKER, askId, question, options: [], class: "blocker" });

/** 带 PM 补的规格：第 10 行是 PM 补的原话（含「已批准」） */
const SPEC2 = ["# T1 · 合成规格", "", "## 验收线", "1. 新文件不超过 800 行", "2. 只改 src/lib/thing.ts", "", "## 范围", "- src/lib/thing.ts", "",
  "PM 补：thing.ts 的注释顺手改，已批准，不算改范围"].join("\n");
const SPEC_LINES = SPEC2.split("\n");
const ctxOf = (question: string, options: string[] = []): JudgeCtx => {
  const gates = gatesOf(question, options);
  return { forbidden: gates.all[0] ?? null, gates, specPath: "spec.md", specLine: (n) => SPEC_LINES[n - 1] ?? null,
    lines: (f) => (f === "spec.md" ? SPEC_LINES.length : f === "src/a.ts" ? 3 : null) };
};
const decided = (over: Record<string, unknown> = {}) => JSON.stringify({ type: "specDecided", answer: "规格的 PM 补已写明这件事。", confident: true,
  evidence: [{ file: "spec.md", line: 10 }], reason: "", pending: [], ...over });
const ASKED_DECIDED = "规格的 PM 补 是否允许顺手改 thing.ts 的注释？现在注释和实现对不上，请定。";

// [验收线 1]
test("a: a question the spec's PM addendum already decides is answered as specDecided, opening with the spec lines the code quotes", async () => {
  expect(gatesOf(ASKED_DECIDED)).toEqual({ all: ["请求批准 / 决策"], hard: false });
  w = await jobWorld("on");
  writeFileSync(w.specPath, SPEC2);
  const { askId } = await w.ask(ASKED_DECIDED);
  expect(w.store.get(askId)).toMatchObject({ direct: true, hard: false, forbiddenAll: ["请求批准 / 决策"] });
  expect(await w.work(() => ok(decided({ evidence: [{ file: w!.specPath, line: 10 }] })))).toBe(1);
  await pmJob.sweep();
  expect(w.pm).toEqual([]);
  expect(w.store.get(askId)).toMatchObject({ state: "sent", result: { verdict: "answer", type: "specDecided" } });
  const answer = w.store.get(askId)!.result!.answer;
  expect(answer.split("\n")).toEqual([`规格第 10 行：『${SPEC_LINES[9]}』`, "规格的 PM 补已写明这件事。"]);
  expect(w.asker).toHaveLength(1);
  expect(w.asker[0]!.content).toContain(`规格第 10 行：『${SPEC_LINES[9]}』`);
  expect(getAsk(w.f.db, askId)).toMatchObject({ state: "answered", answer: { principal: "system:pm-job" } });
});

// [验收线 1]
test("b: an acceptance quote that mentions 授权 hits the permission hard gate and escalates even as specDecided", () => {
  const q = "验收线 3 原文写『授权由 PM 处理』，这条是不是说我不用管？请定。";
  expect(gatesOf(q).hard).toBe(true);
  expect(judgePmJobOutput(decided(), ctxOf(q))).toMatchObject({ verdict: "escalate", reason: expect.stringContaining("权限") });
});

// [验收线 1]
test("c: specDecided with any evidence outside the spec file escalates", () => {
  const out = judgePmJobOutput(decided({ evidence: [{ file: "spec.md", line: 10 }, { file: "src/a.ts", line: 1 }] }), ctxOf(ASKED_DECIDED));
  expect(out).toMatchObject({ verdict: "escalate", reason: expect.stringContaining("只能是规格文件的行：src/a.ts:1") });
});

// [验收线 1]
test("d: approval wording in the model's own sentence escalates; the same words only inside the quoted spec line do not", () => {
  expect(judgePmJobOutput(decided({ answer: "已批准，你可以改。" }), ctxOf(ASKED_DECIDED))).toMatchObject({ verdict: "escalate", reason: expect.stringContaining("批准口吻") });
  const out = judgePmJobOutput(decided(), ctxOf(ASKED_DECIDED));
  expect(out).toMatchObject({ verdict: "answer", type: "specDecided" });
  expect(out.answer.startsWith("规格第 10 行：『PM 补：thing.ts 的注释顺手改，已批准")).toBe(true);
});

// [验收线 1]
test("e: options only pass the hard gates: 批准 / 不批准 does not block a lookup, 删掉台账记录 does", () => {
  const q = "验收线 1 的行数上限是多少？";
  expect(gatesOf(q, ["批准", "不批准"])).toEqual({ all: [], hard: false });
  expect(gatesOf(q, ["扩围到 src/lib/outside.ts", "可以吗"])).toEqual({ all: [], hard: false });
  expect(judgePmJobOutput(goodAnswer({ specPath: "spec.md" }, { evidence: [{ file: "spec.md", line: 4 }] }), ctxOf(q, ["批准", "不批准"]))).toMatchObject({ verdict: "answer" });
  expect(gatesOf(q, ["删掉台账记录", "保留"])).toEqual({ all: ["删数据"], hard: true });
  expect(judgePmJobOutput(decided(), ctxOf(q, ["删掉台账记录"]))).toMatchObject({ verdict: "escalate", reason: expect.stringContaining("删数据") });
});

const HARD: [string, string][] = [
  ["权限", "规格里说给 worker 开写台账的权限，请定。"], ["删数据", "我顺手删除了旧的状态文件数据，请定。"], ["release", "合并后这版跟着 release，请定。"],
  ["tag", "这次合并后要打 tag，请定。"], ["中心限流", "中心限流的阈值规格里写的是 5，请定。"], ["schema", "asks 表需要加一列，迁移脚本放哪，请定。"],
  ["改额度线", "额度线规格写 70，我按 90 跑，请定。"], ["owner 决策", "这条规格写着要 owner 拍板，请定。"], ["凭据 / 安全", "规格要的 token 放在哪个文件，请定。"],
];

// [验收线 1]
test("f: each of the nine hard gates escalates whatever type and confidence the model claims", () => {
  for (const [label, q] of HARD) {
    const ctx = ctxOf(q);
    expect([q, ctx.gates]).toEqual([q, { all: expect.arrayContaining([label]), hard: true }]);
    for (const type of ["specDecided", "acceptance", "standard", "location"]) {
      const out = judgePmJobOutput(decided({ type, evidence: [{ file: "spec.md", line: 4 }] }), ctx);
      expect([q, type, out.verdict, out.reason.includes(label)]).toEqual([q, type, "escalate", true]);
    }
  }
});

// [验收线 1]
test("g: a lookup that hits no gate answers as location with valid file:line, as before", () => {
  const q = "src/lib/thing.ts 里 b 在哪一行？";
  expect(gatesOf(q)).toEqual({ all: [], hard: false });
  const out = judgePmJobOutput(JSON.stringify({ type: "location", answer: "b 在 src/a.ts 第 2 行。", confident: true, evidence: [{ file: "src/a.ts", line: 2 }] }), ctxOf(q));
  expect(out).toEqual({ verdict: "answer", type: "location", answer: "b 在 src/a.ts 第 2 行。", evidence: [{ file: "src/a.ts", line: 2 }], reason: "", pending: [] });
  // 没有 gates 的旧单子：forbidden 一律按硬门算（包括已经不存在的「不像查证」门）
  expect(judgePmJobOutput(decided(), { forbidden: "不像白名单内的查证问题", lines: () => 20 })).toMatchObject({ verdict: "escalate", reason: "问题属于必须由 PM 处理的类别：不像白名单内的查证问题" });
});

const PM_ADDENDUM = "\n\n## PM 补 · 答问时追加\n- 验收线 1 的 800 行不含测试。\n";

// [验收线 2]
test("a spec addendum after intake: the worker runs on the snapshot; a job without a snapshot still escalates as before; on still rechecks before sending", async () => {
  w = await jobWorld(null);
  const { askId } = await w.ask("验收线 1 的行数上限是多少？");
  expect(w.store.get(askId)!.spec).toBe(readFileSync(w.specPath, "utf8"));
  // 旧单子：手动去掉快照字段
  const old = await w.ask("验收线 2 只改哪个文件？"), file = w.store.path(old.askId);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  delete raw.spec;
  writeFileSync(file, JSON.stringify(raw));
  appendFileSync(w.specPath, PM_ADDENDUM);
  expect(await w.work()).toBe(2);
  expect(w.store.get(askId)!.result).toMatchObject({ verdict: "answer", reason: "" });
  expect(w.runs[0]!.prompt).not.toContain("不含测试"); // 用的是接单时的快照
  expect(w.store.get(old.askId)!.result).toMatchObject({ verdict: "escalate", reason: "规格在提问之后改过" });
  expect(w.runs).toHaveLength(1);
  w.close();

  w = await jobWorld("on");
  const q = "验收线 1 的行数上限是多少？", on = await w.ask(q);
  expect(await w.work()).toBe(1);
  expect(w.store.get(on.askId)).toMatchObject({ state: "drafted", result: { verdict: "answer" } });
  appendFileSync(w.specPath, PM_ADDENDUM);
  await pmJob.sweep();
  expect(w.asker).toEqual([]);
  expect(w.store.get(on.askId)).toMatchObject({ state: "escalated", note: "规格在提问之后改过" });
  expect(w.pm[0]!.content.startsWith(original(on.askId, q))).toBe(true);
});

// [验收线 3]
test("direct: on with only soft gates is a candidate, any hard gate is not; observe is never direct", async () => {
  w = await jobWorld("on");
  const soft = await w.ask("需要扩围 src/lib/outside.ts 一行，规格的 PM 补 写了吗？"), hard = await w.ask("能给我开写台账的权限吗？"), none = await w.ask("帮我看看这个");
  expect(w.store.get(soft.askId)).toMatchObject({ direct: true, hard: false, forbidden: "改范围" });
  expect(w.store.get(hard.askId)).toMatchObject({ direct: false, hard: true, forbidden: "权限" });
  expect(w.store.get(none.askId)).toMatchObject({ direct: true, hard: false, forbidden: null, forbiddenAll: [] });
  w.close();
  w = await jobWorld("observe");
  for (const q of ["需要扩围 src/lib/outside.ts 一行，规格的 PM 补 写了吗？", "能给我开写台账的权限吗？", "帮我看看这个"]) {
    const { askId } = await w.ask(q);
    expect(w.store.get(askId)).toMatchObject({ direct: false, mode: "observe" });
  }
});

// [验收线 4]
test("observe: the finished draft goes to the digest queue, not through notify; the original carries the 完成后进摘要 line", async () => {
  w = await jobWorld("observe");
  writeFileSync(w.specPath, SPEC2);
  const { askId } = await w.ask(ASKED_DECIDED), draft = w.store.draftPath(askId);
  expect(w.pm).toEqual([{ to: A, id: `ledger-ask:${askId}`, content: `${original(askId, ASKED_DECIDED)}\n处理员草稿（请求批准 / 决策，需你处理；草稿待生成，完成后进摘要）：${draft}` }]);
  expect(await w.work(() => ok(decided({ evidence: [{ file: w!.specPath, line: 10 }] })))).toBe(1);
  await pmJob.sweep();
  await pmJob.sweep();
  expect(w.pm).toHaveLength(1);
  expect(w.asker).toEqual([]);
  const queued = w.digest.queued(P);
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({ id: `pm-job-draft:${askId}`, source: "pm-job", card: "T1", kind: "sync" });
  for (const part of [`ask ${askId}`, "规格已定", draft]) expect(queued[0]!.firstLine).toContain(part);
  expect(w.store.get(askId)).toMatchObject({ state: "observed", pmNotice: "handed", result: { verdict: "answer", type: "specDecided" } });
  expect(getAsk(w.f.db, askId)?.state).toBe("open");
});
