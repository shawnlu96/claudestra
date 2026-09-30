import { beforeAll, describe, expect, test } from "bun:test";
import { acpClear, acpConfigOf, acpSetConfig, answerAcp, answerAcpDiscord, answerAcpResponse, liveAcpButtons, onAcpFrame, onAcpHostGone } from "../src/bridge/acp-link.ts";
import { noteAcpChannel } from "../src/bridge/acp-state.ts";
import { handleSlashPassthrough } from "../src/bridge/api-slash.ts";
import { subscribeEvents } from "../src/bridge/event-bus.ts";
import { drainChannelWatcher, pushEntries, startWatching, stopWatching, stopWatchingByChannel } from "../src/bridge/jsonl-watcher.ts";
import { setExtensionSocket } from "../src/bridge/pi-abort.ts";

// bridge 这一头：只认当前登记的那条连接；流式条目进 watcher 的推送模式；额度卡 / 权限卡的答案经宿主落地（不发键）

const CH = "local-acp-link";
const sockets = new Map<string, { sent: any[]; send(d: string): void }>();
const sock = (ch: string) => {
  const s = { sent: [] as any[], send: (d: string) => void s.sent.push(JSON.parse(d)) };
  sockets.set(ch, s);
  return s;
};
const discord = {} as any;
const CONFIG = [{ id: "model", name: "Model", type: "select", currentValue: "gpt-5.6-sol", options: [{ value: "gpt-5.6-sol", name: "sol" }, { value: "gpt-5.6-luna", name: "luna" }] }];
const who = { principal: "owner:self" };

beforeAll(() => {
  setExtensionSocket((ch) => sockets.get(ch), {
    deliver: async () => undefined, ownerId: () => "", books: () => ({}) as any,
    hold: () => { throw new Error("ACP link fixture must not queue a voided-message echo"); },
  });
});

describe("onAcpFrame", () => {
  test("不是这个频道当前登记的连接发的帧：丢掉", async () => {
    sock(CH);
    const stranger = { sent: [] as any[], send: () => {} };
    await onAcpFrame({ type: "acp_config", channelId: CH, configOptions: CONFIG }, stranger, discord);
    expect(acpConfigOf(CH)).toEqual([]);
    await onAcpFrame({ type: "acp_config", channelId: CH, configOptions: CONFIG }, sockets.get(CH)!, discord);
    expect(acpConfigOf(CH).map((o) => o.currentValue)).toEqual(["gpt-5.6-sol"]);
  });

  test("流式条目进推送模式的 watcher：发 tool_start（sid 带 acp: 前缀，前端不拿 rollout 游标比）；回合末那批按 requestId 回包", async () => {
    const s = sock(CH);
    noteAcpChannel(CH, "acp");
    await startWatching("agent-acp-link", "/w", "019a-sid", CH, discord, { runtime: "codex" });
    const events: any[] = [];
    const unsub = subscribeEvents({}, (e) => void (e.chatId === CH && events.push(e)));
    try {
      const entries = [{ type: "assistant", timestamp: "t", message: { content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } }] } }];
      await onAcpFrame({ type: "acp_entries", channelId: CH, hostId: "stream-host", firstSeq: 1, entries, requestId: "acphost_1" }, s, discord);
      const start = events.find((e) => e.type === "tool_start");
      expect(start?.data).toMatchObject({ toolId: "c1", name: "Bash", sid: "acp:019a-sid" });
      expect(s.sent.find((f) => f.requestId === "acphost_1")).toEqual({ type: "response", requestId: "acphost_1", result: true });
    } finally {
      unsub();
      stopWatching("agent-acp-link");
    }
  });
});


