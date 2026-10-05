/** ACP 宿主协调适配器、bridge、回合与出站确认；协议细节见 docs/runtimes/codex-acp.md。 */
import { randomBytes } from "node:crypto";
import { codexReplyHint, wrapChannelContent } from "../codex-thread.js";
import { abortAcpTurn } from "./abort.js";
import type { AdapterEnvSpec, AdapterProc } from "./adapter-proc.js";
import { applyAcpLaunchConfig } from "./apply-config.js";
import type { BridgeLink, BridgeLinkDeps } from "./bridge-link.js";
import { commitAcpClear, rotateAcpHost } from "./clear.js";
import { modelStateEntry } from "./config.js";
import { classifyPromptError, failureEntry, FailureDedup, type AcpFailure } from "./failures.js";
import { HostHeartbeat } from "./host-heartbeat.js";
import { acpRuntime, type AcpRuntime } from "./host-runtime.js";
import { AcpIncompatibleError } from "./protocol.js";
import { AcpSession } from "./session.js";
import type { ToolProxy, ToolProxyDeps } from "./tool-proxy.js";
import { acpSlotCall, AcpTurnLoop, type StopReport } from "./turn.js";
import { createAcpTranslator, type AcpTranslator } from "./updates.js";

export interface HostConfig {
  channelId: string;
  agentName: string;
  sessionId: string;
  cwd: string;
  mcpName: string;
  /** 重启 / 收编后第一条入站前附的前言（codex-launch.codexContextPreamble） */
  preamble?: string;
  clearPreamble?: string;
  model?: string;
  effort?: string;
  agentCmd: string[];
  env: Omit<AdapterEnvSpec, "channel">;
  runtime?: AcpRuntime; // 缺省 codex（host-runtime.ts）
  /** 单测注入：出站条目的重送退避、回合末等确认的上限、权限卡等多久（缺省用下面的 TIMINGS） */
  timings?: Partial<typeof TIMINGS>;
}

export interface HostDeps {
  spawn(cmd: string[], env: Record<string, string>, cwd: string): AdapterProc;
  beforeSpawn?(): Promise<void>; // 每次起适配器前等它跑完（含退避重起）；自己负责超时，reject 了宿主只记日志照常起
  makeLink(deps: Omit<BridgeLinkDeps, "url">): Pick<BridgeLink, "connect" | "send" | "request" | "close" | "up">;
  startProxy(deps: Omit<ToolProxyDeps, "port">): ToolProxy;
  postHook(body: { channelId: string } & StopReport): Promise<{ block?: boolean; reason?: string }>;
  markReady(): Promise<void>;
  rotateSession(oldId: string, newId: string): Promise<{ ok: boolean; error?: string }>;
  log(msg: string): void;
}

const RESTART_BASE_MS = 3_000, RESTART_MAX_MS = 60_000, RESTART_STABLE_MS = 5 * 60_000;
const AUTH_RETRY_MS = 60_000;
/** prompt 等适配器接回线程最多这么久；等不到按失败收尾（带上最近一次起不来的原因） */
const SESSION_WAIT_MS = 120_000;
/** 出站条目：一批最多几条、队列最多攒几条（bridge 太久不在就丢最老的，这一轮按 StopFailure 报）、单批等回包多久 */
const ENTRY_BATCH_MAX = 200, ENTRY_OUTBOX_MAX = 5_000, ENTRY_ACK_MS = 15_000, ENTRY_RETRY_MAX = 8;
const TIMINGS: { retryMs: readonly number[]; drainMs: number; permissionMs: number } = { retryMs: [250, 500, 1_000, 2_000, 5_000], drainMs: 90_000, permissionMs: 10 * 60_000 };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** 适配器认 /compact 的写法（codex-acp parseCommand：首块去空白后 /名字，名字不分大小写） */
const COMPACT_COMMAND = /^\s*\/compact(\s|$)/i;

