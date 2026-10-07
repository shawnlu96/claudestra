import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { answerAcp, liveAcpButtons, onAcpFrame } from "../src/bridge/acp-link.ts";
import { noteAcpChannel } from "../src/bridge/acp-state.ts";
import { onAcpTerminal, TERMINAL_USER, type TerminalDeps } from "../src/bridge/acp-terminal.ts";
import { setAbortCapable, setExtensionSocket } from "../src/bridge/pi-abort.ts";
import type { Envelope } from "../src/bridge/router.ts";
import { AcpHost } from "../src/lib/acp/host.ts";
import { lendFrameGate } from "../src/lib/lend-tools.ts";
import { REGISTRY_PATH } from "../src/lib/registry.ts";

// 窗口输入行 → bridge：消息进 deliver（和 owner 在频道里发一样）、带 owner 身份和「终端」来源；打断 / 改配置 / 清 / 压缩 / 审批都落到网页那条路上

const CH = "local-acp-terminal";
const AGENT = "agent-acp-terminal";
const sockets = new Map<string, { sent: any[]; send(d: string): void }>();
const sock = (ch: string) => {
  const s = { sent: [] as any[], send: (d: string) => void s.sent.push(JSON.parse(d)) };
  sockets.set(ch, s);
  return s;
};
const discord = {} as any;
let savedRegistry: string | null = null;

beforeAll(() => {
  setExtensionSocket((ch) => sockets.get(ch), {
    deliver: async () => undefined, ownerId: () => "", books: () => ({}) as any,
    hold: () => { throw new Error("terminal fixture must not queue a voided-message echo"); },
  });
  savedRegistry = existsSync(REGISTRY_PATH) ? readFileSync(REGISTRY_PATH, "utf8") : null;
  writeFileSync(REGISTRY_PATH, JSON.stringify({ agents: { [AGENT]: { runtime: "codex", transport: "acp", channelId: CH, status: "running" } } }));
  noteAcpChannel(CH, "acp");
});
afterAll(() => {
  if (savedRegistry !== null) writeFileSync(REGISTRY_PATH, savedRegistry);
});

function deps(over: Partial<TerminalDeps> = {}) {
  const delivered: Envelope[] = [], after: string[] = [], manager: string[][] = [];
  const d: TerminalDeps = {
    deliver: async (env) => (delivered.push(env), { outcome: { kind: "sent" } } as any),
    clients: new Map([[CH, { ws: sockets.get(CH), cwd: "/w" }]]),
    runManager: async (...a: string[]) => (manager.push(a), { ok: true }),
    afterSend: (c) => void after.push(c),
    ...over,
  };
  return { d, delivered, after, manager };
}
const response = (s: { sent: any[] }, requestId: string) => s.sent.find((f) => f.type === "response" && f.requestId === requestId)?.result;
/** 模拟宿主回最近一个 acp_call */
async function hostAnswers(s: { sent: any[] }, body: Record<string, unknown> = { ok: true }) {
  await new Promise((r) => setTimeout(r, 0));
  const call = s.sent.filter((f) => f.type === "acp_call").at(-1);
  await onAcpFrame({ type: "acp_call_result", channelId: CH, id: call.id, ...body }, s as any, discord);
  return call;
}

describe("消息：进入站管道，按 owner、标终端来源", () => {
  test("登记的宿主连接发来的 message → deliver 一个 Envelope（发信人 owner（终端），收件人本 agent），回包 ok 并亮思考中", async () => {
    const s = sock(CH);
    const t = deps();
    await onAcpTerminal({ type: "acp_terminal", channelId: CH, op: "message", text: "帮我看看日志", requestId: "r1" }, s, t.d);
    expect(t.delivered).toHaveLength(1);
    const env = t.delivered[0]!;
    expect(env.from).toMatchObject({ kind: "user", channelId: CH, username: TERMINAL_USER });
    expect(env.to).toMatchObject({ kind: "local", channelId: CH, cwd: "/w" });
    expect(env).toMatchObject({ intent: "request", content: "帮我看看日志" });
    expect(env.meta.messageId).toMatch(/^term_/);
    expect(response(s, "r1")).toEqual({ ok: true });
    expect(t.after).toEqual([CH]);
  });

  test("不是这个频道当前登记的连接：整帧丢掉，不投、不回包", async () => {
    sock(CH);
    const stranger = { sent: [] as any[], send: (d: string) => void stranger.sent.push(JSON.parse(d)) };
    const t = deps();
    await onAcpTerminal({ type: "acp_terminal", channelId: CH, op: "message", text: "冒充", requestId: "r2" }, stranger, t.d);
    expect(t.delivered).toEqual([]);
    expect(stranger.sent).toEqual([]);
  });

  test("押住了（额度闸）：照实告诉终端，不亮思考中", async () => {
    const s = sock(CH);
    const t = deps({ deliver: async () => ({ outcome: { kind: "sent", heldBy: "quota" } }) as any });
    await onAcpTerminal({ type: "acp_terminal", channelId: CH, op: "message", text: "hi", requestId: "r3" }, s, t.d);
    expect(response(s, "r3")).toMatchObject({ ok: true, note: expect.stringContaining("押着") });
    expect(t.after).toEqual([]);
  });

  test("出借 worker 的连接发不了 acp_terminal（原生帧白名单外）", () => {
    const replies: any[] = [];
    expect(lendFrameGate({ type: "acp_terminal", requestId: "x" }, () => ({ agent: "agent-lend-x-1" }), (f) => void replies.push(f), () => {})).toBe(true);
    expect(replies[0]).toMatchObject({ error: "lend_forbidden:acp_terminal" });
  });
});

