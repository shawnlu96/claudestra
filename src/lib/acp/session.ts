/**
 * 宿主里的一条 ACP 会话（对着 codex-acp 或沙箱的 stub）：initialize、接上已有线程、prompt / steer / cancel / 改配置，
 * 以及把适配器发来的权限请求交给宿主。回合结束的关联（Shawn 复审的两条要求）：
 * - 线程状态（session_info_update._meta.codex.threadStatus）每来一次记一个递增序号，idle / systemError 的序号缓存下来；
 *   steer 答 startedNewTurn 时，在回包那一行处理的**同一刻**（rpc 的 onResult 同步钩子）记下当前序号，那一轮的结束 =
 *   这个序号之后的第一个 idle。已经来过就立刻兑现——不会「先完成、后挂监听」；序号只增，也不会拿上一轮的 idle 充数。
 * - 适配器退出（rpc 断流）：在途请求由 rpc 全部 reject，挂着的外部回合等待在这里一律以失败兑现，没有永远等不到的调用。
 * 规矩与形状见 docs/runtimes/codex-acp.md；tests/acp-session.test.ts。
 */
import { configRefusal, parseConfigOptions, type ConfigOption } from "./config.js";
import { airFailureOf, classifyAirFailure, classifyPromptError } from "./failures.js";
import { permissionCard, permissionResponse, CANCELLED, type PermissionCard } from "./permissions.js";
import { createRpcPeer, type RpcPeer, type RpcWire } from "./rpc.js";
import type { PromptOutcome, SteerResult } from "./turn.js";
import { threadStatusOf } from "./updates.js";

/** initialize 时声明的客户端能力：AIR 的 sessionFailure（结构化失败）+ 终端输出增量（声明了 AIR 不声明它，命令输出就收不到） */
export const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  _meta: { terminal_output_delta: true, jetbrains: { air: { version: 1, capabilities: ["sessionFailure"] } } },
};

export interface SessionDeps {
  /** 这个会话的 session/update（已按 sessionId 过滤） */
  onUpdate(update: Record<string, unknown>): void;
  /** 适配器要授权：交给宿主出卡、等 owner 点；超时 / 取消由宿主回 null */
  onPermission(card: PermissionCard): Promise<string | null>;
  log(msg: string): void;
}

type Waiter = { after: number; resolve: (o: PromptOutcome) => void; cancelled: boolean };

export class AcpSession {
  readonly rpc: RpcPeer;
  sessionId = "";
  configOptions: ConfigOption[] = [];
  steering = false;
  private statusSeq = 0;
  private lastEnd: { seq: number; status: string } | null = null;
  private waiters: Waiter[] = [];
  private turnSeq = 0;

  constructor(wire: RpcWire, private readonly deps: SessionDeps) {
    this.rpc = createRpcPeer(wire, { log: deps.log });
    this.rpc.onNotification("session/update", (p: any) => {
      if (!p || (this.sessionId && p.sessionId !== this.sessionId)) return; // 子会话（我们没声明 subagents）等别的会话不管
      const u = p.update ?? {};
      const st = threadStatusOf(u);
      if (st) this.noteStatus(st);
      this.deps.onUpdate(u);
    });
    this.rpc.onRequest("session/request_permission", async (params) => {
      const card = permissionCard(params);
      if (!card) return CANCELLED;
      const picked = await this.deps.onPermission(card).catch(() => null); // 出卡 / 等答案出错按「没答」：回 cancelled，适配器按拒绝走（fail closed）
      return permissionResponse(card, picked);
    });
    this.rpc.onClosed((why) => this.endAll(why));
  }

  /** initialize，返回适配器声明的会话能力 */
  async initialize(): Promise<{ resume: boolean; fork: boolean }> {
    const r = await this.rpc.request("initialize", { protocolVersion: 1, clientCapabilities: CLIENT_CAPABILITIES, clientInfo: { name: "claudestra-acp-host", version: "1" } }, { timeoutMs: 60_000 });
    this.steering = r?._meta?.steering?.supported === true;
    return { resume: !!r?.agentCapabilities?.sessionCapabilities?.resume, fork: !!r?.agentCapabilities?.sessionCapabilities?.fork };
  }

  /** 接上已有线程：支持 resume 就用它（不回放历史），否则 session/load（回放的历史更新宿主不需要，照样只进 onUpdate） */
  async attach(sessionId: string, cwd: string, resume: boolean): Promise<void> {
    this.sessionId = sessionId;
    const r = await this.rpc.request(resume ? "session/resume" : "session/load", { sessionId, cwd, mcpServers: [] }, { timeoutMs: 120_000 });
    this.configOptions = parseConfigOptions(r?.configOptions);
  }

