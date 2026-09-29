/**
 * ACP 宿主的本体（入口 src/acp-host.ts 只接真实依赖和信号）。一个 agent 一个，跑在它的 tmux 窗口里：
 * - 连 bridge（BridgeLink，register 带 transport=acp），是这个频道唯一的登记者；reply 等工具经回环代理（tool-proxy）转上去；
 * - 起适配器（codex-acp / stub），接上 registry 里的线程；适配器退出 → 在途的都以失败收尾（session.ts），退避后重起、接回同一个线程；
 * - 入站按 CodexQueueSink 同款渲染（<channel …> + reply_via，重启后第一条附前言）后进回合循环（turn.ts）；
 * - 流式：session/update 翻成 CC 形状条目（updates.ts）推给 bridge；回合末先把剩下的推完（等 bridge 回包）再按 hook 契约上报 Stop；
 * - 失败：出结构化帧给 bridge 出卡（额度 / 登录 / 其它），同一个失败只出一次；权限请求转给 bridge 出卡、等 owner 点。
 * 所有外部动作注入，tests/acp-host.test.ts 用假适配器 + 假 bridge 跑整条链。
 */
import { codexReplyHint, wrapChannelContent } from "../codex-thread.js";
import { adapterEnv, type AdapterEnvSpec, type AdapterProc } from "./adapter-proc.js";
import type { BridgeLink, BridgeLinkDeps } from "./bridge-link.js";
import { modelStateEntry } from "./config.js";
import { classifyPromptError, failureEntry, FailureDedup, type AcpFailure } from "./failures.js";
import { AcpSession } from "./session.js";
import type { ToolProxy, ToolProxyDeps } from "./tool-proxy.js";
import { AcpTurnLoop, type StopReport } from "./turn.js";
import { createAcpTranslator } from "./updates.js";

export interface HostConfig {
  channelId: string;
  agentName: string;
  sessionId: string;
  cwd: string;
  mcpName: string;
  /** 重启 / 收编后第一条入站前附的前言（codex-launch.codexContextPreamble） */
  preamble?: string;
  model?: string;
  effort?: string;
  agentCmd: string[];
  env: Omit<AdapterEnvSpec, "channel">;
}

export interface HostDeps {
  spawn(cmd: string[], env: Record<string, string>, cwd: string): AdapterProc;
  makeLink(deps: Omit<BridgeLinkDeps, "url">): Pick<BridgeLink, "connect" | "send" | "request" | "close" | "up">;
  startProxy(deps: Omit<ToolProxyDeps, "port">): ToolProxy;
  postHook(body: { channelId: string } & StopReport): Promise<{ block?: boolean; reason?: string }>;
  markReady(): Promise<void>;
  log(msg: string): void;
}

