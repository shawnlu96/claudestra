/**
 * Claudestra 的 Pi 侧通道（Pi extension）。
 *
 * 作用：让一个跑在 tmux 里的 Pi 会话跟 Claude Code 会话一样成为 Claudestra agent ——
 * 收得到 Discord/Web/API 来的消息、能 reply 回话、能被别的 agent send_to_agent 找到、
 * 回合结束时告诉 bridge「我好了」。
 *
 * 为什么是扩展而不是 MCP：Claude Code 侧靠官方 channel 协议
 * （`notifications/claude/channel`）把消息**推进模型上下文**；Pi 核心不含 MCP
 * （要外挂 pi-mcp-adapter），而且 stdio MCP 子进程拿不到会话身份（PI_SESSION_ID
 * 只注入给 bash 工具）、也无法主动开一轮。Pi 扩展活在 Pi 进程里，天然握有
 * session id / 会话文件 / 注入 API，是唯一能双向闭链的位置。
 *
 * 与 channel-server.ts 的关系：说的是**同一套 bridge WebSocket 协议**
 * （register / registered / response / message / replaced + ping），所以 bridge 侧
 * 零改动即可收发。唯一不同的地方是「消息怎么进模型上下文」：
 *   Claude Code → MCP channel 通知；Pi → `pi.sendUserMessage()`。
 * 同理，Claude Code 的 Stop hook 在这里由 `agent_settled` 事件顶替
 * （比 Stop 更准：Pi 会先跑完自动重试/压缩重试才算 settled）。
 *
 * 环境变量（由 lib/pi-launch.ts 注入）：
 *   DISCORD_CHANNEL_ID —— 该 agent 的频道 id；缺失即认为不是 Claudestra 起的会话，
 *                          整个扩展退化为惰性（用户自己开的 pi 完全不受影响）
 *   CLAUDESTRA_AGENT   —— registry 里的 agent 名（日志/注册用）
 *   BRIDGE_URL         —— bridge 地址，默认 ws://localhost:3847
 */

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CHANNEL_ID = (process.env.DISCORD_CHANNEL_ID ?? "").trim();
const AGENT_NAME = (process.env.CLAUDESTRA_AGENT ?? "").trim();
const BRIDGE_URL = (process.env.BRIDGE_URL ?? "ws://localhost:3847").trim();
const BRIDGE_HTTP = BRIDGE_URL.replace(/^ws/, "http").replace(/\/+$/, "");

/** keepalive 间隔，与 channel-server 一致（防 bridge 的 ws idle 超时） */
const PING_MS = 25_000;
/** 单次 bridge 请求超时（reply 可能带文件上传，给足） */
const REQUEST_TIMEOUT_MS = 120_000;
const RECONNECT_MIN_MS = 3_000;
const RECONNECT_MAX_MS = 60_000;
/** 就绪标记写在 tmux window 上，manager 创建 agent 时轮询它判断「起来了」 */
const READY_OPTION = "@claudestra_ready";

// ────────────────────────────────────────────────────────────
// Pi 扩展 API 的最小结构化类型（本仓库不依赖 pi 包，避免为一个 type import
// 拖进整套依赖；字段与 @earendil-works/pi-coding-agent 0.85.x 的
// dist/core/extensions/types.d.ts 对齐，运行时由 Pi 自己提供实现）
// ────────────────────────────────────────────────────────────

interface PiToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  isError?: boolean;
}

interface PiUi {
  notify?(message: string, level?: "info" | "warning" | "error"): void;
  setStatus?(key: string, text: string | undefined): void;
}

interface PiModelLike {
  provider?: string;
  id?: string;
}

interface PiModelRegistryLike {
  getAll?(): PiModelLike[];
  getAvailable?(): PiModelLike[];
  find?(provider: string, modelId: string): PiModelLike | undefined;
}

