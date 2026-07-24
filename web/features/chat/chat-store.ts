"use client";
import { createReactStore, ZenithStore } from "@do-md/zenith";
import type {
  AgentSession,
  ChatMessage,
  ChatAttachmentView,
  PendingPermission,
  PendingAsk,
  BgTaskView,
  CcTaskView,
} from "./type";
import { consumeSSEStream, processStreamEvent, type StreamSink } from "./stream";
import type { WebStreamEvent, WebComponentRow } from "@/lib/chat/events";
import { getLang } from "@/lib/i18n";

/**
 * roster 变化指纹：捕获会影响渲染的字段（成员 + 状态 + 展示名 + 置顶/mock 标记
 * + busy/contextTokens/lastActivityTs）。轮询用它判断列表是否真的变了，只有变了
 * 才更新 state。⚠ 后三个易变字段必须入指纹——contextTokens 不入的话，compact 后
 * 轮询拉回的新值会被「列表没变」挡掉，ctx 徽章/用量面板永远停在压缩前的旧值
 *（2026-07-16 真机实锤）；busy/lastActivityTs 同理（黄点与时间标签靠轮询回落）。
 */
function agentsSignature(list: AgentSession[]): string {
  return list
    .map(
      (a) =>
        `${a.name}${a.status}${a.displayName}${a.pinnedMaster ? 1 : 0}${a.mock ? 1 : 0}` +
        `${a.busy ? 1 : 0}${a.contextTokens ?? ""}${a.lastActivityTs ?? ""}${a.model ?? ""}${a.effort ?? ""}`
    )
    .join("");
}

interface ChatState {
  agents: AgentSession[];
  loadingAgents: boolean;
  /** agents 首拉是否已完成（成败均置 true）。false = 入场期，Splash 在场，
   *  侧栏不许显示「暂无会话」（SSR 首帧就渲染空态是 2026-07-13 的观感 bug）。 */
  agentsReady: boolean;
  /** 历史加载失败且当前无内容可显示 → 渲染「加载失败·重试」而非空会话。 */
  historyError: boolean;
  /** 当前打开的 agent 名（""=未选） */
  activeAgent: string;
  messages: ChatMessage[];
  /** 正在拉取历史消息（openAgent → loadMessages 期间） */
  loadingHistory: boolean;
  /** 服务端还有更早的历史可翻(向上分页,owner 2026-07-16)。 */
  historyHasMore: boolean;
  /** 正在向上翻页加载更早消息。 */
  loadingOlder: boolean;
  /** 本轮流式进行中 */
  streaming: boolean;
  /** 本轮已起、还没有任何输出 → 显示「思考中」 */
  awaitingChunk: boolean;
  /** Phase 2：当前会话待处理的权限 / session-idle 卡（null=无） */
  pendingPermission: PendingPermission | null;
  /** Phase 2：当前会话待处理的 AskUserQuestion 卡（null=无） */
  pendingAsk: PendingAsk | null;
  /** 当前会话的后台任务（subagent / bg shell）跟踪面板，按到达顺序。 */
  bgTasks: BgTaskView[];
  /** Claude Code 原生任务清单(TaskCreate,~/.claude/tasks/<sid>/)——Web 任务
   *  面板(owner 2026-07-16「console 里的 todo 适配到 Web UI」)。 */
  ccTasks: CcTaskView[];
  /** 左滑消息块选中的引用文本(composer 显示预览,发送时以 > 引用块前置)。 */
  quoteDraft: string | null;
  /** 个人资料：用户头像+昵称（显示在自己消息上方）与 Claude 头像+名称。 */
  profile: { nickname: string; avatar: string; claudeNickname: string; claudeAvatar: string };
}

/**
 * Chat 中枢：agent 会话列表 + 当前会话消息 + 段级流式收发。
 * 数据源是 Bridge（/api/v1 + /events，BFF 翻译），前端消费模式沿用 claude-os：
 * 每个 agent 一条持久 SSE 流；send 只 fire-and-forget 注入，输出经该流回来。
 * streamGen 代际门控：切走 agent 时自增令旧流回调失效，不污染新视图。
 */
export class ChatStore extends ZenithStore<ChatState> implements StreamSink {
  private streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private streamGen = 0;
  /** openAgent 代际：切走 agent 时自增，令历史加载 / 后续连流的旧回调失效。 */
  private openGen = 0;
  private seq = 0;
  /** 流式文本合批：SSE text 事件逐条 produce 会让长回合每秒多次触发整棵消息树
   *  reconcile（2026-07-13「列表滑动卡死」主因之一——移动端列表页与会话页并排
   *  都在 DOM）。缓冲 80ms 合并写入；工具/回复/定稿/发送前强制 flush 保段序；
   *  切会话时丢弃（别把旧会话的残字写进新视图）。 */
  private pendingText = "";
  private textFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** 回合边界标志：进入新回合(status running)置 true，下一段输出另起气泡。
   *  用于区分「新回合的输出」和「Stop 之后才冲刷到的同回合迟到文本」——后者
   *  必须并进同一气泡，否则渲染成「两个 Claude」，且新气泡永远等不到 done
   *  定稿、markdown 不渲染（2026-07-13 截图）。 */
  private nextBubbleBoundary = false;
  /**
   * 每个 agent 的会话快照缓存 —— **只做切回时的首屏即时展示**（stale-while-
   * revalidate）：切走存快照，切回先显示快照、后台重拉历史拉回即替换。
   *
   * 曾经（2026-07-10 前）切回只显示快照不重拉，导致两类不一致：离开期间 agent
   * 的新消息永远看不到（流只带新事件）、和刷新页面看到的版本不同。当时不敢重拉
   * 是因为历史解析丢了所有 channel 用户消息（isMeta 过滤 bug），回合结构被破坏、
   * 窗口一滑内容就大变；session-history.ts 解包修复后重拉是稳定的（气泡 id 用
   * jsonl seq，追加只影响尾部），缓存降级为防白屏的过渡帧。
   */
  private messageCache = new Map<string, ChatMessage[]>();

  constructor() {
    super({
      agents: [],
      loadingAgents: false,
      agentsReady: false,
      activeAgent: "",
      messages: [],
      loadingHistory: false,
      historyHasMore: false,
      loadingOlder: false,
      historyError: false,
      streaming: false,
      awaitingChunk: false,
      pendingPermission: null,
      pendingAsk: null,
      bgTasks: [],
      ccTasks: [],
      quoteDraft: null,
      profile: { nickname: "", avatar: "", claudeNickname: "", claudeAvatar: "" },
    });
  }

  /** 左滑消息块 → 设引用草稿(composer 预览;再滑别的块覆盖;✕ 清除)。 */
  public setQuote(text: string) {
    const t = text.trim().replace(/\s+/g, " ").slice(0, 200);
    if (!t) return;
    this.produce((s) => {
      s.quoteDraft = t;
    });
  }

  public clearQuote() {
    if (!this.state.quoteDraft) return;
    this.produce((s) => {
      s.quoteDraft = null;
    });
  }

  /** 拉取个人资料（应用启动时调一次;失败保持空,不打扰）。 */
  public async loadProfile() {
    try {
      const res = await fetch("/api/profile");
      if (!res.ok) return;
      const json = (await res.json()) as {
        data?: { nickname?: string; avatar?: string; claudeNickname?: string; claudeAvatar?: string };
      };
      this.produce((s) => {
        s.profile = {
          nickname: json.data?.nickname ?? "",
          avatar: json.data?.avatar ?? "",
          claudeNickname: json.data?.claudeNickname ?? "",
          claudeAvatar: json.data?.claudeAvatar ?? "",
        };
      });
    } catch {
      /* 非关键 */
    }
  }

