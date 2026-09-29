/**
 * AskUserQuestion 作答绑定弹框身份（T65，bridge/auq-answer.ts）：三个入口都要带上看到的那一版，拿窗口执行权、抓屏逐项比对才按键；
 * 缺身份 / 换了一代 / 画面对不上 / 抓屏失败一律 409、零发键；并发提交只按一次；Discord 旧消息上的选择 / 提交 / 取消都不动当前状态。
 * 抓屏和发键换成假的，台账是临时库。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openRuntimeAsk, resetRuntimeAsksForTest } from "../src/bridge/ask-runtime.js";
import { auqStates, clearAuqState, postAskUserQuestionMessage, registerAuqState, type AuqQuestion, type AuqState } from "../src/bridge/ask-user-question.js";
import { setAsksForTest, type AsksDeps } from "../src/bridge/asks.js";
import { answerAuqDialog, auqDiscordSelect, setAuqAnswerDepsForTest, type AuqAnswerInput } from "../src/bridge/auq-answer.js";
import { listAsks } from "../src/lib/ledger-asks.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { auqPaneMatches, parseAuqPane, textMatchesLines } from "../src/lib/auq-pane.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const CH = "111";
let path = "";
let screen = "";
let sent: string[] = [];
let gate: Promise<void> | null = null;

const q = (labels: string[], description = (l: string) => `${l} 的说明`): AuqQuestion => ({
  question: "Choose action", header: "Action", multiSelect: false, options: labels.map((label) => ({ label, description: description(label) })),
});
/** CC 2.1.x 单问题单选弹框的画面（形状同 tests/auq-pane.test.ts 的真实 capture） */
const ccPane = (qq: AuqQuestion, cursor = 0) => {
  const opts = qq.options.flatMap((o, i) => [`${i === cursor ? "❯" : " "} ${i + 1}. ${o.label}`, `     ${o.description ?? ""}`]);
  return [" ☐ Action", "", qq.question, "", ...opts, "", "Enter to select · ↑/↓ to navigate · Esc to cancel"].join("\n");
};

const register = (qq: AuqQuestion): AuqState => registerAuqState(CH, "master:agent-x", [qq], "pane");
const web = (st: AuqState, over: Partial<AuqAnswerInput> = {}): AuqAnswerInput => ({
  channelId: CH, agentName: "agent-x", action: "submit", selections: [[1]], via: "api", who: { principal: "owner:self" },
  seen: { dialogId: st.dialogId, questions: st.questions }, ...over,
});

beforeEach(() => {
  path = tempLedgerPath("auq-answer-");
  openLedger(path);
  const deps: AsksDeps = { clients: new Map(), controlChannelId: "999", hold: () => {}, deliver: async (env) => ({ envelope: env, outcome: { kind: "sent" } }) };
  setAsksForTest({ path, deps, registry: [{ name: "agent-x", channelId: CH, status: "active", projectId: "p" } as RegistryAgent], ownerChats: ["api:owner:self"] });
  resetRuntimeAsksForTest();
  sent = [];
  gate = null;
  setAuqAnswerDepsForTest({
    capture: async () => screen,
    sendKey: async (_t, k) => void sent.push(k),
    sendEscape: async () => void sent.push("Escape"),
    sleep: async () => void (await gate),
  });
});
afterEach(() => {
  clearAuqState(CH);
  setAuqAnswerDepsForTest();
  setAsksForTest(undefined);
  closeLedger(path);
});