interface PiContext {
  ui?: PiUi;
  /** 模型注册表（扩展命令里按 provider/id 解析模型用） */
  modelRegistry?: PiModelRegistryLike;
  /** 当前模型（可能为空）。取 name/id 写进能力快照 */
  model?: { id?: string; name?: string } | undefined;
  sessionManager?: {
    getSessionId?(): string | undefined;
    getSessionFile?(): string | undefined;
  };
}

interface PiToolDefinition {
  name: string;
  label?: string;
  description: string;
  promptSnippet?: string;
  parameters: Record<string, unknown>;
  execute(id: string, params: any): Promise<PiToolResult>;
}

interface PiExtensionApi {
  on(event: string, handler: (event: any, ctx: PiContext) => unknown): void;
  registerTool(tool: PiToolDefinition): void;
  sendUserMessage(
    content: string,
    options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
  ): Promise<void>;
  /**
   * 注册斜杠命令（v2.23+）：web 端切模型/思考档位走它 —— 不依赖 Pi 自带
   * `/model`（那是打开选择器的交互语义，未验证是否收参数），而是我们自己的
   * 确定性入口，直接调 setModel/setThinkingLevel。
   */
  registerCommand?(
    name: string,
    options: { description?: string; handler: (args: string, ctx: PiContext) => Promise<void> | void },
  ): void;
  setModel?(model: PiModelLike): Promise<boolean>;
  setThinkingLevel?(level: string): void;
  /** 以下三个用于能力快照（v2.23+），老版本 Pi 上没有 ⇒ 全部可选调用 */
  getAllTools?(): Array<{ name?: string }>;
  getActiveTools?(): string[];
  getCommands?(): Array<{ name?: string }>;
  getThinkingLevel?(): string;
  getModel?(): { id?: string; name?: string } | undefined;
}

// ────────────────────────────────────────────────────────────
// 扩展主体
// ────────────────────────────────────────────────────────────

