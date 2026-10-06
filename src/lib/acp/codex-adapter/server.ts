/**
 * 自研 Codex ACP 适配器的 ACP 服务端（stdin/stdout 对宿主，app-server.ts 对 codex）。方法映射见设计 §2.1：
 * - initialize：握手只做一次（宿主 fork 前会再问一次能力），回 ACP v1、resume / fork、steering（B1、B2、B5）；
 * - session/new|resume|fork：共用会话变更闸（session-state.ts），new / resume 提交后进入待确认；失败带 previousSessionClosed（B56）；
 *   new / resume 在回合没收尾时直接回 -32600、不自动停旧回合：换掉线程后旧回合的收尾事件被线程过滤丢掉，旧 prompt 永远兑现不了、busy 也清不掉；
 * - session/prompt / _session/steering：回包经 ctx 在收尾时写（turns.ts），处理器返回的 promise 等到写完才兑现；
 * - 其余 ACP 方法回 -32601（rpc 缺省）；app-server 的反向请求在 CX-3 接授权卡之前一律按拒绝答，绝不挂起。
 * 线程过滤（B51、I7）：threadId 不是当前会话的通知不进回合状态机；缺 threadId 作废连接（I10）。tests/codex-adapter-session.test.ts。
 */
import { ACP_PROTOCOL_VERSION } from "../protocol.js";
import { createRpcPeer, RpcError, type RpcPeer, type RpcWire } from "../rpc.js";
import type { AppServer, NotificationEvent } from "./app-server.js";
import type { HostCaps } from "./events.js";
import type { ResultOf } from "./protocol.js";
import { type AdapterConfig, applyConfig, configOptions, type ModelState, modelStateOf, threadConfig } from "./session-config.js";
import { SessionState } from "./session-state.js";
import { type Ctx, type FatalCause, type Reconciler, Turns, type TurnTimings } from "./turns.js";

type Rec = Record<string, any>;

export interface ServerDeps {
  app: AppServer;
  cfg: AdapterConfig;
  log(msg: string): void;
  /** 走 I12 收尾（shutdown.ts），可重入 */
  fatal(c: FatalCause): void;
  /** 定向写进 MCP server 自己 env 的控制标记 [变量名, 值]（I12） */
  controlMark?: [string, string];
  reconcile?: Reconciler;
  onCommand?(): void;
  timings?: Partial<TurnTimings>;
  /** agentInfo.version：源码树短哈希（main.ts） */
  version: string;
}

const AUTH_REQUIRED = -32000;
const INVALID_REQUEST = -32600;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const MODEL_PAGES_MAX = 20;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const str = (v: unknown) => (typeof v === "string" ? v : "");

export class CodexAcpServer {
  readonly turns: Turns;
  private readonly acp: RpcPeer;
  private readonly session = new SessionState();
  private caps: HostCaps = { air: false, outputDelta: false, compaction: false };
  private handshake: Promise<unknown> | null = null;
  private stopped = false;
  private warnedThreads = false;

  constructor(wire: RpcWire, private readonly deps: ServerDeps) {
    const acp = (this.acp = createRpcPeer(wire, { log: deps.log }));
    this.turns = new Turns({
      app: deps.app, session: this.session, caps: () => this.caps, emit: (u) => this.emit(u), fatal: deps.fatal, log: deps.log,
      policy: () => ({ ...deps.cfg.policy, summary: "auto", effort: this.session.models?.effort ?? null, model: this.session.models?.model ?? "" }),
      reconcile: deps.reconcile, onCommand: deps.onCommand, timings: deps.timings,
    });
    acp.onRequest("initialize", (p: Rec) => this.initialize(p));
    acp.onRequest("session/new", (p: Rec) => this.open("new", p));
    acp.onRequest("session/resume", (p: Rec) => this.open("resume", p));
    acp.onRequest("session/fork", (p: Rec) => this.open("fork", p));
    acp.onRequest("session/prompt", (p: Rec, ctx) => this.turnRequest(p, ctx, (text, c) => this.turns.prompt(text, c)));
    acp.onRequest("_session/steering", (p: Rec, ctx) => this.turnRequest(p, ctx, (text, c) => this.turns.steer(text, c)));
    acp.onRequest("session/set_config_option", (p: Rec) => this.setConfig(p));
    acp.onNotification("session/cancel", (p: Rec) => this.cancel(p));
    acp.onClosed((why) => deps.fatal({ kind: "stop", why: `宿主断开了（${why}）` }));
    deps.app.onNotification((ev) => this.onAppEvent(ev));
    deps.app.onExit((why) => deps.fatal({ kind: "exit", why: `app-server 退出了（${why}）` }));
    this.refuseReverseRequests();
  }

