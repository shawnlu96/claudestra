/**
 * 「待你处理」删除（T61，bridge/ask-dismiss.ts）与运行时卡的指纹（lib/ask-fingerprint.ts、bridge/ask-runtime.ts）：
 * 三类卡删掉的效果、删过的重启后不再冒出来、同一个弹框重启沿用原卡、Codex 额度卡按「try again at」到点收起。库都是临时的。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dismissFromCard } from "../src/bridge/ask-dismiss.js";
import { sweepExpired } from "../src/bridge/ask-expire.js";
import { noteRuntimeDialogs, openRuntimeAsk, resetRuntimeAsksForTest, staleAuqCard } from "../src/bridge/ask-runtime.js";
import { listForWeb, setAsksForTest, type AsksDeps } from "../src/bridge/asks.js";
import type { Envelope } from "../src/bridge/router.js";
import { codexExpiry, codexQuotaText, reuseOf, runtimeFingerprint } from "../src/lib/ask-fingerprint.js";
import { answerAsk, getAsk, listAsks, openAsk, patchAsk, type Ask, type NewAsk } from "../src/lib/ledger-asks.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import { guest, owner } from "./asks-test-kit.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const REGISTRY = [{ name: "agent-x", channelId: "111", status: "active", projectId: "p" } as RegistryAgent];
let path = "";
let delivered: Envelope[] = [];
let editFails = false;

beforeEach(() => {
  path = tempLedgerPath("ask-dismiss-");
  openLedger(path);
  delivered = [];
  editFails = false;
  const deps: AsksDeps = {
    clients: new Map([["111", { ws: {} as never }]]), controlChannelId: "999", hold: () => {},
    deliver: async (env) => (delivered.push(env), { envelope: env, outcome: { kind: "sent" } }),
    editDiscord: async () => {
      if (editFails) throw new Error("Discord unavailable");
    },
  };
  setAsksForTest({ path, deps, registry: REGISTRY, ownerChats: ["api:owner:self"] });
  resetRuntimeAsksForTest();
});
afterEach(() => {
  setAsksForTest(undefined);
  closeLedger(path);
});

const db = () => openLedger(path);
const reply = (over: Partial<NewAsk> = {}): Ask =>
  openAsk(db(), { project: "p", fromAgent: "agent-x", fromChannelId: "111", source: "reply", kind: "decide", title: "发吗", chatId: "api:owner:self", ...over });
const dismiss = (a: Ask, p = owner()) => dismissFromCard("p", a.id, p);
const texts = () => delivered.map((e) => e.content);

/** Codex 窗口末尾的额度报错行（原屏形状同 tests/runtime-dialogs.test.ts） */
const limitLine = (at: string) =>
  `You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at ${at}.`;
const codexPane = (line: string) => ["• 我先跑一遍测试。", "", `■ ${line}`, "", "› ", "  gpt-5.6 high · 100% left · ~/repo"].join("\n");
const tick = async (pane: string | null) => {
  noteRuntimeDialogs("111", "agent-x", pane ?? "• 继续干活", null, "codex");
  await Bun.sleep(15);
};
const codexRows = () => listAsks(db(), { source: "codex" });
const auqRows = () => listAsks(db(), { source: "auq" });
const auq = (labels: string[]) => ({
  source: "auq" as const, channelId: "111", agentName: "agent-x", kind: "decide" as const, title: "Choose action", context: "Choose action",
  options: [{ question: "Choose action", options: labels.map((label) => ({ label })) }],
});

