/**
 * ACP 服务端 ↔ `pi --mode rpc`（路线 a，docs/design/pi-acp-eval.md §1）。一个适配器进程同一时刻只驱动一个 pi 会话：
 * - session/new 自己生成 id、session/resume 用给定 id，都起 `pi --session-id <id>`（open-or-create，不需要引导轮）；
 *   再来一次 session/new（/clear）就停掉旧 pi、换新 id 重起。
 * - session/prompt → prompt（followUp：pi 还在跑也能排上），等到 agent_settled 才回 stopReason；session/cancel → abort。
 *   _session/steering → 带 steer 的 prompt：排进在跑的回合 = injected，pi 另起一轮 = startedNewTurn（结束只靠 idle）。
 * - 回合结束后按 get_session_stats 发 usage_update；扩展弹框一律回取消；pi 意外退出 = 适配器退出，由宿主重起。
 * - 挂 channel-server 的会话：起 pi 前后各查一次撞名 / reply 能否活下来（deps.mountProblem），pi 里的挂载扩展在 session_start
 *   再报一次（撞名、reply 进没进模型的工具表，MOUNT_STATUS_KEY）；任何一处不过就拒这个会话，不让宿主把没有 reply 的会话当成接通。
 * tests/pi-acp-replay.test.ts（录制的 pi 0.99.1 事件流回放）、tests/pi-acp-shell.test.ts。
 */
import { createRpcPeer, RpcError, type RpcPeer, type RpcWire } from "../rpc.js";
import {
  compactCommand, compactNotice, configOptions, createPiEventMapper, dialogCancel, mcpServersForPi, splitModelValue, textOf, threadStatus, turnEnd, usageUpdate,
  type TurnOutcome,
} from "./map.js";
import { MOUNT_OK, MOUNT_STATUS_KEY, PI_MCP_SERVERS_ENV } from "./mcp-mount.js";
import type { PiLink } from "./pi-link.js";

type Rec = Record<string, any>;

const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
/** pi 起来要加载扩展、连 MCP，头几条命令给足时间 */
const STARTUP_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 30_000;
/** 压缩要跑一次摘要模型调用，长会话可能几分钟 */
const COMPACT_TIMEOUT_MS = 600_000;

export interface PiServerDeps {
  openPi(o: { sessionId: string; cwd: string; env: Record<string, string> }): PiLink;
  newSessionId(): string;
  /** 要挂的 MCP server 起 pi 会出问题（和 pi 的 mcp.json 撞名、reply 会被能力档筛掉）就返回原因；有原因就拒起这个会话 */
  mountProblem?(names: string[], cwd: string): string | null;
  log(msg: string): void;
  /** 适配器该退出了：宿主关了 stdin（0），或 pi 意外退出（1） */
  exit(code: number): void;
}

type Settled = { outcome: TurnOutcome; cancelled: boolean };
type Waiter = { resolve: (s: Settled) => void; reject: (e: Error) => void };

/**
 * 一代 = 一次 session/new|resume 起的一个 pi 和挂在它上面的全部在途状态。/clear、resume、宿主断开时整代作废（closePi）：
 * 在途请求 await 回来先核对自己那一代还是不是当前的，不是就以错误收尾，绝不把等待、用量、配置记到新会话头上。
 */
interface Gen {
  readonly link: PiLink;
  readonly sessionId: string;
  readonly mapper: ReturnType<typeof createPiEventMapper>;
  readonly waiters: Waiter[];
  options: Rec[];
  running: boolean;
  inflight: number;
  cancelRequested: boolean;
  /** 挂载扩展在 session_start 报的状态（MOUNT_STATUS_KEY）；没挂 server 的会话不看 */
  mount?: string;
}

