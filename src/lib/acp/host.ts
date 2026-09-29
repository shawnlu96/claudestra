/**
 * ACP 宿主的本体（入口 src/acp-host.ts 只接真实依赖和信号）。一个 agent 一个，跑在它的 tmux 窗口里：
 * - 连 bridge（BridgeLink，register 带 transport=acp），是这个频道唯一的登记者；reply 等工具经回环代理（tool-proxy）转上去；
 * - 起适配器（codex-acp / stub），接上 registry 里的线程；适配器退出 → 在途的都以失败收尾（session.ts），退避后重起、接回同一个线程；
 * - 入站按 CodexQueueSink 同款渲染（<channel …> + reply_via，重启后第一条附前言）后进回合循环（turn.ts）；
 * - 流式：session/update 翻成 CC 形状条目（updates.ts）进出站队列，按序号一批批推给 bridge，bridge 回 true 才出队；回 false
 *   （watcher 还没挂好）/ 断线 / 超时就留着退避重送，重连登记后接着送（bridge 按 hostId + 序号去重）。回合末等队列全被确认才报 Stop，
 *   等不到（或 bridge 太久不在、队列满了丢过）按 StopFailure 报——没确认的不能当成功；
 * - 失败：出结构化帧给 bridge 出卡（额度 / 登录 / 其它），同一个失败只出一次；
 * - 权限请求按 permId 交 bridge 出卡；owner 答了由 bridge 经 acp_call 回来（这里确认还在等才算数）；超时 / 适配器退出按取消回
 *   适配器并通知 bridge 撤卡；重连登记后把还在等的补发上去。
 * 所有外部动作注入，tests/acp-host.test.ts 用假适配器 + 假 bridge 跑整条链。
 */
