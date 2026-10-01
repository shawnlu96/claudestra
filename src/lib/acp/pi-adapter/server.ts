/**
 * ACP 服务端 ↔ `pi --mode rpc`（路线 a，docs/design/pi-acp-eval.md §1）。一个适配器进程同一时刻只驱动一个 pi 会话：
 * - session/new 自己生成 id、session/resume 用给定 id，都起 `pi --session-id <id>`（open-or-create，不需要引导轮）；
 *   再来一次 session/new（/clear）就停掉旧 pi、换新 id 重起。
 * - session/prompt → prompt（followUp：pi 还在跑也能排上），等到 agent_settled 才回 stopReason；session/cancel → abort。
 *   _session/steering → 带 steer 的 prompt：排进在跑的回合 = injected，pi 另起一轮 = startedNewTurn（结束只靠 idle）。
 * - 回合结束后按 get_session_stats 发 usage_update；扩展弹框一律回取消；pi 意外退出 = 适配器退出，由宿主重起。
 * tests/pi-acp-replay.test.ts（录制的 pi 0.99.1 事件流回放）、tests/pi-acp-shell.test.ts。
 */
import { createRpcPeer, RpcError, type RpcPeer, type RpcWire } from "../rpc.js";
import {
  configOptions, createPiEventMapper, dialogCancel, mcpServersForPi, splitModelValue, stopReasonOf, textOf, threadStatus, usageUpdate, type TurnOutcome,
} from "./map.js";
import { PI_MCP_SERVERS_ENV } from "./mcp-mount.js";
import type { PiLink } from "./pi-link.js";

type Rec = Record<string, any>;

const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
/** pi 起来要加载扩展、连 MCP，头几条命令给足时间 */
const STARTUP_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 30_000;

export interface PiServerDeps {
  openPi(o: { sessionId: string; cwd: string; env: Record<string, string> }): PiLink;
  newSessionId(): string;
  log(msg: string): void;
  /** 适配器该退出了：宿主关了 stdin（0），或 pi 意外退出（1） */
  exit(code: number): void;
}