test("ACP 调用回包绑定频道、连接和 bridge 代际，旧回包不能完成别人的 clear", async () => {
  const a = sock("local-call-a");
  const b = sock("local-call-b");
  const pending = acpClear("local-call-b");
  const id = b.sent.at(-1)?.id;
  expect(id).toMatch(/^acpcall_[0-9a-f]{12}_\d+$/);
  let settled = false;
  void pending.then(() => { settled = true; });

  await onAcpFrame({ type: "acp_call_result", channelId: "local-call-a", id, ok: true, sessionId: "a-thread" }, a, discord);
  await onAcpFrame({ type: "acp_call_result", channelId: "local-call-b", id: "acpcall_000000000000_1",
    ok: true, sessionId: "old-epoch" }, b, discord);
  await Bun.sleep(0);
  expect(settled).toBe(false);

  const reconnected = sock("local-call-b");
  await onAcpFrame({ type: "acp_call_result", channelId: "local-call-b", id, ok: true, sessionId: "wrong-socket" }, reconnected, discord);
  await Bun.sleep(0);
  expect(settled).toBe(false);
  onAcpHostGone("local-call-b", b);
  expect(await pending).toMatchObject({ ok: false, uncertain: true });

  const next = acpClear("local-call-b");
  const nextId = reconnected.sent.at(-1)?.id;
  expect(nextId).not.toBe(id);
  await onAcpFrame({ type: "acp_call_result", channelId: "local-call-b", id: nextId,
    ok: true, sessionId: "b-thread" }, reconnected, discord);
  expect(await next).toEqual({ ok: true, sessionId: "b-thread" });
});


test("Web 聊天 /clear 确认后按会话清理动作返回，结果不确定时回 504", async () => {
  const ch = "local-web-clear-result";
  const s = sock(ch);
  noteAcpChannel(ch, "acp");
  const request = () => handleSlashPassthrough({
    principal: { id: "owner:self", role: "owner", name: "owner", agents: ["*"], createdAt: "2026-01-01T00:00:00Z" },
    tokenId: "owner:self", agent: { name: "agent-web-clear", channelId: ch, runtime: "codex", sessionId: "old-thread" }, text: "/clear", hasAttachments: false,
  }, { sendLine: async () => {}, mirror: async () => {}, scheduleClearRotation: () => {},
    markThinking: () => {}, record: () => {}, wallWait: async () => null });
  try {
    const success = request();
    await Bun.sleep(0);
    const firstId = s.sent.at(-1)?.id;
    await onAcpFrame({ type: "acp_call_result", channelId: ch, id: firstId, ok: true, sessionId: "new-thread" }, s, discord);
    expect((await success)?.status).toBe(200);
    const response = await success;
    expect(await response?.json()).toMatchObject({ ok: true, slash: true, clear: true, sessionId: "new-thread", previousSessionId: "old-thread" });
    const uncertain = request();
    await Bun.sleep(0);
    onAcpHostGone(ch, s);
    expect((await uncertain)?.status).toBe(504);
    const committedButUnbound = request();
    await Bun.sleep(0);
    const latestId = s.sent.at(-1)?.id;
    await onAcpFrame({ type: "acp_call_result", channelId: ch, id: latestId, ok: false,
      sessionId: "committed-thread", error: "watcher not ready" }, s, discord);
    const unknownResponse = await committedButUnbound;
    expect(unknownResponse?.status).toBe(504);
    expect(await unknownResponse?.json()).toMatchObject({ code: "clear_result_unknown", sessionId: "committed-thread" });
  } finally {
    noteAcpChannel(ch, "tmux");
  }
});