describe("三类卡删掉的效果", () => {
  test("agent 发起的：撤销、记 owner 删掉，告诉发起方没作答（不是按未批准的那句）", async () => {
    const a = reply();
    expect((await dismiss(a)).status).toBe(200);
    expect(getAsk(db(), a.id)).toMatchObject({ state: "cancelled", extra: { dismissed: { by: "owner:self" } } });
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain(`owner 删掉了你`);
    expect(texts()[0]).toContain("没作答");
    expect(texts()[0]).not.toContain("按未批准");
  });

  test("authorize 删掉 = 不批准：通知写明按未批准处理", async () => {
    await dismiss(reply({ kind: "authorize", title: "打 tag" }));
    expect(texts()[0]).toContain("按未批准处理");
  });

  test("运行时弹框卡：只收起，不往终端发任何东西、也不通知 agent", async () => {
    await tick(codexPane(limitLine("8:41 AM")));
    const [c] = codexRows();
    expect((await dismiss(c!)).status).toBe(200);
    expect(getAsk(db(), c!.id)).toMatchObject({ state: "cancelled", extra: { dismissed: { by: "owner:self" } } });
    expect(delivered).toEqual([]);
  });

  test("已结案的：从网页列表隐藏，状态和答案不动", async () => {
    const a = reply();
    answerAsk(db(), a.id, { choices: [], labels: [], text: "好", principal: "owner:self", via: "web_card", at: Date.now(), final: true });
    await dismiss(a);
    expect(getAsk(db(), a.id)).toMatchObject({ state: "answered", answer: { text: "好" }, extra: { hidden: { by: "owner:self" } } });
    expect(listForWeb(() => true).map((x) => x.id)).not.toContain(a.id);
    expect(delivered).toEqual([]);
  });

  test("改 Discord 原消息失败（原消息删了 / 连不上）不挡通知发起方", async () => {
    const a = reply();
    patchAsk(db(), a.id, { discordMessageIds: ["d1"] });
    editFails = true;
    expect((await dismiss(getAsk(db(), a.id)!)).status).toBe(200);
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain("没作答");
  });

  test("只给 owner 本人的全权设备：guest、没有管理权的设备 403；别的项目 404", async () => {
    const a = reply();
    expect((await dismiss(a, guest("aa"))).status).toBe(403);
    expect((await dismiss(a, owner({ agents: ["*"], terminal: true, manage: false }))).status).toBe(403);
    expect((await dismissFromCard("other", a.id, owner())).status).toBe(404);
    expect(getAsk(db(), a.id)?.state).toBe("open");
  });
});

describe("指纹：同一个弹框重启沿用原卡，删过的不再冒出来", () => {
  const pane = codexPane(limitLine("8:41 AM"));

  test("重启（内存表丢了）后同一个弹框：认回原卡，不撤旧建新", async () => {
    await tick(pane);
    resetRuntimeAsksForTest();
    await tick(pane);
    expect(codexRows().map((a) => a.state)).toEqual(["open"]);
  });

  test("重启后还没看过屏幕（watcher 没起来 / 抓屏失败）：不撤卡、不记消失；看到弹框还在就认回原卡", async () => {
    await openRuntimeAsk(auq(["Yes", "No"]));
    const [a] = auqRows();
    resetRuntimeAsksForTest();
    await Bun.sleep(15);
    expect(getAsk(db(), a!.id)).toMatchObject({ state: "open" });
    expect(getAsk(db(), a!.id)!.extra.clearedAt).toBeUndefined();
    await openRuntimeAsk(auq(["Yes", "No"]));
    expect(auqRows().map((x) => [x.id, x.state])).toEqual([[a!.id, "open"]]);
  });

  test("重启后第一眼就是空屏：删过的也记上消失，同一行再出现开新卡", async () => {
    await tick(pane);
    await dismiss(codexRows()[0]!);
    resetRuntimeAsksForTest();
    await tick(null);
    await tick(pane);
    expect(codexRows().map((a) => a.state).sort()).toEqual(["cancelled", "open"]);
  });

  test("进程一直在跑、额度提示中间没空屏就换了一行：按新指纹开新卡，不被旧的占位挡住", async () => {
    await tick(pane);
    await dismiss(codexRows()[0]!);
    await tick(codexPane(limitLine("9:15 PM")));
    expect(codexRows().map((a) => a.state).sort()).toEqual(["cancelled", "open"]);
  });

  test("删过、弹框一直在：重启后不再开；弹框消失后再出现才是新的一次", async () => {
    await tick(pane);
    await dismiss(codexRows()[0]!);
    await tick(pane);
    resetRuntimeAsksForTest();
    await tick(pane);
    await tick(pane);
    expect(codexRows().map((a) => a.state)).toEqual(["cancelled"]);
    await tick(null); // 弹框没了
    await tick(pane);
    expect(codexRows().map((a) => a.state).sort()).toEqual(["cancelled", "open"]);
  });

  test("不同的一次额度用完（重置时间不同 = 那一行不同）不受之前删的影响", async () => {
    await tick(pane);
    await dismiss(codexRows()[0]!);
    resetRuntimeAsksForTest();
    await tick(codexPane(limitLine("9:15 PM")));
    expect(codexRows().filter((a) => a.state === "open")).toHaveLength(1);
  });

  test("判定表：开着的沿用；删过 / 额度卡到点、且弹框没消失过的不开；答过的、别的来源到期的、消失过的都开新的", () => {
    const row = (state: Ask["state"], extra: Record<string, unknown> = {}, source: Ask["source"] = "codex") => ({ state, source, extra });
    expect(reuseOf(null)).toBe("new");
    expect(reuseOf(row("open"))).toBe("adopt");
    expect(reuseOf(row("cancelled", { dismissed: { by: "o" } }))).toBe("suppress");
    expect(reuseOf(row("expired"))).toBe("suppress");
    expect(reuseOf(row("expired", {}, "permission"))).toBe("new");
    expect(reuseOf(row("cancelled", { dismissed: { by: "o" }, clearedAt: 1 }))).toBe("new");
    expect(reuseOf(row("answered"))).toBe("new");
    expect(runtimeFingerprint("codex", "agent-x", "r", "l")).toBe(runtimeFingerprint("codex", "x", "r", " l "));
    expect(runtimeFingerprint("codex", "x", "r", "l")).not.toBe(runtimeFingerprint("codex", "x", "r", "l2"));
  });
});

