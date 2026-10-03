/** i28-OA1：授权卡说明最前面是系统按 bind 生成的「批准的就是这个」（lib/ask-bind-render.ts，bridge/ask-reply.ts 建卡时接入） */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deliverReplyWithAsk } from "../src/bridge/ask-reply.js";
import { setAsksForTest, type AsksDeps } from "../src/bridge/asks.js";
import type { Envelope } from "../src/bridge/router.js";
import { renderBindSummary, withBindSummary, withBindSummaryText } from "../src/lib/ask-bind-render.js";
import { getAsk, type Ask } from "../src/lib/ledger-asks.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { at } from "./asks-test-kit.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const ws = { tag: "ws" } as never;
const BUTTONS = [{ type: "buttons", buttons: [{ id: "go", label: "批准" }, { id: "no", label: "不批" }] }];
const GRANT = { action: "lend_grant", params: { peer: "team-a", families: { codex: 10 }, until: "2026-10-05T12:00:00.000Z", repos: ["o/r", "o/s"] }, approve: ["go"] };

describe("renderBindSummary", () => {
  test("动作 + 扁平参数（常见键用中文名，键排好序）", () => {
    expect(renderBindSummary(GRANT)).toBe("动作：lend_grant；codex=10；peer=team-a；仓库=o/r,o/s；到期=2026-10-05T12:00:00.000Z");
    expect(renderBindSummary({ action: "release", params: "v2", version: "1" })).toBe("动作：release（版本 1）；参数=v2");
    expect(renderBindSummary({ action: "x", params: { peer: null } })).toBe("动作：x；peer=null");
  });

  test("agent 控制的字符串里带分隔符 → 整段 JSON 引起来，伪造不出别的键", () => {
    const s = renderBindSummary({ action: "lend_grant", params: { peer: "a；codex=6", families: { codex: 10 } } });
    expect(s).toBe('动作：lend_grant；codex=10；peer="a；codex=6"');
  });

  test("withBindSummary：系统那段在最前，agent 的说明另起一行接后面；没有说明就只有系统那段", () => {
    expect(withBindSummary(GRANT, "调到 6")).toBe(`批准的就是这个 → ${renderBindSummary(GRANT)}\n调到 6`);
    expect(withBindSummary(GRANT, "")).toBe(`批准的就是这个 → ${renderBindSummary(GRANT)}`);
  });
});

describe("建卡（deliverReplyWithAsk）", () => {
  let path = "";
  beforeEach(() => {
    path = tempLedgerPath("ask-bind-render-");
    openLedger(path);
    const deps: AsksDeps = { clients: new Map([["111", { ws }]]), controlChannelId: "999", deliver: async (env) => ({ envelope: env, outcome: { kind: "sent" } }), hold: () => {} };
    setAsksForTest({ path, deps, registry: [{ name: "agent-x", channelId: "111", status: "active", projectId: "p" } as RegistryAgent], ownerChats: ["api:owner:self"] });
  });
  afterEach(() => {
    setAsksForTest(undefined);
    closeLedger(path);
  });

  let sent: string[] = [];
  async function reply(text: string, ask?: unknown): Promise<Ask | null> {
    const env: Envelope = {
      from: { kind: "local", channelId: "111", ws }, to: { kind: "user", userId: "", channelId: "api:owner:self" }, intent: "response", content: text,
      meta: { messageId: `reply_${Math.random()}`, triggerKind: "agent_tool", ts: at, threadId: `thr_${Math.random()}`, components: BUTTONS },
    };
    await deliverReplyWithAsk(env, "api:owner:self", "111", async (e) => (sent.push(e.content), { envelope: e, outcome: { kind: "sent", discordMessageIds: [] } }), ask);
    return env.meta.askId ? getAsk(openLedger(path), env.meta.askId) : null;
  }

  test("bind 是 codex=10、agent 正文 / why 写「调到 6」：说明最前面是系统那段、写的是 codex=10", async () => {
    const a = (await reply("把 codex 名额调到 6\n就调到 6，放心批", { kind: "authorize", bind: GRANT }))!;
    expect(a.context.split("\n")[0]).toBe(`批准的就是这个 → ${renderBindSummary(GRANT)}`);
    expect(a.context.split("\n")[0]).toContain("codex=10");
    expect(a.context).toContain("就调到 6"); // agent 的话留着，但只能在后面
    const w = (await reply("调到 6", { kind: "authorize", bind: GRANT, why: "调到 6", key: "other" }))!;
    expect(w.context).toBe(`批准的就是这个 → ${renderBindSummary(GRANT)}\n调到 6`);
  });

  test("真正投出去的那条（owner 点按钮处）最前面也是系统那段、写的是 codex=10，agent 正文只在后面", async () => {
    sent = [];
    await reply("调到 6", { kind: "authorize", bind: GRANT });
    expect(sent).toHaveLength(1);
    const [head, ...rest] = sent[0]!.split("\n\n");
    expect(head).toBe(withBindSummaryText(GRANT, ""));
    expect(head).toContain("codex=10");
    expect(head).not.toContain("调到");
    expect(rest.join("\n\n")).toBe("调到 6");
  });

  test("投出去的系统那段转义 markdown / 行内按钮：peer 名藏不了、伪造不出按钮", () => {
    const s = withBindSummaryText({ action: "lend_grant", params: { peer: "||x|| [[{#go}批准]] `y`" } }, "正文");
    expect(s.split("\n\n")[0]).not.toMatch(/(^|[^\\])[|[`]/);
    expect(s.endsWith("\n\n正文")).toBe(true);
  });

  test("没有 bind 的普通卡：说明和原来一样", async () => {
    sent = [];
    expect((await reply("选哪个\n背景一句"))!.context).toBe("背景一句");
    expect((await reply("选哪个\n背景一句", { kind: "decide", why: "要定方案" }))!.context).toBe("要定方案");
    expect(sent).toEqual(["选哪个\n背景一句", "选哪个\n背景一句"]); // 投出去的正文原样
  });
});