// Shawn 本机 Codex r4 P1-2 的 bridge 一侧：watcher 还没挂好（注册后要查 registry）回 false，宿主据此重送、不当成功；
// 重送的批次按 hostId + 条目序号跳过已经处理过的前缀（上次处理完、回包却丢了），换了宿主进程序号重来
describe("流式条目的确认与去重（r4 P1-2）", () => {
  const CH2 = "local-acp-seq";
  const tool = (id: string) => ({ type: "assistant", timestamp: "t", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: id } }] } });
  test("毒条目只记一次丢失：前面的正文不重复发，回包丢后重送仍带丢失标记", async () => {
    const ch = "local-acp-poison";
    const s = sock(ch);
    noteAcpChannel(ch, "acp");
    await startWatching("agent-acp-poison", "/w", "sid", ch, discord, { transport: "acp" });
    const texts: string[] = [];
    const unsub = subscribeEvents({}, (e) => void (e.chatId === ch && e.type === "assistant_text" && texts.push(String(e.data.text))));
    const entries = [
      { type: "assistant", message: { content: [{ type: "text", text: "好的正文" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: 42 }] } },
    ];
    try {
      for (const requestId of ["poison-1", "poison-retry"]) {
        await onAcpFrame({ type: "acp_entries", channelId: ch, hostId: "poison-host", firstSeq: 1, entries, requestId }, s, discord);
        expect(s.sent.find((f) => f.requestId === requestId)?.result).toMatchObject({ ok: true, lost: 1 });
      }
      expect(texts).toEqual(["好的正文"]);
    } finally {
      unsub();
      stopWatching("agent-acp-poison");
    }
  });
  test("没 watcher 回 false；同一宿主重送只处理没处理过的；新宿主进程从头算", async () => {
    const s = sock(CH2);
    noteAcpChannel(CH2, "acp");
    const send = async (hostId: string, firstSeq: number, ids: string[], rid: string) => {
      await onAcpFrame({ type: "acp_entries", channelId: CH2, hostId, firstSeq, entries: ids.map(tool), requestId: rid }, s, discord);
      return s.sent.find((f) => f.requestId === rid)?.result;
    };
    expect(await send("h1", 1, ["a"], "r0")).toBe(false);
    await startWatching("agent-acp-seq", "/w", "019a-seq", CH2, discord, { runtime: "codex" });
    const started: string[] = [];
    const unsub = subscribeEvents({}, (e) => void (e.chatId === CH2 && e.type === "tool_start" && started.push(String((e.data as { toolId?: unknown }).toolId))));
    try {
      expect(await send("h1", 1, ["a"], "r1")).toBe(true);
      expect(await send("h1", 1, ["a", "b"], "r2")).toBe(true);
      expect(await send("h1", 1, ["a", "b"], "r3")).toBe(true);
      expect(await send("h1", 4, ["gap"], "r-gap")).toMatchObject({ ok: true, lost: 1 }); // 缺口明确报丢失，不能永远拒收
      expect(await send("h2", 1, ["c"], "r4")).toBe(true);
      expect(started).toEqual(["a", "b", "gap", "c"]);
    } finally {
      unsub();
      stopWatching("agent-acp-seq");
    }
  });

  test("宿主重启换 hostId：新宿主从序号 1 重新接，旧宿主的序号不会污染新连接", async () => {
    const s = sock(CH2);
    noteAcpChannel(CH2, "acp");
    await startWatching("agent-acp-seq", "/w", "019a-seq", CH2, discord, { transport: "acp" });
    try {
      await onAcpFrame({ type: "acp_entries", channelId: CH2, hostId: "restarted-host", firstSeq: 1,
        entries: [tool("after-restart")], requestId: "r-restart" }, s, discord);
      expect(s.sent.find((f) => f.requestId === "r-restart")?.result).toBe(true);
    } finally {
      stopWatching("agent-acp-seq");
    }
  });

  test("bridge 重启后宿主从较大未确认序号续送：新 watcher 接住，宿主负责将这一轮标为不确定", async () => {
    const ch = "local-acp-bridge-cold";
    const s = sock(ch);
    await startWatching("agent-acp-bridge-cold", "/w", "sid", ch, discord, { transport: "acp" });
    try {
      await onAcpFrame({ type: "acp_entries", channelId: ch, hostId: "surviving-host", firstSeq: 25,
        entries: [tool("after-bridge-restart")], requestId: "r-cold" }, s, discord);
      expect(s.sent.find((f) => f.requestId === "r-cold")?.result).toBe(true);
    } finally {
      stopWatching("agent-acp-bridge-cold");
    }
  });

  test("并发重送等前批处理完才确认：不能在 watcher 忙时把新正文算作已收", async () => {
    const ch = "discord-acp-overlap";
    const s = sock(ch);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const fakeDiscord = { channels: { fetch: async () => ({ send: async () => (await blocked, { id: "fake-msg" }) }) } } as any;
    await startWatching("agent-acp-overlap", "/w", "sid", ch, fakeDiscord, { transport: "acp" });
    const events: any[] = [];
    const unsub = subscribeEvents({}, (e) => void (e.chatId === ch && events.push(e)));
    try {
      const first = onAcpFrame({ type: "acp_entries", channelId: ch, hostId: "same-host", firstSeq: 1,
        entries: [tool("slow-tool")], requestId: "first" }, s, fakeDiscord);
      await new Promise((r) => setTimeout(r, 10));
      const retry = onAcpFrame({ type: "acp_entries", channelId: ch, hostId: "same-host", firstSeq: 1,
        entries: [tool("slow-tool"), { type: "assistant", message: { content: [{ type: "text", text: "must arrive" }] } }], requestId: "retry" }, s, fakeDiscord);
      expect(s.sent).toEqual([]);
      release();
      await Promise.all([first, retry]);
      expect(s.sent.map((f) => [f.requestId, f.result])).toEqual([["first", true], ["retry", true]]);
      expect(events.some((e) => e.type === "assistant_text" && e.data.text === "must arrive")).toBe(true);
    } finally {
      release();
      unsub();
      stopWatching("agent-acp-overlap");
    }
  });

  test("换线程后旧批次即使全是已处理前缀也不确认", async () => {
    const ch = "local-acp-session-handoff";
    const s = sock(ch);
    noteAcpChannel(ch, "acp");
    await startWatching("agent-acp-handoff", "/w", "sid-old", ch, discord, { transport: "acp" });
    const oldBatch = { type: "acp_entries", channelId: ch, sessionId: "sid-old", hostId: "same-host",
      firstSeq: 1, entries: [tool("old")], requestId: "old-first" };
    try {
      await onAcpFrame(oldBatch, s, discord);
      expect(s.sent.find((f) => f.requestId === "old-first")?.result).toBe(true);
      await startWatching("agent-acp-handoff", "/w", "sid-new", ch, discord, { transport: "acp", rebind: true });
      await onAcpFrame({ ...oldBatch, requestId: "old-retry" }, s, discord);
      expect(s.sent.find((f) => f.requestId === "old-retry")?.result).toBe(false);
      await onAcpFrame({ ...oldBatch, sessionId: "sid-new", firstSeq: 2, entries: [tool("new")], requestId: "new" }, s, discord);
      expect(s.sent.find((f) => f.requestId === "new")?.result).toBe(true);
    } finally {
      stopWatching("agent-acp-handoff");
    }
  });
});

