/**
 * 自研 Codex 适配器的进程内测试台：假 codex app-server（内存线路、app-server 方言）+ 真实的 CodexAcpServer + 宿主真用的 AcpSession。
 * - 假 app-server 按 method 回包（on 覆盖；处理器返回 undefined = 由测试自己回），记下适配器发来的每条请求和每条输入（按 clientId 计数），
 *   thread/items/list 按它记的 userMessage 倒序分页；feed 把多条消息放进同一个 chunk（测 I3 的行序）。
 * - 两条 ACP 线路异步投递（同真实管道），适配器写给宿主的每一行按写出顺序记在 lines。
 * - fatal 缺省立即模拟收尾：stop + failAll（不起真进程树），原因记在 causes。
 */
import { createAppServer } from "../../src/lib/acp/codex-adapter/app-server.ts";
import { createReconciler } from "../../src/lib/acp/codex-adapter/delivery.ts";
import { CodexAcpServer } from "../../src/lib/acp/codex-adapter/server.ts";
import { parseAdapterEnv } from "../../src/lib/acp/codex-adapter/session-config.ts";
import type { FatalCause, TurnTimings } from "../../src/lib/acp/codex-adapter/turns.ts";
import type { RpcWire } from "../../src/lib/acp/rpc.ts";
import { AcpSession } from "../../src/lib/acp/session.ts";
import type { PromptOutcome } from "../../src/lib/acp/turn.ts";

export type Rec = Record<string, any>;
type Handler = (params: Rec, id: number) => unknown;

export const MODEL = {
  id: "gpt-x", model: "gpt-x", displayName: "GPT X", hidden: false, isDefault: true, defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }],
};
const opened = (id: string) => ({ thread: { id }, model: "gpt-x", modelProvider: "fake", reasoningEffort: null });

export function fakeApp() {
  const sent: Rec[] = [];
  const handlers = new Map<string, Handler>();
  const inputs = new Map<string, number>();
  const items: Rec[] = [];
  const replies = new Map<number, (m: Rec) => void>();
  let onData: (c: string) => void = () => {};
  let onClose: (why: string) => void = () => {};
  let seq = 0;
  let reverseId = 100;
  const feed = (...msgs: (Rec | string)[]) => onData(msgs.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join("\n") + "\n");
  const f = {
    sent,
    inputs,
    items,
    /** 当前在跑的回合（turn/start 回包时设、complete 时清） */
    turn: null as string | null,
    calls: (method: string) => sent.filter((m) => m.method === method && m.id !== undefined).map((m) => m.params),
    on: (method: string, h: Handler) => void handlers.set(method, h),
    feed,
    reply: (id: number, result: unknown) => feed({ id, result }),
    fail: (id: number, code: number, message: string) => feed({ id, error: { code, message } }),
    exit: (why = "exit 1") => onClose(why),
    nextTurn: () => `T${++seq}`,
    note: (method: string, params: Rec) => feed({ method, params, emittedAtMs: Date.now() }),
    started: (turnId: string) => f.note("turn/started", { threadId: f.thread, turn: { id: turnId, items: [], status: "inProgress" } }),
    /** 模型消费了这条输入：item/started userMessage 并记进 items/list */
    consume(turnId: string, clientId: string, text = "x") {
      const item = { type: "userMessage", id: `um-${clientId}`, clientId, content: [{ type: "text", text, text_elements: [] }] };
      items.push({ turnId, item, startedAtMs: Date.now(), completedAtMs: Date.now() });
      f.note("item/started", { threadId: f.thread, turnId, item });
    },
    text: (turnId: string, itemId: string, delta: string) => f.note("item/agentMessage/delta", { threadId: f.thread, turnId, itemId, delta }),
    complete(turnId: string, status = "completed", error?: Rec) {
      if (f.turn === turnId) f.turn = null;
      f.note("turn/completed", { threadId: f.thread, turn: { id: turnId, items: [], status, error: error ?? null } });
    },
    /** 反向请求：兑现适配器的回包 */
    request: (method: string, params: Rec) => new Promise<Rec>((resolve) => (replies.set(++reverseId, resolve), feed({ id: reverseId, method, params }))),
    thread: "th-1",
    wire: {
      write(line: string) {
        const m = JSON.parse(line);
        sent.push(m);
        if (m.method === undefined) return replies.get(m.id)?.(m);
        if (m.id === undefined) return;
        const clientId = m.params?.clientUserMessageId;
        if (clientId) inputs.set(clientId, (inputs.get(clientId) ?? 0) + 1);
        const h = handlers.get(m.method) ?? DEFAULTS[m.method];
        if (!h) return queueMicrotask(() => f.fail(m.id, -32601, `method not found: ${m.method}`));
        const r = h(m.params ?? {}, m.id);
        if (r !== undefined) queueMicrotask(() => f.reply(m.id, r));
      },
      onData: (cb) => void (onData = cb as (c: string) => void),
      onClose: (cb) => void (onClose = cb),
      close: (why) => onClose(why),
    } satisfies RpcWire,
  };
  const DEFAULTS: Record<string, Handler> = {
    initialize: () => ({ codexHome: "/tmp/fake", platformFamily: "unix", platformOs: "macos", userAgent: "fake" }),
    "account/read": () => ({ account: { type: "apiKey" }, requiresOpenaiAuth: false }),
    "config/read": () => ({ config: { model_provider: "fake" } }),
    "model/list": () => ({ data: [MODEL], nextCursor: null }),
    "thread/start": () => opened(f.thread),
    "thread/resume": (p) => opened(p.threadId),
    "thread/fork": () => opened(`fork-${++seq}`),
    "thread/unsubscribe": () => ({}),
    "thread/read": (p) => ({ thread: { id: p.threadId, status: { type: f.turn ? "active" : "idle" } } }),
    "thread/items/list": () => ({ data: [...items].reverse(), nextCursor: null }),
    "turn/start": () => ({ turn: { id: (f.turn = f.nextTurn()), items: [], status: "inProgress" } }),
    "turn/steer": () => (f.turn ? { turnId: f.turn } : undefined),
    "turn/interrupt": () => ({}),
    "thread/compact/start": () => ({}),
  };
  return f;
}
export type FakeApp = ReturnType<typeof fakeApp>;