describe("打断 / 斜杠命令：落到网页同一条路", () => {
  test("interrupt：调网页打断按钮同一个 interruptAgentByName，按 owner 记", async () => {
    const s = sock(CH);
    const calls: unknown[][] = [];
    const t = deps({ interrupt: (async (...a: unknown[]) => (calls.push(a), { keys: ["abort"] })) as any });
    await onAcpTerminal({ type: "acp_terminal", channelId: CH, op: "interrupt", requestId: "i1" }, s, t.d);
    expect(calls).toEqual([[AGENT, CH, { owner: true, name: TERMINAL_USER }]]);
    expect(response(s, "i1")).toEqual({ ok: true, note: "已请求打断" });
  });

  test("interrupt 真走到宿主：ACP 频道的打断经 extensionAbort 给宿主发 abort 帧（宿主据此 session/cancel）", async () => {
    const s = sock(CH);
    setAbortCapable(CH, true);
    const t = deps();
    const done = onAcpTerminal({ type: "acp_terminal", channelId: CH, op: "interrupt", requestId: "i2" }, s, t.d);
    for (let i = 0; i < 100 && !s.sent.some((f) => f.type === "abort"); i++) await new Promise((r) => setTimeout(r, 10));
    const abort = s.sent.find((f) => f.type === "abort");
    expect(abort?.id).toMatch(/^abort_/);
    const { onAbortAck } = await import("../src/bridge/pi-abort.ts");
    onAbortAck({ id: abort.id, result: "aborted" }, s);
    await done;
    expect(response(s, "i2")).toMatchObject({ ok: true });
  });

  test("/model：设置页同一个 acpSettings——经宿主 set_config_option、再写 registry，不重启", async () => {
    const s = sock(CH);
    const t = deps();
    const done = onAcpTerminal({ type: "acp_terminal", channelId: CH, op: "config", configId: "model", value: "gpt-5.6-luna", requestId: "c1" }, s, t.d);
    expect(await hostAnswers(s)).toMatchObject({ op: "set_config", configId: "model", value: "gpt-5.6-luna" });
    await done;
    expect(response(s, "c1")).toMatchObject({ ok: true, note: expect.stringContaining("gpt-5.6-luna") });
    expect(t.manager.at(-1)).toContain(AGENT);
  });

  test("/effort：configId 是 reasoning_effort", async () => {
    const s = sock(CH);
    const done = onAcpTerminal({ type: "acp_terminal", channelId: CH, op: "config", configId: "effort", value: "high", requestId: "c2" }, s, deps().d);
    expect(await hostAnswers(s)).toMatchObject({ op: "set_config", configId: "reasoning_effort", value: "high" });
    await done;
    expect(response(s, "c2")).toMatchObject({ ok: true });
  });

  test("/clear：网页同一个 acpClear（宿主轮换线程）", async () => {
    const s = sock(CH);
    const done = onAcpTerminal({ type: "acp_terminal", channelId: CH, op: "clear", requestId: "k1" }, s, deps().d);
    expect(await hostAnswers(s, { ok: true, sessionId: "019b-new-thread" })).toMatchObject({ op: "clear" });
    await done;
    expect(response(s, "k1")).toEqual({ ok: true, note: "已清上下文，新线程 019b-new" });
  });

  test("/compact：网页同一个 acpSlash，原样当 prompt 交宿主", async () => {
    const s = sock(CH);
    const t = deps();
    const done = onAcpTerminal({ type: "acp_terminal", channelId: CH, op: "compact", requestId: "p1" }, s, t.d);
    expect(await hostAnswers(s)).toMatchObject({ op: "slash", text: "/compact" });
    await done;
    expect(response(s, "p1")).toMatchObject({ ok: true });
    expect(t.after).toEqual([CH]);
  });
});