describe("AUQ 按下标作答：选项换了就是另一个弹框", () => {
  test("同名问题换了选项顺序：重启后不认回旧卡，旧卡撤掉；拿旧卡的 id 提交被拒", async () => {
    await openRuntimeAsk(auq(["Cancel", "Delete"]));
    const [old] = auqRows();
    resetRuntimeAsksForTest();
    const now = auq(["Delete", "Cancel"]);
    await openRuntimeAsk(now);
    const fresh = auqRows().find((a) => a.id !== old!.id)!;
    expect(getAsk(db(), old!.id)?.state).toBe("cancelled");
    expect(fresh.state).toBe("open");
    expect(staleAuqCard(old!.id, "111", now.options)).toBe(true);
    expect(staleAuqCard(fresh.id, "111", now.options)).toBe(false);
    expect(staleAuqCard(fresh.id, "222", now.options)).toBe(true);
    expect(staleAuqCard(undefined, "111", now.options)).toBe(false); // 聊天里的交互卡不带 askId，不查
  });

  test("进程一直在跑、换了选项：旧卡结掉、开新卡", async () => {
    await openRuntimeAsk(auq(["Cancel", "Delete"]));
    await openRuntimeAsk(auq(["Delete", "Cancel"]));
    expect(auqRows().map((a) => a.state).sort()).toEqual(["cancelled", "open"]);
  });
});

describe("Codex 额度卡按重置时间收起", () => {
  test("解析「try again at」：只有时刻的取将来最近那次；带日期的照日期；认不出的交给默认有效期", () => {
    const now = new Date(2026, 8, 29, 20, 0).getTime();
    expect(new Date(codexExpiry(limitLine("8:41 PM"), now)!).getHours()).toBe(20);
    expect(codexExpiry(limitLine("8:41 AM"), now)! - now).toBeGreaterThan(12 * 3600_000);
    expect(new Date(codexExpiry(limitLine("Sep 30th, 2026 9:05 AM"), now)!).getDate()).toBe(30);
    expect(codexExpiry("You've hit your usage limit. Upgrade to Pro.", now)).toBeUndefined();
  });

  test("额度卡正文只说几点恢复：原文（Upgrade 链接那行）只留在 extra.raw，解析不出就写「额度用完」", async () => {
    await tick(codexPane(limitLine("8:41 AM")));
    const [c] = codexRows();
    expect(c!.title).toBe("Codex 额度用完了");
    expect(c!.context).toMatch(/^(\d+月\d+日 )?08:41 恢复$/);
    expect(c!.extra).toMatchObject({ quota: true, raw: limitLine("8:41 AM") });
    resetRuntimeAsksForTest();
    await tick(codexPane("You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro)."));
    expect(codexRows().find((a) => a.id !== c!.id)?.context).toBe("额度用完");
  });

  test("恢复时间的写法：今天的只写时刻，别的日子带日期", () => {
    const now = new Date(2026, 8, 29, 20, 0).getTime();
    expect(codexQuotaText(new Date(2026, 8, 29, 23, 59).getTime(), now)).toBe("23:59 恢复");
    expect(codexQuotaText(new Date(2026, 8, 30, 9, 5).getTime(), now)).toBe("9月30日 09:05 恢复");
    expect(codexQuotaText(undefined, now)).toBe("额度用完");
  });

  test("到点由过期清扫收起、不通知 agent；弹框还挂着时重启不再开", async () => {
    await tick(codexPane(limitLine("8:41 AM")));
    const [c] = codexRows();
    expect(c!.expiresAt - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
    await sweepExpired(c!.expiresAt + 1);
    expect(getAsk(db(), c!.id)?.state).toBe("expired");
    expect(delivered).toEqual([]);
    resetRuntimeAsksForTest();
    await tick(codexPane(limitLine("8:41 AM")));
    expect(codexRows().map((a) => a.state)).toEqual(["expired"]);
  });
});