  /** I12 ①：之后的请求一律 -32603 */
  stop(): void {
    this.stopped = true;
    this.turns.stop();
  }

  private live(): void {
    if (this.stopped) throw new RpcError(INTERNAL_ERROR, "Codex 适配器正在退出");
  }

  private async initialize(p: Rec): Promise<Rec> {
    this.live();
    const caps = p?.clientCapabilities ?? {};
    const air = caps?._meta?.jetbrains?.air?.capabilities;
    this.caps = { air: Array.isArray(air) && air.includes("sessionFailure"), outputDelta: caps?._meta?.terminal_output_delta === true, compaction: !!caps?.session?.compaction };
    const ci = p?.clientInfo ?? {};
    // clientInfo 透传宿主的（rollout 首行的 originator 跟它走，和 2.1.0 一致，B12）
    const clientInfo = { name: str(ci.name) || "claudestra-codex-acp", version: str(ci.version) || this.deps.version, title: str(ci.title) || "Codex ACP" };
    this.handshake ??= this.deps.app.initialize(clientInfo);
    try {
      await this.handshake;
    } catch (e) {
      this.deps.fatal({ kind: "exit", why: `app-server 握手失败：${errText(e)}` });
      throw new RpcError(INTERNAL_ERROR, `codex app-server 握手失败：${errText(e)}`);
    }
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentInfo: { name: "claudestra-codex-acp", version: this.deps.version },
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { resume: {}, fork: {} },
        mcpCapabilities: { http: false, sse: false },
      },
      authMethods: [],
      _meta: { steering: { supported: true } },
    };
  }

  /** new / resume 提交为当前线程（待确认）；fork 只建不切，宿主随后在新进程里 resume（B7–B11、B56） */
  private async open(kind: "new" | "resume" | "fork", p: Rec): Promise<Rec> {
    this.live();
    const cwd = str(p?.cwd);
    if (!cwd) throw new RpcError(INVALID_PARAMS, `session/${kind} 缺 cwd`);
    if (Array.isArray(p?.mcpServers) && p.mcpServers.length) throw new RpcError(INVALID_PARAMS, "不接受 ACP 的 mcpServers：channel-server 走 CODEX_CONFIG（B14）");
    const source = str(p?.sessionId);
    if (kind !== "new" && !source) throw new RpcError(INVALID_PARAMS, `session/${kind} 缺 sessionId`);
    if (kind !== "fork" && this.turns.busy) throw new RpcError(INVALID_REQUEST, `还有回合没收尾，不能 session/${kind}（先 cancel 并等它结束）`);
    const release = this.session.acquire(kind !== "fork");
    try {
      const config = threadConfig(this.deps.cfg.overlay, cwd, this.deps.controlMark);
      if (kind === "new") {
        await this.requireAuth();
        const r = await this.deps.app.call("thread/start", { config, modelProvider: null, cwd });
        return this.adopt(r.thread.id, await this.modelState(r), true);
      }
      if (kind === "resume") await this.requireAuth();
      const read = await this.deps.app.call("config/read", { includeLayers: false });
      const opened = { threadId: source, cwd, config, excludeTurns: true as const, modelProvider: read.config.model_provider ?? "openai" };
      if (kind === "resume") return this.adopt(source, await this.modelState(await this.deps.app.call("thread/resume", opened)), false);
      const r = await this.deps.app.call("thread/fork", opened);
      if (r.thread.id === source) throw new Error("thread/fork 返回的 id 和源线程相同");
      await this.deps.app.call("thread/unsubscribe", { threadId: r.thread.id }).catch((e) => this.deps.log(`fork 出的线程退订失败（宿主会在新进程里 resume 它）：${errText(e)}`));
      return { sessionId: r.thread.id, configOptions: configOptions(await this.modelState(r)) };
    } catch (e) {
      throw this.sessionError(e);
    } finally {
      release();
    }
  }

  private adopt(id: string, models: ModelState, withId: boolean): Rec {
    this.session.commit(id, models);
    return { ...(withId ? { sessionId: id } : {}), configOptions: configOptions(models) };
  }

  private async requireAuth(): Promise<void> {
    const a = await this.deps.app.call("account/read", { refreshToken: false });
    if (a.requiresOpenaiAuth && !a.account) throw new RpcError(AUTH_REQUIRED, "Authentication required");
  }

  /** 模型目录读完所有分页（B42）；目录空也照样给 model 一项 */
  private async modelState(r: ResultOf<"thread/start">): Promise<ModelState> {
    const models: ResultOf<"model/list">["data"] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MODEL_PAGES_MAX; page++) {
      const res: ResultOf<"model/list"> = await this.deps.app.call("model/list", { cursor, limit: null });
      models.push(...res.data);
      cursor = res.nextCursor ?? null;
      if (!cursor) break;
    }
    return modelStateOf(models, r.model, r.reasoningEffort);
  }

  /** 会话类请求的失败：我们自己的 RpcError 原样；app-server 的错误改写成可读的 -32603；旧线程放掉过就带 previousSessionClosed */
  private sessionError(e: unknown): RpcError {
    const extra = this.session.failureData() ?? {};
    if (e instanceof RpcError && e.code === AUTH_REQUIRED) return e;
    const msg = errText(e);
    if (/\bthread \S+ already has an active writer\b/.test(msg)) {
      return new RpcError(INTERNAL_ERROR, "这个 Codex 会话正被别的 Codex 客户端（Codex 应用、CLI 或 IDE 插件）占用，先在那边关掉再试（B9）", { reason: "thread_active_writer", ...extra });
    }
    return new RpcError(INTERNAL_ERROR, `codex app-server：${msg}`, Object.keys(extra).length ? extra : undefined);
  }

  /** prompt / steering：先表态会话（确认 / 回滚），只收 text 块（B52），回包由回合状态机经 ctx 写 */
  private turnRequest(p: Rec, ctx: Ctx, run: (text: string, ctx: Ctx) => void): Promise<void> {
    this.live();
    const blocks: unknown[] = Array.isArray(p?.prompt) ? p.prompt : [];
    if (!blocks.length || blocks.some((b: any) => b?.type !== "text" || typeof b.text !== "string")) throw new RpcError(INVALID_PARAMS, "只收 text 块");
    if (this.session.switching) throw new RpcError(INVALID_REQUEST, "会话切换还在进行，等它回包再发");
    this.touch(p?.sessionId);
    const text = blocks.map((b: any) => b.text as string).join("\n");
    return new Promise((resolve) => run(text, { respond: (r) => (ctx.respond(r), resolve()), fail: (e) => (ctx.fail(e), resolve()) }));
  }

  private touch(sessionId: unknown): void {
    const release = this.session.touch(sessionId);
    if (!release) return;
    this.deps.app.call("thread/unsubscribe", { threadId: release }).catch((e) => this.deps.log(`退订线程 ${release} 失败（它已不是当前会话，事件按线程过滤）：${errText(e)}`));
  }

  private setConfig(p: Rec): Rec {
    this.live();
    this.touch(p?.sessionId);
    if (!this.session.models) throw new RpcError(INVALID_PARAMS, "还没有会话");
    const next = applyConfig(this.session.models, p?.configId, p?.value);
    if (typeof next === "string") throw new RpcError(INVALID_PARAMS, next);
    this.session.models = next;
    return { configOptions: configOptions(next) };
  }

  /** cancel 通知不算会话表态；不是当前会话的直接丢 */
  private cancel(p: Rec): void {
    if (this.stopped || p?.sessionId !== this.session.current) return void this.deps.log(`忽略 session/cancel（${str(p?.sessionId) || "缺 sessionId"} 不是当前会话）`);
    this.turns.cancel();
  }

  private emit(update: Rec): void {
    if (this.session.current) this.acp.notify("session/update", { sessionId: this.session.current, update });
  }

  private onAppEvent(ev: NotificationEvent): void {
    const threadId = ev.corr.threadId;
    if (!threadId) return this.deps.fatal({ kind: "protocol", why: `app-server 的 ${ev.method} 缺 threadId` });
    if (threadId === this.session.current) return this.turns.onEvent(ev);
    if (threadId === this.session.previous) return;
    if (!this.warnedThreads) this.deps.log(`丢掉不是当前会话的线程事件（${ev.method}，子线程等，之后同类不再记）`);
    this.warnedThreads = true;
  }

  /** CX-3 之前没有授权卡：审批一律 cancel（fail closed），其余反向请求按「不给」答（§2.4） */
  private refuseReverseRequests(): void {
    const app = this.deps.app;
    const refuse = (what: string) => this.deps.log(`app-server 要${what}：这一版还没有授权卡，按拒绝（cancel）答`);
    app.handle("item/commandExecution/requestApproval", () => (refuse("执行命令的授权"), { decision: "cancel" as const }));
    app.handle("item/fileChange/requestApproval", () => (refuse("改文件的授权"), { decision: "cancel" as const }));
    app.handle("item/permissions/requestApproval", () => ({ permissions: {}, scope: "turn" as const, strictAutoReview: false as const }));
    app.handle("mcpServer/elicitation/request", () => ({ action: "cancel" as const, content: null, _meta: null }));
    app.handle("item/tool/requestUserInput", () => ({ answers: {} }));
  }
}
