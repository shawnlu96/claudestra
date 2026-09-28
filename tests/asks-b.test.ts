/**
 * 「待你处理」第二版 B（T11b PR B）：作答回显（选项人话 + askId，历史 / 直播同一个算法）、原消息定位（locate）、单条接口、
 * 回复附件记进 ask、AUQ 所选项进 decision（多问标「共 N 问」）、#control 授权摘要置顶、Codex 弹框扩展规则。库、状态文件都是临时的。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateInLines } from "../src/bridge/ask-locate.js";
import { pinText, refreshAskPin } from "../src/bridge/ask-pin.js";
import { deliverReplyWithAsk } from "../src/bridge/ask-reply.js";
import { openRuntimeAsk, resetRuntimeAsksForTest, settleAuq } from "../src/bridge/ask-runtime.js";
import { setAsksForTest } from "../src/bridge/asks.js";
import { handleAsksApi } from "../src/bridge/local-api/asks.js";
import type { Envelope } from "../src/bridge/router.js";
import { answerEcho, channelAskId } from "../src/lib/inbound-body.js";
import { getAsk, listAsks, openAsk, patchAsk, type NewAsk } from "../src/lib/ledger-asks.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import { detectCodexRuntimeDialog, parseDialogRules } from "../src/lib/runtime-dialogs.js";
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
  test("去掉说明行、wire 行换成选项人话、再接原话；只写了话的只有原话；中英两种说明行都认", () => {
    expect(answerEcho(`${zh}\n[button:go]\n[select:who:codex]`)).toEqual({ askId: "ask_q1", text: "发；只发 Codex" });
    expect(answerEcho(`${en}\n[button:go]\nlater`)).toEqual({ askId: "ask_q2", text: "Ship; Codex only\nlater" });
    expect(answerEcho("[✅ owner 回复了你 12:00 的「待你处理」（ask_q3）：发吗？下面是 owner 发的原文]\n都同意吧").text).toBe("都同意吧");
  });
  test("channelAskId 只认 trigger=ask_answer 的；带注入头的也剥得掉", () => {
    expect(channelAskId(' trigger="ask_answer" api="true"', `[🌐 来自 Web 端用户「owner」]\n\n${zh}\n[button:go]`)).toBe("ask_q1");
    expect(channelAskId(' trigger="user_message"', `${zh}\n[button:go]`)).toBeUndefined();
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
  });
});

describe("Codex 运行中弹框的扩展规则", () => {
  test("状态目录的 codex-dialogs.json：合格的行生效，坏行（不是对象 / 正则编不过 / 没标题）跳过；文件改了下次就生效", () => {
    expect(parseDialogRules([{ pattern: "usage limit", title: "Codex 额度用完" }, { pattern: "(", title: "坏正则" }, { pattern: "x" }, "nope"]).map((r) => r.title)).toEqual(["Codex 额度用完"]);
    const file = join(dir, "codex-dialogs.json");
    expect(detectCodexRuntimeDialog("You've hit your usage limit", file)).toBeNull();
    writeFileSync(file, JSON.stringify([{ pattern: "hit your usage limit", title: "Codex 额度用完" }]));
    expect(detectCodexRuntimeDialog("You've hit your usage limit", file)).toEqual({ title: "Codex 额度用完", context: "hit your usage limit" });
  });
});