  /** 保存个人资料并更新本地状态。返回是否成功（设置面板据此提示）。 */
  public async saveProfile(p: ChatState["profile"]): Promise<boolean> {
    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
      });
      if (!res.ok) return false;
      this.produce((s) => {
        s.profile = {
          nickname: p.nickname.trim().slice(0, 32),
          avatar: p.avatar,
          claudeNickname: p.claudeNickname.trim().slice(0, 32),
          claudeAvatar: p.claudeAvatar,
        };
      });
      return true;
    } catch {
      return false;
    }
  }

  private nextId() {
    return `cm${++this.seq}`;
  }

  private gotoLogin() {
    if (typeof window !== "undefined") window.location.href = "/login";
  }

  // ─── agent 列表 ──────────────────────────────────────────

  public async loadAgents() {
    this.produce((s) => {
      s.loadingAgents = true;
    });
    try {
      const res = await fetch("/api/agents");
      if (res.status === 401) return this.gotoLogin();
      const json = (await res.json()) as { data?: AgentSession[] };
      // 非 2xx（bridge 重启窗口的 502）别把列表清空——agents 一空,TopBar 的
      // info 变 undefined,已打开的终端页/操作区整体卸载(2026-07-14 实证:
      // 用户在终端页被「丢回聊天框」的元凶之一)。保留旧列表等下一轮。
      if (!res.ok || !Array.isArray(json.data)) throw new Error(`HTTP ${res.status}`);
      this.produce((s) => {
        s.agents = json.data!;
        s.loadingAgents = false;
        s.agentsReady = true;
      });
    } catch {
      this.produce((s) => {
        s.loadingAgents = false;
        s.agentsReady = true; // 失败也算入场结束——Splash 得退场，别永远盖着
      });
    }
  }

  /**
   * 静默刷新会话列表（轮询用）。感知本端之外的 roster 变化——master(大总管) /
   * CLI / 其他浏览器端 创建 / kill / restart 的 agent。
   * 与 loadAgents 的区别：不 toggle loadingAgents（不触发「加载中…」），且仅在
   * 列表实际变化时才 produce，避免每轮轮询都替换数组引用导致侧栏空转 re-render。
   * 401 静默返回（轮询不主动跳登录，交给显式操作处理）。
   */
  public async refreshAgents() {
    this.sweepStaleBgTasks(); // bg 卡陈旧收敛与网络无关,轮询节拍顺带跑
    try {
      const res = await fetch("/api/agents", { signal: AbortSignal.timeout(10_000) });
      if (res.status === 401) return;
      const json = (await res.json()) as { data?: AgentSession[] };
      // 同 loadAgents:502/坏响应不清列表(否则 15s 轮询撞上 bridge 重启窗口,
      // 终端页随 TopBar 卸载而蒸发)
      if (!res.ok || !Array.isArray(json.data)) return;
      const next = json.data;
      // 会话态校准(2026-07-14 owner:agent 忙不忙是服务端事实,别只依赖流):
      // 活跃会话在服务端是 busy(hook 真值)而本地没在 streaming → 补锁。
      const cur = next.find((a) => a.name === this.state.activeAgent);
      if (cur?.status === "active" && cur.busy && !this.state.streaming) {
        this.produce((s) => {
          s.streaming = true;
        });
      }
      // 反向对齐(2026-07-24 wechat-bot 事故:iOS 冻结页面错过 reply+done,恢复后
      // 各事件驱动的恢复路径全都没生效,UI 永远「正在回复」、回复永远不出现):
      // UI 认为回合进行中而服务端连续两拍(≈30s)说 agent 空闲 → 漏收 done/reply
      // 实锤,强制全量对齐(重拉历史把漏的 reply 补回 + 重连流)。单拍不动——
      // 15s 轮询粒度粗,刚起步的回合会瞬时 busy=false,下一拍即清零计数。
      // 这条自愈只依赖「JS 在跑 + 轮询能通」,不依赖 visibility/focus 事件。
      if (this.state.streaming && cur?.status === "active" && cur.busy === false) {
        this.staleStreamStrikes++;
        if (this.staleStreamStrikes >= 2 && Date.now() - this.lastForcedAlign > 60_000) {
          this.staleStreamStrikes = 0;
          this.lastForcedAlign = Date.now();
          this.clientLog("realign: UI streaming 但服务端连续两拍空闲,强制对齐");
          this.maybeReconnect();
        }
      } else {
        this.staleStreamStrikes = 0;
      }
      if (agentsSignature(next) === agentsSignature(this.state.agents)) return;
      this.produce((s) => {
        s.agents = next;
      });
    } catch {
      /* 轮询失败静默，下一轮再试 */
    }
  }

  // ─── 会话生命周期（新建 / kill / restart）──────────────────

  /** 新建 agent（经 BFF → Bridge runManager create）。成功后刷新列表并打开。 */
  public async createAgent(
    name: string,
    dir: string,
    purpose?: string,
    opts?: { model?: string; effort?: string }
  ): Promise<{ ok: boolean; error?: string; agent?: string }> {
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, dir, purpose, model: opts?.model, effort: opts?.effort }),
      });
      if (res.status === 401) {
        this.gotoLogin();
        return { ok: false, error: "未登录" };
      }
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        agent?: string;
      };
      if (!res.ok || json.ok === false) {
        return { ok: false, error: json.error || "创建失败" };
      }
      await this.loadAgents();
      const created = json.agent || name;
      await this.openAgent(created);
      return { ok: true, agent: created };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** kill agent（经 BFF → Bridge runManager kill）。成功后刷新列表。 */
  public async killAgent(
    name: string
  ): Promise<{ ok: boolean; error?: string }> {
    return this.lifecycleAction("kill", name);
  }

  /** restart agent（经 BFF → Bridge runManager restart）。成功后刷新列表。 */
  public async restartAgent(
    name: string
  ): Promise<{ ok: boolean; error?: string }> {
    return this.lifecycleAction("restart", name);
  }

  /** 永久移除(kill + registry 条目删除,归档保留)——列表左滑删除的后端。
   *  成功后本地立即剔除,activeAgent 恰好是它则清空回列表。 */
  public async removeAgent(
    name: string
  ): Promise<{ ok: boolean; error?: string }> {
    const r = await this.lifecycleAction("remove", name);
    if (r.ok) {
      this.messageCache.delete(name);
      this.produce((s) => {
        s.agents = s.agents.filter((a) => a.name !== name);
        if (s.activeAgent === name) {
          s.activeAgent = "";
          s.messages = [];
          s.streaming = false;
        }
      });
    }
    return r;
  }

  private async lifecycleAction(
    action: "kill" | "restart" | "remove",
    name: string
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`/api/agents/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.status === 401) {
        this.gotoLogin();
        return { ok: false, error: "未登录" };
      }
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || json.ok === false) {
        return {
          ok: false,
          error:
            json.error ||
            (getLang() === "zh" ? `${action} 失败` : `${action} failed`),
        };
      }
      await this.loadAgents();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // ─── 打开会话 + 持久流 ─────────────────────────────────────

  public async openAgent(name: string) {
    if (name === this.state.activeAgent) {
      // 重复打开当前会话(点推送通知/重点侧栏项)= 用户明确要看最新——不能静默
      // 返回:冻结页面点通知进来正是这条路(2026-07-24 wechat-bot 事故,推送到了
      // 点进去还是死页面)。做一次完整对齐,带断点锚则快路径重放补漏。
      this.clientLog("openAgent(same): 强制对齐");
      this.maybeReconnect();
      return;
    }
    // 记住最后打开的会话——iOS 把后台页整个回收重载后（store 全新、hash 还在
    // #chat），据此自动恢复，不让用户卡在空内容页手动重选（2026-07-12 真机）。
    try { localStorage.setItem("cstra_last_agent", name); } catch { /* 隐私模式等 */ }
    // 切走前把当前会话快照进缓存，回来时原样恢复（见 messageCache 注释）
    const prev = this.state.activeAgent;
    if (prev) this.messageCache.set(prev, this.state.messages);
    this.detachActiveStream();
    const gen = ++this.openGen;
    const cached = this.messageCache.get(name);
    this.produce((s) => {
      s.activeAgent = name;
      // 有缓存=先秒开上次那份（无 loading 闪烁），拉回最新后整体替换
      s.messages = cached ?? [];
      s.loadingHistory = !cached;
      s.historyError = false;
      s.streaming = false;
      s.awaitingChunk = false;
      // 交互卡是 per-session 的：切走先清空，新流连上后 bridge 会 replay 当前 pending。
      s.pendingPermission = null;
      s.pendingAsk = null;
      // bg 任务面板 per-session：切走清空（新流只带连上后的新任务，watcher 不 replay 旧的）
      s.bgTasks = [];
      // CC 任务清单 per-session:切走清空,下面异步拉当前 agent 的
      s.ccTasks = [];
    });
    void this.refreshCcTasks(name);
    // 无论有无缓存都重拉历史（stale-while-revalidate）——离开期间 agent 的产出
    // 只存在于 jsonl，不重拉就永远看不到。历史解析已稳定，重拉不再"漂"。
    await this.loadMessages(name, gen);
    if (gen !== this.openGen) return; // 已切走
    // 持久流 fire-and-forget（不 await，否则会一直阻塞到流关闭）
    void this.openStream(name);
  }

  /** 当前历史所属 sessionId(向上分页要钉在同一 session——seq 空间 per-session)。 */
  private historySessionId: string | null = null;

  /** 向上翻页:拉当前 session 更早的一页,prepend 到列表头。
   *  「显示更早」把本地窗口耗尽后由按钮触发(owner 2026-07-16「往上滑看全部历史」)。 */
  public async loadOlder() {
    const name = this.state.activeAgent;
    const sid = this.historySessionId;
    if (!name || !sid || this.state.loadingOlder || !this.state.historyHasMore) return;
    // 最早一条历史消息的 seq(id=h{seq};乐观消息是本地 id,跳过)
    const first = this.state.messages.find((m) => m.id.startsWith("h"));
    const beforeSeq = first ? Number(first.id.slice(1)) : NaN;
    if (!Number.isFinite(beforeSeq)) return;
    const gen = this.openGen;
    this.produce((s) => {
      s.loadingOlder = true;
    });
    try {
      const res = await fetch(
        `/api/chat/history?agent=${encodeURIComponent(name)}&before=${beforeSeq}&session=${encodeURIComponent(sid)}`
      );
      if (res.status === 401) return this.gotoLogin();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data?: ChatMessage[]; hasMore?: boolean };
      if (gen !== this.openGen) return; // 已切走
      this.produce((s) => {
        s.messages = [...(json.data ?? []), ...s.messages];
        s.historyHasMore = !!json.hasMore;
        s.loadingOlder = false;
      });
    } catch {
      if (gen === this.openGen) {
        this.produce((s) => {
          s.loadingOlder = false;
        });
      }
    }
  }

  /** CC 任务清单刷新防抖(TaskCreate/TaskUpdate 常连发)。 */
  private ccTasksTimer: ReturnType<typeof setTimeout> | null = null;

  /** 拉取当前 agent 的 Claude Code 原生任务清单(TaskCreate 落盘文件)。 */
  private async refreshCcTasks(name: string) {
    try {
      const res = await fetch(`/api/chat/tasks?agent=${encodeURIComponent(name)}`);
      if (!res.ok) return;
      const j = (await res.json()) as { data?: CcTaskView[] };
      if (this.state.activeAgent !== name) return; // 已切走
      this.produce((s) => {
        s.ccTasks = j.data ?? [];
      });
    } catch {
      /* 拉取失败不打扰,下次工具触发再试 */
    }
  }

  /** Task* 工具调用出现 → 防抖刷新任务面板(直播侧的触发钩子)。 */
  public noteTaskToolSeen() {
    const name = this.state.activeAgent;
    if (!name) return;
    if (this.ccTasksTimer) clearTimeout(this.ccTasksTimer);
    this.ccTasksTimer = setTimeout(() => {
      this.ccTasksTimer = null;
      void this.refreshCcTasks(this.state.activeAgent);
    }, 1200);
  }

  /** 强制从 jsonl 重新拉取当前 agent 的历史（丢弃缓存快照）。刷新入口用。 */
  public async reloadHistory() {
    const name = this.state.activeAgent;
    if (!name) return;
    this.messageCache.delete(name);
    this.discardPendingText();
    const gen = ++this.openGen;
    this.produce((s) => {
      s.messages = [];
      s.loadingHistory = true;
      s.historyError = false;
    });
    await this.loadMessages(name, gen);
  }

  /** 拉某 agent 的历史消息（读 CC session jsonl）。gen 守卫防切换竞态。
   *  失败（Bridge 限流 429→502 等）**不清空当前视图**：有缓存快照就继续显示，
   *  什么都没有才标 historyError（渲染「加载失败·重试」而不是空会话——
   *  2026-07-13「切回来完全没有聊天记录」）。失败自动重试一次（1.5s 后）。 */
  private async loadMessages(name: string, gen: number, attempt = 0) {
    try {
      const res = await fetch(
        `/api/chat/history?agent=${encodeURIComponent(name)}`,
        { signal: AbortSignal.timeout(15_000) } // 解冻窗口 fetch 悬挂 → 超时走既有重试
      );
      if (res.status === 401) return this.gotoLogin();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        data?: ChatMessage[];
        sessionId?: string;
        hasMore?: boolean;
      };
      if (gen !== this.openGen) return; // 已切走，丢弃
      this.historySessionId = json.sessionId ?? null;
      this.produce((s) => {
        s.historyHasMore = !!json.hasMore;
        const history = json.data ?? [];
        // 乐观消息保全:agent 忙时连发的消息在服务端排队,送达前不进 jsonl——
        // 历史整体替换会把它们从视图「吞掉」(2026-07-14 真机:连发多条 UI 上
        // 消失,消息本身没丢)。把尚未在历史尾部出现的本地消息接回视图尾;
        // 逐条消费匹配(同文本连发两条也各自对账),30 分钟后不再保全。
        const tail = history.slice(-80);
        const used = new Set<number>();
        // CRLF/空白归一后再比——channel 注入链路把 \n 变 \r\n,精确匹配失败
        // 会让乐观条+历史条双份并存(2026-07-15 真机;history route 已归一,
        // 这里再归一防其它来源差异)
        const norm = (x: string) => x.replace(/\r\n?/g, "\n").trim();
        const pending = s.messages.filter((m) => {
          if (!m.local || m.role !== "user") return false;
          if (m.ts && Date.now() - Date.parse(m.ts) > 30 * 60_000) return false;
          const t = norm(m.content);
          // wire 口径:按钮点击的乐观气泡显示 label,jsonl 里落的是 [button:<id>]
          // ——不看 wire 就永远对不上,气泡挂满 30 分钟(2026-07-14 真机截图)。
          // history route 会把点击渲染成 label(与乐观气泡同形,t 相等即中)或
          // 兜底「🔘 id」——第三种形态也要认,否则对账再度失败(2026-07-16)
          const w = m.wire?.trim();
          const friendly = w
            ? (w.match(/^\[button:([\w-]+)\]$/)?.[1] ??
                w.match(/^\[select:[\w-]+:(.+)\]$/)?.[1] ??
                null)
            : null;
          const idx = tail.findIndex(
            (h, i) =>
              !used.has(i) &&
              h.role === "user" &&
              (norm(h.content) === t ||
                (!!w && h.content.includes(w)) ||
                (!!friendly && norm(h.content) === `🔘 ${friendly}`))
          );
          if (idx >= 0) {
            used.add(idx);
            return false; // 已进历史,不再需要本地副本
          }
          return true;
        });
        // 直播回合保全:回合进行中做对齐(回前台 >5min / seq 倒退兜底),历史
        // 整体替换会把正在流式的 assistant 气泡吞掉——CC 回合内经常攒内存不落
        // 盘,jsonl 里还没有这些内容,气泡一吞屏上只剩状态条,「头像和动效都
        // 消失了,像卡死」(2026-07-16 真机截图)。历史尾部还不是 assistant
        // (jsonl 未落盘)时,把 streamed 气泡接回列表尾。
        const liveTail: ChatMessage[] = [];
        if (this.state.streaming) {
          const streamedBubbles = s.messages.filter(
            (m) => m.role === "assistant" && m.streamed
          );
          const histLast = history[history.length - 1];
          if (streamedBubbles.length && (!histLast || histLast.role !== "assistant")) {
            liveTail.push(...streamedBubbles);
          }
        }
        s.messages = [...history, ...pending, ...liveTail];
        // 回合进行中但尾部没有直播气泡(被历史吸收/尚无输出)→ 恢复「思考中」
        // 指示,别让 streaming 态孤零零挂在状态条上而列表底空白
        if (s.streaming && !liveTail.length) {
          const tail = s.messages[s.messages.length - 1];
          if (!(tail?.role === "assistant" && tail.streamed)) s.awaitingChunk = true;
        }
        s.loadingHistory = false;
        s.historyError = false;
      });
    } catch {
      if (gen !== this.openGen) return;
      if (attempt < 2) {
        // 瞬时失败自动重试:限流窗口/竞态之外,iOS 回前台头几秒网络栈未醒
        // fetch 必败(2026-07-14 真机:对齐失败历史缺口一直留到杀 App)——
        // 1.5s/3s 两次重试把网络唤醒窗口盖住;保持 loading 态不闪空
        setTimeout(() => {
          if (gen === this.openGen) void this.loadMessages(name, gen, attempt + 1);
        }, 1500 * (attempt + 1));
        return;
      }
      this.produce((s) => {
        s.loadingHistory = false;
        // 有缓存快照在显示就不打扰；空视图才亮错误态
        s.historyError = s.messages.length === 0;
      });
    }
  }

  /** 断流自动重连的退避（ms）：流存活 ≥10s 视为曾健康、重置 1s；快速反复断则翻倍封顶 10s。 */
  private reconnectDelay = 1_000;

  /** 假死流看门狗(25s 无字节 → cancel 重连);openStream 内创建,finally 清。 */
  private streamDog: ReturnType<typeof setInterval> | null = null;

  /** 断点续传锚:最后收到的 bridge 事件 seq(BFF 附在每条事件的 eid 上)。
   *  重连带 ?since=<seq> → bridge 环形缓冲重放错过的事件,不用全量重拉历史。 */
  private lastEventSeq = 0;
  private lastEventAgent = "";
  /** 页面最近一次进后台的时刻(chat.tsx visibilitychange hidden 时记)。 */
  private hiddenAt = 0;
  /** 反向对齐计数:UI streaming 但服务端说空闲的连续轮询拍数(见 refreshAgents)。 */
  private staleStreamStrikes = 0;
  private lastForcedAlign = 0;

  /** 前端恢复动作的服务端存档(fire-and-forget)——「web 收不到消息」类事故反复
   *  发生却无法取证前端当时做了什么(iOS 无法看 console),关键恢复路径打点到
   *  ~/.claude-orchestrator/web/client.log,下次直接对时间线。低频:只记恢复事件。 */
  public clientLog(msg: string) {
    try {
      void fetch("/api/client-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msg }),
      }).catch(() => {});
    } catch { /* 不影响主流程 */ }
  }

  public noteHidden() {
    this.hiddenAt = Date.now();
  }

  /** 打开某 agent 的持久 SSE 输出流。会话切换 / 重连共用。
   *  since:断点续传锚——bridge 重放 seq>since 的缓冲事件(错过的直播直接补)。 */
  private async openStream(name: string, since?: number) {
    const gen = ++this.streamGen;
    const startedAt = Date.now();
    // 连接建立超时(2026-07-24 owner:「点通知进来不更新,切出切回才好」):iOS
    // 解冻瞬间发的 fetch 会在网络栈未醒的窗口里永远悬着——无超时就无 catch/
    // finally,自动重连链彻底断头,只能靠用户再切一次页面。10s 没握上手就
    // abort → finally 走既有退避重连,网络醒了自然连上。连上后清计时器,
    // signal 不再触发,长连接流不受影响(流的死活归 25s 无字节看门狗管)。
    const connCtrl = new AbortController();
    const connTimer = setTimeout(() => connCtrl.abort(), 10_000);
    try {
      const res = await fetch(
        `/api/chat/stream?agent=${encodeURIComponent(name)}${since ? `&since=${since}` : ""}`,
        { signal: connCtrl.signal }
      );
      clearTimeout(connTimer);
      if (res.status === 401) return this.gotoLogin();
      if (gen !== this.streamGen) return; // 已切走
      const rawReader = res.body?.getReader();
      if (!rawReader) return;
      this.streamReader = rawReader;
      // 假死流看门狗:iOS 挂起恢复/网络切换后连接常「不报错也不产出」,以前
      // 只能等用户切页触发对齐。BFF 心跳 10s 一发,25s 收不到任何字节即判死,
      // 主动 cancel → read 返回 done → finally 走快路径重连(断点重放无损)。
      let lastByteAt = Date.now();
      if (this.streamDog) clearInterval(this.streamDog);
      this.streamDog = setInterval(() => {
        if (Date.now() - lastByteAt > 25_000) {
          this.clientLog(`watchdog: 流 ${Math.round((Date.now() - lastByteAt) / 1000)}s 无字节,判死重连`);
          rawReader.cancel().catch(() => {});
        }
      }, 5_000);
      const reader = {
        read: () =>
          rawReader.read().then((r) => {
            lastByteAt = Date.now();
            return r;
          }),
      } as ReadableStreamDefaultReader<Uint8Array>;
      await consumeSSEStream(reader, (evt) => {
        if (gen !== this.streamGen) return;
        const eid = (evt as { eid?: number }).eid;
        if (typeof eid === "number" && eid > 0) {
          // seq 倒退 = bridge 重启过(seq 清零 + 环形缓冲清空,重启窗口内的
          // 事件永久丢失)→ 全量重拉历史补缺口,一次即可(之后 seq 恢复单调)
          if (this.lastEventAgent === name && eid < this.lastEventSeq) {
            const g = ++this.openGen;
            void this.loadMessages(name, g);
          }
          this.lastEventSeq = eid;
          this.lastEventAgent = name;
        }
        processStreamEvent(this, evt);
      });
    } catch {
      /* 断流：保持静默，由下面的自动重连续 */
    } finally {
      clearTimeout(connTimer);
      if (this.streamDog) {
        clearInterval(this.streamDog);
        this.streamDog = null;
      }
      // 流关闭/断开时，若本轮仍卡在 streaming（done 没收到、流被掐、bridge 重启），
      // 解锁 composer——别让「■ 停止」永久卡住导致用户发不出/看着像没渲染。仅清当前流。
      if (
        gen === this.streamGen &&
        (this.state.streaming || this.state.awaitingChunk)
      ) {
        this.flushPendingText(); // 流断在缓冲窗口内的文本别丢
        // 不立即解锁:iOS 系统弹框(摇一摇撤销等)会让页面瞬时挂起、SSE 瞬断,
        // 回合其实还在继续——立即置 streaming=false 会让「思考中/停止按钮」
        // 凭空消失(2026-07-14 真机)。5s 后仍是当前代际(重连成功会自增代际,
        // 由连流后的 /pending 校准真实 thinking 态)才解锁,防 done 丢失锁死。
        setTimeout(() => {
          if (gen !== this.streamGen) return; // 已重连,新流说了算
          if (this.state.streaming || this.state.awaitingChunk) {
            this.produce((s) => {
              s.streaming = false;
              s.awaitingChunk = false;
            });
          }
        }, 5_000);
      }
      // [fork] 断流自动重连：bridge 重启 / 网络抖动会掐 SSE。此前只有「回前台」
      // 触发 maybeReconnect，页面一直在前台就永远断着——断流期间 agent 的过程
      // 记录直播全丢，也不重拉历史（2026-07-12 真机：bridge 重启后用户盯着页面，
      // 后续处理过程 web 上完全没有）。仍是当前流才自动重连；走 maybeReconnect
      // 完整对齐（重拉历史把断流期间的消息补回来）。后台页交给 visibilitychange。
      if (gen === this.streamGen && this.state.activeAgent === name) {
        // 退避 1s 起步 / 10s 封顶(曾 3s/30s——web 实时性完全押在这条流上,
        // 断档窗口就是「web 慢于 Discord」的主要成分;有断点重放兜着,激进
        // 一点重连是无损的。owner 2026-07-16)
        this.reconnectDelay =
          Date.now() - startedAt >= 10_000 ? 1_000 : Math.min(this.reconnectDelay * 2, 10_000);
        setTimeout(() => {
          if (gen !== this.streamGen || this.state.activeAgent !== name) return;
          if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
          // 断流重连:断档只有退避的 1-10s,带断点锚快路径重连(重放补事件)
          this.maybeReconnect({ fast: true });
        }, this.reconnectDelay);
      }
    }
  }

  /** 切走当前 agent：断前端流但不 abort 后端会话；自增代号令旧回调失效。 */
  private detachActiveStream() {
    this.discardPendingText(); // 旧会话的残字不写进新视图
    this.streamGen++;
    const reader = this.streamReader;
    this.streamReader = null;
    if (reader) reader.cancel().catch(() => {});
    if (this.state.streaming || this.state.awaitingChunk)
      this.produce((s) => {
        s.streaming = false;
        s.awaitingChunk = false;
      });
  }

  /**
   * 回前台 / bfcache 恢复：对当前会话做一次**完整对齐**，而不只是「流断了才重连」。
   *
   * 后台挂起有两个坑，光重连流补不回（真机实测：退到后台看终端、回合在后台跑完，
   * 回来后流卡住、回复看不到，必须杀 App 重进才看到）：
   *   ① iOS 常把 fetch-based SSE 流挂起但不真正关闭 → streamReader 仍非空，旧的
   *      「if (streamReader) return」守卫会永久挡住重连（僵尸流），这正是只能杀 App 的根因。
   *   ② 实时流只带「新事件」，补不回后台期间已经发生的 reply / done —— 回复看不到、
   *      done 漏收导致 composer 卡在「停止」。jsonl 才是权威，必须重拉历史。
   * 所以这里无条件：断开旧流（detachActiveStream 会 cancel + 置空 reader + 令旧回调
   * 失效）→ 重拉历史（追平错过的消息，bubble id 用 jsonl seq，追加只动尾部不闪）→
   * 重连流（openStream 连上后 BFF /pending 补 thinking 态，把 composer 锁态也校准：
   * 仍在回合则重锁「停止」，已结束则保持解锁）。
   */
  public maybeReconnect(opts?: { fast?: boolean }) {
    const name = this.state.activeAgent;
    if (!name) return;
    this.detachActiveStream();
    // 快路径(owner 2026-07-16「catch up 更快更丝滑」):短暂离开(<5min)且有
    // 断点锚 → 只重连流带 ?since=<seq>,bridge 环形缓冲把错过的事件直接重放,
    // 跳过全量历史往返(限流窗口下动辄数秒)。长时间后台/无锚 → 事件可能被挤出
    // 缓冲(每 agent 500 条),仍走全量重拉保正确。断流自动重连(fast:true)断档
    // 只有退避的 3-30s,恒走快路径。bridge 重启的缺口由 seq 倒退检测兜底。
    const shortAway = this.hiddenAt > 0 && Date.now() - this.hiddenAt < 5 * 60_000;
    if ((opts?.fast || shortAway) && this.lastEventAgent === name && this.lastEventSeq > 0) {
      if (!opts?.fast) this.clientLog(`reconnect(fast): since=${this.lastEventSeq} agent=${name}`);
      void this.openStream(name, this.lastEventSeq);
      return;
    }
    this.clientLog(`reconnect(full): agent=${name} 重拉历史+重连流`);
    const gen = ++this.openGen;
    void this.loadMessages(name, gen).then(() => {
      if (gen !== this.openGen) return;
      void this.openStream(name);
    });
  }

  /** [fork] 另一端用户的发言(stream user-in 事件,2026-07-24 owner:手机发的话
   *  电脑端要等对齐才出现)。同一 token 两端共用,本端自己发的消息也会收到回声
   *  ——按归一化文本对尾部消息对账,匹配到(乐观消息/历史已有)则跳过,否则画成
   *  用户气泡。历史重拉时 ru_ 气泡会被 jsonl 里的正主整体替换,无双份。 */
  public addRemoteUserMessage(text: string, attachments?: ChatAttachmentView[]) {
    const norm = (x: string) => x.replace(/\r\n?/g, "\n").trim();
    const t = norm(text);
    if (!t && !attachments?.length) return;
    const tail = this.state.messages.slice(-15);
    // 对账去重:文本相同即回声(附件消息 BFF 已剥注入块,与乐观消息的干净文本
    // 对得上);纯附件无文本时按附件数量兜底匹配
    if (
      tail.some(
        (m) =>
          m.role === "user" &&
          norm(m.wire ?? m.content) === t &&
          (t !== "" || (m.attachments?.length ?? 0) === (attachments?.length ?? 0))
      )
    )
      return;
    this.produce((s) => {
      // 与 send 一致:插话给流式中的助手气泡定稿,后续输出另起气泡
      if (s.streaming) {
        const last = s.messages[s.messages.length - 1];
        if (last?.role === "assistant" && last.streamed) last.streamed = false;
      }
      s.messages.push({
        id: `ru_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        role: "user",
        content: text,
        ts: new Date().toISOString(),
        ...(attachments?.length ? { attachments } : {}),
      });
    });
  }

  // ─── 发送 ────────────────────────────────────────────────

  /**
   * 发送一条用户消息。流式进行中也可发（「插入会话」）——claudestra 后端对忙碌
   * agent 无 busy 拦截，消息经 channel 投递后由 Claude Code 原生排队、当前回合边界
   * 处理（Discord 侧本就如此）。这是 claude-os stdin steer 在 claudestra 架构下的等价：
   * 不写进程 stdin，靠 CC 原生排队，语义即「插入正在跑的会话」。
   */
  public async send(text: string, files?: File[], wireText?: string) {
    let display = text.trim();
    const hasFiles = !!files && files.length > 0;
    if ((!display && !hasFiles) || !this.state.activeAgent) return;
    const agent = this.state.activeAgent;
    // 引用回复(owner 2026-07-16 左滑引用):composer 文本发送时把引用草稿以
    // Markdown 引用块前置——web/Discord 都原生渲染,agent 也看得懂针对哪段。
    // 按钮点击(wireText 场景)不消费引用。
    if (!wireText && this.state.quoteDraft && display) {
      display = `> ${this.state.quoteDraft}\n\n${display}`;
      this.clearQuote();
    }
    // wireText：发给 agent 的真实 payload（默认=展示文本）。按钮点击时展示 label、
    // 实际发 [button:<id>]，二者不同——agent 收到的是分支用的机器 payload。
    const wire = (wireText ?? display).trim() || display;
    // 用户气泡内回显：图片给 objectURL 预览，其它给文件名 chip
    const attachments: ChatAttachmentView[] | undefined = hasFiles
      ? files!.map((f) => {
          const isImg = f.type.startsWith("image/");
          return {
            name: f.name,
            kind: isImg ? ("image" as const) : ("file" as const),
            url: isImg ? URL.createObjectURL(f) : undefined,
          };
        })
      : undefined;
    this.flushPendingText(); // 用户气泡排在已缓冲的叙述之后
    const optimisticId = this.nextId();
    this.produce((s) => {
      // 流式中插话：给当前流式助手气泡定稿，用户插入独立成段（后续输出另起气泡），
      // 避免把「插入前的回复」和「插入后的回复」挤进同一个气泡显得错乱。
      if (s.streaming) {
        const last = s.messages[s.messages.length - 1];
        if (last?.role === "assistant" && last.streamed) last.streamed = false;
      }
      s.messages.push({
        id: optimisticId,
        role: "user",
        content: display,
        ts: new Date().toISOString(),
        attachments,
        local: true, // 历史确认前保留(见 loadMessages 的乐观消息保全)
        // 按钮点击:展示 label、实发 wire——对账按 wire 匹配,否则气泡永挂 30min
        ...(wire !== display ? { wire } : {}),
      });
      s.streaming = true;
      s.awaitingChunk = true;
    });
    try {
      let res: Response;
      if (hasFiles) {
        // multipart：不手动设 Content-Type，浏览器自动带 boundary
        const fd = new FormData();
        fd.append("agent", agent);
        fd.append("text", wire);
        for (const f of files!) fd.append("files", f);
        res = await fetch("/api/chat/send", { method: "POST", body: fd });
      } else {
        res = await fetch("/api/chat/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent, text: wire }),
        });
      }
      if (res.status === 401) return this.gotoLogin();
      if (!res.ok) {
        // 发送失败（agent 离线→502 / 超限→400 等）：解锁 + 附错误提示，
        // 别让「停止」按钮 + 思考态一直卡死（此前给离线 agent 发消息就会一直转）。
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        this.produce((s) => {
          s.streaming = false;
          s.awaitingChunk = false;
          s.messages.push({
            id: this.nextId(),
            role: "assistant",
            content: `${getLang() === "zh" ? "⚠️ 发送失败：" : "⚠️ Send failed: "}${j.error || `HTTP ${res.status}`}`,
            ts: new Date().toISOString(),
          });
        });
      }
      else {
        // slash 直通（/compact、/context 这类 CC 原生命令走 tmux 注入）：没有常规
        // 回合,不会有 done 事件——立即解除「正在回复」,并插一条系统线告知已注入。
        const j = (await res.json().catch(() => ({}))) as {
          data?: { slash?: boolean; ccText?: string };
        };
        if (j.data?.slash) {
          this.produce((s) => {
            s.streaming = false;
            s.awaitingChunk = false;
            // 撤掉乐观 user 气泡:slash 在 jsonl 里落 <command-name> → 历史渲染
            // 成 system 分隔线,不是 user 消息——对账(只扫 user)永远配不上,
            // 气泡会在每次 realign 后挂到列表末尾(与按钮点击同款错乱)。
            // 信息由下面的注入提示线承载,刷新后与历史形态一致。
            s.messages = s.messages.filter((m) => m.id !== optimisticId);
            s.messages.push({
              id: this.nextId(),
              role: "system",
              content:
                getLang() === "zh"
                  ? `⚡ 已注入 ${j.data?.ccText || "命令"} — 由 Claude Code 原生执行`
                  : `⚡ Injected ${j.data?.ccText || "command"} — run natively by Claude Code`,
              ts: new Date().toISOString(),
            });
          });
        }
        // 普通消息：输出经已打开的持久流回来
      }
    } catch (e) {
      this.produce((s) => {
        s.streaming = false;
        s.awaitingChunk = false;
        s.messages.push({
          id: this.nextId(),
          role: "assistant",
          content: `${getLang() === "zh" ? "⚠️ 发送失败：" : "⚠️ Send failed: "}${(e as Error).message}`,
          ts: new Date().toISOString(),
        });
      });
    }
  }

  // ─── StreamSink 实现 ─────────────────────────────────────

  /** 确保当前有一个流式助手气泡承接工具/文本；没有则新建。 */
  private ensureLiveAssistant() {
    const last = this.state.messages[this.state.messages.length - 1];
    // 尾部是 assistant 气泡且不在回合边界 → 直接承接。包括已定稿的：
    // Stop 之后才冲刷到的同回合迟到文本并进原气泡（此时 streamed=false，
    // 渲染自动走 Domd，markdown 正常）。只有新回合(boundary)才另起气泡。
    if (last && last.role === "assistant" && (last.streamed || !this.nextBubbleBoundary)) {
      this.nextBubbleBoundary = false; // 本回合输出已开始流动，边界消费掉
      return;
    }
    this.nextBubbleBoundary = false;
    const streamed = this.state.streaming;
    this.produce((s) => {
      s.messages.push({
        id: this.nextId(),
        role: "assistant",
        content: "",
        segments: [],
        // 回合外冒出的文本（罕见）直接定稿——永远等不到 done，别卡在纯文本渲染
        streamed,
        toolCalls: [],
        ts: new Date().toISOString(),
      });
      s.awaitingChunk = false;
    });
  }

  public addToolCall(
    name: string,
    summary: string,
    state: "running" | "done" | "error",
    detail?: string,
    id?: string
  ) {
    // Task* 工具出现 = 任务清单大概率变了 → 防抖刷新任务面板
    if (/^Task(Create|Update|Stop)$/.test(name)) this.noteTaskToolSeen();
    this.flushPendingText(); // 保持叙述/工具的真实交错序
    this.ensureLiveAssistant();
    this.produce((s) => {
      const last = s.messages[s.messages.length - 1];
      if (last?.role === "assistant") {
        const tc = { name, summary, state, ts: new Date().toISOString(), ...(detail ? { detail } : {}), ...(id ? { id } : {}) };
        last.toolCalls = last.toolCalls ?? [];
        last.toolCalls.push(tc);
        // segments 保持叙述/工具的真实交错序（渲染层优先用它）
        last.segments = last.segments ?? [];
        const tail = last.segments[last.segments.length - 1];
        if (tail?.kind === "tools") tail.tools.push(tc);
        else last.segments.push({ kind: "tools", tools: [tc] });
      }
      s.awaitingChunk = false;
    });
  }

  /** 工具状态更新（失败标红）。toolCalls 与 segments 是两份引用,immer 下
   *  各自 copy-on-write 可能分叉——两处都按 id 找到并更新。 */
  public updateToolState(id: string, state: "done" | "error") {
    this.produce((s) => {
      for (let i = s.messages.length - 1; i >= 0; i--) {
        const m = s.messages[i];
        if (m.role !== "assistant") continue;
        let hit = false;
        for (const tc of m.toolCalls ?? []) {
          if (tc.id === id) { tc.state = state; hit = true; }
        }
        for (const seg of m.segments ?? []) {
          if (seg.kind === "tools") {
            for (const tc of seg.tools) {
              if (tc.id === id) { tc.state = state; hit = true; }
            }
          }
        }
        if (hit) return;
      }
    });
  }

  public appendAssistantText(text: string) {
    this.pendingText += text;
    if (this.textFlushTimer === null) {
      this.textFlushTimer = setTimeout(() => this.flushPendingText(), 80);
    }
  }

  /** 把缓冲的流式文本一次性写入（合批）。时序敏感操作前必须先调它。 */
  private flushPendingText() {
    if (this.textFlushTimer !== null) {
      clearTimeout(this.textFlushTimer);
      this.textFlushTimer = null;
    }
    const text = this.pendingText;
    if (!text) return;
    this.pendingText = "";
    this.ensureLiveAssistant();
    this.produce((s) => {
      const last = s.messages[s.messages.length - 1];
      if (last?.role === "assistant") {
        last.content += text;
        last.segments = last.segments ?? [];
        const tail = last.segments[last.segments.length - 1];
        if (tail?.kind === "text") tail.text += text;
        else last.segments.push({ kind: "text", text, ts: new Date().toISOString() });
      }
      s.awaitingChunk = false;
    });
  }

  /** 丢弃未 flush 的流式文本（切会话/重拉历史时——残字不属于新视图）。 */
  private discardPendingText() {
    if (this.textFlushTimer !== null) {
      clearTimeout(this.textFlushTimer);
      this.textFlushTimer = null;
    }
    this.pendingText = "";
  }

  /**
   * [fork] reply() 的最终回复：挂到当前/最后一条 assistant 气泡的 replyText
   * （与过程叙述 content 分区渲染，中间淡分隔线）。
   *
   * 关键：**不走 ensureLiveAssistant**——reply 的 chat_message(out) 可能在回合结束
   * done 之后才到（envelope 投递有延迟）。若那时新建流式气泡，就永远等不到下一个 done
   * 定稿 → 停在纯文本、不渲染 markdown（正是「回复完又冒一条纯文本」的 bug）。这里
   * 直接挂到最后一条 assistant 气泡上（无论是否已定稿），已定稿的保持定稿 → reply 走
   * Domd 富文本。没有前置 assistant 气泡（纯 reply 无叙述）才新建，且回合外直接定稿。
   */
  public setReplyText(
    text: string,
    components?: WebComponentRow[],
    attachments?: { name: string; kind: "image" | "file"; url: string }[]
  ) {
    this.flushPendingText(); // reply 段插入前先落缓冲的叙述文本
    const hasComp = Array.isArray(components) && components.length > 0;
    const hasAtts = Array.isArray(attachments) && attachments.length > 0;
    const last = this.state.messages[this.state.messages.length - 1];
    // 回合边界上的 reply（他端触发、纯 reply 无叙述）另起气泡，不并进上一回合
    if (last && last.role === "assistant" && !this.nextBubbleBoundary) {
      this.produce((s) => {
        const m = s.messages[s.messages.length - 1];
        m.replyText = m.replyText ? `${m.replyText}\n${text}` : text;
        m.replyTs = m.replyTs ?? new Date().toISOString();
        // reply 作为段按时间序入列（reply 后叙述可能还在继续，钉底会时间倒挂）
        m.segments = m.segments ?? [];
        m.segments.push({ kind: "reply", text, ts: new Date().toISOString() });
        // 组件挂到承载 reply 的气泡；一条 reply 多段拼接时后到的组件覆盖（通常只一组）
        if (hasComp) m.replyComponents = components;
        // agent 出站附件（发图给用户）——多段 reply 各自的附件累积
        if (hasAtts) m.attachments = [...(m.attachments ?? []), ...attachments!];
        s.awaitingChunk = false;
      });
    } else {
      this.nextBubbleBoundary = false; // 本回合气泡由 reply 开启
      const streamed = this.state.streaming;
      this.produce((s) => {
        s.messages.push({
          id: this.nextId(),
          role: "assistant",
          content: "",
          replyText: text,
          replyTs: new Date().toISOString(),
          segments: [{ kind: "reply", text, ts: new Date().toISOString() }],
          ...(hasComp ? { replyComponents: components } : {}),
          ...(hasAtts ? { attachments } : {}),
          streamed,
          ts: new Date().toISOString(),
        });
        s.awaitingChunk = false;
      });
    }
  }

  /**
   * 点击 reply 附带的按钮 / 选单：回投 [button:<id>] / [select:<id>:<value>] 给 agent
   * （与 Discord 侧语义完全一致），同时禁用该条 reply 的整组组件、高亮所选。
   * 展示气泡用人类可读的 label（而非裸的 [button:id]），wire 才是 agent 分支用的 payload。
   */
  public async clickReplyComponent(
    messageId: string,
    choiceId: string,
    label: string,
    wire: string
  ) {
    // 已作答过就忽略（防重复点）
    const target = this.state.messages.find((m) => m.id === messageId);
    if (!target || target.replyClickedId) return;
    this.produce((s) => {
      const m = s.messages.find((x) => x.id === messageId);
      if (m) m.replyClickedId = choiceId;
    });
    await this.send(label, undefined, wire);
  }

  public setStatus(status: "running" | "done") {
    this.produce((s) => {
      if (status === "done") {
        s.streaming = false;
        s.awaitingChunk = false;
      } else if (!s.streaming) {
        // 进入回合 → 锁 composer 成「停止」态。三种触发：本端 send（已置 streaming，
        // 走不到这里）/ 他端（Discord/master/另一浏览器）触发该会话 / 刷新·切回·回前台后
        // 连流时 BFF 补的 status:running（会话本就在回合中）。awaitingChunk 补「思考中」点，
        // 首个工具/文本段到达即由 ensureLiveAssistant 清除。
        s.streaming = true;
        s.awaitingChunk = true;
      }
    });
    // 新回合开始（此前不在回合中）→ 下一段输出另起气泡，不并进上一回合。
    // ⚠ 例外:列表尾已经是本回合的流式气泡(重连/回前台恢复,detach 清过
    // streaming,/pending 又补回 running)——回合没换,不置边界,续写原气泡;
    // 否则同一回合拆成两个气泡,「像新对话一样多了一个头像」(2026-07-16 截图)
    if (status === "running") {
      const last = this.state.messages[this.state.messages.length - 1];
      if (!(last?.role === "assistant" && last.streamed)) this.nextBubbleBoundary = true;
    }
  }

  public endTurn(interrupted?: boolean) {
    this.flushPendingText(); // 定稿前落掉缓冲文本
    this.produce((s) => {
      // 逆扫最近一条 assistant,不只看 messages[last]——连发抢占时用户的新消息
      // 已乐观 push 到末尾,done(interrupted) 到达时末尾是 user 气泡,只看末尾
      // 会整个跳过打断标记(2026-07-14 用户实测:工作中补发消息没标「已打断」;
      // 手动「■ 停止」没有新消息插队所以一直正常)。streamed 标志保证只标直播回合。
      let marked = false;
      for (let i = s.messages.length - 1; i >= 0; i--) {
        const m = s.messages[i];
        if (m.role !== "assistant") continue;
        // 定稿 + 完成/打断标记(owner 2026-07-14):气泡底部绿色「✓ 完成」或
        // 琥珀「⊘ 已打断」行;仅直播回合,历史消息不带(历史有中断系统线)
        if (m.streamed) {
          if (interrupted) m.turnInterrupted = true;
          else m.turnDone = true;
          m.streamed = false;
          marked = true;
        }
        break;
      }
      // thinking 期被打断:回合还没吐出任何流式气泡,无处标黄 → 插一条与历史
      // 同款的中断系统线(SystemDivider 渲染成黄⊘)。插线位置按场景分:
      // - 连发抢占:末尾 user 是触发打断的新消息(刚乐观 push,<3s),线落它
      //   **前面**(两句之间,2026-07-14 temp 实测);
      // - 手动「■ 停止」:末尾 user 是被打断回合的发起者(更早发出),线落它
      //   **后面**——一刀切跳过会把线错插到发起消息之前(2026-07-15 真机:
      //   发一句→按停止→补一句,线跑到第一句上面,timeline 错乱)。
      // 两种 done(interrupt) 事件形状相同,用「末尾 user 的新鲜度」区分。
      if (interrupted && !marked) {
        let idx = s.messages.length;
        const tail = s.messages[idx - 1];
        if (
          tail?.role === "user" &&
          tail.ts &&
          Date.now() - Date.parse(tail.ts) < 3000
        ) {
          idx--;
        }
        s.messages.splice(idx, 0, {
          id: this.nextId(),
          role: "system",
          content: "已被用户中断",
          ts: new Date().toISOString(),
        });
      }
      s.streaming = false;
      s.awaitingChunk = false;
    });
  }

  /** 回合出错(流 error 事件)——最后一条 assistant 标红「✕ 出错」。 */
  public turnError() {
    this.produce((s) => {
      for (let i = s.messages.length - 1; i >= 0; i--) {
        const m = s.messages[i];
        if (m.role === "assistant") {
          m.turnError = true;
          break;
        }
      }
    });
  }

  /** 回合耗时(jsonl turn_duration)——补到完成标记上:「✓ 完成 · 12.3s」。
   *  隔了 user 消息就不回填(与 session-history 的 jsonl 侧回填同一保护):
   *  事件迟到时用户已开新回合,耗时错挂到新气泡上。 */
  public turnDuration(ms: number) {
    this.produce((s) => {
      for (let i = s.messages.length - 1; i >= 0; i--) {
        const m = s.messages[i];
        if (m.role === "assistant") {
          m.turnMs = ms;
          break;
        }
        if (m.role === "user") break;
      }
    });
  }

  // ─── Phase 2 交互卡：sink 写入 + 用户回传 ─────────────────────

  public setPermission(p: PendingPermission | null) {
    this.produce((s) => {
      s.pendingPermission = p;
      // 有卡 = 在等用户抉择而非等 agent 输出 → 关掉「思考中」dots
      if (p) s.awaitingChunk = false;
    });
  }

  public setAsk(a: PendingAsk | null) {
    this.produce((s) => {
      s.pendingAsk = a;
      if (a) s.awaitingChunk = false;
    });
  }

  // ── 后台任务（subagent / bg shell）跟踪 ──
  // 每行已在 bridge 侧截断；这里再给单任务的行数封顶，防长跑任务无界增长。
  private static readonly BG_MAX_LINES = 500;

  /** 收起一张后台任务卡（纯前端——bridge 重启后的 stale 卡 / 看完的完成卡）。 */
  public dismissBgTask(id: string) {
    this.produce((s) => {
      s.bgTasks = s.bgTasks.filter((t) => t.id !== id);
    });
  }

  /** 请求 agent 停止某后台任务。bridge 层没有 kill 权柄（任务进程归 Claude Code
   *  管），走普通消息让 agent 自己用 TaskStop——用户点了停止按钮,插话是预期行为。 */
  public requestStopBgTask(t: { id: string; title: string }) {
    void this.send(`请立即停止后台任务「${t.title || t.id}」(task id: ${t.id})，用 TaskStop。`);
  }

  public bgTaskStart(id: string, kind: "subagent" | "shell", title: string) {
    if (!id) return;
    this.produce((s) => {
      const existing = s.bgTasks.find((t) => t.id === id);
      if (existing) {
        // 同 id 重开（restart 后 baseline 再触发）→ 重置为 running
        existing.status = "running";
        existing.title = title || existing.title;
        existing.lastEventAt = Date.now();
      } else {
        s.bgTasks.push({ id, kind, title, lines: [], status: "running", lastEventAt: Date.now() });
      }
    });
  }

  public bgTaskUpdate(id: string, items: string[]) {
    if (!id || !items.length) return;
    this.produce((s) => {
      let t = s.bgTasks.find((x) => x.id === id);
      if (!t) {
        // update 早于 start（事件乱序/连流后补）→ 建一个占位任务
        t = { id, kind: "subagent", title: id, lines: [], status: "running" };
        s.bgTasks.push(t);
      }
      t.lastEventAt = Date.now();
      t.lines.push(...items);
      if (t.lines.length > ChatStore.BG_MAX_LINES) {
        t.lines = t.lines.slice(-ChatStore.BG_MAX_LINES);
      }
    });
  }

  public bgTaskDone(id: string, durationMs?: number) {
    if (!id) return;
    this.produce((s) => {
      const t = s.bgTasks.find((x) => x.id === id);
      if (t) {
        t.status = "done";
        t.durationMs = durationMs;
      }
    });
  }

  /** 活跃任务全集快照（连流后 BFF 下发）：不在 ids 里的 running 卡标完成。
   *  bridge 重启会丢 bg_task_completed 事件——幽灵「working」卡靠这里收敛
   *  （owner 2026-07-14:「为什么还有一个 Background task 在 working」）。 */
  public bgTaskSync(ids: string[]) {
    const live = new Set(ids);
    this.produce((s) => {
      for (const t of s.bgTasks) {
        if (t.status === "running" && !live.has(t.id)) t.status = "done";
      }
    });
  }

  /** [fork] bg 卡陈旧收敛(2026-07-24 owner:「bg task 总是不能正确关掉」):
   *  working 卡超 4min 无任何事件 → 置完成,镜像 bridge「3min 无活动即完成」
   *  规则。completed 事件在断档/冻结窗口漏收时,此前只有重连时刻的 bg-sync
   *  一次收敛机会,错过就永远 working。搭 15s 轮询便车,零新计时器。 */
  public sweepStaleBgTasks() {
    const cutoff = Date.now() - 4 * 60_000;
    if (!this.state.bgTasks.some((t) => t.status === "running" && (t.lastEventAt ?? 0) < cutoff)) return;
    this.produce((s) => {
      for (const t of s.bgTasks) {
        if (t.status === "running" && (t.lastEventAt ?? 0) < cutoff) t.status = "done";
      }
    });
  }

  /** compact 完成（bridge compact_done 事件）：聊天流里插一条系统分隔线，并把该
   *  agent 的 contextTokens 即时改成 post——ctx 徽章/警示条不用等 15s 轮询回落。
   *  此前「压缩完没完」全靠用户亲自去验证（owner 2026-07-14），这条就是完成回执。 */
  public compactDone(pre: number, post: number) {
    this.flushPendingText();
    const fmtK = (n: number) => `${Math.round(n / 1000)}k`;
    this.produce((s) => {
      s.messages.push({
        id: this.nextId(),
        role: "system",
        content: pre
          ? getLang() === "zh"
            ? `📦 上下文已压缩：${fmtK(pre)} → ${fmtK(post)}`
            : `📦 Context compacted: ${fmtK(pre)} → ${fmtK(post)}`
          : "📦 上下文已压缩",
        ts: new Date().toISOString(),
      });
      const a = s.agents.find((x) => x.name === s.activeAgent);
      if (a) a.contextTokens = post;
    });
  }

  /** POST 一个交互回传（interrupt/permission/auq）到 BFF，统一处理 401/错误。 */
  private async postAction(
    path: string,
    payload: Record<string, unknown>
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.status === 401) {
        this.gotoLogin();
        return { ok: false, error: "未登录" };
      }
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || json.ok === false)
        return { ok: false, error: json.error || "操作失败" };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * 清空会话（远程 Claude Code 原生 /clear）+ 可选开机指令。
   *
   * 流程：确保会话已打开（clear 后要看到全新对话）→ POST /api/chat/clear
   * （Bridge 打 /clear + 后台轮转 sessionId/watcher）→ 本地视图清零（消息、
   * 缓存、交互卡）→ 若配置了开机指令，稍候作为普通消息发出（走 send，
   * 用户气泡可见、回复流式回来——知识注入可见可审计）。
   * 回合进行中 Bridge 返 409（先停止再 clear），错误原样返回给对话框展示。
   */
  public async clearAgent(
    name: string,
    initMessage?: string
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.state.activeAgent !== name) await this.openAgent(name);
    const res = await this.postAction("/api/chat/clear", { agent: name });
    if (!res.ok) return res;
    this.messageCache.delete(name);
    this.produce((s) => {
      s.messages = [];
      s.pendingPermission = null;
      s.pendingAsk = null;
      s.streaming = false;
      s.awaitingChunk = false;
    });
    const boot = initMessage?.trim();
    if (boot) {
      // /clear 在 TUI 内瞬时完成；隔一拍再注入，避免与 slash 处理竞争
      await new Promise((r) => setTimeout(r, 1500));
      await this.send(boot);
    }
    return { ok: true };
  }

  /** 一键中断：给当前会话的 tmux window 发 Ctrl+C。 */
  /** 打断请求的本地冷却(防双击双 C-c;服务端另有 3s 冷却兜底)。 */
  private lastInterruptAt = 0;

  public async interrupt(): Promise<{ ok: boolean; error?: string }> {
    const agent = this.state.activeAgent;
    if (!agent) return { ok: false, error: "无活动会话" };
    if (Date.now() - this.lastInterruptAt < 3_000) return { ok: true };
    this.lastInterruptAt = Date.now();
    const res = await this.postAction("/api/chat/interrupt", { agent });
    // done 会经 SSE 回来解锁；这里乐观收敛
    if (res.ok)
      this.produce((s) => {
        s.streaming = false;
        s.awaitingChunk = false;
      });
    return res;
  }

  /** 应答权限 / session-idle 卡（action 见 bridge PERM_KEY_SEQ）。 */
  public async resolvePermission(
    action: string
  ): Promise<{ ok: boolean; error?: string }> {
    const agent = this.state.activeAgent;
    if (!agent) return { ok: false, error: "无活动会话" };
    // 乐观清卡（bridge 也会经 SSE 推 permission-cleared）
    this.produce((s) => {
      s.pendingPermission = null;
    });
    return this.postAction("/api/chat/permission", { agent, action });
  }

  /** 提交 AskUserQuestion 选择。selections[i]=第 i 题选中的 option index 数组。 */
  public async submitAsk(
    selections: number[][]
  ): Promise<{ ok: boolean; error?: string }> {
    const agent = this.state.activeAgent;
    if (!agent) return { ok: false, error: "无活动会话" };
    this.produce((s) => {
      s.pendingAsk = null;
    });
    return this.postAction("/api/chat/auq", {
      agent,
      action: "submit",
      selections,
    });
  }

  /** 取消 AskUserQuestion（给 agent 发 Esc）。 */
  public async cancelAsk(): Promise<{ ok: boolean; error?: string }> {
    const agent = this.state.activeAgent;
    if (!agent) return { ok: false, error: "无活动会话" };
    this.produce((s) => {
      s.pendingAsk = null;
    });
    return this.postAction("/api/chat/auq", { agent, action: "cancel" });
  }
}

export const {
  StoreProvider: ChatStoreProvider,
  useStore: useChatStore,
  useStoreApi: useChatStoreApi,
} = createReactStore(ChatStore);