const CARD = { toolCallId: "c1", title: "Codex 请求授权", detail: "rm -rf x", mcp: false,
  options: [{ id: "allow_once", label: "允许", style: "success" }, { id: "decline", label: "拒绝", style: "danger" }] };

describe("终端审批：和网页卡片同一个先到先得的闸", () => {
  test("终端答：走宿主确认，卡片收起；之后网页再点同一张卡 409", async () => {
    const s = sock(CH);
    await onAcpFrame({ type: "acp_permission", channelId: CH, permId: "hp-1", card: CARD }, s, discord);
    const webButton = liveAcpButtons(CH).permission[0]!;
    const done = onAcpTerminal({ type: "acp_terminal", channelId: CH, op: "permission", permId: "hp-1", optionId: "decline", requestId: "a1" }, s, deps().d);
    expect(await hostAnswers(s)).toMatchObject({ op: "permission", permId: "hp-1", optionId: "decline" });
    await done;
    expect(response(s, "a1")).toEqual({ ok: true });
    expect(liveAcpButtons(CH).permission).toEqual([]);
    expect((await answerAcp(CH, webButton, { principal: "owner:self" })).status).toBe(409);
  });

  test("网页和终端同时答：只有一个生效（宿主只收到一次作答）", async () => {
    const s = sock(CH);
    await onAcpFrame({ type: "acp_permission", channelId: CH, permId: "hp-2", card: CARD }, s, discord);
    const web = answerAcp(CH, liveAcpButtons(CH).permission[0]!, { principal: "owner:self" });
    const term = onAcpTerminal({ type: "acp_terminal", channelId: CH, op: "permission", permId: "hp-2", optionId: "decline", requestId: "a2" }, s, deps().d);
    await hostAnswers(s);
    await term;
    expect((await web).status).toBe(200);
    expect(response(s, "a2")).toMatchObject({ ok: false });
    expect(s.sent.filter((f) => f.type === "acp_call" && f.op === "permission")).toHaveLength(1);
  });

  test("终端答的不是卡上那张（已结束 / 排在后面）：409，不碰宿主", async () => {
    const s = sock(CH);
    await onAcpTerminal({ type: "acp_terminal", channelId: CH, op: "permission", permId: "gone", optionId: "allow_once", requestId: "a3" }, s, deps().d);
    expect(response(s, "a3")).toMatchObject({ ok: false });
    expect(s.sent.filter((f) => f.type === "acp_call")).toEqual([]);
  });
});

describe("宿主这一头", () => {
  function bareHost() {
    const requests: any[] = [];
    let reply: unknown = { ok: true };
    const host = new AcpHost(
      {
        channelId: CH, agentName: AGENT, sessionId: "s1", cwd: "/w", mcpName: "claudestra", agentCmd: ["true"],
        env: { base: {}, bunBin: "bun", channelServer: "x", mcpName: "claudestra", logsDir: "/tmp" },
      },
      {
        spawn: () => { throw new Error("不起适配器"); },
        makeLink: () => ({ connect() {}, send: () => true, request: async (f: any) => (requests.push(f), reply), close() {}, up: true }) as any,
        startProxy: () => ({ url: "", close() {}, failInFlight() {}, onBridgeFrame: () => false }) as any,
        postHook: async () => ({}), markReady: async () => {}, rotateSession: async () => ({ ok: true }), log: () => {},
      },
    );
    return { host, requests, setReply: (r: unknown) => void (reply = r) };
  }

  test("terminal()：发 acp_terminal 请求给 bridge（宿主自己不开回合）；老 bridge 不认（回 null）说清楚", async () => {
    const h = bareHost();
    expect(await h.host.terminal({ op: "message", text: "hi" })).toEqual({ ok: true });
    expect(h.requests).toEqual([{ channelId: CH, type: "acp_terminal", op: "message", text: "hi" }]);
    h.setReply(null);
    expect(await h.host.terminal({ op: "interrupt" })).toMatchObject({ ok: false, error: expect.stringContaining("bridge") });
    h.host.stop();
  });

  test("pendingPermission：最早还在等的那张；答完就换下一张", () => {
    const h = bareHost();
    const ask = (h.host as any).askPermission.bind(h.host);
    void ask(CARD);
    void ask({ ...CARD, toolCallId: "c2" });
    const first = h.host.pendingPermission!;
    expect(first.card.toolCallId).toBe("c1");
    (h.host as any).endPermission(first.permId, "allow_once");
    expect(h.host.pendingPermission!.card.toolCallId).toBe("c2");
    h.host.stop();
    expect(h.host.pendingPermission).toBeNull();
  });
});