// outer-codex 合并时的探针（T60 r4 P1-2 补充）：宿主断线重连 / 重新登记会重建推送 watcher，没 flush 的正文跟着旧的丢了
// （drain 出来 text=null），序号也从 0 重来。现在同一会话沿用停下时收着的那份；换了会话才是新的
describe("推送 watcher 重建：未 flush 的正文不丢、序号不回退（r4 P1-2 补充）", () => {
  const CH3 = "local-acp-rebuild";
  const AG = "agent-acp-rebuild";
  const say = (t: string) => ({ type: "assistant", timestamp: new Date().toISOString(), message: { content: [{ type: "text", text: t }] } });
  test("断线后重新登记、直接重新登记：drain 拿得到正文，序号接着涨；换会话才从头", async () => {
    noteAcpChannel(CH3, "acp");
    const seqs: number[] = [];
    const unsub = subscribeEvents({}, (e) => void (e.chatId === CH3 && e.type === "assistant_text" && seqs.push(Number((e.data as { seq?: unknown }).seq))));
    try {
      await startWatching(AG, "/w", "sid-1", CH3, discord, { transport: "acp" });
      expect(await pushEntries(CH3, [say("新线程不能混进旧 watcher")], discord, "sid-2")).toEqual({ ok: false, lost: 0 });
      expect(await pushEntries(CH3, [say("第一段")], discord)).toEqual({ ok: true, lost: 0 });
      stopWatchingByChannel(CH3); // ws close
      expect(await pushEntries(CH3, [say("x")], discord)).toEqual({ ok: false, lost: 0 }); // 断着：宿主会留着重送
      await startWatching(AG, "/w", "sid-1", CH3, discord, { transport: "acp" });
      expect(await pushEntries(CH3, [say("第二段")], discord)).toEqual({ ok: true, lost: 0 });
      await startWatching(AG, "/w", "sid-1", CH3, discord, { transport: "acp" }); // 被顶替后直接重新登记
      expect((await drainChannelWatcher(CH3, discord)).text).toBe("第一段\n第二段");
      expect(seqs).toHaveLength(2);
      expect(seqs[1]!).toBeGreaterThan(seqs[0]!);
      await pushEntries(CH3, [say("第三段")], discord);
      expect(seqs[2]!).toBeGreaterThan(seqs[1]!);
      await startWatching(AG, "/w", "sid-2", CH3, discord, { transport: "acp", rebind: true }); // 换了会话：不沿用
      expect((await drainChannelWatcher(CH3, discord)).text).toBeNull();
    } finally {
      unsub();
      stopWatching(AG);
    }
  });
});

