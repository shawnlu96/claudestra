/**
 * 宿主里的一条 ACP 会话（对着 codex-acp、Pi 适配器或沙箱的 stub）：initialize、接上已有线程、prompt / steer / cancel / 改配置，
 * 以及把适配器发来的权限请求交给宿主。回合结束的关联（Shawn 复审的两条要求）：
 * - 线程状态（session_info_update 的 threadStatus，见 updates.ts）每来一次记一个递增序号，idle / systemError 的序号缓存下来；
 *   steer 答 startedNewTurn 时，在回包那一行处理的**同一刻**（rpc 的 onResult 同步钩子）记下当前序号，那一轮的结束 =
 *   这个序号之后的第一个 idle。已经来过就立刻兑现——不会「先完成、后挂监听」；序号只增，也不会拿上一轮的 idle 充数。
 * - 适配器退出（rpc 断流）：在途请求由 rpc 全部 reject，挂着的外部回合等待在这里一律以失败兑现，没有永远等不到的调用。
 * - idle 带了这一轮的结局（Pi 适配器的 _meta.claudestra.turn）就按它兑现：steering 另起的回合失败了也得出卡、报 StopFailure。
 * - 适配器自己开的回合（Pi 的异步子任务回调 triggerTurn、压缩后续跑）：线程从非 active 变 active 时既没有 prompt 在途、也没有
 *   steer 另起的回合在等，就当自发回合交给宿主（onSelfTurn），等到下一个 idle。codex-acp 只在宿主的 prompt / steer 期间变 active，不受影响。
 * 规矩与形状见 docs/runtimes/codex-acp.md；tests/acp-session.test.ts。
 */
import { configRefusal, parseConfigOptions, resolveConfigValue, type ConfigOption } from "./config.js";
import { airFailureOf, classifyAirFailure, classifyNeutralFailure, classifyPromptError } from "./failures.js";
import { permissionCard, permissionResponse, CANCELLED, type PermissionCard } from "./permissions.js";
import { ACP_PROTOCOL_VERSION, AcpIncompatibleError, checkInitialize, type AgentInfo } from "./protocol.js";
import { createRpcPeer, type RpcPeer, type RpcWire } from "./rpc.js";
import type { PromptOutcome, SteerResult } from "./turn.js";
import { threadStatusOf, turnEndOf } from "./updates.js";

/**
 * initialize 时声明的客户端能力：AIR 的 sessionFailure（结构化失败）+ 终端输出增量（声明了 AIR 不声明它，命令输出就收不到）；
 * session.compaction（ACP unstable）：codex-acp 才按 compaction_update 报压缩的开始 / 完成 / 失败（updates.ts 认 completed 出边界），
 * 不声明它只给一个「Compact conversation」工具调用，宿主分不出压缩成没成。核对见 docs/runtimes/codex-acp.md「压缩完成信号」
 */
export const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  session: { compaction: {} },
  _meta: { terminal_output_delta: true, jetbrains: { air: { version: 1, capabilities: ["sessionFailure"] } } },
};

export interface SessionDeps {
  /** 这个会话的 session/update（已按 sessionId 过滤） */
  onUpdate(update: Record<string, unknown>): void;
  /** 适配器要授权：交给宿主出卡、等 owner 点；超时 / 取消由宿主回 null */
  onPermission(card: PermissionCard): Promise<string | null>;
  log(msg: string): void;
  /** 卡片 / 失败文案里的运行时称呼（缺省 Codex） */
  label?: string;
  /** 适配器自己开了一轮（见文件头）：done 在这一轮结束时兑现。不给就不跟（create / fork 的短命引导会话） */
  onSelfTurn?(done: Promise<PromptOutcome>): void;
}

/** _claudestra/cancel 等适配器清完队列最多这么久（bridge 等回执 1.5s，过了照样认迟到的作废列表） */
const CANCEL_TIMEOUT_MS = 5_000;

type Waiter = { after: number; resolve: (o: PromptOutcome) => void; cancelled: boolean; selfTurn?: true };
type TurnEnd = ReturnType<typeof turnEndOf>;

export class AcpSession {
  readonly rpc: RpcPeer;
  sessionId = "";
  configOptions: ConfigOption[] = [];
  steering = false;
  /** 适配器在 initialize 回包里报的名字和版本（没报是 null）：宿主接上线程时记进日志 */
  agentInfo: AgentInfo | null = null;
  /** 适配器的 cancel 会先清掉排队消息并把正文交回来（Pi 适配器 _claudestra/cancel）；codex-acp 没有，照旧发 session/cancel 通知 */
  private cancelReturnsQueue = false;
  private statusSeq = 0;
  private lastStatus: string | null = null;
  /** 在途的 session/prompt：回包那一刻同步减（rpc onResult），之后到的 active 才可能是自发回合 */
  private prompting = 0;
  private lastEnd: { seq: number; status: string; end: TurnEnd } | null = null;
  private waiters: Waiter[] = [];
  private turnSeq = 0;

