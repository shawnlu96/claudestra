/**
 * 运行时适配层（v2.24+）—— owner 2026-09-22：「不要每样都做一套。加一些标准接口，
 * 让它可扩展性强一点，日后还要加别的。」
 *
 * ## 为什么需要
 *
 * 到 Codex 为止我们有三种运行时，而每加一种，散在各处的 `if (runtime === "pi")`
 * 就多一批：manager 的 create 与 resume 各抄了同一套五步（可用性检查 → 清就绪标记 →
 * 等就绪 → 文案 → registry 字段），session-source 有三条分支，manager 有三个
 * scanXxxSessions。漏改一处的症状都是「某个入口把 A 运行时当 B 起/读」，而这种
 * 错误不报错、只是行为不对，排查成本远高于抽象本身。
 *
 * ## 分两层，因为现实就是两层
 *
 * - `SessionSourceAdapter`：**能被看见**。扫会话、定位文件、把一行翻译成 Claude Code
 *   形状。只读，历史面板与会话列表要的就是这些。
 * - `ManagedRuntimeAdapter`：在此之上**还能被我们启动并对话**。多出启动命令、就绪
 *   判据、退出指令，以及「消息怎么送进去」。
 *
 * 这个分层不是为了好看：Codex 在补完生命周期之前只实现上层，类型系统会替我们挡住
 * 「给一个只读来源建 agent」这种事——而不是等到运行时报一句看不懂的错。
 */

export type AnyRecord = Record<string, any>;

/** 会话列表里的一条（三种来源统一成这个形状） */
export interface DiscoveredSession {
  sessionId: string;
  cwd: string;
  slug: string;
  modifiedAt: Date;
  lastUserMessage: string;
  runtime: string;
}

export interface SessionSourceAdapter {
  /** registry / API / 前端都用这个字符串认它 */
  readonly id: string;
  /** 给人看的名字 */
  readonly label: string;
  /** 能不能被 Claudestra 启动并对话（false = 只读来源，前端据此不给「收编」按钮） */
  readonly manageable: boolean;

  /** 扫本机这种运行时的所有会话 */
  scanSessions(search?: string): Promise<DiscoveredSession[]>;

  /**
   * cwd + sessionId → 文件路径。**推不出来就返回 null**（调用方转去全库扫描）——
   * Pi 与 Codex 的文件名都带时间戳前缀，光有 id 拼不出路径。
   */
  sessionPath(cwd: string, sessionId: string): string | null;

  /** 全库兜底查找（cwd 记错 / 路径推断失准时用） */
  findSessionById(sessionId: string): string | null;

  /** 某工作目录下的会话文件（fork 前后 diff、归档扫描用） */
  listSessionsForCwd(cwd: string): string[];

  /** 这个路径是不是这种运行时的会话文件（按根目录判，零 I/O） */
  ownsPath(path: string, home?: string): boolean;

  /** 会话文件路径 → sessionId（文件名规则各家不同；认不出返回 null） */
  sessionIdFromPath(path: string): string | null;

  /**
   * bridge / API 侧的运行时策略。只读来源也可以先声明（接线前就把「怎么打断」
   * 这类约束定下来）；不声明 = 按 Claude Code 处理（controlFor 的回退）。
   */
  readonly control?: RuntimeControl;

  /**
   * 首行嗅探：归档副本的路径不带任何根特征，只能看内容。
   * 不实现 = 这种运行时没有可靠的头行签名。
   */
  sniffFirstLine?(firstLine: AnyRecord): boolean;

  /** 一行原文 → Claude Code 形状（不是对话内容返回 null） */
  translateLine(line: string): AnyRecord | null;

  /**
   * 有状态翻译器（每个文件 / 每个读窗口一个）。行格式需要跨行上下文才能翻对的运行时
   * 实现它（Codex：按轮丢 code-mode exec、整轮丢 exec 引导）；不实现 = translateLine 本身
   * 就是无状态的，调用方直接用它。
   */
  newTranslator?(): (line: string) => AnyRecord | null;
}

