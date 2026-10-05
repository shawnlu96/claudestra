/**
 * ACP 协议版本与能力（lib/acp/protocol.ts，docs/runtimes/codex-acp.md「可选能力缺失时怎么降级」）：
 * - initialize 回包的判定表：版本不是 1 / 没回、接不回线程、要 fork 却没声明 → 不兼容；生产在用的 codex-acp 2.1.0 回包照常通过；
 * - 拒起走现有的失败通路：不可重试的 error、固定 key（一张卡），bridge 没登记上时登记后补发；create / fork 的引导同样拒；
 * - 可选能力降级表：每一行对真的 AcpHost + AcpSession + 翻译器（适配器是内存里的假 codex-acp），同一个场景有 / 没有这项能力各跑一遍。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { BridgeLinkDeps } from "../src/lib/acp/bridge-link.ts";
import { classifyPromptError, failureEntry } from "../src/lib/acp/failures.ts";
import { AcpHost } from "../src/lib/acp/host.ts";
import { ACP_PROTOCOL_VERSION, AcpIncompatibleError, checkInitialize } from "../src/lib/acp/protocol.ts";
import type { RpcWire } from "../src/lib/acp/rpc.ts";
import { withAttachmentLines } from "../src/lib/inbound-body.ts";
import { createCodexAcpAdapter } from "../src/lib/runtimes/codex-acp.ts";

type Rec = Record<string, any>;
const REPO = join(import.meta.dir, "..");
const SID = "019a0000-0000-7000-8000-0000000ca950";
const RESUMABLE = { loadSession: true, sessionCapabilities: { resume: {} } };

/** codex-acp 2.1.0 的 initialize 回包（照它 bundle 里 CodexAgent.initialize 的写法，_meta / authMethods 与判定无关从略） */
const CODEX_ACP_2_1_0 = {
  protocolVersion: 1,
  agentInfo: { name: "@agentclientprotocol/codex-acp", title: "Codex", version: "2.1.0" },
  agentCapabilities: {
    auth: { logout: {} }, providers: {}, loadSession: true, promptCapabilities: { embeddedContext: true, image: true },
    sessionCapabilities: { resume: {}, list: {}, close: {}, delete: {}, fork: {}, additionalDirectories: {}, subagents: {} },
    mcpCapabilities: { acp: false, http: true, sse: false },
  },
  _meta: { steering: { supported: true } },
};