  /** 新建线程（只在 create 的引导里用：新线程要先跑一轮才落盘，见 runtimes/codex-acp.ts） */
  async create(cwd: string): Promise<string> {
    const r = await this.rpc.request("session/new", { cwd, mcpServers: [] }, { timeoutMs: 120_000 });
    if (typeof r?.sessionId !== "string" || !r.sessionId) throw new Error("session/new 没返回 sessionId");
    this.sessionId = r.sessionId;
    this.configOptions = parseConfigOptions(r?.configOptions);
    return this.sessionId;
  }

  /** 分叉已持久化的线程；调用方须在短命引导进程退出前接上并跑一轮。 */
  async fork(sessionId: string, cwd: string): Promise<string> {
    const r = await this.rpc.request("session/fork", { sessionId, cwd, mcpServers: [] }, { timeoutMs: 120_000 });
    if (typeof r?.sessionId !== "string" || !r.sessionId || r.sessionId === sessionId) throw new Error("session/fork 没返回新的 sessionId");
    this.sessionId = r.sessionId;
    this.configOptions = parseConfigOptions(r?.configOptions);
    return this.sessionId;
  }

  async prompt(text: string): Promise<PromptOutcome> {
    const turnKey = `${this.sessionId}#${++this.turnSeq}`;
    try {
      const r = await this.rpc.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] });
      const air = airFailureOf(r);
      if (air) return { kind: "failed", failure: classifyAirFailure(air) };
      return r?.stopReason === "cancelled" ? { kind: "cancelled" } : { kind: "done" };
    } catch (e) {
      return { kind: "failed", failure: classifyPromptError(e, turnKey) };
    }
  }

  /** steering：startedNewTurn 的结束信号在回包那一刻同步登记（见文件头） */
  async steer(text: string): Promise<SteerResult> {
    let done: Promise<PromptOutcome> | null = null;
    const r = await this.rpc.request(
      "_session/steering",
      { sessionId: this.sessionId, prompt: [{ type: "text", text }] },
      { onResult: (res: any) => void (res?.outcome === "startedNewTurn" && (done = this.waitEndAfter(this.statusSeq))) },
    );
    if (r?.outcome === "injected") return { outcome: "injected" };
    if (r?.outcome === "startedNewTurn") return { outcome: "startedNewTurn", done: done ?? this.waitEndAfter(this.statusSeq) };
    return { outcome: "failed" };
  }

  /** 打断当前回合（通知，不等回）。挂着的外部回合等待记成「被打断」 */
  cancel(): void {
    for (const w of this.waiters) w.cancelled = true;
    this.rpc.notify("session/cancel", { sessionId: this.sessionId });
  }

  /** 改会话配置（模型 / 推理强度…）：先本地校验，再调 set_config_option，成功后更新缓存 */
  async setConfig(configId: string, value: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const refusal = configRefusal(this.configOptions, configId, value);
    if (refusal) return { ok: false, error: refusal };
    try {
      const r = await this.rpc.request("session/set_config_option", { sessionId: this.sessionId, configId, value }, { timeoutMs: 30_000 });
      const next = parseConfigOptions(r?.configOptions);
      if (next.length) this.configOptions = next;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 序号 after 之后的第一个回合结束（idle / systemError）；已经来过就立刻兑现 */
  private waitEndAfter(after: number): Promise<PromptOutcome> {
    if (this.lastEnd && this.lastEnd.seq > after) return Promise.resolve(this.endOutcome(this.lastEnd.status, false));
    return new Promise((resolve) => this.waiters.push({ after, resolve, cancelled: false }));
  }

  private noteStatus(status: string): void {
    const seq = ++this.statusSeq;
    if (status !== "idle" && status !== "systemError") return;
    this.lastEnd = { seq, status };
    const due = this.waiters.filter((w) => seq > w.after);
    this.waiters = this.waiters.filter((w) => seq <= w.after);
    for (const w of due) w.resolve(this.endOutcome(status, w.cancelled));
  }

  private endOutcome(status: string, cancelled: boolean): PromptOutcome {
    if (status === "systemError") return { kind: "failed", failure: { kind: "error", key: `status:${this.sessionId}#${this.statusSeq}`, message: "Codex 线程出错（systemError）" } };
    return cancelled ? { kind: "cancelled" } : { kind: "done" };
  }

  /** 适配器退出：挂着的等待一律以失败兑现（在途请求由 rpc 自己 reject） */
  private endAll(why: string): void {
    const ws = this.waiters.splice(0);
    for (const w of ws) w.resolve({ kind: "failed", failure: { kind: "error", key: `exit:${this.sessionId}#${this.statusSeq}`, message: `ACP 适配器退出了（${why}）` } });
  }
}