  /** mcpServers：session/new|resume|load|fork 都带同一份（Pi 的 channel-server 只能这样交，/clear 新建时也要再带） */
  constructor(wire: RpcWire, private readonly deps: SessionDeps, private readonly mcpServers: readonly unknown[] = []) {
    this.rpc = createRpcPeer(wire, { log: deps.log });
    this.rpc.onNotification("session/update", (p: any) => {
      if (!p || (this.sessionId && p.sessionId !== this.sessionId)) return; // 子会话（我们没声明 subagents）等别的会话不管
      const u = p.update ?? {};
      const st = threadStatusOf(u);
      if (st) this.noteStatus(st, turnEndOf(u));
      this.deps.onUpdate(u);
    });
    this.rpc.onRequest("session/request_permission", async (params) => {
      const card = permissionCard(params, this.label);
      if (!card) return CANCELLED;
      const picked = await this.deps.onPermission(card).catch(() => null); // 出卡 / 等答案出错按「没答」：回 cancelled，适配器按拒绝走（fail closed）
      return permissionResponse(card, picked);
    });
    this.rpc.onClosed((why) => this.endAll(why));
  }

  /** initialize：回包先过协议版本与必要能力检查（protocol.ts，不过就抛 AcpIncompatibleError），返回接线程要用的会话能力。need.fork = 要 fork */
  async initialize(need: { fork?: boolean } = {}): Promise<{ resume: boolean; fork: boolean }> {
    const params = { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: CLIENT_CAPABILITIES, clientInfo: { name: "claudestra-acp-host", version: "1" } };
    const r = await this.rpc.request("initialize", params, { timeoutMs: 60_000 });
    const verdict = checkInitialize(r, need);
    if (!verdict.ok) throw new AcpIncompatibleError(verdict.reason);
    this.agentInfo = verdict.agentInfo;
    this.steering = r?._meta?.steering?.supported === true;
    this.cancelReturnsQueue = r?._meta?.claudestra?.cancelReturnsQueue === true;
    return { resume: verdict.resume, fork: verdict.fork };
  }

  /** 接上已有线程：支持 resume 就用它（不回放历史），否则 session/load（回放的历史更新宿主不需要，照样只进 onUpdate） */
  async attach(sessionId: string, cwd: string, resume: boolean): Promise<void> {
    this.sessionId = sessionId;
    const r = await this.rpc.request(resume ? "session/resume" : "session/load", { sessionId, cwd, mcpServers: this.mcpServers }, { timeoutMs: 120_000 });
    this.configOptions = parseConfigOptions(r?.configOptions);
  }

  /** 新建线程（create 的引导与 /clear；Codex 新线程要先跑一轮才落盘，见 runtimes/codex-acp.ts） */
  async create(cwd: string, timeoutMs = 120_000): Promise<string> {
    const r = await this.rpc.request("session/new", { cwd, mcpServers: this.mcpServers }, { timeoutMs });
    if (typeof r?.sessionId !== "string" || !r.sessionId) throw new Error("session/new 没返回 sessionId");
    this.sessionId = r.sessionId;
    this.configOptions = parseConfigOptions(r?.configOptions);
    return this.sessionId;
  }

  /** 分叉已持久化的线程；调用方须在短命引导进程退出前接上并跑一轮。 */
  async fork(sessionId: string, cwd: string): Promise<string> {
    const r = await this.rpc.request("session/fork", { sessionId, cwd, mcpServers: this.mcpServers }, { timeoutMs: 120_000 });
    if (typeof r?.sessionId !== "string" || !r.sessionId || r.sessionId === sessionId) throw new Error("session/fork 没返回新的 sessionId");
    this.sessionId = r.sessionId;
    this.configOptions = parseConfigOptions(r?.configOptions);
    return this.sessionId;
  }

  /** 线程此刻在跑（最近一次线程状态是 active）：宿主据此答忙、叫停时取消，哪怕这一轮不是它发的 */
  get running(): boolean {
    return this.lastStatus === "active";
  }