// ── 生命周期层 ─────────────────────────────────────────────────────────
//
// manager 只认下面这几个接口：建窗口 → 准备会话 → 发启动命令 → 等就绪 → 落 registry，
// 退出时按适配器给的按键 / 退出指令 / 弹窗处理走。加一种运行时 = 写一个适配器文件，
// manager / bridge 零改动。

/**
 * manager 交给适配器的窗口操作面。适配器不直接拼 tmux 命令 → 就绪 / 退出逻辑能用
 * 假窗口单测（runtime-lifecycle.test.ts）。
 */
export interface WindowOps {
  /** tmux 窗口名（registry 名，如 agent-foo；大总管是 "0"） */
  readonly name: string;
  /** tmux target（"master:agent-foo"） */
  readonly target: string;
  capture(lines?: number): Promise<string>;
  /** 字面文本 + Enter（带 copy-mode 守卫，见 tmuxSendLine） */
  sendLine(text: string): Promise<void>;
  /** 只发字面文本，不回车 */
  sendLiteral(text: string): Promise<void>;
  /** 发一个 tmux 按键名（"Enter" / "Escape" / "C-c" / "Down"） */
  sendKey(key: string): Promise<void>;
  /** Esc 走双击护栏（CC 连按两次 = Rewind，见 tmuxSendEscape） */
  sendEscape(): Promise<void>;
  getOption(key: string): Promise<string | null>;
  setOption(key: string, value: string): Promise<boolean>;
  childPids(): Promise<number[]>;
  sleep(ms: number): Promise<void>;
}

/** new = 全新会话；resume = 续上 sessionId；fork = 从 sessionId 分一份副本 */
export type LaunchMode = "new" | "resume" | "fork";

/**
 * 一次启动需要的全部信息。各适配器只读自己认得的字段，manager 可以无脑全传。
 *
 * ⚠ 可选字段「不传」与「传空」对启动命令是有区别的（比如 resume 历来不注入
 * agentName / purpose）——适配器必须原样转交，不要自作主张补默认值，否则
 * 老 agent 的启动命令会变（runtime-lifecycle.test.ts 逐字钉住）。
 */
export interface LaunchSpec {
  mode: LaunchMode;
  channelId: string;
  bridgeUrl: string;
  /** new：新会话 id；resume / fork：源会话 id */
  sessionId: string;
  /** 注入给会话的自称（registry 名）。不传 = 不注入 */
  agentName?: string;
  /**
   * 会话的工作目录（tmux 窗口的 -c）。CC / Pi 不读它（窗口 cwd 即会话 cwd）；Codex 要拿它
   * 跑 exec 引导（-C）并写目录信任。不传时 Codex 从 rollout 首行的 session_meta 取。
   */
  cwd?: string;
  displayName?: string;
  purpose?: string;
  projectContext?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  /** 运行时专属项（CC：disallowedPreset / disallowedRaw；Pi：piEnv）。不认得的键忽略 */
  extras?: Readonly<Record<string, unknown>>;
}

export type ReadyResult =
  | { ready: true; recoveredFullSession?: boolean }
  | {
      ready: false;
      /** occupied = 会话被别的进程占着（CC 的 bg agent）——调用方可改 fork 重试 */
      reason: "timeout" | "exited" | "occupied" | "blocked-dialog";
      detail?: string;
      recoveredFullSession?: boolean;
    };

/** bridge / API 侧的运行时策略：把散落的 `runtime === "pi"` 收成声明 */
export interface RuntimeControl {
  /** 打断当前回合发什么键。CC / Pi 是 C-c；空闲 Codex 收到 C-c 会直接退出 */
  interruptKeys: readonly string[];
  /** 人类消息到达且目标在忙时，是否先打断再投递（Pi 能 steer 进回合，不打断） */
  preemptOnHumanMessage: boolean;
  /** 忙闲信号从哪来：pane = 看屏幕文案；hook = 只信回合结束上报（isAgentIdle 恒答空闲） */
  idleSource: "pane" | "hook";
  /** 模型钉值怎么生效：in-session = 启动后会话内补发 /model；launch-flag = 启动参数即权威 */
  modelEnforcement: "in-session" | "launch-flag";
  /** CC 的屏幕文案判据（压缩中 / 权限弹窗等）能不能套在它身上 */
  paneHeuristics: boolean;
  /**
   * 只在「忙」时才发 interruptKeys。Codex：空闲时的 Esc 不是空操作——第一下挂上
   * backtrack，第二下打开历史回溯遮罩，TUI 就停在那里。不声明 = 照旧无条件发（CC / Pi）。
   * window-ops 的 interruptWindow 读它：空闲时一个键都不发，调用方回报「当前空闲，无需打断」。
   */
  interruptOnlyWhenBusy?: boolean;
}