describe("checkInitialize：initialize 回包判定", () => {
  const cases: [string, unknown, { fork?: boolean }, string | null][] = [
    ["codex-acp 2.1.0（生产在用）", CODEX_ACP_2_1_0, {}, null],
    ["codex-acp 2.1.0 要 fork", CODEX_ACP_2_1_0, { fork: true }, null],
    ["只有 loadSession（没有 resume）", { protocolVersion: 1, agentCapabilities: { loadSession: true } }, {}, null],
    ["Pi 适配器的形状（resume、没有 loadSession / fork）", { protocolVersion: 1, agentCapabilities: { loadSession: false, sessionCapabilities: { resume: {} } } }, {}, null],
    ["protocolVersion 2", { ...CODEX_ACP_2_1_0, protocolVersion: 2 }, {}, "initialize 回的 protocolVersion 是 2，宿主只讲 ACP v1"],
    ["protocolVersion 是字符串", { ...CODEX_ACP_2_1_0, protocolVersion: "1" }, {}, "protocolVersion 是 \"1\""],
    ["没有 protocolVersion", { agentCapabilities: RESUMABLE }, {}, "initialize 没回 protocolVersion"],
    ["回包不是对象", null, {}, "initialize 没回 protocolVersion"],
    ["resume 与 loadSession 都没有", { protocolVersion: 1, agentCapabilities: { loadSession: false, sessionCapabilities: {} } }, {}, "接不回已有线程"],
    ["要 fork 却没声明", { protocolVersion: 1, agentCapabilities: RESUMABLE }, { fork: true }, "没有声明 session/fork 能力"],
  ];
  for (const [what, result, need, refused] of cases) {
    test(`${what} → ${refused ? "不兼容" : "通过"}`, () => {
      const v = checkInitialize(result, need);
      expect(v.ok).toBe(refused === null);
      if (!v.ok) expect(v.reason).toContain(refused!);
    });
  }

  test("记下 agentInfo，拒起原因里带上适配器的名字和版本；codex-acp 2.1.0 的能力如实读出", () => {
    expect(checkInitialize(CODEX_ACP_2_1_0)).toEqual({ ok: true, resume: true, fork: true, agentInfo: { name: "@agentclientprotocol/codex-acp", version: "2.1.0" } });
    const v = checkInitialize({ ...CODEX_ACP_2_1_0, protocolVersion: 2 });
    expect(!v.ok && v.reason).toStartWith("ACP 适配器（@agentclientprotocol/codex-acp 2.1.0）协议不兼容，拒绝启动：");
    expect(checkInitialize({ protocolVersion: 1, agentInfo: { version: "1" }, agentCapabilities: RESUMABLE })).toMatchObject({ ok: true, agentInfo: null });
    expect(ACP_PROTOCOL_VERSION).toBe(1);
  });

  test("不兼容归成不可重试的 error、固定 key（一个宿主只出一张卡），错误条目不标 API 错误（不触发自动续跑）", () => {
    const f = classifyPromptError(new AcpIncompatibleError("ACP 适配器协议不兼容，拒绝启动：x"), "start#7");
    expect(f).toEqual({ kind: "error", key: "incompatible", message: "ACP 适配器协议不兼容，拒绝启动：x", retry: false });
    expect(classifyPromptError(new AcpIncompatibleError("y"), "start#8").key).toBe(f.key);
    expect(failureEntry(f, "T")).toMatchObject({ isApiErrorMessage: false, error: f.message });
  });
});

describe("create / fork 的引导也过协议检查（真 stub 子进程）", () => {
  test("适配器回 v2 → create 失败；没声明 fork → fork 失败；原因都写明", async () => {
    const saved = { agent: process.env.CLAUDESTRA_ACP_AGENT, init: process.env.STUB_INITIALIZE };
    process.env.CLAUDESTRA_ACP_AGENT = JSON.stringify([process.execPath, join(REPO, "scripts/acp-stub.ts")]);
    const adapter = createCodexAcpAdapter({ bunBin: process.execPath, repoRoot: REPO, resolveBin: async () => null });
    const spec = { channelId: "1", bridgeUrl: "ws://127.0.0.1:9", sessionId: SID, agentName: "agent-proto", cwd: REPO };
    try {
      process.env.STUB_INITIALIZE = JSON.stringify({ protocolVersion: 2 });
      await expect(adapter.prepareSession!({ ...spec, mode: "new" })).rejects.toThrow("protocolVersion 是 2");
      process.env.STUB_INITIALIZE = JSON.stringify({ agentCapabilities: { sessionCapabilities: { fork: null } } });
      await expect(adapter.prepareSession!({ ...spec, mode: "fork" })).rejects.toThrow("没有声明 session/fork 能力");
    } finally {
      for (const [k, v] of [["CLAUDESTRA_ACP_AGENT", saved.agent], ["STUB_INITIALIZE", saved.init]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }, 30_000);
});

// —— 内存里的假 codex-acp + 真 AcpHost ——

type Io = { update(u: Rec): void; status(type: string): void; reply(result: Rec): void; error(e: Rec): void };
type Turn = (io: Io) => void;

const finish = (io: Io, result: Rec = { stopReason: "end_turn" }) => (io.status("idle"), io.reply(result));
const plainTurn: Turn = (io) => (io.status("active"), io.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "好" } }), finish(io));