describe("额度卡：先「等重置」、只列其它模型、owner 点了才经宿主改", () => {
  const quota = (key: string, message: string) => ({ type: "acp_failure", channelId: CH, failure: { kind: "quota", key, message }, configOptions: CONFIG });
  test("切到某模型 → 宿主收到 set_config_option；等重置 → 什么都不改；答过的按钮 409", async () => {
    const s = sock(CH);
    await onAcpFrame(quota("air:t1", "You've hit your usage limit."), s, discord);
    const [, luna] = liveAcpButtons(CH).quota;
    await onAcpFrame(quota("air:t1", "You've hit your usage limit."), s, discord);
    expect(liveAcpButtons(CH).quota[1]).toBe(luna!); // 同一个失败又报一次：沿用这张卡，按钮不变
    const pending = answerAcp(CH, luna!, who);
    await new Promise((r) => setTimeout(r, 0));
    const call = s.sent.find((f) => f.type === "acp_call");
    expect(call).toMatchObject({ op: "set_config", configId: "model", value: "gpt-5.6-luna" });
    await onAcpFrame({ type: "acp_call_result", channelId: CH, id: call.id, ok: true, configOptions: CONFIG }, s, discord);
    expect(await pending).toEqual({ status: 200, body: { ok: true, model: "gpt-5.6-luna" } });
    expect((await answerAcp(CH, luna!, who)).status).toBe(409);

    await onAcpFrame(quota("air:t2", "limit"), s, discord);
    const before = s.sent.length;
    expect(await answerAcp(CH, liveAcpButtons(CH).quota[0]!, who)).toEqual({ status: 200, body: { ok: true, model: null } });
    expect(s.sent.length).toBe(before);
  });

  test("宿主拒了（选项不对等）→ 409 带原因，卡不结、按钮还能用", async () => {
    const s = sock(CH);
    await onAcpFrame(quota("air:t3", "limit"), s, discord);
    const luna = liveAcpButtons(CH).quota[1]!;
    const pending = answerAcp(CH, luna, who);
    await new Promise((r) => setTimeout(r, 0));
    const call = s.sent.filter((f) => f.type === "acp_call").at(-1);
    await onAcpFrame({ type: "acp_call_result", channelId: CH, id: call.id, ok: false, error: "Invalid params" }, s, discord);
    expect(await pending).toMatchObject({ status: 409, body: { error: expect.stringContaining("Invalid params") } });
    expect(liveAcpButtons(CH).quota[1]).toBe(luna);
    await answerAcp(CH, liveAcpButtons(CH).quota[0]!, who); // 收尾：等重置，结掉这张
  });

  // Shawn 本机 Codex r4 P1-1（额度卡按索引复用）：旧卡的第 i 个按钮不能落到新卡的第 i 个选项上
  test("换了一次失败就是新卡：旧卡的按钮 409、零调用；认领在第一个 await 之前，连点两下只算一下", async () => {
    const s = sock(CH);
    await onAcpFrame(quota("air:t4", "limit A"), s, discord);
    const old = liveAcpButtons(CH).quota;
    await onAcpFrame(quota("air:t5", "limit B"), s, discord);
    const fresh = liveAcpButtons(CH).quota;
    expect(fresh[1]).not.toBe(old[1]!);
    const calls = () => s.sent.filter((f) => f.type === "acp_call").length;
    const n = calls();
    expect(await answerAcp(CH, old[1]!, who)).toMatchObject({ status: 409, body: { code: "ask_stale" } });
    expect(await answerAcp(CH, "acp_quota_1", who)).toMatchObject({ status: 409 }); // 不带代际的老按钮
    expect(calls()).toBe(n);
    const first = answerAcp(CH, fresh[1]!, who);
    expect(await answerAcp(CH, fresh[1]!, who)).toMatchObject({ status: 409 });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls()).toBe(n + 1);
    await onAcpFrame({ type: "acp_call_result", channelId: CH, id: s.sent.filter((f) => f.type === "acp_call").at(-1).id, ok: true }, s, discord);
    expect((await first).status).toBe(200);
  });

  test("额度失败正文和选项相同、failure key 不同，也必须换代际", async () => {
    const s = sock(CH);
    await onAcpFrame(quota("air:same-a", "same limit"), s, discord);
    const old = liveAcpButtons(CH).quota[0]!;
    await onAcpFrame(quota("air:same-b", "same limit"), s, discord);
    expect(liveAcpButtons(CH).quota[0]).not.toBe(old);
    expect((await answerAcp(CH, old, who)).status).toBe(409);
    await answerAcp(CH, liveAcpButtons(CH).quota[0]!, who);
  });
});