/** fork 后探测真实会话 id 的上下文 */
export interface DiscoverContext {
  windowName: string;
  cwd: string;
  /** 源会话 id（探测结果不能是它） */
  exclude?: string;
  /** forkBaseline 在启动前拍的快照；没有 = 只用不依赖快照的探测手段 */
  baseline?: unknown;
  timeoutMs?: number;
}

export interface ManagedRuntimeAdapter extends SessionSourceAdapter {
  readonly manageable: true;
  readonly control: RuntimeControl;
  /** 消息怎么进会话（声明性，doctor / 前端展示用；真正的注入在 agent 侧通道进程） */
  readonly inbound: string;
  /** 回合结束怎么报（最终都是 POST /hook {event:"Stop"}） */
  readonly turnEnd: string;
  /** 优雅退出时键入的指令 */
  readonly exitCommand: string;
  /**
   * 退出指令之前的清场（停下当前回合、关掉遮罩）。返回 "at-shell" = 已经回到 shell。
   * 不实现 = 默认序列：interruptKeys 连发 3 轮（间隔 800ms）+ 一次守卫 Esc（CC / Pi）。
   * 连按 Esc 在别的 TUI 里是手势（Codex：backtrack 回溯）的运行时必须自己实现。
   */
  exitPrelude?(win: WindowOps): Promise<"at-shell" | "continue">;
  /** registry notes 里的会话前缀（历史值 "claude" / "pi"，保持不变） */
  readonly noteTag: string;

  isValidSessionId(id: string): boolean;
  /** 可执行文件在不在：create / resume 早败，不留垃圾频道 */
  available(): Promise<{ ok: true } | { ok: false; hint: string }>;
  /** 启动前把会话准备好，返回 TUI 应打开的 id。不实现 = 用 spec.sessionId */
  prepareSession?(spec: LaunchSpec): Promise<{ sessionId: string }>;
  buildLaunchCommand(spec: LaunchSpec): string;
  /** 发启动命令之前（复用窗口时清掉上一轮的就绪标记） */
  beforeLaunch?(win: WindowOps): Promise<void>;
  waitReady(win: WindowOps, budget: { rounds: number; pollMs: number }): Promise<ReadyResult>;
  /** 退出指令发出后，每轮看一眼屏幕，处理这个运行时自己的收尾弹窗 */
  onExitPane?(pane: string, win: WindowOps): Promise<"handled" | "none">;
  /** fork 启动前拍快照（给 discoverSessionId 做 diff 兜底） */
  forkBaseline?(cwd: string): Promise<unknown>;
  /** fork / 轮转后探测窗口里真实的会话 id。不实现 = 这个运行时不需要（会话 id 自报） */
  discoverSessionId?(ctx: DiscoverContext): Promise<{ sessionId: string; via: string } | null>;
  /** 落 registry 的运行时字段（CC 返回 {}：老数据逐字节不变） */
  registryFields(spec: LaunchSpec): Record<string, unknown>;
}

export function isManaged(a: SessionSourceAdapter): a is ManagedRuntimeAdapter {
  return a.manageable === true && typeof (a as Partial<ManagedRuntimeAdapter>).buildLaunchCommand === "function";
}

/** agent 侧通道进程里「把 bridge 的 message 帧送进会话」这一步（channel-server / 扩展实现） */
export interface InboundSink {
  deliver(content: string, meta: Record<string, string>): Promise<{ ok: true } | { ok: false; error: string }>;
}