/** initialize 回 init；session/prompt 正文带 [hold] 的挂着等 release，其余交给 turn；记下宿主发来的每一条 */
function fakeAgent(init: Rec, turn: Turn = plainTurn) {
  const sent: Rec[] = [];
  const held: Io[] = [];
  let onData: (c: string) => void = () => {};
  const send = (m: Rec) => queueMicrotask(() => onData(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`));
  const update = (u: Rec) => send({ method: "session/update", params: { sessionId: SID, update: u } });
  const status = (type: string) => update({ sessionUpdate: "session_info_update", _meta: { codex: { threadStatus: { type } } } });
  const wire: RpcWire = {
    write(line) {
      const m = JSON.parse(line);
      sent.push(m);
      const reply = (result: Rec) => send({ id: m.id, result });
      if (m.method === "initialize") reply(init);
      else if (m.method === "session/resume" || m.method === "session/load") reply({ configOptions: [] });
      else if (m.method === "_session/steering") reply({ outcome: "injected" });
      else if (m.method === "_claudestra/cancel") reply({ cleared: [] });
      else if (m.method === "session/prompt") {
        const io: Io = { update, status, reply, error: (error) => send({ id: m.id, error }) };
        if (String(m.params.prompt[0]?.text).includes("[hold]")) io.status("active"), held.push(io);
        else turn(io);
      }
    },
    onData: (cb) => void (onData = cb as (c: string) => void),
    onClose: () => {},
    close: () => {},
  };
  const got = (method: string, text?: string) => sent.some((m) => m.method === method && (!text || JSON.stringify(m.params).includes(text)));
  return { wire, sent, got, release: (result?: Rec) => finish(held.shift()!, result) };
}

let host: AcpHost | null = null;
afterEach(() => {
  host?.stop();
  host = null;
});

async function until(cond: () => boolean, what: string, ms = 3_000) {
  for (const end = Date.now() + ms; !cond(); await Bun.sleep(5)) if (Date.now() > end) throw new Error(`等不到：${what}`);
}

/** 真 AcpHost 接假适配器；bridge 连接是假的：登记之前 send 返回 false、帧丢掉（和 BridgeLink 一样），register:false 时由单测手动登记 */
function boot(agent: ReturnType<typeof fakeAgent>, o: { register?: boolean } = {}) {
  const frames: Rec[] = [];
  const stops: Rec[] = [];
  const logs: string[] = [];
  let link!: Omit<BridgeLinkDeps, "url">;
  let up = false;
  let ready = false;
  const register = () => ((up = true), link.onRegistered());
  host = new AcpHost(
    {
      channelId: "local-acp-proto", agentName: "agent-acp-proto", sessionId: SID, cwd: "/tmp", mcpName: "claudestra", agentCmd: ["fake"],
      env: { base: {}, bunBin: "bun", channelServer: "x", mcpName: "claudestra", logsDir: "/tmp" }, timings: { retryMs: [5], drainMs: 1_000 },
    },
    {
      spawn: () => ({ wire: agent.wire, stop() {}, exited: new Promise(() => {}) }),
      makeLink: (d) => ((link = d), {
        connect: () => void (o.register !== false && setTimeout(register, 0)),
        send: (f: Rec) => (up && frames.push(f), up),
        request: async (f: Rec) => (frames.push(f), f.type === "acp_entries" ? true : null),
        close() {},
        get up() { return up; },
      }) as any,
      startProxy: () => ({ url: "ws://127.0.0.1:1/?t=x", onBridgeFrame: () => false, failInFlight() {}, close() {} }) as any,
      postHook: async (b) => (stops.push(b), {}),
      markReady: async () => void (ready = true),
      rotateSession: async () => ({ ok: true }),
      log: (m) => logs.push(m),
    },
  );
  host.start();
  const entries = () => frames.filter((f) => f.type === "acp_entries").flatMap((f) => f.entries);
  const inbound = (content: string, message_id = "m1") => link.onFrame({ type: "message", content, meta: { chat_id: "api:owner", message_id } });
  return { frames, stops, logs, entries, inbound, register, frame: (m: Rec) => link.onFrame(m), isReady: () => ready };
}

describe("拒起：bridge 还没登记上时那张卡不丢", () => {
  test("拒起那一刻连接没好 → 登记后补发同一张卡；不标就绪，回合当场按失败收尾", async () => {
    const h = boot(fakeAgent({ protocolVersion: 2, agentCapabilities: RESUMABLE }), { register: false });
    await until(() => h.logs.some((l) => l.includes("协议不兼容，拒绝启动")), "宿主拒起");
    expect(h.frames.filter((f) => f.type === "acp_failure")).toEqual([]);
    h.register();
    await until(() => h.frames.some((f) => f.type === "acp_failure"), "登记后补发的卡");
    expect(h.frames.find((f) => f.type === "acp_failure")!.failure).toMatchObject({ kind: "error", key: "incompatible", retry: false });
    h.inbound("在吗");
    await until(() => h.stops.length === 1, "回合收尾");
    expect(h.stops[0]).toMatchObject({ event: "StopFailure" });
    expect(h.isReady()).toBe(false);
  });
});

// —— 可选能力降级表：与 docs/runtimes/codex-acp.md「可选能力缺失时怎么降级」逐行对应 ——

type Booted = ReturnType<typeof boot> & { agent: ReturnType<typeof fakeAgent> };
const BASE_INIT = { protocolVersion: 1, agentInfo: { name: "fake-codex-acp", version: "0" }, agentCapabilities: RESUMABLE };
const toolUses = (h: Booted) => h.entries().flatMap((e) => e.message?.content ?? []).filter((b: Rec) => b.type === "tool_use").map((b: Rec) => b.name);
const toolResults = (h: Booted) => h.entries().flatMap((e) => e.message?.content ?? []).filter((b: Rec) => b.type === "tool_result").map((b: Rec) => b.content);
const failure = (h: Booted) => h.frames.find((f) => f.type === "acp_failure")?.failure;
const LIMIT = "You've hit your usage limit.";

interface Row {
  cap: string;
  rule: string;
  /** 有这项能力时 initialize 回包多出来的字段 */
  init?: Rec;
  /** 适配器这一轮怎么跑（has = 有这项能力） */
  turn?: (has: boolean) => Turn;
  check(h: Booted, has: boolean): Promise<void>;
}

const ROWS: Row[] = [
  {
    cap: "steering", rule: "忙时的消息排队，等这一轮结束再当下一轮 prompt 发",
    init: { _meta: { steering: { supported: true } } },
    async check(h, has) {
      h.inbound("[hold] 先做 A", "m1");
      await until(() => h.agent.got("session/prompt", "先做 A"), "第一轮");
      h.inbound("补充 B", "m2");
      await until(() => h.logs.some((l) => l.includes("m2")), "第二条消息的去向");
      expect(h.logs.find((l) => l.includes("m2"))).toContain(has ? "插进当前回合" : "排队");
      expect(h.agent.got("_session/steering")).toBe(has);
      h.agent.release();
      if (!has) await until(() => h.agent.got("session/prompt", "补充 B"), "排队的消息成了下一轮");
    },
  },
  {
    cap: "cancelReturnsQueue", rule: "叫停改发 session/cancel 通知，回执的作废列表为空",
    init: { _meta: { claudestra: { cancelReturnsQueue: true } } },
    async check(h, has) {
      h.inbound("[hold] 慢活");
      await until(() => h.agent.got("session/prompt", "慢活"), "回合开始");
      h.frame({ type: "abort", id: "a1" });
      await until(() => h.frames.some((f) => f.type === "abort_ack"), "打断回执");
      expect(h.agent.got("_claudestra/cancel")).toBe(has);
      expect(h.agent.sent.some((m) => m.method === "session/cancel" && m.id === undefined)).toBe(!has);
      expect(h.frames.find((f) => f.type === "abort_ack")).toMatchObject({ result: "aborted", voided: [] });
      h.agent.release({ stopReason: "cancelled" });
    },
  },
  {
    cap: "compaction_update", rule: "压缩照样由适配器做，但不出压缩边界（只看到一个「Compact conversation」工具调用）",
    turn: (has) => (io) => {
      io.status("active");
      if (has) for (const status of ["in_progress", "completed"]) io.update({ sessionUpdate: "compaction_update", compactionId: "c1", status });
      else io.update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Compact conversation", kind: "think", status: "in_progress" });
      if (!has) io.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" });
      finish(io);
    },
    async check(h, has) {
      h.inbound("压缩一下");
      await until(() => h.stops.length === 1, "回合收尾");
      expect(h.entries().filter((e) => e.subtype === "compact_boundary")).toHaveLength(has ? 1 : 0);
      expect(toolUses(h).includes("Compact conversation")).toBe(!has);
    },
  },
  {
    cap: "AIR sessionFailure", rule: "按 legacy 认失败：只有额度用完（JSON-RPC 错误带 usageLimitExceeded）认得出，按回合去重",
    turn: (has) => (io) => {
      io.status("active");
      const sessionFailure = { id: "f1:error", revision: 1, category: "limit", severity: "error", title: LIMIT, actions: [] };
      if (has) return finish(io, { stopReason: "end_turn", _meta: { jetbrains: { air: { version: 1, sessionFailure } } } });
      io.status("idle");
      io.error({ code: -32603, message: "Internal error", data: { message: LIMIT, codexErrorInfo: "usageLimitExceeded" } });
    },
    async check(h, has) {
      h.inbound("干活");
      await until(() => h.stops.length === 1, "回合收尾");
      expect(failure(h)).toMatchObject({ kind: "quota", message: LIMIT });
      expect(failure(h).key).toStartWith(has ? "air:f1:error" : "quota:");
    },
  },
  {
    cap: "terminal_output_delta", rule: "看不到命令输出，工具结果只剩适配器收尾时给的内容 / 退出码",
    turn: (has) => (io) => {
      io.status("active");
      io.update({ sessionUpdate: "tool_call", toolCallId: "t1", kind: "execute", title: "echo hi", status: "in_progress" });
      if (has) io.update({ sessionUpdate: "tool_call_update", toolCallId: "t1", _meta: { terminal_output_delta: { data: "hi\n", terminal_id: "t1" } } });
      io.update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: { exit_code: 0 } });
      finish(io);
    },
    async check(h, has) {
      h.inbound("跑个命令");
      await until(() => h.stops.length === 1, "回合收尾");
      expect(toolResults(h)).toEqual([has ? "hi\n" : "exit 0"]);
    },
  },
  {
    cap: "promptCapabilities.image", rule: "附件只以本地路径写进正文（有这项能力也一样：宿主还不发图片块）",
    init: { agentCapabilities: { ...RESUMABLE, promptCapabilities: { image: true } } },
    async check(h) {
      h.inbound(withAttachmentLines("看这张图", ["/tmp/acp-proto/a.png"]));
      await until(() => h.stops.length === 1, "回合收尾");
      const blocks = h.agent.sent.find((m) => m.method === "session/prompt")!.params.prompt;
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("text");
      expect(blocks[0].text).toContain("[attachment: /tmp/acp-proto/a.png]");
    },
  },
];

describe("可选能力缺失时怎么降级（表驱动，真宿主）", () => {
  for (const row of ROWS) {
    test(`${row.cap}：缺了 → ${row.rule}`, async () => {
      for (const has of [true, false]) {
        const agent = fakeAgent({ ...BASE_INIT, ...(has ? row.init : {}) }, row.turn?.(has));
        const h = { ...boot(agent), agent };
        await until(h.isReady, "宿主接上线程");
        await row.check(h, has);
        host?.stop();
        host = null;
      }
    });
  }
});