import { randomBytes } from "node:crypto";
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
  /** 单测注入：出站条目的重送退避、回合末等确认的上限、权限卡等多久（缺省用下面的 TIMINGS） */
  timings?: Partial<typeof TIMINGS>;
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
/** 出站条目：一批最多几条、队列最多攒几条（bridge 太久不在就丢最老的，这一轮按 StopFailure 报）、单批等回包多久 */
const ENTRY_BATCH_MAX = 200;
const ENTRY_OUTBOX_MAX = 5_000;
const ENTRY_ACK_MS = 15_000;
const TIMINGS: { retryMs: readonly number[]; drainMs: number; permissionMs: number } = { retryMs: [250, 500, 1_000, 2_000, 5_000], drainMs: 90_000, permissionMs: 10 * 60_000 };

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
  /** 这个宿主进程的标识：bridge 按它 + 条目序号去重；permId 也以它开头 */
  private readonly hostId = randomBytes(6).toString("hex");
  private outbox: { seq: number; entry: Record<string, unknown> }[] = [];
  private entrySeq = 0;
  private droppedEntries = 0;
  private pumping = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private drainWaiters: (() => void)[] = [];
  private readonly permits = new Map<string, { frame: Record<string, unknown>; resolve: (optionId: string | null) => void; timer: ReturnType<typeof setTimeout> }>();
  private permSeq = 0;
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
      onRegistered: () => ((this.registered = true), deps.log("已在 bridge 登记"), this.resync(), void this.maybeReady()),
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
    for (const id of [...this.permits.keys()]) this.endPermission(id, null);
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
    for (const id of [...this.permits.keys()]) this.endPermission(id, null, "适配器退出了");
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

  /** 在 bridge 登记上了（首次 / 重连 / bridge 重启）：还在等的权限请求补发出卡，出站条目接着送 */
  private resync(): void {
    for (const p of this.permits.values()) this.link.send(p.frame);
    void this.pump();
  }

  /** 流式条目进出站队列，按序号送（pump）；队列满了丢最老的并记数，这一轮结束按 StopFailure 报 */
  private pushEntries(entries: Record<string, unknown>[]): void {
    for (const entry of entries) this.outbox.push({ seq: ++this.entrySeq, entry });
    const over = this.outbox.length - ENTRY_OUTBOX_MAX;
    if (over > 0) {
      this.outbox.splice(0, over);
      this.droppedEntries += over;
      this.deps.log(`bridge 太久没确认，出站条目超过 ${ENTRY_OUTBOX_MAX} 条：丢掉最老的 ${over} 条`);
    }
    void this.pump();
  }

  /** 队首一批一批送，bridge 回 true 才出队；false / 断线 / 超时就停下退避重送（登记上了也会接着送） */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.outbox.length && this.registered && !this.stopping) {
        const batch = this.outbox.slice(0, ENTRY_BATCH_MAX);
        const frame = { channelId: this.cfg.channelId, type: "acp_entries", hostId: this.hostId, firstSeq: batch[0]!.seq, entries: batch.map((b) => b.entry) };
        const ok = await this.link.request<boolean>(frame, ENTRY_ACK_MS).then((r) => r === true, (e) => (this.deps.log(`条目没送到：${errText(e)}`), false));
        if (!ok && this.retries === 0) this.deps.log(`bridge 还没接住 ${batch.length} 条流式条目（序号 ${frame.firstSeq} 起），留着重送`);
        if (!ok) return this.retryLater();
        this.retries = 0;
        const last = batch[batch.length - 1]!.seq;
        this.outbox = this.outbox.filter((b) => b.seq > last);
      }
    } finally {
      this.pumping = false;
    }
    if (!this.outbox.length) for (const w of this.drainWaiters.splice(0)) w();
  }

  private timing<K extends keyof typeof TIMINGS>(k: K): (typeof TIMINGS)[K] {
    return this.cfg.timings?.[k] ?? TIMINGS[k];
  }

  private retryLater(): void {
    if (this.retryTimer || this.stopping) return;
    const steps = this.timing("retryMs");
    const delay = steps[Math.min(this.retries++, steps.length - 1)]!;
    this.retryTimer = setTimeout(() => ((this.retryTimer = null), void this.pump()), delay);
  }

  /** 出站队列清空（全部被 bridge 确认）就 true；到点还没清空 false */
  private drained(ms: number): Promise<boolean> {
    if (!this.outbox.length) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => ((this.drainWaiters = this.drainWaiters.filter((w) => w !== done)), resolve(false)), ms);
      const done = () => (clearTimeout(t), resolve(true));
      this.drainWaiters.push(done);
      void this.pump();
    });
  }

  private async reportStop(r: StopReport): Promise<{ block?: boolean; reason?: string }> {
    const rest = this.translator.flush();
    if (rest.length) this.pushEntries(rest);
    // 这一轮的条目 bridge 全部确认处理完才报 Stop：Stop 的 drain 要看到收尾文字（ws 与 HTTP 两条路没有先后保证）。
    // 等不到确认、或 bridge 太久不在丢过条目：不能当成功报，按 StopFailure 报；没确认的留在队列里，连上了照样补送
    const ok = await this.drained(this.timing("drainMs"));
    const lost = this.droppedEntries;
    this.droppedEntries = 0;
    if (ok && !lost) return this.deps.postHook({ channelId: this.cfg.channelId, ...r });
    this.deps.log(ok ? `这一轮 bridge 不在时丢了 ${lost} 条流式条目：按 StopFailure 报` : "回合末的条目等不到 bridge 确认：按 StopFailure 报");
    return this.deps.postHook({ channelId: this.cfg.channelId, ...r, event: "StopFailure" });
  }

  private fail(f: AcpFailure): void {
    if (!this.dedup.admit(f)) return;
    const entry = failureEntry(f, new Date().toISOString());
    if (entry) this.pushEntries([entry]);
    this.link.send({ channelId: this.cfg.channelId, type: "acp_failure", failure: f, configOptions: this.session?.configOptions ?? [] });
  }

  /** 权限请求：按 permId 交 bridge 出卡，等 owner 答（bridge 经 acp_call 回来）；到点按取消回适配器 */
  private askPermission(card: unknown): Promise<string | null> {
    const permId = `${this.hostId}-${++this.permSeq}`;
    const frame = { channelId: this.cfg.channelId, type: "acp_permission", permId, card };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.endPermission(permId, null, "等太久没人答"), this.timing("permissionMs"));
      this.permits.set(permId, { frame, resolve, timer });
      if (!this.link.send(frame)) this.deps.log(`bridge 不在：权限请求 ${permId} 等登记上了再出卡`);
    });
  }

  /** 结束一个权限请求；why 有值 = 不是 owner 答的（超时 / 适配器退出），通知 bridge 撤卡。返回它是不是还在等 */
  private endPermission(permId: string, optionId: string | null, why?: string): boolean {
    const p = this.permits.get(permId);
    if (!p) return false;
    this.permits.delete(permId);
    clearTimeout(p.timer);
    p.resolve(optionId);
    if (why) {
      this.deps.log(`权限请求 ${permId} ${why}：按取消回适配器、撤卡`);
      this.link.send({ channelId: this.cfg.channelId, type: "acp_permission", permId, gone: why });
    }
    return true;
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
    if (m.op === "permission") {
      const ok = this.endPermission(String(m.permId ?? ""), typeof m.optionId === "string" ? m.optionId : null);
      return void reply(ok ? { ok: true } : { ok: false, error: "这个权限请求已经不在等了（超时或适配器重起过）" });
    }
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