/** 一对异步投递的内存线路：b 写的每一行按顺序记进 written */
function asyncPipe(): { a: RpcWire; b: RpcWire; written: string[] } {
  const ends = [{ data: (_: string) => {}, close: (_: string) => {} }, { data: (_: string) => {}, close: (_: string) => {} }];
  const written: string[] = [];
  const make = (me: number): RpcWire => ({
    write: (line) => {
      if (me === 1) written.push(line.trim());
      queueMicrotask(() => ends[1 - me]!.data(line));
    },
    onData: (cb) => void (ends[me]!.data = cb as (c: string) => void),
    onClose: (cb) => void (ends[me]!.close = cb),
    close: (why) => queueMicrotask(() => (ends[0]!.close(why), ends[1]!.close(why))),
  });
  return { a: make(0), b: make(1), written };
}

const FAST: Partial<TurnTimings> = { ackMs: 150, sysErrMs: 60, staleWaitMs: 120, interruptMs: 80, watchdogMs: 5_000 };

export interface HarnessOpts {
  fake?: FakeApp;
  env?: Record<string, string>;
  timings?: Partial<TurnTimings>;
  /** false = 不接对账（只看实时记录） */
  reconcile?: boolean;
  /** false = fatal 只记原因，不模拟收尾 */
  autoShutdown?: boolean;
  tail?: string;
  /** 宿主 initialize 声明的 AIR（缺省声明，同宿主真用的 CLIENT_CAPABILITIES） */
  air?: boolean;
  /** 宿主一侧的线路先过它再交给 AcpSession（共享契约套件用） */
  wrap?: (w: RpcWire) => RpcWire;
}

export function harness(o: HarnessOpts = {}) {
  const f = o.fake ?? fakeApp();
  const logs: string[] = [];
  const log = (m: string) => void logs.push(m);
  const app = createAppServer(f.wire, { log });
  const pipe = asyncPipe();
  const causes: FatalCause[] = [];
  const parsed = parseAdapterEnv({ CODEX_PATH: "/fake/codex", INITIAL_AGENT_MODE: "agent-full-access", ...o.env });
  if (!parsed.ok) throw new Error(parsed.why);
  let server: CodexAcpServer;
  const fatal = (c: FatalCause) => {
    causes.push(c);
    if (causes.length > 1 || o.autoShutdown === false) return;
    queueMicrotask(() => (server.stop(), server.turns.failAll(c, o.tail ?? "")));
  };
  const reconcile = o.reconcile === false ? undefined : createReconciler(app, log, { budgetMs: 400, minDelayMs: 10, retryMs: 10 });
  server = new CodexAcpServer(pipe.b, { app, cfg: parsed.cfg, log, fatal, version: "test", reconcile, timings: { ...FAST, ...o.timings }, controlMark: ["CLAUDESTRA_ACP_CONTROL", "ctl"] });
  const updates: Rec[] = [];
  const selfTurns: Promise<PromptOutcome>[] = [];
  const session = new AcpSession(o.wrap ? o.wrap(pipe.a) : pipe.a, { onUpdate: (u) => void updates.push(u), onPermission: async () => null, log, onSelfTurn: (d) => void selfTurns.push(d) });
  if (o.air === false) (session as any).rpc.request = wrapNoAir((session as any).rpc.request.bind((session as any).rpc));
  return {
    f, app, server, session, updates, selfTurns, causes, logs,
    /** 适配器写给宿主的每一行（解析后） */
    out: () => pipe.written.map((l) => JSON.parse(l) as Rec),
    /** 宿主看到的线程状态序列（active / idle） */
    statuses: () => updates.map((u) => u._meta?.codex?.threadStatus?.type).filter(Boolean) as string[],
    async open(id = "th-1") {
      f.thread = id;
      await session.initialize();
      await session.create("/w");
      return session;
    },
  };
}

/** 宿主不声明 AIR：把 initialize 请求里的 clientCapabilities._meta.jetbrains 去掉 */
function wrapNoAir(request: (m: string, p?: any, o?: any) => Promise<any>) {
  return (m: string, p?: any, o?: any) => {
    if (m !== "initialize") return request(m, p, o);
    const { jetbrains: _drop, ...meta } = p.clientCapabilities._meta;
    return request(m, { ...p, clientCapabilities: { ...p.clientCapabilities, _meta: meta } }, o);
  };
}

export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

export async function until(pred: () => boolean, what: string, ms = 2_000): Promise<void> {
  const t = Date.now();
  while (!pred()) {
    if (Date.now() - t > ms) throw new Error(`等不到：${what}`);
    await Bun.sleep(3);
  }
}