export class AcpHost {
  private session: AcpSession | null = null;
  private proc: AdapterProc | null = null;
  private stopping = false;
  private restarts = 0;
  /** 起适配器 / 等不到会话的失败键用单调序号（同一毫秒两次失败不能被合成一张卡） */
  private startSeq = 0;
  private lastStartError: AcpFailure | null = null;
  /** 适配器协议不兼容（protocol.ts）：重起换不来别的结果，不再重起、回合当场按失败收尾；换了适配器或宿主要 restart */
  private refused = false;
  private sessionWaiters: ((s: AcpSession | null) => void)[] = [];
  private preamblePending: string | undefined;
  private readyMarked = false;
  private registered = false;
  private rotating = false;
  private restartDeferred = false;
  private readonly hostId = randomBytes(6).toString("hex");
  private readonly rt: AcpRuntime;
  private outbox: { seq: number; entry: Record<string, unknown> }[] = [];
  private entrySeq = 0;
  private droppedEntries = 0;
  private lastBridgeLost = 0;
  private lastBridgeEpoch: string | undefined;
  private deliveryUncertain = false;
  private pumping = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private drainWaiters: (() => void)[] = [];
  private readonly permits = new Map<string, { frame: Record<string, unknown>; resolve: (optionId: string | null) => void; timer: ReturnType<typeof setTimeout> }>();
  private permSeq = 0;
  private translator: AcpTranslator;
  /** 在跑的这一轮是宿主发的 /compact：其间到的压缩完成算 manual，否则是适配器自己的自动压缩 */
  private compactCommand = false;
  private readonly beat = new HostHeartbeat(() => ({ agent: this.cfg.agentName, sessionId: this.cfg.sessionId }), (m) => this.deps.log(m)); // 监护判卡住的回合心跳
  private readonly dedup = new FailureDedup();
  private readonly proxy: ToolProxy;
  private readonly link: ReturnType<HostDeps["makeLink"]>;
  readonly loop: AcpTurnLoop;

