/**
 * 「待你处理」第二版 B（T11b PR B）：作答回显（选项人话 + askId，历史 / 直播同一个算法）、原消息定位（locate）、单条接口、
 * 回复附件记进 ask、AUQ 所选项进 decision（多问标「共 N 问」）、#control 授权摘要置顶（Codex 弹框规则在 tests/runtime-dialogs.test.ts）。库、状态文件都是临时的。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateInLines } from "../src/bridge/ask-locate.js";
import { pinText, refreshAskPin } from "../src/bridge/ask-pin.js";
import { deliverReplyWithAsk } from "../src/bridge/ask-reply.js";
import { openRuntimeAsk, resetRuntimeAsksForTest, settleAuq } from "../src/bridge/ask-runtime.js";
import { onAsk, setAsksForTest } from "../src/bridge/asks.js";
import { handleAsksApi } from "../src/bridge/local-api/asks.js";
import type { Envelope } from "../src/bridge/router.js";
import { auqAnswerSummary, auqEchoCard } from "../src/lib/auq-echo.js";
import { answerEcho, channelAnswer } from "../src/lib/inbound-body.js";
import { getAsk, listAsks, openAsk, patchAsk, type NewAsk } from "../src/lib/ledger-asks.js";
import { readSessionHistory, unwrapChannelMessage } from "../src/lib/session-history.js";
import { heldAcrossStopNote, withInterruptNote } from "../src/lib/turn-cuts.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import { at, guest, owner } from "./asks-test-kit.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const dir = mkdtempSync(join(tmpdir(), "asks-b-"));
let path = "";
beforeEach(() => {
  path = tempLedgerPath("asks-b-");
  openLedger(path);
  resetRuntimeAsksForTest();
  const registry = [{ name: "agent-x", channelId: "111", status: "active", projectId: "p" } as RegistryAgent];
  const deps = { clients: new Map(), controlChannelId: "999", deliver: async (env: Envelope) => ({ envelope: env, outcome: { kind: "sent" as const } }), hold: () => {} };
  setAsksForTest({ path, registry, ownerChats: ["api:owner:self"], deps });
});
afterEach(() => {
  setAsksForTest(undefined);
  closeLedger(path);
});

const base: NewAsk = { project: "p", fromAgent: "agent-x", fromChannelId: "111", source: "reply", kind: "decide", title: "发吗", body: "发 v2.32.0 吗？" };

describe("作答回显（第 7 条）", () => {
  const zh = "[✅ owner 回复了你 12:00 的「待你处理」（ask_q1）：发吗？选择：发；只发 Codex。下面是 owner 发的原文]";
  const en = "[✅ owner answered the 12:00 ask (ask_q2): Ship? Chose: Ship; Codex only. Owner's words below]";
  test("去掉说明行、wire 行换成选项人话、再接原话；只写了话的只有原话；中英两种说明行都认；原文另放 wire", () => {
    expect(answerEcho(`${zh}\n[button:go]\n[select:who:codex]`)).toEqual({ askId: "ask_q1", text: "发；只发 Codex", wire: "[button:go]\n[select:who:codex]" });
    expect(answerEcho(`${en}\n[button:go]\nlater`)).toEqual({ askId: "ask_q2", text: "Ship; Codex only\nlater", wire: "[button:go]\nlater" });
    expect(answerEcho("[✅ owner 回复了你 12:00 的「待你处理」（ask_q3）：发吗？下面是 owner 发的原文]\n都同意吧")).toEqual({ askId: "ask_q3", text: "都同意吧" });
  });
  test("「选择：」只认标题标点后面、到固定措辞为止的那段：标题里的「请选择：」不算，选项里的「。」不截断，还有 N 项没答的也认", () => {
    const head = (mid: string) => `[✅ owner 回复了你 09:00 的「待你处理」（ask_2）：${mid}下面是 owner 发的原文]`;
    expect(answerEcho(`${head("请选择：先合 A 还是先合 B？选择：先合 B。")}\n[button:b]`).text).toBe("先合 B");
    expect(answerEcho(`${head("请选择：A。")}\n都行`).text).toBe("都行");
    expect(answerEcho(`${head("发吗？选择：发。然后通知。")}\n[button:go]`).text).toBe("发。然后通知");
    expect(answerEcho(`${head("发吗？选择：发。这条还有 1 项没答，答了会再发给你。")}\n[button:go]`).text).toBe("发");
    expect(answerEcho(`${head("发吗？选择：发。还有 2 项 owner 没选（从卡片一次提交，没选的就是不选）。")}\n[button:go]`).text).toBe("发");
    const en = "[✅ owner answered the 12:00 ask (ask_q2): Pick: A or B? Chose: B. 1 more part(s) still unanswered. Owner's words below]";
    expect(answerEcho(`${en}\n[button:b]`).text).toBe("B");
  });
  test("channelAnswer 只认 trigger=ask_answer 的；带注入头的也剥得掉", () => {
    expect(channelAnswer(' trigger="ask_answer" api="true"', `[🌐 来自 Web 端用户「owner」]\n\n${zh}\n[button:go]`)).toEqual({ askId: "ask_q1", wire: "[button:go]" });
    expect(channelAnswer(' trigger="user_message"', `${zh}\n[button:go]`)).toEqual({});
  });
  test("押在叫停之前、之后才送到的作答：先剥叫停抬头，刷新后 askId、原文都还在（PR B r2 P2-A）", () => {
    const attrs = ' trigger="ask_answer" interrupt_note="true"';
    const body = withInterruptNote(`${zh}\n[button:go]`, heldAcrossStopNote(Date.parse("2026-09-29T01:00:00Z"), Date.parse("2026-09-29T01:01:00Z")));
    expect(channelAnswer(attrs, body)).toEqual({ askId: "ask_q1", wire: "[button:go]" });
    const un = unwrapChannelMessage(`<channel source="claudestra" chat_id="api:owner:self" user="web"${attrs}>\n${body}\n</channel>`);
    expect(un).toMatchObject({ askId: "ask_q1", wire: "[button:go]" });
  });
});

describe("原消息定位（第 6 条）", () => {
  const line = (o: unknown) => JSON.stringify(o);
  const reply = (text: string, ts: string) => line({ type: "assistant", timestamp: ts, message: { content: [{ type: "tool_use", name: "mcp__claudestra__reply", input: { text } }] } });
  const user = (ts: string) => line({ type: "user", timestamp: ts, message: { content: "hi" } });
  const lines = [user("2026-09-29T00:00:00Z"), reply("发 v2.32.0 吗？", "2026-09-29T00:00:05Z"), user("2026-09-29T00:01:00Z"), reply("别的", "2026-09-29T00:02:00Z")];

  test("reply 类按原文找到那一行；运行时弹框按建 ask 的时间退到之前最后一条；都没有 → null", () => {
    expect(locateInLines(lines, { source: "reply", body: "发 v2.32.0 吗？", createdAt: Date.parse("2026-09-29T00:05:00Z") })).toBe(1);
    expect(locateInLines(lines, { source: "auq", body: "", createdAt: Date.parse("2026-09-29T00:01:30Z") })).toBe(2);
    expect(locateInLines(lines, { source: "reply", body: "找不到的原文", createdAt: Date.parse("2026-09-28T00:00:00Z") })).toBeNull();
  });

  test("GET /asks/:id 与 /locate：看不见的 404；定位要发起 agent 在 scope 里；人发起的没有原消息；定位过的直接用缓存", async () => {
    const a = openAsk(openLedger(path), base);
    patchAsk(openLedger(path), a.id, { extra: { loc: { agent: "agent-x", sessionId: "s1", seq: 42 } } });
    const get = async (p: string, who = owner()) => {
      const r = (await handleAsksApi(new Request(`http://x/api/v1${p}`), p, who))!;
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    expect(await get(`/asks/${a.id}`)).toMatchObject({ status: 200, body: { ask: { id: a.id, title: "发吗", canAnswer: true } } });
    expect(await get(`/asks/${a.id}/locate`)).toMatchObject({ status: 200, body: { agent: "agent-x", sessionId: "s1", seq: 42 } });
    expect((await get(`/asks/${a.id}`, guest("aa11"))).status).toBe(404);
    const human = openAsk(openLedger(path), { project: "p", source: "human", createdBy: "owner:self", kind: "assigned", title: "t", assignee: "local:guest:aa11" });
    expect((await get(`/asks/${human.id}`, guest("aa11"))).status).toBe(200);
    expect((await get(`/asks/${human.id}/locate`, guest("aa11"))).status).toBe(404);
    expect((await get("/asks/ask_nope")).status).toBe(404);
  });
});

test("回复附件记进 ask（api 目的地拷进 inbox 后的名字），卡片据此列出、点开走附件预览", async () => {
  const env: Envelope = {
    from: { kind: "local", channelId: "111", ws: {} as never }, to: { kind: "user", userId: "", channelId: "api:owner:self" }, intent: "response", content: "看下设计稿，发吗？",
    meta: { messageId: "r1", triggerKind: "agent_tool", ts: at, threadId: "t1", components: [{ type: "buttons", buttons: [{ id: "go", label: "发" }] }], files: ["/x/design.md"] },
  };
  await deliverReplyWithAsk(env, "api:owner:self", "111", async (e) => {
    e.meta.sentFiles = [{ name: "design.md", attachment: "1790_design.md" }]; // bridge.ts deliverToApi 回填的样子
    return { envelope: e, outcome: { kind: "sent" } };
  });
  expect(getAsk(openLedger(path), env.meta.askId!)?.extra.files).toEqual([{ name: "design.md", attachment: "1790_design.md" }]);
});

test("投到 Discord 频道的 reply：附件只上传给 Discord，这里补拷进 inbox 再记进 ask；记上之后再推一次", async () => {
  const env: Envelope = {
    from: { kind: "local", channelId: "111", ws: {} as never }, to: { kind: "user", userId: "", channelId: "111" }, intent: "response", content: "看下截图，发吗？",
    meta: { messageId: "r2", triggerKind: "agent_tool", ts: at, threadId: "t2", components: [{ type: "buttons", buttons: [{ id: "go", label: "发" }] }], files: ["/tmp/x/shot.png"] },
  };
  const copied: [string[], string][] = [];
  const copy = async (paths: string[], agent: string) => (copied.push([paths, agent]), [{ name: "shot.png", attachment: "1790_shot.png" }]);
  const published: unknown[] = [];
  const stop = onAsk((a) => void published.push(a.extra));
  await deliverReplyWithAsk(env, "111", "111", async (e) => ({ envelope: e, outcome: { kind: "sent", discordMessageIds: ["m9"] } }), undefined, copy);
  stop();
  expect(copied).toEqual([[["/tmp/x/shot.png"], "agent-x"]]);
  expect(getAsk(openLedger(path), env.meta.askId!)?.extra.files).toEqual([{ name: "shot.png", attachment: "1790_shot.png" }]);
  expect(published.at(-1)).toMatchObject({ files: [{ attachment: "1790_shot.png" }] });
});

describe("AUQ", () => {
  const qs = [
    { question: "用哪个模型？", header: "模型", options: [{ label: "Opus" }, { label: "Sonnet" }] },
    { question: "要不要跑测试？", header: "测试", options: [{ label: "跑" }, { label: "不跑" }] },
  ];
  test("多问的建一条、标题标「共 N 问」；提交后所选项按「问题：选项」写进 decision，actor 是作答的人", async () => {
    await openRuntimeAsk({ source: "auq", channelId: "111", agentName: "agent-x", kind: "decide", title: "用哪个模型？（共 2 问）", context: "", options: qs });
    settleAuq("111", "interact", { questions: qs, selections: [[0], [1]] }, { principal: "owner:self", device: "dev_1" });
    const [a] = listAsks(openLedger(path), { source: "auq" });
    expect(a).toMatchObject({ state: "answered", title: "用哪个模型？（共 2 问）", answer: { labels: ["模型：Opus", "测试：不跑"], principal: "owner:self" } });
    expect(listEvents(openLedger(path), { project: "p" }).find((e) => e.kind === "decision")?.text).toBe("模型：Opus；测试：不跑");
  });
  test("一问的就是选项文字（多选用「、」连）", async () => {
    await openRuntimeAsk({ source: "auq", channelId: "111", agentName: "agent-x", kind: "decide", title: "q", context: "", options: [qs[0]] });
    settleAuq("111", "discord", { questions: [qs[0]], selections: [[0, 1]] }, { principal: "discord:42" });
    expect(listAsks(openLedger(path), { source: "auq" })[0].answer?.labels).toEqual(["Opus、Sonnet"]);
  });
});

describe("AUQ 作答在聊天里留痕（第 7 条，PM 定 A）", () => {
  const questions = [{ question: "用哪个模型？", options: [] }, { question: "要不要跑测试？", options: [] }];
  const result = (answers: Record<string, string>) => ({
    type: "user", timestamp: "2026-09-29T00:00:05Z", toolUseResult: { questions, answers },
    message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "Your questions have been answered: ..." }] },
  });
  test("摘要按「问题 · 选项」，多问用「；」连；没答（取消）或不是 AUQ 的结果 → null", () => {
    expect(auqAnswerSummary(result({ "用哪个模型？": "Opus", "要不要跑测试？": "跑, 只跑单测" }))).toBe("💬 答复：用哪个模型？ · Opus；要不要跑测试？ · 跑, 只跑单测");
    expect(auqAnswerSummary(result({}))).toBeNull();
    expect(auqAnswerSummary({ type: "user", toolUseResult: { stdout: "x" } })).toBeNull();
  });
  test("历史：AUQ 工具卡的摘要换成作答；直播：补一张已完成的卡，摘要一样", async () => {
    const rec = result({ "用哪个模型？": "Opus" });
    const auqUse = { type: "tool_use", id: "tu_1", name: "AskUserQuestion", input: { questions } };
    const p = join(dir, "s-auq.jsonl");
    writeFileSync(p, [{ type: "assistant", timestamp: "2026-09-29T00:00:00Z", message: { content: [auqUse] } }, rec].map((r) => JSON.stringify(r)).join("\n"));
    const page = await readSessionHistory(p, { formatToolFn: (n: string) => `🔧 ${n}` });
    expect(page.messages[0].tools?.[0]).toMatchObject({ name: "AskUserQuestion", summary: "💬 答复：用哪个模型？ · Opus" });
    expect(auqEchoCard(rec, () => "d")).toEqual({ toolId: "tu_1", name: "AskUserQuestion", summary: "💬 答复：用哪个模型？ · Opus", detail: "d", done: true });
  });
});

describe("#control 授权摘要置顶（第 5 条）", () => {
  test("只列开着的授权类；没有就写「没有」；第一次发出来置顶、记下消息 id，之后只改那一条；内容没变不动", async () => {
    const db = openLedger(path);
    openAsk(db, { ...base, kind: "decide", title: "不是授权" });
    openAsk(db, { ...base, kind: "authorize", title: "打 tag v2.32.0", taskId: "T9" });
    const sent: string[] = [];
    const edits: string[] = [];
    let pinned = 0;
    const msg = { id: "m1", edit: async (o: { content: string }) => void edits.push(o.content), pin: async () => void pinned++ };
    const ch = { send: async (o: { content: string }) => (sent.push(o.content), msg), messages: { fetch: async (id: string) => (id === "m1" ? msg : Promise.reject(new Error("gone"))) } };
    const discord = { channels: { fetch: async () => ch } };
    const file = join(dir, "ask-pin.json");
    const last = { text: "" };
    await refreshAskPin(discord, "999", last, file);
    expect([sent.length, pinned, JSON.parse(readFileSync(file, "utf8"))]).toEqual([1, 1, { channelId: "999", messageId: "m1" }]);
    expect(sent[0]).toContain("打 tag v2.32.0");
    expect(sent[0]).not.toContain("不是授权");
    await refreshAskPin(discord, "999", last, file);
    expect(edits).toHaveLength(0);
    last.text = "";
    await refreshAskPin(discord, "999", last, file);
    expect([sent.length, edits.length]).toEqual([1, 1]);
    expect(pinText([])).toContain("没有");
    // 取消息失败：网络抖动 / 429 / 5xx 不重发（频道里会留两条置顶），抛给调用方、正文不记，下次再试；Discord 说 Unknown Message 才重发
    let fail: unknown = Object.assign(new Error("Service Unavailable"), { status: 503 });
    ch.messages.fetch = async () => Promise.reject(fail);
    last.text = "";
    await expect(refreshAskPin(discord, "999", last, file)).rejects.toThrow("Service Unavailable");
    expect([sent.length, last.text]).toEqual([1, ""]);
    fail = Object.assign(new Error("Unknown Message"), { code: 10008 });
    await refreshAskPin(discord, "999", last, file);
    expect([sent.length, pinned]).toEqual([2, 2]);
  });
});