const STALE = "会话被换掉或关闭了（session/new、resume 或宿主断开），这一轮作废";
/** 旧会话已经停掉后新会话又起不来：错误带上它，宿主据此重起适配器、接回 registry 里的旧会话（lib/acp/clear.ts） */
const CLOSED_OLD = { previousSessionClosed: true };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class PiAcpServer {
  private readonly acp: RpcPeer;
  private gen: Gen | null = null;
  private opening: Promise<unknown> = Promise.resolve();

  constructor(wire: RpcWire, private readonly deps: PiServerDeps) {
    const acp = (this.acp = createRpcPeer(wire, { log: deps.log }));
    acp.onRequest("initialize", () => ({
      protocolVersion: 1,
      agentInfo: { name: "claudestra-pi-acp", version: "1" },
      agentCapabilities: { loadSession: false, sessionCapabilities: { resume: {} }, mcpCapabilities: { http: false, sse: false } },
      authMethods: [],
      _meta: { steering: { supported: true } },
    }));
    acp.onRequest("session/new", async (p: Rec) => {
      const id = deps.newSessionId();
      const g = await this.open(id, p);
      return { sessionId: id, configOptions: g.options };
    });
    acp.onRequest("session/resume", async (p: Rec) => {
      if (typeof p?.sessionId !== "string" || !p.sessionId) throw new RpcError(INVALID_PARAMS, "session/resume 缺 sessionId");
      return { configOptions: (await this.open(p.sessionId, p)).options };
    });
    acp.onRequest("session/prompt", (p: Rec) => this.prompt(p));
    acp.onRequest("_session/steering", (p: Rec) => this.steer(p));
    acp.onRequest("session/set_config_option", (p: Rec) => this.setOption(p));
    acp.onNotification("session/cancel", (p: Rec) => this.cancel(p));
    acp.onClosed(() => void this.closePi().finally(() => deps.exit(0)));
  }

  /** 只发当前这一代的；被换下的那一代迟到的输出（用量、收尾事件）直接丢 */
  private update(g: Gen, u: Rec): void {
    if (g === this.gen) this.acp.notify("session/update", { sessionId: g.sessionId, update: u });
  }

  /** 当前这一代；请求带的 sessionId 对不上就拒（宿主只会问自己接上的那个会话） */
  private live(p: Rec): Gen {
    const g = this.gen;
    if (!g) throw new RpcError(INVALID_PARAMS, "还没有会话：先 session/new 或 session/resume");
    if (p?.sessionId !== g.sessionId) throw new RpcError(INVALID_PARAMS, `不认识的 sessionId：${p?.sessionId}`);
    return g;
  }

  /** await 回来先调：这期间 g 被换下了就以错误收尾（tests/pi-acp-generation.test.ts） */
  private stillLive(g: Gen): void {
    if (g !== this.gen) throw new RpcError(INTERNAL_ERROR, STALE);
  }

  /** 串行起会话：两个 session/new 交错时后一个等前一个起完，不会各起一个 pi、漏停其中一个 */
  private open(id: string, p: Rec): Promise<Gen> {
    const run = this.opening.then(() => this.openNow(id, p));
    this.opening = run.catch(() => undefined); // 失败已经交给发起它的那个请求；这里只是让下一次照常排队
    return run;
  }

  private async openNow(id: string, p: Rec): Promise<Gen> {
    const mcp = mcpServersForPi(p?.mcpServers);
    if ("error" in mcp) throw new RpcError(INVALID_PARAMS, mcp.error);
    const names = Object.keys(mcp.servers);
    const cwd = typeof p?.cwd === "string" && p.cwd ? p.cwd : process.cwd();
    const problem = () => (names.length ? (this.deps.mountProblem?.(names, cwd) ?? null) : null);
    const before = problem(); // 先查：已知有问题就别停掉还好好的旧会话
    if (before) throw new RpcError(INVALID_PARAMS, before);
    const hadOld = !!this.gen;
    await this.closePi();
    const after = problem(); // 等旧 pi 退出期间配置可能变了，起新的之前再查一次
    if (after) throw new RpcError(INVALID_PARAMS, after, hadOld ? CLOSED_OLD : undefined);
    const env: Record<string, string> = names.length ? { [PI_MCP_SERVERS_ENV]: JSON.stringify(mcp.servers) } : {};
    const link = this.deps.openPi({ sessionId: id, cwd, env });
    const g: Gen = { link, sessionId: id, mapper: createPiEventMapper(), waiters: [], options: [], running: false, inflight: 0, cancelRequested: false };
    this.gen = g;
    link.onRecord((rec) => {
      if (g === this.gen) this.onRecord(g, rec); // 被 /clear 换下的旧 pi 收尾时的输出不算
    });
    link.onExit((why) => {
      if (g !== this.gen) return;
      this.deps.log(`pi 意外退出（${why}），适配器随之退出`);
      for (const w of g.waiters.splice(0)) w.reject(new RpcError(INTERNAL_ERROR, `pi 退出了（${why}）`));
      this.deps.exit(1);
    });
    await this.refreshOptions(g, STARTUP_TIMEOUT_MS);
    // session_start 在 pi 开始读命令之前就跑完了，所以启动查询回来时挂载扩展的状态一定已经到了；没到 = 扩展没加载上
    if (names.length && g.mount !== MOUNT_OK) {
      await this.closePi();
      const why = g.mount ?? "pi 没有报挂载状态（挂载扩展没加载上？），channel-server 没挂上";
      throw new RpcError(INVALID_PARAMS, why, hadOld ? CLOSED_OLD : undefined);
    }
    return g;
  }

  /** 换下 / 关掉当前这一代：它的退出不再算意外（onExit 认当前代），还在等它 settle 的回合在这里就失败，不能悬着 */
  private async closePi(): Promise<void> {
    const old = this.gen;
    this.gen = null;
    if (!old) return;
    for (const w of old.waiters.splice(0)) w.reject(new RpcError(INTERNAL_ERROR, STALE));
    old.link.stop();
    await old.link.exited;
  }

  private async refreshOptions(g: Gen, timeoutMs: number): Promise<void> {
    const [state, models, levels] = await Promise.all([
      g.link.command({ type: "get_state" }, timeoutMs),
      g.link.command({ type: "get_available_models" }, timeoutMs),
      g.link.command({ type: "get_available_thinking_levels" }, timeoutMs),
    ]);
    this.stillLive(g);
    g.options = configOptions(state, models?.models, levels?.levels);
  }

  private onRecord(g: Gen, rec: Rec): void {
    if (rec.type === "extension_ui_request" && rec.method === "setStatus" && rec.statusKey === MOUNT_STATUS_KEY) {
      g.mount = typeof rec.statusText === "string" ? rec.statusText : undefined;
      return;
    }
    if (rec.type === "extension_ui_request") {
      const reply = dialogCancel(rec);
      if (!reply) return;
      this.deps.log(`扩展弹框（${rec.method}：${rec.title ?? ""}）按规矩回了取消`);
      return g.link.send(reply);
    }
    if (rec.type === "extension_error") return this.deps.log(`pi 扩展出错（${rec.extensionPath} / ${rec.event}）：${rec.error}`);
    for (const u of g.mapper.push(rec)) this.update(g, u);
    if (rec.type === "agent_start" && !g.running) {
      g.running = true;
      this.update(g, threadStatus("active"));
    }
    if (rec.type === "agent_settled") this.settle(g);
  }

  private settle(g: Gen): void {
    g.running = false;
    const s: Settled = { outcome: g.mapper.takeOutcome(), cancelled: g.cancelRequested };
    g.cancelRequested = false;
    this.update(g, threadStatus("idle", turnEnd(s.outcome, s.cancelled))); // steering 另起的回合只能从这里知道结局
    for (const w of g.waiters.splice(0)) w.resolve(s);
    void this.reportUsage(g);
  }

  private async reportUsage(g: Gen): Promise<void> {
    try {
      const u = usageUpdate(await g.link.command({ type: "get_session_stats" }, COMMAND_TIMEOUT_MS));
      if (u) this.update(g, u);
    } catch (e) {
      this.deps.log(`取用量失败（本回合不报 usage_update）：${errText(e)}`);
    }
  }

  private async prompt(p: Rec): Promise<Rec> {
    const g = this.live(p);
    const message = textOf(p.prompt);
    const compact = compactCommand(message);
    if (compact) return this.compact(g, compact);
    let wait: Promise<Settled> | null = null;
    g.inflight++;
    try {
      const r = await g.link.command({ type: "prompt", message, streamingBehavior: "followUp" }, COMMAND_TIMEOUT_MS);
      this.stillLive(g); // 确认回来前被 /clear 换下了：等待既不该挂到新会话上，也不会再有人兑现
      if (r?.disposition !== "handled") wait = new Promise((resolve, reject) => g.waiters.push({ resolve, reject }));
    } finally {
      g.inflight--;
    }
    if (!wait) {
      if (!g.running && !g.waiters.length) g.cancelRequested = false; // 扩展命令当场处理完，没有回合可打断
      return { stopReason: "end_turn" };
    }
    const { outcome, cancelled } = await wait;
    const end = turnEnd(outcome, cancelled);
    if (!end.failure) return { stopReason: end.stopReason };
    throw new RpcError(INTERNAL_ERROR, end.failure.message, { message: end.failure.message, piStopReason: "error", failureKind: end.failure.kind });
  }

  /**
   * pi 的 rpc prompt 不认内置命令，/compact 会被当普通文字发给模型：换成 rpc compact。session/cancel 的 abort 也停压缩。
   * 没压成（最常见的是会话太短）只回一句话、照常结束：会话没坏，不值得出回合失败卡。期间被 /clear 换下就以错误收尾。
   */
  private async compact(g: Gen, cmd: Rec): Promise<Rec> {
    g.inflight++;
    try {
      const r = await g.link.command(cmd, COMPACT_TIMEOUT_MS);
      this.stillLive(g);
      this.update(g, compactNotice(r));
    } catch (e) {
      this.stillLive(g);
      if (g.cancelRequested) return { stopReason: "cancelled" };
      this.update(g, compactNotice(null, errText(e)));
    } finally {
      g.inflight--;
      g.cancelRequested = false;
    }
    void this.reportUsage(g);
    return { stopReason: "end_turn" };
  }

  private async steer(p: Rec): Promise<Rec> {
    const g = this.live(p);
    const r = await g.link.command({ type: "prompt", message: textOf(p.prompt), streamingBehavior: "steer" }, COMMAND_TIMEOUT_MS);
    this.stillLive(g);
    return { outcome: r?.disposition === "started" ? "startedNewTurn" : "injected" };
  }

  private async setOption(p: Rec): Promise<Rec> {
    const g = this.live(p);
    const opt = g.options.find((o) => o.id === p.configId);
    if (!opt || !opt.options.some((c: Rec) => c.value === p.value)) throw new RpcError(INVALID_PARAMS, `配置项 ${p.configId} 没有 ${p.value} 这个值`);
    if (p.configId === "model") {
      const m = splitModelValue(String(p.value));
      if (!m) throw new RpcError(INVALID_PARAMS, `模型要写成 provider/model：${p.value}`);
      await g.link.command({ type: "set_model", ...m }, COMMAND_TIMEOUT_MS);
    } else {
      await g.link.command({ type: "set_thinking_level", level: p.value }, COMMAND_TIMEOUT_MS);
    }
    await this.refreshOptions(g, COMMAND_TIMEOUT_MS); // 思考档会按模型收敛（deepseek 设 low 实际是 high），以 pi 回报的为准
    return { configOptions: g.options };
  }

  /** 只有真有回合（在跑 / 在等 / 正在提交）才记「被打断」，否则会错记到下一回合头上；abort 本身空闲时发也无害 */
  private cancel(p: Rec): void {
    const g = this.gen;
    if (!g || p?.sessionId !== g.sessionId) return;
    if (g.running || g.waiters.length || g.inflight) g.cancelRequested = true;
    g.link.command({ type: "abort" }, COMMAND_TIMEOUT_MS).catch((e) => this.deps.log(`abort 失败：${errText(e)}`));
  }
}