  constructor(private readonly cfg: HostConfig, private readonly deps: HostDeps) {
    this.preamblePending = cfg.preamble;
    this.rt = cfg.runtime ?? acpRuntime();
    this.translator = this.makeTranslator();
    this.proxy = deps.startProxy({ channelId: cfg.channelId, toBridge: (f) => this.link.send(f), log: (m) => deps.log(m) });
    this.link = deps.makeLink({
      registerFrame: () => ({
        type: "register", channelId: cfg.channelId, cwd: cfg.cwd, pid: process.pid, ppid: process.ppid,
        runtime: this.rt.id, transport: "acp", agentName: cfg.agentName, sessionId: cfg.sessionId, abort: true,
      }),
      onFrame: (m) => this.onFrame(m),
      onRegistered: () => {
        this.registered = true;
        deps.log("已在 bridge 登记");
        this.resync();
        void this.maybeReady();
      },
      onDown: (why) => {
        if (this.loop.busy || this.outbox.length) this.deliveryUncertain = true; // bridge 重启可能丢掉已经确认、但还没 drain 的正文
        this.registered = false;
        this.proxy.failInFlight(`宿主和 bridge 的连接断了（${why}）`);
      },
      log: deps.log,
    });
    this.loop = new AcpTurnLoop({
      prompt: async (text) => {
        this.beat.turn();
        const s = await this.waitSession();
        if (!s) return { kind: "failed", failure: this.lastStartError ?? { kind: "error", key: `nosession#${++this.startSeq}`, message: "ACP 适配器没起来" } };
        this.compactCommand = COMPACT_COMMAND.test(text);
        return s.prompt(text).finally(() => (this.compactCommand = false));
      },
      steer: (text) => (this.session?.steering ? this.session.steer(text).then((r) => this.beat.steered(r)) : Promise.resolve({ outcome: "failed" as const })),
      reportStop: (r) => (this.beat.end(this.loop.queued > 0), this.reportStop(r)),
      onFailure: (f) => this.fail(f),
      onSlotEnd: (e) => deps.log(`槽 ${e.opId}#${e.gen} 结束：${e.outcome}`),
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
    if (this.loop.busy) void this.session?.cancel();
    for (const id of [...this.permits.keys()]) this.endPermission(id, null);
    this.proc?.stop();
    this.proxy.close();
    this.link.close();
    for (const w of this.sessionWaiters.splice(0)) w(null);
  }

  private async startAdapter(): Promise<void> {
    if (this.stopping) return;
    await this.deps.beforeSpawn?.().catch((e) => this.deps.log(`⚠️ 起适配器前的版本探测失败，按未知照常起：${String(e)}`));
    if (this.stopping || this.rotating) return void (this.restartDeferred ||= this.rotating); // 停机中不再起；/clear 轮换中等它换完再起
    const spec = { ...this.cfg.env, channel: { channelId: this.cfg.channelId, proxyUrl: this.proxy.url, agentName: this.cfg.agentName, sessionId: this.cfg.sessionId } };
    const proc = (this.proc = this.deps.spawn(this.cfg.agentCmd, this.rt.adapterEnv(spec), this.cfg.cwd));
    const session = new AcpSession(proc.wire, {
      onUpdate: (u) => (this.rotating || this.beat.update(), this.onUpdate(u)), onPermission: (card) => (this.beat.update(), this.askPermission(card)), // /clear 引导不算动静
      onSelfTurn: (done) => (this.beat.turn(), this.loop.track(done)), log: this.deps.log, label: this.rt.label,
    }, this.rt.mcpServers(spec));
    const startedAt = Date.now();
    void proc.exited.then((code) => this.onAdapterExit(session, code, startedAt));
    try {
      const caps = await session.initialize();
      await session.attach(this.cfg.sessionId, this.cfg.cwd, caps.resume);
      await applyAcpLaunchConfig(session, this.cfg.model, this.cfg.effort, false, this.deps.log);
      this.session = session;
      this.lastStartError = null;
      const who = session.agentInfo ? `，${session.agentInfo.name} ${session.agentInfo.version}` : "";
      this.deps.log(`已接上线程 ${this.cfg.sessionId.slice(0, 8)}（${caps.resume ? "session/resume" : "session/load"}${session.steering ? "，支持 steering" : ""}${who}）`);
      this.publishConfig(session);
      for (const w of this.sessionWaiters.splice(0)) w(session);
      void this.maybeReady();
    } catch (e) {
      const f = classifyPromptError(e, `start#${++this.startSeq}`);
      this.lastStartError = f;
      this.refused = e instanceof AcpIncompatibleError;
      this.deps.log(`适配器接不上线程：${f.message}${this.refused ? "（不再重起；不标就绪，manager 按启动失败处理）" : ""}`);
      this.fail(f);
      // 没登录也算「起来了」：宿主在、卡已出、消息会按失败收尾——不然 restart / 切 transport 要白等两分钟就绪超时
      if (f.kind === "auth") void this.maybeReady();
      if (this.refused) for (const w of this.sessionWaiters.splice(0)) w(null);
      proc.stop();
    }
  }

  private onAdapterExit(session: AcpSession, code: number, startedAt: number): void {
    if (this.session === session) this.session = null;
    for (const id of [...this.permits.keys()]) this.endPermission(id, null, "适配器退出了");
    if (this.stopping) return;
    if (this.rotating) return void (this.restartDeferred = true);
    if (this.refused) return void this.deps.log(`适配器退出了（code ${code}）：协议不兼容，不再重起`);
    if (Date.now() - startedAt > RESTART_STABLE_MS) this.restarts = 0;
    const auth = this.lastStartError?.kind === "auth";
    const delay = auth ? AUTH_RETRY_MS : Math.min(RESTART_BASE_MS * 2 ** Math.min(this.restarts++, 5), RESTART_MAX_MS);
    this.deps.log(`适配器退出了（code ${code}），${delay / 1000}s 后重起${auth ? "（等 owner 登录）" : ""}`);
    setTimeout(() => void this.startAdapter(), delay);
  }

  private waitSession(): Promise<AcpSession | null> {
    if (this.session) return Promise.resolve(this.session);
    if (this.lastStartError?.kind === "auth" || this.refused || this.stopping) return Promise.resolve(null);
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

  /** 压缩完成只认本运行时的来源（updates.ts 文件头）：Pi 是 _meta.claudestra.compacted，Codex 是 ACP compaction_update */
  private makeTranslator(): AcpTranslator {
    const from = this.rt.id === "pi" ? "claudestra-meta" : "compaction-update";
    return createAcpTranslator(undefined, { from, trigger: () => (this.compactCommand ? "manual" : "auto") });
  }

  private onUpdate(u: Record<string, unknown>): void {
    if (this.rotating) return; // /clear 的内部引导不能作为用户回合推送
    const entries = this.translator.push(u);
    if (entries.length) this.pushEntries(entries);
  }

  /** 在 bridge 登记上了（首次 / 重连 / bridge 重启）：还在等的权限请求补发出卡，拒起的卡补发一次（bridge 按题面去重），出站条目接着送 */
  private resync(): void {
    for (const p of this.permits.values()) this.link.send(p.frame);
    if (this.refused && this.lastStartError) this.sendFailure(this.lastStartError); // 拒起时 bridge 可能还没登记上，那一帧就丢了
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
        const frame = { channelId: this.cfg.channelId, type: "acp_entries", sessionId: this.cfg.sessionId, hostId: this.hostId, firstSeq: batch[0]!.seq, entries: batch.map((b) => b.entry) };
        const ack = await this.link.request<boolean | { ok: true; lost: number; bridgeEpoch?: string }>(frame, ENTRY_ACK_MS)
          .catch((e) => (this.deps.log(`条目没送到：${errText(e)}`), false as const));
        const ok = ack === true || (typeof ack === "object" && ack?.ok === true);
        if (!ok && this.retries === 0) this.deps.log(`bridge 还没接住 ${batch.length} 条流式条目（序号 ${frame.firstSeq} 起），留着重送`);
        if (!ok && this.retries < ENTRY_RETRY_MAX) return this.retryLater();
        if (!ok) {
          this.droppedEntries += batch.length;
          this.deps.log(`bridge 连续 ${ENTRY_RETRY_MAX} 次没接住条目：放弃序号 ${frame.firstSeq} 起的 ${batch.length} 条，这轮按 StopFailure 报`);
        } else if (typeof ack === "object" && Number.isInteger(ack.lost) && ack.lost >= 0) {
          if (ack.bridgeEpoch && ack.bridgeEpoch !== this.lastBridgeEpoch) this.lastBridgeLost = 0;
          this.lastBridgeEpoch = ack.bridgeEpoch;
          if (ack.lost > this.lastBridgeLost) this.droppedEntries += ack.lost - this.lastBridgeLost;
          this.lastBridgeLost = ack.lost;
        }
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
    for (const id of [...this.permits.keys()]) this.endPermission(id, null, "回合已结束");
    const rest = this.translator.flush();
    if (rest.length) this.pushEntries(rest);
    // 这一轮的条目 bridge 全部确认处理完才报 Stop：Stop 的 drain 要看到收尾文字（ws 与 HTTP 两条路没有先后保证）。
    // 等不到确认、或 bridge 太久不在丢过条目：不能当成功报，按 StopFailure 报；没确认的留在队列里，连上了照样补送
    const ok = await this.drained(this.timing("drainMs"));
    const lost = this.droppedEntries;
    const uncertain = this.deliveryUncertain;
    this.droppedEntries = 0;
    this.deliveryUncertain = false;
    if (ok && !lost && !uncertain) return this.deps.postHook({ channelId: this.cfg.channelId, ...r });
    this.deps.log(!ok ? "回合末的条目等不到 bridge 确认：按 StopFailure 报" : `bridge 重连后这轮的条目可能缺失（溢出 ${lost} 条）：按 StopFailure 报`);
    return this.deps.postHook({ channelId: this.cfg.channelId, ...r, event: "StopFailure", acpDeliveryWarning: true });
  }

  private fail(f: AcpFailure): void {
    if (!this.dedup.admit(f)) return;
    const entry = failureEntry(f, new Date().toISOString());
    if (entry) this.pushEntries([entry]);
    this.sendFailure(f);
  }

  private sendFailure(f: AcpFailure): void {
    this.link.send({ channelId: this.cfg.channelId, type: "acp_failure", failure: f, configOptions: this.session?.configOptions ?? [], label: this.rt.label });
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
    if (m.type === "abort") return void abortAcpTurn(String(m.id ?? ""), {
      session: this.session, loop: this.loop, send: (f) => this.link.send(f), log: this.deps.log,
      endPermissions: () => { for (const permId of [...this.permits.keys()]) this.endPermission(permId, null, "回合已打断"); },
    });
    if (m.type === "acp_call") return void this.call(m);
    if (m.type !== "rejected") this.deps.log(`bridge 发来不认识的帧：${String(m.type)}`);
  }

  private async inbound(content: string, meta: Record<string, string>): Promise<void> {
    const { after_interrupt: _drop, ...shown } = meta;
    const wrapped = wrapChannelContent(content, shown, this.cfg.mcpName, codexReplyHint(this.cfg.mcpName));
    const text = this.preamblePending ? `${this.preamblePending}\n\n${wrapped}` : wrapped;
    this.preamblePending = undefined;
    const how = await this.loop.submit(text, meta.message_id);
    this.deps.log(`收到 ${meta.chat_id ?? "?"} 的消息（${meta.message_id ?? "?"}）→ ${how === "steer" ? "插进当前回合" : how === "prompt" ? "开一轮" : "排队"}`);
  }

  /** bridge 发来的调用（改配置）：结果按 id 回 acp_call_result */
  private async call(m: Record<string, any>): Promise<void> {
    const reply = (body: Record<string, unknown>) => this.link.send({ channelId: this.cfg.channelId, type: "acp_call_result", id: m.id, ...body });
    if (m.op === "clear") return void reply(await this.clearSession());
    if (m.op === "turn") return void reply({ ok: true, busy: this.loop.busy || !!this.session?.running }); // 升级闸问回合在不在途（bridge/acp-turn-status.ts），含适配器自发的
    const slot = acpSlotCall(this.loop, m, this.hostId); // slash / op_turn / slot_status / cancel_slot（turn.ts）
    if (slot) return void slot.then(reply);
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

  private async clearSession(): Promise<{ ok: boolean; error?: string; sessionId?: string }> {
    const oldPreamble = this.preamblePending;
    return rotateAcpHost({
      session: this.session, ready: !!this.proc && this.registered, pending: !!(this.outbox.length || this.pumping || this.permits.size),
      loop: this.loop, oldId: this.cfg.sessionId, cwd: this.cfg.cwd, bootstrap: this.rt.clearBootstrap, rotateRegistry: this.deps.rotateSession,
      configure: (s) => applyAcpLaunchConfig(s, this.cfg.model, this.cfg.effort, true, this.deps.log),
      begin: () => ((this.rotating = true), (this.preamblePending = this.cfg.clearPreamble)),
      failed: (changed) => {
        this.preamblePending = oldPreamble;
        if (changed) this.session = null, this.proc?.stop(); // 内存线程已变，重起后从 registry 接回旧线程
      },
      committed: (id, session) => commitAcpClear({
        sessionId: id, previousSessionId: this.cfg.sessionId, channelId: this.cfg.channelId, request: (f, ms) => this.link.request<boolean>(f, ms),
        update: () => { this.cfg.sessionId = id; this.translator = this.makeTranslator(); },
        ready: () => { if (this.session) this.publishConfig(this.session); if (!this.rotating) this.loop.resume(); },
        alive: () => !this.stopping && this.cfg.sessionId === id,
      }),
      end: () => {
        this.rotating = false;
        if (this.restartDeferred) this.restartDeferred = false, void this.startAdapter();
      },
    });
  }

  /** 配置变了：给 bridge 存一份（设置页 / 额度卡的选项），再推一条 model_state 条目让顶栏跟上 */
  private publishConfig(s: AcpSession): void {
    this.link.send({ channelId: this.cfg.channelId, type: "acp_config", configOptions: s.configOptions });
    const e = modelStateEntry(s.configOptions, new Date().toISOString());
    if (e) this.pushEntries([e]);
  }
}