describe("网页入口：带上看到的那一版", () => {
  test("正常：身份和画面都对上才按键，按完清状态", async () => {
    const st = register(q(["Cancel", "Delete"]));
    screen = ccPane(st.questions[0]);
    expect(await answerAuqDialog(web(st))).toMatchObject({ ok: true, keys: 2 });
    expect(sent).toEqual(["Down", "Enter"]);
    expect(auqStates.has(CH)).toBe(false);
  });

  test("聊天卡没带身份（旧客户端）→ 409 要求刷新，零发键", async () => {
    const st = register(q(["Cancel", "Delete"]));
    screen = ccPane(st.questions[0]);
    expect(await answerAuqDialog(web(st, { seen: {} }))).toMatchObject({ ok: false, status: 409, code: "auq_identity_required" });
    expect(await answerAuqDialog(web(st, { seen: { questions: st.questions } }))).toMatchObject({ code: "auq_identity_required" });
    expect(sent).toEqual([]);
  });

  test("换了一代（新的 tool_use / 新登记），题面一模一样也 409", async () => {
    const old = register(q(["Cancel", "Delete"]));
    register(q(["Cancel", "Delete"]));
    screen = ccPane(old.questions[0]);
    expect(await answerAuqDialog(web(old))).toMatchObject({ ok: false, status: 409, code: "auq_stale" });
    expect(sent).toEqual([]);
  });

  test("「待你处理」卡：askId 有效、题面也对，但画面已经换了顺序 → 409 且零发键，这一版作废", async () => {
    const st = register(q(["Cancel", "Delete"]));
    await openRuntimeAsk({ source: "auq", channelId: CH, agentName: "agent-x", kind: "decide", title: "Choose action", context: "", options: st.questions, dialogId: st.dialogId });
    const [card] = listAsks(openLedger(path), { source: "auq" });
    screen = ccPane(q(["Delete", "Cancel"]));
    expect(await answerAuqDialog(web(st, { seen: { askId: card!.id, questions: card!.options } }))).toMatchObject({ ok: false, status: 409, code: "screen_mismatch" });
    expect(sent).toEqual([]);
    expect(auqStates.has(CH)).toBe(false);
  });

  test("只有选项描述变了（授权对象不同）→ 409", async () => {
    const st = register(q(["Proceed", "Cancel"], () => "Delete /tmp/reports /tmp/archive"));
    screen = ccPane(q(["Proceed", "Cancel"], () => "Delete /tmp/reports/tmp/archive"));
    expect(await answerAuqDialog(web(st))).toMatchObject({ ok: false, code: "screen_mismatch" });
    expect(sent).toEqual([]);
  });

  test("抓屏失败 → 409，不盲发", async () => {
    const st = register(q(["Cancel", "Delete"]));
    setAuqAnswerDepsForTest({ capture: async () => Promise.reject(new Error("no pane")), sendKey: async (_t, k) => void sent.push(k) });
    expect(await answerAuqDialog(web(st))).toMatchObject({ ok: false, status: 409, code: "capture_failed" });
    expect(sent).toEqual([]);
    expect(auqStates.get(CH)).toBe(st);
  });

  test("两次并发提交只按一次键：第二次拿不到窗口执行权", async () => {
    const st = register(q(["Cancel", "Delete"]));
    screen = ccPane(st.questions[0]);
    let open!: () => void;
    gate = new Promise((r) => (open = r));
    const first = answerAuqDialog(web(st));
    await Bun.sleep(5);
    expect(await answerAuqDialog(web(st))).toMatchObject({ ok: false, status: 409, code: "window_busy" });
    open();
    expect(await first).toMatchObject({ ok: true });
    expect(sent).toEqual(["Down", "Enter"]);
  });

  test("发键途中换了一代：停下，剩下的键不发", async () => {
    const st = register(q(["A", "B", "C"]));
    screen = ccPane(st.questions[0]);
    let open!: () => void;
    gate = new Promise((r) => (open = r));
    const run = answerAuqDialog(web(st, { selections: [[2]] }));
    await Bun.sleep(5);
    register(q(["A", "B", "C"]));
    open();
    expect(await run).toMatchObject({ ok: false, code: "dialog_changed" });
    expect(sent).toEqual(["Down"]);
  });

  test("最后一个 await（Esc / 最后一个键 / 间隔）期间换了一代：回 409，新的一代原样留着、不清不记账", async () => {
    const a = register(q(["Proceed", "Cancel"]));
    screen = ccPane(a.questions[0]);
    let next: AuqState | undefined;
    setAuqAnswerDepsForTest({ capture: async () => screen, sendEscape: async () => void (next = register(q(["New", "Cancel"]))) });
    expect(await answerAuqDialog(web(a, { action: "cancel" }))).toMatchObject({ ok: false, status: 409, code: "dialog_changed" });
    expect(auqStates.get(CH)).toBe(next);
    const b = register(q(["Proceed", "Cancel"]));
    screen = ccPane(b.questions[0]);
    setAuqAnswerDepsForTest({ capture: async () => screen, sendKey: async () => {}, sleep: async () => void (next = register(q(["New", "Cancel"]))) });
    expect(await answerAuqDialog(web(b, { selections: [[0]] }))).toMatchObject({ ok: false, status: 409, code: "dialog_changed" });
    expect(auqStates.get(CH)).toBe(next);
  });

  test("单问题旧卡不认两段式弹框：第 1 段一模一样也 409（单题的 Enter 在两段表单里只是翻页）", async () => {
    const st = register(q(["Proceed", "Cancel"]));
    const opts = st.questions[0].options.flatMap((o, i) => [`${i ? " " : "❯"} ${i + 1}. ${o.label}`, `     ${o.description}`]);
    screen = ["←  ☐ Action  ☐ Other  ✔ Submit  →", "", "Choose action", "", ...opts, "", "Enter to select · ↑/↓ to navigate · Esc to cancel"].join("\n");
    expect(parseAuqPane(screen)).toMatchObject({ form: "tabbed", sections: ["Action", "Other"] });
    expect(await answerAuqDialog(web(st, { selections: [[0]] }))).toMatchObject({ ok: false, status: 409, code: "screen_mismatch" });
    expect(sent).toEqual([]);
  });

  test("取消也核画面：对不上 409 不发 Esc；对上才发", async () => {
    const st = register(q(["Cancel", "Delete"]));
    screen = ccPane(q(["Delete", "Cancel"]));
    expect(await answerAuqDialog(web(st, { action: "cancel" }))).toMatchObject({ ok: false, code: "screen_mismatch" });
    const st2 = register(q(["Cancel", "Delete"]));
    screen = ccPane(st2.questions[0]);
    expect(await answerAuqDialog(web(st2, { action: "cancel" }))).toMatchObject({ ok: true, cancelled: true });
    expect(sent).toEqual(["Escape"]);
  });
});