type Settled = { outcome: TurnOutcome; cancelled: boolean };
type Waiter = { resolve: (s: Settled) => void; reject: (e: Error) => void };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class PiAcpServer {
  private readonly acp: RpcPeer;
  private pi: PiLink | null = null;
  private sessionId = "";
  private mapper = createPiEventMapper();
  private options: Rec[] = [];
  private running = false;
  private inflight = 0;
  private cancelRequested = false;
  private waiters: Waiter[] = [];

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
      await this.open(id, p);
      return { sessionId: id, configOptions: this.options };
    });
    acp.onRequest("session/resume", async (p: Rec) => {
      if (typeof p?.sessionId !== "string" || !p.sessionId) throw new RpcError(INVALID_PARAMS, "session/resume 缺 sessionId");
      await this.open(p.sessionId, p);
      return { configOptions: this.options };
    });
    acp.onRequest("session/prompt", (p: Rec) => this.prompt(p));
    acp.onRequest("_session/steering", (p: Rec) => this.steer(p));
    acp.onRequest("session/set_config_option", (p: Rec) => this.setOption(p));
    acp.onNotification("session/cancel", (p: Rec) => this.cancel(p));
    acp.onClosed(() => void this.closePi().finally(() => deps.exit(0)));
  }

  private update(u: Rec): void {
    this.acp.notify("session/update", { sessionId: this.sessionId, update: u });
  }

  /** 当前 pi；请求带的 sessionId 对不上就拒（宿主只会问自己接上的那个会话） */
  private live(p: Rec): PiLink {
    if (!this.pi) throw new RpcError(INVALID_PARAMS, "还没有会话：先 session/new 或 session/resume");
    if (p?.sessionId !== this.sessionId) throw new RpcError(INVALID_PARAMS, `不认识的 sessionId：${p?.sessionId}`);
    return this.pi;
  }

  private async open(id: string, p: Rec): Promise<void> {
    const mcp = mcpServersForPi(p?.mcpServers);
    if ("error" in mcp) throw new RpcError(INVALID_PARAMS, mcp.error);
    await this.closePi();
    const env: Record<string, string> = Object.keys(mcp.servers).length ? { [PI_MCP_SERVERS_ENV]: JSON.stringify(mcp.servers) } : {};
    const link = this.deps.openPi({ sessionId: id, cwd: typeof p?.cwd === "string" && p.cwd ? p.cwd : process.cwd(), env });
    this.pi = link;
    this.sessionId = id;
    this.mapper = createPiEventMapper();
    link.onRecord((rec) => {
      if (link === this.pi) this.onRecord(link, rec); // 被 /clear 换下的旧 pi 收尾时的输出不算
    });
    link.onExit((why) => {
      if (link !== this.pi) return;
      this.deps.log(`pi 意外退出（${why}），适配器随之退出`);
      for (const w of this.waiters.splice(0)) w.reject(new RpcError(INTERNAL_ERROR, `pi 退出了（${why}）`));
      this.deps.exit(1);
    });
    await this.refreshOptions(link, STARTUP_TIMEOUT_MS);
  }

  /** 换下 / 关掉当前 pi：它的退出不再算意外（onExit 认 this.pi），所以还在等它 settle 的回合在这里就失败，不能悬着 */
  private async closePi(): Promise<void> {
    const old = this.pi;
    this.pi = null;
    if (!old) return;
    for (const w of this.waiters.splice(0)) w.reject(new RpcError(INTERNAL_ERROR, "会话被换掉或关闭了（session/new、resume 或宿主断开），这一轮作废"));
    this.running = false;
    this.cancelRequested = false;
    old.stop();
    await old.exited;
  }

  private async refreshOptions(link: PiLink, timeoutMs: number): Promise<void> {
    const [state, models, levels] = await Promise.all([
      link.command({ type: "get_state" }, timeoutMs),
      link.command({ type: "get_available_models" }, timeoutMs),
      link.command({ type: "get_available_thinking_levels" }, timeoutMs),
    ]);
    this.options = configOptions(state, models?.models, levels?.levels);
  }

  private onRecord(link: PiLink, rec: Rec): void {
    if (rec.type === "extension_ui_request") {
      const reply = dialogCancel(rec);
      if (!reply) return;
      this.deps.log(`扩展弹框（${rec.method}：${rec.title ?? ""}）按规矩回了取消`);
      return link.send(reply);
    }
    if (rec.type === "extension_error") return this.deps.log(`pi 扩展出错（${rec.extensionPath} / ${rec.event}）：${rec.error}`);
    for (const u of this.mapper.push(rec)) this.update(u);
    if (rec.type === "agent_start" && !this.running) {
      this.running = true;
      this.update(threadStatus("active"));
    }
    if (rec.type === "agent_settled") this.settle(link);
  }

  private settle(link: PiLink): void {
    this.running = false;
    this.update(threadStatus("idle"));
    const s: Settled = { outcome: this.mapper.takeOutcome(), cancelled: this.cancelRequested };
    this.cancelRequested = false;
    for (const w of this.waiters.splice(0)) w.resolve(s);
    void this.reportUsage(link);
  }

  private async reportUsage(link: PiLink): Promise<void> {
    try {
      const u = usageUpdate(await link.command({ type: "get_session_stats" }, COMMAND_TIMEOUT_MS));
      if (u) this.update(u);
    } catch (e) {
      this.deps.log(`取用量失败（本回合不报 usage_update）：${errText(e)}`);
    }
  }

  private async prompt(p: Rec): Promise<Rec> {
    const link = this.live(p);
    let wait: Promise<Settled> | null = null;
    this.inflight++;
    try {
      const r = await link.command({ type: "prompt", message: textOf(p.prompt), streamingBehavior: "followUp" }, COMMAND_TIMEOUT_MS);
      if (r?.disposition !== "handled") wait = new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    } finally {
      this.inflight--;
    }
    if (!wait) {
      if (!this.running && !this.waiters.length) this.cancelRequested = false; // 扩展命令当场处理完，没有回合可打断
      return { stopReason: "end_turn" };
    }
    const { outcome, cancelled } = await wait;
    const stopReason = stopReasonOf(outcome, cancelled);
    if (stopReason) return { stopReason };
    const message = `Pi 回合失败：${outcome.errorMessage ?? "未说明原因"}`;
    throw new RpcError(INTERNAL_ERROR, message, { message, piStopReason: "error" });
  }

  private async steer(p: Rec): Promise<Rec> {
    const r = await this.live(p).command({ type: "prompt", message: textOf(p.prompt), streamingBehavior: "steer" }, COMMAND_TIMEOUT_MS);
    return { outcome: r?.disposition === "started" ? "startedNewTurn" : "injected" };
  }

  private async setOption(p: Rec): Promise<Rec> {
    const link = this.live(p);
    const opt = this.options.find((o) => o.id === p.configId);
    if (!opt || !opt.options.some((c: Rec) => c.value === p.value)) throw new RpcError(INVALID_PARAMS, `配置项 ${p.configId} 没有 ${p.value} 这个值`);
    if (p.configId === "model") {
      const m = splitModelValue(String(p.value));
      if (!m) throw new RpcError(INVALID_PARAMS, `模型要写成 provider/model：${p.value}`);
      await link.command({ type: "set_model", ...m }, COMMAND_TIMEOUT_MS);
    } else {
      await link.command({ type: "set_thinking_level", level: p.value }, COMMAND_TIMEOUT_MS);
    }
    await this.refreshOptions(link, COMMAND_TIMEOUT_MS); // 思考档会按模型收敛（deepseek 设 low 实际是 high），以 pi 回报的为准
    return { configOptions: this.options };
  }

  /** 只有真有回合（在跑 / 在等 / 正在提交）才记「被打断」，否则会错记到下一回合头上；abort 本身空闲时发也无害 */
  private cancel(p: Rec): void {
    if (!this.pi || p?.sessionId !== this.sessionId) return;
    if (this.running || this.waiters.length || this.inflight) this.cancelRequested = true;
    this.pi.command({ type: "abort" }, COMMAND_TIMEOUT_MS).catch((e) => this.deps.log(`abort 失败：${errText(e)}`));
  }
}
