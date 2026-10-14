/**
 * agents-PMJOB1 验收线 1–3：on 直回（PM 零叫醒）、必须升级的各类不直回、off 逐字旧路 / observe 两阶段草稿 / 非 PM 与人类不接单。
 * 真实台账 + 真实 PM 投递口；模型是可控桩。先红：没有 intake 接线时，第一条测试里 PM 会收到原通知（见最后一条 off 测试的旧路形状）。
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { pmJob } from "../src/bridge/pm-job.js";
import { getAsk } from "../src/lib/ledger-asks.js";
import { ASK_DEFAULT_MS, sweepAskDefaults } from "../src/lib/order-ask-default.js";
import { askNoticeText } from "../src/lib/order-ask.js";
import { A, ASKER, goodAnswer, jobWorld, lendOrder, ORDER, P, SPEC, type JobWorld } from "./pm-job-world.test.js";

let w: JobWorld;
afterEach(() => w?.close());
const ok = (message: string) => ({ ok: true, message, sessionId: null, elapsedMs: 5 });
const original = (askId: string, question: string) => askNoticeText({ taskId: "T1", orderId: ORDER, from: ASKER, askId, question, options: [], class: "blocker" });

// [验收线 1]
test("on: a spec-defined question is answered once from a fresh read-only session; the PM is not woken and gets a one-line summary", async () => {
  w = await jobWorld("on");
  const q = "验收线 1 的行数上限是多少？", { askId } = await w.ask(q);
  expect(w.pm).toEqual([]); // 原通知没投给 PM
  expect(w.store.get(askId)).toMatchObject({ state: "queued", direct: true, project: P, card: "T1", target: ASKER, pm: A, specRev: 1, messageId: `ledger-ask:${askId}` });
  expect(await w.work()).toBe(1);
  expect(w.runs).toHaveLength(1);
  const run = w.runs[0]!;
  expect(run).toMatchObject({ cwd: w.repo, sandbox: "read-only", isolateMcp: true });
  expect(run.thread).toBeUndefined(); // 新会话，不 resume
  for (const part of [SPEC.split("\n")[3]!, q, "src/lib/thing.ts", w.specPath, "只读"]) expect(run.prompt).toContain(part);
  expect(run.prompt).not.toContain(A); // 不带 PM 的任何东西
  await pmJob.sweep();
  await pmJob.sweep(); // 再扫不重发
  expect(w.asker).toHaveLength(1);
  expect(w.asker[0]).toMatchObject({ to: ASKER, id: `pm-job-answer:${askId}` });
  const text = w.asker[0]!.content;
  expect(text.split("\n")[0]).toBe(`处理员代答，依据 ${w.specPath}:4、src/lib/thing.ts:2；有异议回 PM。`);
  expect(text).toContain(`ask ${askId}`);
  expect(text).toContain("验收线 1 说的是新文件不超过 800 行。");
  expect(w.pm).toEqual([]);
  expect(getAsk(w.f.db, askId)).toMatchObject({ state: "answered", answer: { principal: "system:pm-job", labels: ["处理员代答"] } });
  expect(w.store.get(askId)).toMatchObject({ state: "sent", pmNotice: "handed", usage: { requests: 1 } });
  const summary = w.digest.queued(P);
  expect(summary).toHaveLength(1);
  expect(summary[0]).toMatchObject({ source: "pm-job", card: "T1" });
  for (const part of [askId, "验收编号 / 范围解释", "不超过 800 行", w.store.draftPath(askId)]) expect(summary[0]!.firstLine).toContain(part);
  expect(summary[0]!.firstLine).not.toContain("\n");
});

// agents-PMJOB2：改规格 / 改范围成了软门（直回候选，只能按 specDecided 答，见下一条测试），这里只留硬门
const MUST_ESCALATE: [string, string][] = [
  ["权限", "能给我开写台账的权限吗？"], ["删数据", "可以删掉旧的状态文件数据吗？"], ["release", "这次要不要发 release？"], ["tag", "合并后需要打 tag 吗？"],
  ["中心限流", "中心限流的阈值要不要调？"], ["schema", "asks 表要不要加一列 schema？"], ["改额度线", "额度线可以调到 90 吗？"],
];

// [验收线 2]
test("on: the owner categories never go back directly; the PM gets the original at once and the draft goes to the digest", async () => {
  w = await jobWorld("on");
  for (const [label, q] of MUST_ESCALATE) {
    const before = w.pm.length, { askId } = await w.ask(q);
    expect(w.store.get(askId)).toMatchObject({ direct: false, forbidden: label });
    expect(w.pm.slice(before)).toEqual([{ to: A, id: `ledger-ask:${askId}`, content: expect.stringContaining(original(askId, q)) }]); // 原文立刻到 PM
    expect(w.pm[before]!.content).toContain(w.store.draftPath(askId));
  }
  // 模型就算自称白名单、有依据，也不直回
  expect(await w.work((o) => ok(goodAnswer({ specPath: w.specPath }, { pending: ["要不要改由 PM 定"] })))).toBe(MUST_ESCALATE.length);
  const before = w.pm.length;
  await pmJob.sweep();
  expect(w.asker).toEqual([]);
  expect(w.remote).toEqual([]);
  expect(w.pm).toHaveLength(before); // agents-PMJOB2 PM 定 6：草稿提示进摘要，不单独叫醒 PM
  const hints = w.digest.queued(P).map((e) => ({ id: e.id, content: e.firstLine }));
  expect(hints).toHaveLength(MUST_ESCALATE.length);
  for (const job of w.store.list()) {
    expect(job).toMatchObject({ state: "observed", result: { verdict: "escalate" } });
    expect(getAsk(w.f.db, job.askId)?.state).toBe("open");
    expect(hints.find((h) => h.id === `pm-job-draft:${job.askId}`)?.content).toContain(job.draftPath);
    const draft = readFileSync(job.draftPath, "utf8");
    expect(draft).toContain("## 待批项");
    expect(draft).toContain(job.forbidden!);
  }
});

const SOFT: [string, string][] = [["改规格", "验收线 2 能不能改成也允许 src/lib/outside.ts？"], ["改范围", "需要扩围 src/lib/outside.ts 一行，可以吗？"]];

// [验收线 3]
test("on: a spec / scope change question is a direct candidate, but a non-specDecided answer escalates the original to the PM", async () => {
  w = await jobWorld("on");
  for (const [label, q] of SOFT) {
    const { askId } = await w.ask(q), before = w.pm.length;
    expect(w.store.get(askId)).toMatchObject({ direct: true, hard: false, forbidden: label });
    expect(await w.work()).toBe(1);
    await pmJob.sweep();
    expect(w.store.get(askId)).toMatchObject({ state: "escalated", note: expect.stringContaining("specDecided") });
    expect(w.pm.slice(before)).toEqual([{ to: A, id: `ledger-ask:${askId}`, content: expect.stringContaining(original(askId, q)) }]);
  }
  expect(w.asker).toEqual([]);
});

const BAD_OUTPUT: [string, (specPath: string) => string, RegExp][] = [
  ["无依据", (s) => goodAnswer({ specPath: s }, { evidence: [] }), /没有 文件:行 依据/],
  ["未知类别", (s) => goodAnswer({ specPath: s }, { type: "other" }), /不在白名单/],
  ["模型自造类别", (s) => goodAnswer({ specPath: s }, { type: "approve_scope" }), /不在白名单/],
  ["没把握", (s) => goodAnswer({ specPath: s }, { confident: false, reason: "材料缺" }), /没把握：材料缺/],
  ["依据在批准路径外", (s) => goodAnswer({ specPath: s }, { evidence: [{ file: "src/lib/outside.ts", line: 1 }] }), /依据无效/],
  ["依据越出仓库", (s) => goodAnswer({ specPath: s }, { evidence: [{ file: "../docs/tasks/T1.md", line: 1 }] }), /依据无效/],
  ["行号不存在", (s) => goodAnswer({ specPath: s }, { evidence: [{ file: "src/lib/thing.ts", line: 99 }] }), /依据无效/],
  ["不是约定的输出", () => "我觉得可以。", /不是约定的 JSON/],
];

// [验收线 2]
test("on: no basis, unknown type, low confidence or bad evidence escalate the original question with the draft", async () => {
  w = await jobWorld("on");
  for (const [label, output, reason] of BAD_OUTPUT) {
    const q = `验收线 1 具体指什么（${label}）？`, { askId } = await w.ask(q), before = w.pm.length;
    expect(await w.work(() => ok(output(w.specPath)))).toBe(1);
    await pmJob.sweep();
    expect(w.store.get(askId)).toMatchObject({ state: "escalated", pmNotice: "handed", note: expect.stringMatching(reason) });
    const got = w.pm.slice(before);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ to: A, id: `ledger-ask:${askId}` });
    expect(got[0]!.content.startsWith(original(askId, q))).toBe(true);
    expect(got[0]!.content).toContain(w.store.draftPath(askId));
    expect(getAsk(w.f.db, askId)?.state).toBe("open");
  }
  expect(w.asker).toEqual([]);
});

// [验收线 2]
test("a review order's ask starts no worker; a design / scope ask keeps its 15-minute default untouched", async () => {
  w = await jobWorld("on");
  lendOrder(w.f.db, "lend:T1:review", "review", "claimed");
  await expect(w.ask("这条算 P1 吗？", { orderId: "lend:T1:review", from: "worker-9@remote" })).rejects.toThrow(/answered/); // 当场回了规则，没开 ask
  const { askId } = await w.ask("打算把 helper 放 src/lib/thing.ts", { class: "design", default: "放 src/lib/thing.ts" });
  expect(w.store.list()).toEqual([]);
  expect(await w.work()).toBe(0);
  expect(w.pm).toHaveLength(1);
  expect(w.pm[0]!.content).not.toContain("处理员");
  const handedAt = getAsk(w.f.db, askId)!.extra.handedAt;
  await pmJob.sweep();
  expect(getAsk(w.f.db, askId)).toMatchObject({ state: "open", extra: { handedAt } });
  await sweepAskDefaults(w.f.db, w.now() + ASK_DEFAULT_MS);
  expect(getAsk(w.f.db, askId)).toMatchObject({ state: "answered", answer: { principal: "system:ask-default" } });
  expect(w.runs).toEqual([]);
});

// [验收线 3]
test("off: every envelope goes out byte for byte in order, and nothing is read or written for the job", async () => {
  w = await jobWorld("off");
  const qs = ["验收线 1 的行数上限是多少？", "需要扩围吗？", "src/lib/thing.ts 的 b 在哪一行？"], ids: string[] = [];
  for (const q of qs) ids.push((await w.ask(q)).askId);
  expect(w.pm).toEqual(qs.map((q, i) => ({ to: A, id: `ledger-ask:${ids[i]}`, content: original(ids[i]!, q) })));
  await pmJob.sweep();
  expect(await w.work()).toBe(0);
  expect(existsSync(w.store.dir)).toBe(false);
  expect(w.pm).toHaveLength(3);
  expect(w.asker).toEqual([]);
  expect(w.digest.queued(P)).toEqual([]);
});

// [验收线 3]
test("observe: the original goes out at once with the pending draft; the finished draft is linked by a follow-up, never sent to the executor", async () => {
  w = await jobWorld(null); // 没配 = observe
  const q = "验收线 1 的行数上限是多少？", { askId } = await w.ask(q), draft = w.store.draftPath(askId);
  expect(w.pm).toEqual([{ to: A, id: `ledger-ask:${askId}`, content: `${original(askId, q)}\n处理员草稿（待生成，完成后进摘要）：${draft}` }]); // 没等模型
  expect(w.runs).toEqual([]);
  expect(readFileSync(draft, "utf8")).toContain("待生成");
  expect(w.store.get(askId)).toMatchObject({ state: "queued", direct: false, mode: "observe" });
  expect(await w.work()).toBe(1);
  await pmJob.sweep();
  await pmJob.sweep();
  expect(w.pm).toHaveLength(1); // agents-PMJOB2 PM 定 6：草稿完成进摘要队列，不再单独叫醒 PM
  const queued = w.digest.queued(P);
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({ id: `pm-job-draft:${askId}`, source: "pm-job", card: "T1" });
  for (const part of [`ask ${askId}`, draft, "未发给执行者"]) expect(queued[0]!.firstLine).toContain(part);
  const done = readFileSync(draft, "utf8");
  for (const part of [`ask ${askId}`, "验收线 1 说的是新文件不超过 800 行。", `${w.specPath}:4`]) expect(done).toContain(part);
  expect(w.asker).toEqual([]);
  expect(w.remote).toEqual([]);
  expect(getAsk(w.f.db, askId)?.state).toBe("open");
  expect(w.store.get(askId)).toMatchObject({ state: "observed", pmNotice: "handed" });
});

// [验收线 3]
test("a human message, a non-PM recipient, a non-ledger sender or an owner-decision notice is never taken as a job", async () => {
  w = await jobWorld("on");
  const { askId } = await w.ask("验收线 1 的行数上限是多少？");
  w.store.remove(askId); // 同一条 ask 换不同来源再投
  const id = `ledger-ask:${askId}`, body = original(askId, "验收线 1 的行数上限是多少？");
  await w.deliver(w.envelope(A, body, id, { kind: "user", userId: "u1", username: "owner", channelId: "c" } as never)); // 人类
  await w.deliver(w.envelope(A, body, id, { kind: "local", agentName: ASKER, channelId: "channel-x", ws: null as never })); // 别的 agent 冒用编号
  await w.deliver(w.envelope("agent-dispatcher", body, id)); // 收件人不是当班 PM
  await w.deliver(w.envelope(A, body, "pm-reply:1")); // 不是执行者提问的通知
  await w.deliver(w.envelope(A, `${body}\n这件事需要 owner 决策`, id)); // owner 类原路
  expect(w.store.list()).toEqual([]);
  expect(w.pm.map((m) => m.to)).toEqual([A, A, "agent-dispatcher", A, A]);
  expect(await w.work()).toBe(0);
});