  async prompt(text: string, timeoutMs?: number): Promise<PromptOutcome> {
    const turnKey = `${this.sessionId}#${++this.turnSeq}`;
    let open = true;
    const settled = () => void (open && ((open = false), this.prompting--));
    this.prompting++;
    try {
      const r = await this.rpc.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] }, { timeoutMs, onResult: settled });
      const air = airFailureOf(r);
      if (air) return { kind: "failed", failure: classifyAirFailure(air, this.label) };
      return r?.stopReason === "cancelled" ? { kind: "cancelled" } : { kind: "done" };
    } catch (e) {
      return { kind: "failed", failure: classifyPromptError(e, turnKey) };
    } finally {
      settled();
    }
  }

  /**
   * steering：startedNewTurn 的结束信号在回包那一刻同步登记（见文件头）。这一轮的 active 先于回包到、已经当自发回合交给宿主了
   * （回合调度器在报上一轮 Stop 时插的话，codex-acp 可能先报 active）：同一轮不再跟第二次，按「插进了在跑的回合」答
   */
  async steer(text: string): Promise<SteerResult> {
    let done: Promise<PromptOutcome> | null = null;
    let tracked = false;
    const onResult = (res: any) => {
      if (res?.outcome !== "startedNewTurn") return;
      tracked = this.waiters.some((w) => w.selfTurn);
      if (!tracked) done = this.waitEndAfter(this.statusSeq);
    };
    const r = await this.rpc.request("_session/steering", { sessionId: this.sessionId, prompt: [{ type: "text", text }] }, { onResult });
    if (r?.outcome === "injected" || tracked) return { outcome: "injected" };
    if (r?.outcome === "startedNewTurn") return { outcome: "startedNewTurn", done: done ?? this.waitEndAfter(this.statusSeq) };
    return { outcome: "failed" };
  }

  /**
   * 打断当前回合，挂着的外部回合等待记成「被打断」。返回适配器清掉的排队消息正文（宿主据此在回执里列出作废的消息）：
   * 适配器支持就发 _claudestra/cancel 等它清完队列（不等回合停下）；不支持（codex-acp）或出错就发 session/cancel 通知、回空。从不 reject
   */
  async cancel(): Promise<string[]> {
    for (const w of this.waiters) w.cancelled = true;
    const params = { sessionId: this.sessionId };
    if (this.cancelReturnsQueue) {
      try {
        const r = await this.rpc.request("_claudestra/cancel", params, { timeoutMs: CANCEL_TIMEOUT_MS });
        return (Array.isArray(r?.cleared) ? r.cleared : []).filter((t: unknown): t is string => typeof t === "string");
      } catch (e) {
        this.deps.log(`_claudestra/cancel 没成（${e instanceof Error ? e.message : e}），改发 session/cancel`);
      }
    }
    this.rpc.notify("session/cancel", params);
    return [];
  }

  /** 改会话配置（模型 / 推理强度…）：先把值对上选项（resolveConfigValue）再本地校验，再调 set_config_option，成功后更新缓存 */
  async setConfig(configId: string, raw: string, timeoutMs = 30_000): Promise<{ ok: true } | { ok: false; error: string }> {
    const value = resolveConfigValue(this.configOptions, configId, raw);
    const refusal = configRefusal(this.configOptions, configId, value);
    if (refusal) return { ok: false, error: refusal };
    try {
      const r = await this.rpc.request("session/set_config_option", { sessionId: this.sessionId, configId, value }, { timeoutMs });
      const next = parseConfigOptions(r?.configOptions);
      if (next.length) this.configOptions = next;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private get label(): string {
    return this.deps.label ?? "Codex";
  }

  /** 序号 after 之后的第一个回合结束（idle / systemError）；已经来过就立刻兑现 */
  private waitEndAfter(after: number): Promise<PromptOutcome> {
    if (this.lastEnd && this.lastEnd.seq > after) return Promise.resolve(this.endOutcome(this.lastEnd, false));
    return new Promise((resolve) => this.waiters.push({ after, resolve, cancelled: false }));
  }

  private noteStatus(status: string, end: TurnEnd): void {
    const seq = ++this.statusSeq;
    const started = status === "active" && this.lastStatus !== "active";
    this.lastStatus = status;
    const track = this.deps.onSelfTurn;
    if (started && track && !this.prompting && !this.waiters.length) return this.trackSelfTurn(seq, track);
    if (status !== "idle" && status !== "systemError") return;
    const last = (this.lastEnd = { seq, status, end });
    const due = this.waiters.filter((w) => seq > w.after);
    this.waiters = this.waiters.filter((w) => seq <= w.after);
    for (const w of due) w.resolve(this.endOutcome(last, w.cancelled));
  }

  private endOutcome(e: { seq: number; status: string; end: TurnEnd }, cancelled: boolean): PromptOutcome {
    const key = `status:${this.sessionId}#${e.seq}`;
    if (e.status === "systemError") return { kind: "failed", failure: { kind: "error", key, message: `${this.label} 线程出错（systemError）` } };
    const f = e.end?.failure;
    if (f) {
      const message = typeof f.message === "string" && f.message ? f.message : `${this.label} 回合失败`;
      return { kind: "failed", failure: classifyNeutralFailure(f.kind, key, message) ?? { kind: "error", key, message } };
    }
    return cancelled || e.end?.stopReason === "cancelled" ? { kind: "cancelled" } : { kind: "done" };
  }

  /** 适配器自己开的一轮（见文件头）：挂一个等它结束的等待交给宿主，宿主当 external 槽跟到 idle 再报 Stop */
  private trackSelfTurn(seq: number, track: (done: Promise<PromptOutcome>) => void): void {
    const done = new Promise<PromptOutcome>((resolve) => this.waiters.push({ after: seq, resolve, cancelled: false, selfTurn: true }));
    this.deps.log(`${this.label} 自己开了一轮（不是宿主发的 prompt）：跟到它结束再报 Stop`);
    track(done);
  }

  /** 适配器退出：挂着的等待一律以失败兑现（在途请求由 rpc 自己 reject） */
  private endAll(why: string): void {
    const ws = this.waiters.splice(0);
    for (const w of ws) w.resolve({ kind: "failed", failure: { kind: "error", key: `exit:${this.sessionId}#${this.statusSeq}`, message: `ACP 适配器退出了（${why}）` } });
  }
}