const OPTIONS = [{ id: "allow_once", label: "Allow", style: "success" }, { id: "decline", label: "Decline", style: "danger" }];
const permCard = (id: string, title = "Codex 请求授权", detail = "rm -rf x") => ({ toolCallId: id, title, detail, mcp: false, options: OPTIONS });
const hostCalls = (s: { sent: any[] }) => s.sent.filter((f) => f.type === "acp_call" || f.type === "response");
/** 模拟宿主回 acp_call 的结果（还在等 = ok） */
async function hostAnswers(s: { sent: any[] }, ok: boolean) {
  await new Promise((r) => setTimeout(r, 0));
  const call = s.sent.filter((f) => f.type === "acp_call").at(-1);
  await onAcpFrame({ type: "acp_call_result", channelId: CH, id: call.id, ...(ok ? { ok: true } : { ok: false, error: "这个权限请求已经不在等了" }) }, s as any, discord);
  return call;
}

describe("权限卡：按钮带代际、排队、经宿主确认（r4 P1-1 / P2）", () => {
  test("点了卡上的选项 → acp_call 带 permId 交宿主，宿主确认还在等才 200；不在卡上的 → 409", async () => {
    const s = sock(CH);
    await onAcpFrame({ type: "acp_permission", channelId: CH, permId: "h1-1", card: permCard("c9") }, s, discord);
    const [, decline] = liveAcpButtons(CH).permission;
    expect((await answerAcp(CH, decline!.replace(/_decline$/, "_bogus"), who)).status).toBe(409);
    const pending = answerAcp(CH, decline!, who);
    expect(await hostAnswers(s, true)).toMatchObject({ op: "permission", permId: "h1-1", optionId: "decline" });
    expect(await pending).toEqual({ status: 200, body: { ok: true } });
    expect((await answerAcp(CH, decline!, who)).status).toBe(409);
    expect(liveAcpButtons(CH).permission).toEqual([]);
  });

  // 原探针：A（读）出卡，B（删）到了，拿 A 的按钮作答——不能落到 B 上
  test("旧卡的按钮批准不了新请求：不带代际的 409 零回包；A 的按钮只作用于 A，B 排在后面、另起新代际", async () => {
    const s = sock(CH);
    await onAcpFrame({ type: "acp_permission", channelId: CH, permId: "old", card: permCard("old-read", "Read file", "Read public file") }, s, discord);
    const aAllow = liveAcpButtons(CH).permission[0]!;
    await onAcpFrame({ type: "acp_permission", channelId: CH, permId: "new", card: permCard("new-delete", "Delete file", "Delete private file") }, s, discord);
    const n = hostCalls(s).length;
    expect(await answerAcp(CH, "acp_perm_allow_once", who)).toMatchObject({ status: 409 });
    expect(hostCalls(s).length).toBe(n);
    expect(liveAcpButtons(CH).permission[0]).toBe(aAllow); // 卡上还是 A
    const pending = answerAcp(CH, aAllow, who);
    expect(await hostAnswers(s, true)).toMatchObject({ permId: "old", optionId: "allow_once" });
    expect((await pending).status).toBe(200);
    const bAllow = liveAcpButtons(CH).permission[0]!;
    expect(bAllow).not.toBe(aAllow);
    const again = hostCalls(s).length;
    expect(await answerAcp(CH, aAllow, who)).toMatchObject({ status: 409, body: { code: "ask_stale" } });
    expect(hostCalls(s).length).toBe(again); // A 的按钮再点：零调用，B 没被批准
    const decline = answerAcp(CH, liveAcpButtons(CH).permission[1]!, who);
    expect(await hostAnswers(s, true)).toMatchObject({ permId: "new", optionId: "decline" });
    await decline;
  });

  test("题面一模一样的两个请求：代际不同，前一个答完它的按钮对后一个无效", async () => {
    const s = sock(CH);
    await onAcpFrame({ type: "acp_permission", channelId: CH, permId: "same-1", card: permCard("s1") }, s, discord);
    const first = liveAcpButtons(CH).permission[0]!;
    const p = answerAcp(CH, first, who);
    await hostAnswers(s, true);
    await p;
    await onAcpFrame({ type: "acp_permission", channelId: CH, permId: "same-2", card: permCard("s2") }, s, discord);
    const n = hostCalls(s).length;
    expect((await answerAcp(CH, first, who)).status).toBe(409);
    expect(hostCalls(s).length).toBe(n);
    await onAcpFrame({ type: "acp_permission", channelId: CH, permId: "same-2", gone: "测试收尾" }, s, discord);
  });

  test("Discord 原按钮和网页 answer API 都拒绝旧代际，不会把批准交给新请求", async () => {
    const s = sock(CH);
    await onAcpFrame({ type: "acp_permission", channelId: CH, permId: "entry-a", card: permCard("entry-a") }, s, discord);
    const old = liveAcpButtons(CH).permission[0]!;
    await onAcpFrame({ type: "acp_permission", channelId: CH, permId: "entry-a", gone: "旧请求取消" }, s, discord);
    await onAcpFrame({ type: "acp_permission", channelId: CH, permId: "entry-b", card: permCard("entry-b") }, s, discord);
    const before = hostCalls(s).length;
    const edits: string[] = [], whispers: string[] = [];
    expect((await answerAcpDiscord(CH, old, "owner", {
      edit: async (content) => void edits.push(content), whisper: async (content) => void whispers.push(content),
    }, "旧权限卡")).status).toBe(409);
    const web = await answerAcpResponse(CH, { action: old }, { id: "owner:self" });
    expect(web.status).toBe(409);
    expect(edits).toEqual([]);
    expect(whispers).toHaveLength(1);
    expect(hostCalls(s)).toHaveLength(before);
    await onAcpFrame({ type: "acp_permission", channelId: CH, permId: "entry-b", gone: "测试收尾" }, s, discord);
  });

  test("宿主超时 / 适配器退出发 gone：撤卡，之后点 409 零调用；宿主答「不在等了」→ 409、不记已答", async () => {
    const s = sock(CH);
    await onAcpFrame({ type: "acp_permission", channelId: CH, permId: "t-1", card: permCard("t1") }, s, discord);
    const allow = liveAcpButtons(CH).permission[0]!;
    await onAcpFrame({ type: "acp_permission", channelId: CH, permId: "t-1", gone: "等太久没人答" }, s, discord);
    expect(liveAcpButtons(CH).permission).toEqual([]);
    const n = hostCalls(s).length;
    expect((await answerAcp(CH, allow, who)).status).toBe(409);
    expect(hostCalls(s).length).toBe(n);

    await onAcpFrame({ type: "acp_permission", channelId: CH, permId: "t-2", card: permCard("t2") }, s, discord);
    const pending = answerAcp(CH, liveAcpButtons(CH).permission[0]!, who);
    await hostAnswers(s, false);
    expect(await pending).toMatchObject({ status: 409, body: { code: "ask_stale" } });
    expect(liveAcpButtons(CH).permission).toEqual([]);
  });

  test("宿主断线：它挂着的卡撤掉；重连后补发同一个 permId 出新卡（新代际），旧按钮 409", async () => {
    const s = sock(CH);
    await onAcpFrame({ type: "acp_permission", channelId: CH, permId: "d-1", card: permCard("d1") }, s, discord);
    const before = liveAcpButtons(CH).permission[0]!;
    onAcpHostGone(CH, s);
    expect(liveAcpButtons(CH).permission).toEqual([]);
    const s2 = sock(CH); // 重连：新连接登记为这个频道的宿主
    await onAcpFrame({ type: "acp_permission", channelId: CH, permId: "d-1", card: permCard("d1") }, s2, discord);
    const after = liveAcpButtons(CH).permission[0]!;
    expect(after).not.toBe(before);
    expect((await answerAcp(CH, before, who)).status).toBe(409);
    const pending = answerAcp(CH, after, who);
    expect(await hostAnswers(s2, true)).toMatchObject({ permId: "d-1" });
    expect((await pending).status).toBe(200);
  });

  test("宿主不在线：改配置直接失败，不挂着", async () => {
    expect(await acpSetConfig("local-nobody", "model", "x")).toEqual({ ok: false, error: "ACP 宿主不在线" });
    expect((await answerAcp(CH, "whatever", who)).status).toBe(400);
  });
});