describe("Discord：按消息 id 认这一版，新一版一定是新消息", () => {
  let n = 0;
  let release: (() => void) | null = null;
  const discord = {
    channels: { fetch: async () => ({ send: async () => { if (release === null) return { id: `m${++n}` }; const id = `m${++n}`; await new Promise<void>((r) => (release = r)); return { id }; } }) },
  } as never;
  const discordIn = (messageId: string, action: "submit" | "cancel" = "submit"): AuqAnswerInput => ({
    channelId: CH, agentName: "agent-x", action, via: "discord", who: { principal: "discord:u1" }, seen: { messageId },
  });

  test("换了一版 AUQ 后，旧消息的 select / Submit / Cancel 全部 409 且不改当前状态", async () => {
    const v1 = register(q(["Cancel", "Delete"]));
    await postAskUserQuestionMessage(discord, v1);
    const v2 = register(q(["Delete", "Cancel"]));
    await postAskUserQuestionMessage(discord, v2);
    expect(v1.messageId).not.toBe(v2.messageId);
    screen = ccPane(v2.questions[0]);
    expect(auqDiscordSelect(CH, v1.messageId, 0, ["0"])).toBe(false);
    expect(v2.selections).toEqual([[]]);
    expect(await answerAuqDialog(discordIn(v1.messageId))).toMatchObject({ ok: false, status: 409, code: "auq_stale" });
    expect(await answerAuqDialog(discordIn(v1.messageId, "cancel"))).toMatchObject({ ok: false, status: 409 });
    expect(sent).toEqual([]);
    expect(auqStates.get(CH)).toBe(v2);
    expect(auqDiscordSelect(CH, v2.messageId, 0, ["0"])).toBe(true);
    expect(await answerAuqDialog(discordIn(v2.messageId))).toMatchObject({ ok: true });
    expect(sent).toEqual(["Enter"]);
  });

  test("旧一版的消息晚发出来：不绑到新一版上", async () => {
    const v1 = register(q(["Cancel", "Delete"]));
    release = () => {};
    const posting = postAskUserQuestionMessage(discord, v1);
    await Bun.sleep(5);
    const v2 = register(q(["Delete", "Cancel"]));
    const done = release;
    release = null;
    done();
    await posting;
    expect(v1.messageId).not.toBe("");
    expect(v2.messageId).toBe("");
    expect(await answerAuqDialog(discordIn(v1.messageId))).toMatchObject({ ok: false, code: "auq_stale" });
  });
});

describe("画面比对（lib/auq-pane.ts auqPaneMatches / textMatchesLines）", () => {
  test("真实折行处允许空格或无；行内多一个、少一个空格都算不同", () => {
    expect(textMatchesLines("删除 /tmp/reports 和 /tmp/archive 两个目录", ["删除 /tmp/reports 和", "/tmp/archive 两个目录"])).toBe(true);
    expect(textMatchesLines("只读检查，不改任何东西", ["只读检查，不改", "任何东西"])).toBe(true);
    expect(textMatchesLines("Delete /tmp/reports /tmp/archive", ["Delete /tmp/reports/tmp/archive"])).toBe(false);
    expect(textMatchesLines("Delete /tmp/reports/tmp/archive", ["Delete /tmp/reports /tmp/archive"])).toBe(false);
    expect(textMatchesLines("说明", [])).toBe(false);
    expect(textMatchesLines("", [])).toBe(true);
  });

  test("逐项：问题、选项个数、文字、描述、单选 / 多选；多问题只核段数和第 1 段", () => {
    const qq = q(["Cancel", "Delete"]);
    const p = parseAuqPane(ccPane(qq))!;
    expect(auqPaneMatches([qq], p)).toBe(true);
    expect(auqPaneMatches([{ ...qq, question: "Choose another" }], p)).toBe(false);
    expect(auqPaneMatches([{ ...qq, multiSelect: true }], p)).toBe(false);
    expect(auqPaneMatches([q(["Cancel", "Delete", "Keep"])], p)).toBe(false);
    expect(auqPaneMatches([qq, q(["X", "Y"])], p)).toBe(false); // 画面上只有一段
    expect(auqPaneMatches([qq, q(["X", "Y"])], { ...p, form: "tabbed", sections: ["Action", "Other"] })).toBe(true);
    expect(auqPaneMatches([qq], { ...p, form: "tabbed", sections: ["Action", "Other"] })).toBe(false); // 单题卡不认两段表单
    expect(auqPaneMatches([qq], { ...p, form: "tabbed" })).toBe(false); // 单题单选只认 single
    expect(auqPaneMatches([{ ...qq, multiSelect: true }], { ...p, form: "tabbed", multiSelect: true })).toBe(true);
  });
});