const RESTART_BASE_MS = 3_000;
const RESTART_MAX_MS = 60_000;
/** 连续跑满这么久才把重起计数清零 */
const RESTART_STABLE_MS = 5 * 60_000;
const AUTH_RETRY_MS = 60_000;
/** prompt 等适配器接回线程最多这么久；等不到按失败收尾（带上最近一次起不来的原因） */
const SESSION_WAIT_MS = 120_000;
const PERMISSION_WAIT_MS = 10 * 60_000;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class AcpHost {
  private session: AcpSession | null = null;
  private proc: AdapterProc | null = null;
  private stopping = false;
  private restarts = 0;
  /** 起适配器 / 等不到会话的失败键用单调序号（同一毫秒两次失败不能被合成一张卡） */
  private startSeq = 0;
  private lastStartError: AcpFailure | null = null;
  private sessionWaiters: ((s: AcpSession | null) => void)[] = [];
  private preamblePending: string | undefined;
  private readyMarked = false;
  private registered = false;
  private readonly translator = createAcpTranslator();
  private readonly dedup = new FailureDedup();
  private readonly proxy: ToolProxy;
  private readonly link: ReturnType<HostDeps["makeLink"]>;
  readonly loop: AcpTurnLoop;

  constructor(private readonly cfg: HostConfig, private readonly deps: HostDeps) {
    this.preamblePending = cfg.preamble;
    this.proxy = deps.startProxy({ channelId: cfg.channelId, toBridge: (f) => this.link.send(f), log: (m) => deps.log(m) });
    this.link = deps.makeLink({
      registerFrame: () => ({
        type: "register", channelId: cfg.channelId, cwd: cfg.cwd, pid: process.pid, ppid: process.ppid,
        runtime: "codex", transport: "acp", agentName: cfg.agentName, sessionId: cfg.sessionId, abort: true,
      }),
      onFrame: (m) => this.onFrame(m),
      onRegistered: () => ((this.registered = true), deps.log("已在 bridge 登记"), void this.maybeReady()),
      onDown: (why) => ((this.registered = false), this.proxy.failInFlight(`宿主和 bridge 的连接断了（${why}）`)),
      log: deps.log,
    });
    this.loop = new AcpTurnLoop({
      prompt: async (text) => {
        const s = await this.waitSession();
        if (!s) return { kind: "failed", failure: this.lastStartError ?? { kind: "error", key: `nosession#${++this.startSeq}`, message: "ACP 适配器没起来" } };
        return s.prompt(text);
      },
      steer: (text) => (this.session?.steering ? this.session.steer(text) : Promise.resolve({ outcome: "failed" as const })),
      reportStop: (r) => this.reportStop(r),
      onFailure: (f) => this.fail(f),
      log: deps.log,
    });
  }

  start(): void {
    this.link.connect();
    void this.startAdapter();
  }

  /** SIGINT / SIGTERM / SIGHUP：停当前回合、关适配器（带走 app-server）、关代理和连接 */
  stop(): void {
    this.stopping = true;
    if (this.loop.busy) this.session?.cancel();
    this.proc?.stop();
    this.proxy.close();
    this.link.close();
    for (const w of this.sessionWaiters.splice(0)) w(null);
  }

  private async startAdapter(): Promise<void> {
    if (this.stopping) return;
    const env = adapterEnv({ ...this.cfg.env, channel: { channelId: this.cfg.channelId, proxyUrl: this.proxy.url, agentName: this.cfg.agentName, sessionId: this.cfg.sessionId } });
    const proc = this.deps.spawn(this.cfg.agentCmd, env, this.cfg.cwd);
    this.proc = proc;
    const session = new AcpSession(proc.wire, { onUpdate: (u) => this.onUpdate(u), onPermission: (card) => this.askPermission(card), log: this.deps.log });
    const startedAt = Date.now();
    void proc.exited.then((code) => this.onAdapterExit(session, code, startedAt));
    try {
      const caps = await session.initialize();
      await session.attach(this.cfg.sessionId, this.cfg.cwd, caps.resume);
      await this.applyLaunchConfig(session);
      this.session = session;
      this.lastStartError = null;
      this.deps.log(`已接上线程 ${this.cfg.sessionId.slice(0, 8)}（${caps.resume ? "session/resume" : "session/load"}${session.steering ? "，支持 steering" : ""}）`);
      this.publishConfig(session);
      for (const w of this.sessionWaiters.splice(0)) w(session);
      void this.maybeReady();
    } catch (e) {
      const f = classifyPromptError(e, `start#${++this.startSeq}`);
      this.lastStartError = f;
      this.deps.log(`适配器接不上线程：${f.message}`);
      this.fail(f);
      // 没登录也算「起来了」：宿主在、卡已出、消息会按失败收尾——不然 restart / 切 transport 要白等两分钟就绪超时
      if (f.kind === "auth") void this.maybeReady();
      proc.stop();
    }
  }

  /** registry 里钉的模型 / 推理强度：接上线程后经 set_config_option 补上（不在选项里只记日志，不拦启动） */
  private async applyLaunchConfig(s: AcpSession): Promise<void> {
    for (const [id, v] of [["model", this.cfg.model], ["reasoning_effort", this.cfg.effort]] as const) {
      if (!v) continue;
      const r = await s.setConfig(id, v);
      if (!r.ok) this.deps.log(`启动配置 ${id}=${v} 没生效：${r.error}`);
    }
  }

  private onAdapterExit(session: AcpSession, code: number, startedAt: number): void {
    if (this.session === session) this.session = null;
    if (this.stopping) return;
    if (Date.now() - startedAt > RESTART_STABLE_MS) this.restarts = 0;
    const auth = this.lastStartError?.kind === "auth";
    const delay = auth ? AUTH_RETRY_MS : Math.min(RESTART_BASE_MS * 2 ** Math.min(this.restarts++, 5), RESTART_MAX_MS);
    this.deps.log(`适配器退出了（code ${code}），${delay / 1000}s 后重起${auth ? "（等 owner 登录）" : ""}`);
    setTimeout(() => void this.startAdapter(), delay);
  }

  private waitSession(): Promise<AcpSession | null> {
    if (this.session) return Promise.resolve(this.session);
    if (this.lastStartError?.kind === "auth" || this.stopping) return Promise.resolve(null);
    return new Promise((resolve) => {
      const t = setTimeout(() => ((this.sessionWaiters = this.sessionWaiters.filter((w) => w !== done)), resolve(null)), SESSION_WAIT_MS);
      const done = (s: AcpSession | null) => (clearTimeout(t), resolve(s));
      this.sessionWaiters.push(done);
    });
  }

  private async maybeReady(): Promise<void> {
    if (this.readyMarked || !this.registered || !(this.session || this.lastStartError?.kind === "auth")) return;
    this.readyMarked = true;
    await this.deps.markReady().catch((e) => this.deps.log(`标窗口就绪失败：${errText(e)}`));
  }

  private onUpdate(u: Record<string, unknown>): void {
    const entries = this.translator.push(u);
    if (entries.length) this.pushEntries(entries);
  }

  /** 流式条目直接推；连接没好就丢（不补发：重连后接着推新的，历史照旧从 rollout 读） */
  private pushEntries(entries: Record<string, unknown>[]): void {
    if (!this.link.send({ channelId: this.cfg.channelId, type: "acp_entries", entries })) this.deps.log(`bridge 不在，丢掉 ${entries.length} 条流式条目`);
  }

  private async reportStop(r: StopReport): Promise<{ block?: boolean; reason?: string }> {
    const rest = this.translator.flush();
    // 等 bridge 把最后这批处理完再报 Stop：Stop 的 drain 要看到回合的收尾文字（ws 与 HTTP 两条路没有先后保证）
    if (rest.length) await this.link.request({ channelId: this.cfg.channelId, type: "acp_entries", entries: rest }).catch((e) => this.deps.log(`回合末条目没送到：${errText(e)}`));
    return this.deps.postHook({ channelId: this.cfg.channelId, ...r });
  }

  private fail(f: AcpFailure): void {
    if (!this.dedup.admit(f)) return;
    const entry = failureEntry(f, new Date().toISOString());
    if (entry) this.pushEntries([entry]);
    this.link.send({ channelId: this.cfg.channelId, type: "acp_failure", failure: f, configOptions: this.session?.configOptions ?? [] });
  }

  private async askPermission(card: unknown): Promise<string | null> {
    const frame = { channelId: this.cfg.channelId, type: "acp_permission", card };
    const r = await this.link.request<{ optionId?: string | null }>(frame, PERMISSION_WAIT_MS).catch((e) => (this.deps.log(`权限卡没答上：${errText(e)}`), null));
    return typeof r?.optionId === "string" ? r.optionId : null;
  }

  private onFrame(m: Record<string, any>): void {
    if (this.proxy.onBridgeFrame(m)) return;
    if (m.type === "message") return void this.inbound(String(m.content ?? ""), (m.meta ?? {}) as Record<string, string>);
    if (m.type === "abort") return this.abort(String(m.id ?? ""));
    if (m.type === "acp_call") return void this.call(m);
    if (m.type !== "rejected") this.deps.log(`bridge 发来不认识的帧：${String(m.type)}`);
  }

  private async inbound(content: string, meta: Record<string, string>): Promise<void> {
    const { after_interrupt: _drop, ...shown } = meta;
    const wrapped = wrapChannelContent(content, shown, this.cfg.mcpName, codexReplyHint(this.cfg.mcpName));
    const text = this.preamblePending ? `${this.preamblePending}\n\n${wrapped}` : wrapped;
    this.preamblePending = undefined;
    const how = await this.loop.submit(text);
    this.deps.log(`收到 ${meta.chat_id ?? "?"} 的消息（${meta.message_id ?? "?"}）→ ${how === "steer" ? "插进当前回合" : how === "prompt" ? "开一轮" : "排队"}`);
  }

  /** 停止：有回合在跑就 session/cancel；排着的消息照旧留着（下一轮处理） */
  private abort(id: string): void {
    const busy = this.loop.busy && !!this.session;
    if (busy) this.session!.cancel();
    this.link.send({ type: "abort_ack", id, result: busy ? "aborted" : "idle", voided: [], inEditor: 0 });
    this.deps.log(busy ? "收到停止：已调 session/cancel" : "收到停止：当前空闲");
  }

  /** bridge 发来的调用（改配置）：结果按 id 回 acp_call_result */
  private async call(m: Record<string, any>): Promise<void> {
    const reply = (body: Record<string, unknown>) => this.link.send({ channelId: this.cfg.channelId, type: "acp_call_result", id: m.id, ...body });
    if (m.op === "slash") return void (this.loop.submit(String(m.text ?? "")), reply({ ok: true })); // 原样当一轮 prompt，适配器自己认
    if (m.op !== "set_config") return void reply({ ok: false, error: `不认识的调用 ${String(m.op)}` });
    if (!this.session) return void reply({ ok: false, error: "ACP 适配器还没接上线程" });
    const r = await this.session.setConfig(String(m.configId), String(m.value));
    if (r.ok) this.deps.log(`已改 ${m.configId}=${m.value}（不重启）`);
    reply(r.ok ? { ok: true, configOptions: this.session.configOptions } : { ok: false, error: r.error });
    if (r.ok) this.publishConfig(this.session);
  }

  /** 配置变了：给 bridge 存一份（设置页 / 额度卡的选项），再推一条 model_state 条目让顶栏跟上 */
  private publishConfig(s: AcpSession): void {
    this.link.send({ channelId: this.cfg.channelId, type: "acp_config", configOptions: s.configOptions });
    const e = modelStateEntry(s.configOptions, new Date().toISOString());
    if (e) this.pushEntries([e]);
  }
}