export default function claudestraChannel(pi: PiExtensionApi): void {
  // 不是 Claudestra 起的会话 ⇒ 一行工具都不注册，彻底不影响用户自己的 pi。
  if (!CHANNEL_ID) return;

  let ui: PiUi | undefined;
  let sessionId = "";
  let sessionFile = "";
  let socket: WebSocket | null = null;
  let shuttingDown = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** registered 后**持有 30s** 才把退避计数归零（channel-server 同款）：立刻归零会让两个活实例以 3s 恒定互抢 */
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** 曾注册成功过 ⇒ 断线期间的请求入队等重连（channel-server 的 grace-queue 同款），而不是直接报错丢回复 */
  let everRegistered = false;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  /** Pi 是否在一轮当中——决定注入用不用 deliverAs（流式中必须给） */
  let streaming = false;
  /** 最近一次入站消息的 chat_id：reply 不传 chat_id 时的默认去处 */
  let lastChatId = "";
  const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const QUEUE_GRACE_MS = 60_000;
  const queued: Array<{ type: string; payload: Record<string, unknown>; resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  function notify(message: string, level: "info" | "warning" | "error" = "info") {
    try { ui?.notify?.(message, level); } catch { /* UI 不可用时静默 */ }
  }

  function setLinkStatus(linked: boolean) {
    try { ui?.setStatus?.("claudestra", linked ? `🔗 ${AGENT_NAME || "claudestra"}` : "⚠️ bridge 断开"); } catch { /* 同上 */ }
  }

  /** 在 tmux window 上留一个就绪标记：manager 靠它确认 Pi 已经挂上通道 */
  function markReady() {
    const pane = process.env.TMUX_PANE;
    if (!pane) return;
    execFile("tmux", ["set-option", "-w", "-t", pane, READY_OPTION, "1"], () => { /* 不在 tmux 里就忽略 */ });
  }

  /**
   * 把「这个会话实际加载了什么」写成快照（manager pi-env / 网页端读）。
   *
   * 为什么要落文件而不是发 bridge：bridge 对 registry 只读（唯一写者是 manager），
   * 而这份快照需要在 bridge 挂了、会话已死之后仍然可读（排查用）。落点与 registry 同
   * 目录家族，0600。
   * 记的是**实况**而不是配置：`--no-extensions` 到底关掉了什么，只有这里看得见。
   */
  function writeEnvSnapshot(ctx?: PiContext) {
    if (!AGENT_NAME) return;
    try {
      const tools = (pi.getAllTools?.() ?? [])
        .map((t) => (typeof t?.name === "string" ? t.name : ""))
        .filter(Boolean)
        .sort();
      const active = (pi.getActiveTools?.() ?? []).slice().sort();
      const commands = (pi.getCommands?.() ?? [])
        .map((c) => (typeof c?.name === "string" ? c.name : ""))
        .filter(Boolean)
        .sort();
      const model = ctx?.model ?? pi.getModel?.();
      const snap = {
        at: new Date().toISOString(),
        agent: AGENT_NAME,
        sessionId: sessionId || undefined,
        cwd: process.cwd(),
        piVersion: process.env.PI_VERSION || undefined,
        toolCount: tools.length,
        tools,
        activeTools: active,
        commandCount: commands.length,
        commands,
        model: model?.id || model?.name || undefined,
        thinking: (() => { try { return pi.getThinkingLevel?.(); } catch { return undefined; } })(),
      };
      const dir = join(homedir(), ".claude-orchestrator", "pi-env");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, `${AGENT_NAME}.json`), JSON.stringify(snap, null, 1), { mode: 0o600 });
    } catch { /* 快照写不了不影响通道本身 */ }
  }

  // ── bridge 连接 ──────────────────────────────────────────

  function stopPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({ type: "ping" })); } catch { /* 下一轮重连兜 */ }
      }
    }, PING_MS);
  }

  function rejectPending(reason: string) {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      pending.delete(id);
    }
  }

  function rejectQueued(reason: string) {
    for (const q of queued.splice(0, queued.length)) {
      clearTimeout(q.timer);
      q.reject(new Error(reason));
    }
  }

  /** registered 之后把断线期间排队的请求按原顺序重发 */
  function flushQueued() {
    if (!queued.length) return;
    for (const q of queued.splice(0, queued.length)) {
      clearTimeout(q.timer);
      bridgeRequest(q.type, q.payload).then(q.resolve, q.reject);
    }
  }

  function scheduleReconnect() {
    if (shuttingDown || reconnectTimer) return;
    const delay = Math.min(RECONNECT_MIN_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect(): void {
    if (shuttingDown) return;
    // 同进程只留一条 bridge 连接：session_start 可能再次触发（Pi 内切会话），不先关旧
    // socket 就会两条 ws 互相 4001 顶替 → onclose → 重连 → 自我内战。
    if (socket) {
      const old = socket;
      socket = null;
      try { old.onclose = null; old.onerror = null; old.close(); } catch { /* 已在关闭中 */ }
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(BRIDGE_URL);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      try {
        // 与 channel-server 的 register 帧同构，多带 runtime/sessionId/sessionFile：
        // bridge 靠 runtime 把 Pi 会话与 Claude Code 会话区分开（后者要挂 jsonl watcher）。
        ws.send(JSON.stringify({
          type: "register",
          channelId: CHANNEL_ID,
          agentName: AGENT_NAME || undefined,
          runtime: "pi",
          // 自报 pid/ppid：bridge 的频道对抢识别（lib/channel-contention.ts）只认数字 pid，
          // 不报 = 两个 Pi 实例内战永不告警，日志也只有 `pid ? → ?`
          pid: process.pid,
          ppid: process.ppid,
          sessionId: sessionId || undefined,
          sessionFile: sessionFile || undefined,
          cwd: process.cwd(),
        }));
      } catch { /* onclose 会兜重连 */ }
      startPing();
    };

    ws.onmessage = (event) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        return;
      }
      switch (msg.type) {
        case "registered":
          setLinkStatus(true);
          markReady();
          everRegistered = true;
          // 退避归零要等**持有 30s**：被顶替→夺回→再被顶替的循环里立刻归零，两个活实例就是 3s 一轮死循环
          if (holdTimer) clearTimeout(holdTimer);
          holdTimer = setTimeout(() => { holdTimer = null; reconnectAttempts = 0; }, 30_000);
          flushQueued();
          return;
        case "response": {
          const entry = pending.get(msg.requestId);
          if (!entry) return;
          pending.delete(msg.requestId);
          clearTimeout(entry.timer);
          if (msg.error) entry.reject(new Error(String(msg.error)));
          else entry.resolve(msg.result);
          return;
        }
        case "message":
          // bridge 已经把 header（[🤖 来自 X] 等）渲染好，原样注入即可
          if (msg.meta?.chat_id) lastChatId = String(msg.meta.chat_id);
          void inject(String(msg.content ?? ""));
          return;
        case "replaced":
          // 同一个频道被另一条连接顶替。Claude Code 侧的判据是「MCP stdio 还在 ⇒ 绝不死」；
          // 这里等价：会话还活着 ⇒ 不当致命错误，退避后把频道抢回来。
          setLinkStatus(false);
          return;
        default:
          return;
      }
    };

    ws.onclose = () => {
      stopPing();
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (socket === ws) socket = null;
      rejectPending("bridge 连接断开");
      if (!shuttingDown) {
        setLinkStatus(false);
        scheduleReconnect();
      }
    };

    ws.onerror = () => { /* onclose 兜 */ };
  }

  /** 把一条消息注入 Pi 会话。空闲时直接开一轮；流式中必须带 deliverAs。 */
  async function inject(text: string): Promise<void> {
    const content = String(text ?? "");
    if (!content.trim()) return;
    try {
      if (streaming) await pi.sendUserMessage(content, { deliverAs: "steer" });
      else await pi.sendUserMessage(content);
    } catch (error) {
      // 自己的 streaming 判断与 Pi 内部状态可能有一拍之差：两条路都试一遍再报错
      try {
        await pi.sendUserMessage(content, { deliverAs: "followUp" });
      } catch {
        notify(`Claudestra 消息注入失败：${String(error)}`, "error");
      }
    }
  }

  /** 向 bridge 发一条请求并等 response（协议与 channel-server 的 bridgeRequest 相同） */
  function bridgeRequest(type: string, payload: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        if (everRegistered && !shuttingDown) {
          // bridge 例行重启（kickstart 几秒）期间：入队等 registered 后 flush，
          // 而不是让 reply 直接报工具错误 → 用户丢回复
          const timer = setTimeout(() => {
            const i = queued.findIndex((q) => q.timer === timer);
            if (i >= 0) queued.splice(i, 1);
            reject(new Error(`bridge 断开超过 ${QUEUE_GRACE_MS / 1000}s，请求放弃：${type}`));
          }, QUEUE_GRACE_MS);
          queued.push({ type, payload, resolve, reject, timer });
          return;
        }
        reject(new Error("bridge 未连接（稍后重试，或检查 bridge 是否在跑）"));
        return;
      }
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`bridge 请求超时：${type}`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(requestId, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ type, requestId, ...payload }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(error as Error);
      }
    });
  }

  /**
   * 回合结束 → 让 bridge 把状态翻成「完成」（等价 Claude Code 的 Stop hook），
   * 并处理它的反向指令：这回合有投递给它却没回的请求时，bridge 会回
   * {block:true, reason}（v2.22.x 的补 reply 拦截）。Claude Code 侧把 block 翻成
   * hook 的 decision=block 让模型续跑一轮；这里等价地注入一条提醒再开一轮。
   *
   * 实测触发场景：弱模型会把结论写在正文里而不调 reply 工具 —— 对端收不到任何
   * 东西（web 只有零散过程文本、Discord 一条回复都没有）。与 CC 一致：同一条
   * 挂起请求只提醒一次（bridge 侧 nudgedAt 去重）。
   */
  function reportSettled(): void {
    void (async () => {
      try {
        const res = await fetch(`${BRIDGE_HTTP}/hook`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channelId: CHANNEL_ID, event: "Stop" }),
          signal: AbortSignal.timeout(5_000),
        });
        const data = (await res.json().catch(() => null)) as { block?: boolean; reason?: string } | null;
        if (data?.block && data.reason) {
          notify("本回合未调 reply，已提醒补发", "warning");
          await inject(String(data.reason));
        }
      } catch { /* bridge 不可达时不影响 Pi 本体 */ }
    })();
  }

  // ── 事件 ────────────────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    ui = ctx?.ui;
    try {
      sessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
      sessionFile = ctx?.sessionManager?.getSessionFile?.() ?? "";
    } catch { /* 老版本没有这两个方法时留空，不影响收发 */ }
    // 能力快照要在扩展/工具都注册完之后写 —— session_start 时本扩展自己的工具已注册，
    // 但 MCP 等懒加载的工具可能还没进 getAllTools（那时数量偏少，属已知误差）。
    writeEnvSnapshot(ctx);
    setLinkStatus(false);
    connect();
  });

  // 模型换了就重写快照（档案里钉的模型/用户手动切换都走这里）
  pi.on("model_select", (_event, ctx) => writeEnvSnapshot(ctx));

  pi.on("agent_start", () => { streaming = true; });
  pi.on("agent_settled", () => {
    streaming = false;
    reportSettled();
  });

  pi.on("session_shutdown", () => {
    shuttingDown = true;
    stopPing();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    rejectPending("会话结束");
    rejectQueued("会话结束");
    try { socket?.close(); } catch { /* 已在关闭中 */ }
    socket = null;
  });

  // ── 工具 ────────────────────────────────────────────────

  pi.registerTool({
    name: "reply",
    label: "Claudestra reply",
    description:
      "Send a reply to the user's channel (Discord or Web). On Discord, messages over 2000 chars are auto-chunked.",
    promptSnippet: "Reply to the user through Claudestra's reply tool — plain assistant text does not reach the user.",
    parameters: {
      type: "object",
      properties: {
        chat_id: {
          type: "string",
          description: "Target chat id from the incoming message header (Discord channel ID, or api:<tokenId> for Web/API users). Defaults to the channel this session was started with.",
        },
        text: {
          type: "string",
          description: "Message text to send. Markdown supported. Inline widgets also work (buttons [[{#id .primary}label]], copy chips [[{.copy}cmd]], agent chips [[{.agent}name]], badges).",
        },
        reply_to: { type: "string", description: "Message ID to reply to (optional, for threading)" },
        components: {
          type: "array",
          description: "Optional UI rows: {type:'buttons',buttons:[{id,label,style,emoji}]} | {type:'select',id,placeholder,options:[{label,value}]} | {type:'multiselect',id,options,min,max,submitLabel}. Clicks come back as [button:id] / [select:id:value].",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Absolute file paths to attach (images, logs, etc). Max 10 files, 25MB each.",
        },
      },
      required: ["text"],
    },
    async execute(_id, params) {
      try {
        const result = await bridgeRequest("reply", {
          chatId: params?.chat_id || lastChatId || CHANNEL_ID,
          text: params?.text || "",
          replyTo: params?.reply_to,
          components: params?.components,
          files: params?.files,
        });
        return {
          content: [{ type: "text", text: `Sent message(s): ${JSON.stringify(result?.messageIds ?? [])}` }],
          details: {},
          isError: false,
        };
      } catch (error) {
        return { content: [{ type: "text", text: String(error) }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "send_to_agent",
    label: "Claudestra send to agent",
    description:
      "Send a message to another Claudestra agent. Use for agent-to-agent collaboration, including cross-instance peers via target \"<agent>@<peer>\".",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "Target agent name (registry name, e.g. worker-alpha), or <agent>@<peer> for another Claudestra instance." },
        text: { type: "string", description: "Message text" },
        expecting: { type: "string", description: "Optional: what you expect back, shown to the receiver." },
        oneShot: { type: "boolean", description: "Fire-and-forget: no reply is pushed back to you." },
      },
      required: ["target", "text"],
    },
    async execute(_id, params) {
      try {
        const result = await bridgeRequest("route_to_agent", {
          targetName: params?.target || "",
          text: params?.text || "",
          expecting: typeof params?.expecting === "string" ? params.expecting : undefined,
          oneShot: params?.oneShot === true,
        });
        const advice = params?.oneShot === true
          ? `消息已 fire-and-forget 发给 ${result?.targetName}。不期待 push-back，直接 end_turn。`
          : result?.pushBack
            ? `消息已发送给 ${result?.targetName}。不要轮询——对方 reply 时 bridge 会自动把它 push 回你这边作为新的入站消息，结束本轮等即可。`
            : `消息已发送给 ${result?.targetName}。如需回复可用 fetch_messages 轮询频道 ${result?.targetChannelId}`;
        return { content: [{ type: "text", text: advice }], details: {}, isError: false };
      } catch (error) {
        return { content: [{ type: "text", text: String(error) }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "fetch_messages",
    label: "Claudestra fetch messages",
    description: "Fetch recent messages from a Discord channel (oldest first). Discord-only.",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Discord channel ID" },
        limit: { type: "number", description: "How many messages (max 100, default 20)" },
      },
      required: ["channel"],
    },
    async execute(_id, params) {
      try {
        const result = await bridgeRequest("fetch_messages", {
          channel: params?.channel || CHANNEL_ID,
          limit: params?.limit || 20,
        });
        return { content: [{ type: "text", text: String(result) }], details: {}, isError: false };
      } catch (error) {
        return { content: [{ type: "text", text: String(error) }], details: {}, isError: true };
      }
    },
  });

  /**
   * web 端切模型/思考档位（v2.23+）：`/claudestra-model <provider/id>`、
   * `/claudestra-thinking <level>`。由 bridge 用 tmux send-keys 注入本命令，
   * 效果与在 TUI 里手动切一致（Pi 的模型表 / 思考档位都是会话级状态）。
   */
  pi.registerCommand?.("claudestra-model", {
    description: "Claudestra: 切换本会话模型（参数：provider/model）",
    handler: async (args, ctx) => {
      const wanted = String(args || "").trim();
      if (!wanted) {
        notify("用法: /claudestra-model <provider/model>", "warning");
        return;
      }
      const registry = ctx?.modelRegistry;
      const all = [...(registry?.getAll?.() ?? []), ...(registry?.getAvailable?.() ?? [])];
      const found =
        all.find((m) => `${m?.provider ?? ""}/${m?.id ?? ""}` === wanted) ??
        (wanted.includes("/")
          ? registry?.find?.(wanted.split("/")[0], wanted.split("/").slice(1).join("/"))
          : all.find((m) => m?.id === wanted));
      if (!found) {
        notify(`找不到模型：${wanted}`, "error");
        return;
      }
      const ok = await pi.setModel?.(found);
      notify(ok ? `已切到 ${found.provider}/${found.id}` : `切换失败：${wanted}`, ok ? "info" : "error");
    },
  });

  pi.registerCommand?.("claudestra-thinking", {
    description: "Claudestra: 切换本会话思考档位（参数：off/minimal/low/medium/high/xhigh/max）",
    handler: async (args) => {
      const level = String(args || "").trim().toLowerCase();
      const allowed = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
      if (!allowed.includes(level)) {
        notify(`思考档位只能是 ${allowed.join(" / ")}`, "warning");
        return;
      }
      pi.setThinkingLevel?.(level);
      notify(`思考档位 → ${level}`);
    },
  });

  pi.registerTool({
    name: "project_info",
    label: "Claudestra project info",
    description:
      "Look up your Claudestra project: member agents, working directories, purpose roster. Check it before cross-repo collaboration to learn where other repos live and who to ask.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      try {
        const result = await bridgeRequest("project_info", {});
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {}, isError: false };
      } catch (error) {
        return { content: [{ type: "text", text: String(error) }], details: {}, isError: true };
      }
    },
  });
}
