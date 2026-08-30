/**
 * Claude Code 启动命令构造
 *
 * 统一 manager/launcher/cron 三处的 Claude Code 启动参数：
 * - MCP server 名（由 env MCP_NAME 控制，默认 claudestra）
 * - disallowedTools 黑名单（支持命名预设和自定义）
 * - dev channel 加载 + skip-permissions
 */

const MCP_NAME = process.env.MCP_NAME || "claudestra";

// ────────────────────────────────────────────────
// disallowedTools 预设
// ────────────────────────────────────────────────
//
// 预设的设计原则：
//   default   — 默认拦截真正不可逆的命令，其他放行。适合大多数场景
//   strict    — default + 禁网络 / 特权命令，适合 untrusted 任务
//   readonly  — default + 禁文件写入 + 禁包管理，适合 review/分析类任务
//   paranoid  — default + 禁 Bash / Write / Edit / WebFetch，最小权限
//
// 使用方式：
//   resolveDisallowed({ preset: "strict" })
//   resolveDisallowed({ raw: "Bash(foo:*) Bash(bar:*)" })
//   resolveDisallowed({})  // → default

const DEFAULT_DISALLOWED: readonly string[] = [
  "Bash(rm -rf:*)",
  "Bash(rm -r:*)",
  "Bash(rmdir:*)",
  "Bash(git push --force:*)",
  "Bash(git reset --hard:*)",
  "Bash(git clean -f:*)",
  "Bash(chmod 777:*)",
  // fork bomb。规则内不能含空格：--disallowedTools 是空格分隔的单参数编码
  // （见 buildClaudeCommand 的 join(" ")），带空格的规则会被 CLI 拆成两截并
  // 报 "matches no known tool"（v2.6.x 前的老写法 "Bash(:(){ :|:&};:)" 从未生效）。
  "Bash(:(){:|:&};:)",
] as const;

export const DISALLOWED_PRESETS: Record<string, readonly string[]> = {
  default: DEFAULT_DISALLOWED,

  strict: [
    ...DEFAULT_DISALLOWED,
    "Bash(sudo:*)",
    "Bash(su:*)",
    "Bash(curl:*)",
    "Bash(wget:*)",
    "Bash(ssh:*)",
    "Bash(scp:*)",
    "Bash(rsync:*)",
    "Bash(nc:*)",
    "Bash(ncat:*)",
    "Bash(dd:*)",
    "Bash(mkfs:*)",
  ],

  readonly: [
    ...DEFAULT_DISALLOWED,
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "Bash(git *:*)",
    "Bash(npm *:*)",
    "Bash(yarn *:*)",
    "Bash(pnpm *:*)",
    "Bash(bun *:*)",
    "Bash(pip *:*)",
    "Bash(uv *:*)",
    "Bash(cargo *:*)",
  ],

  paranoid: [
    ...DEFAULT_DISALLOWED,
    "Bash",
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "WebFetch",
  ],
};

export const DEFAULT_PRESET = "default";

// ────────────────────────────────────────────────
// 权限模式（Claude Code --permission-mode）
// ────────────────────────────────────────────────
//
// Claude Code 2.1.x 的 `--permission-mode <mode>`：
//   default          — 正常逐个问权限
//   acceptEdits      — 自动接受文件编辑，其余照问
//   bypassPermissions— 跳过所有权限检查（= 老的 --dangerously-skip-permissions）。
//                      Claudestra 新建/resume 的默认；详见 manager.ts cmdCreate 注释。
//   dontAsk          — 不弹框，按规则静默放行/拒绝
//   plan             — 只读 plan 模式
//
// disallowedTools 黑名单与 permission-mode 正交，两者叠加：黑名单永远是硬拦截。
//
// 历史模式 "auto"（v2.1.0 - v2.4.10 期间是默认）已彻底 deprecated，所有路径都
// 归一到 bypassPermissions。原因：classifier 模型过载会全 deny、误判 reply 是
// "擅自向外发布"、每装一个 MCP server 都得 install-cli 加 allow 规则、每次 tool
// call 加几百 ms。disallowedTools 黑名单已经把真危险命令兜住。详见 v2.4.11/13。

// v2.4.13+ "auto" 从 KNOWN 列表里拿掉了（仍接受作为输入，但会被归一到
// bypassPermissions，见 buildClaudeCommand / cmdCreate / cmdResume 里的兜底）。
// 显式删除是为了 `--help` / 错误提示不再把 auto 当合法选项推给用户。
export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "dontAsk",
  "plan",
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isKnownPermissionMode(m: string): boolean {
  return (PERMISSION_MODES as readonly string[]).includes(m);
}

// 启动路径未显式指定 permissionMode 时的回退。v2.4.11+ 重新回到 bypassPermissions，
// 也是 cmdCreate / cmdResume 的默认。所有路径里出现的 "auto" 字符串都会归一到这个值。
export const DEFAULT_PERMISSION_MODE: PermissionMode = "bypassPermissions";

// ────────────────────────────────────────────────
// 模型（Claude Code --model）
// ────────────────────────────────────────────────
//
// v2.4.20+ 支持按 agent 钉模型。别名 → 完整 model id 的映射，方便用户敲短名。
// 不在别名表里的值原样透传（允许用户指定任意 model id / 未来新模型）。
export const MODEL_ALIASES: Record<string, string> = {
  fable: "claude-fable-5",
  "fable-5": "claude-fable-5",
  opus: "claude-opus-5",
  "opus-5": "claude-opus-5",
  "opus-4-8": "claude-opus-4-8",
  "opus-4-7": "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

/** 别名 → model id；未知值原样返回（透传任意 model id）。 */
export function resolveModelAlias(m: string): string {
  const key = m.trim().toLowerCase();
  return MODEL_ALIASES[key] || m.trim();
}

/** Claude Code --effort / settings.json effortLevel 的合法档位。 */
export const KNOWN_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "auto"] as const;

/**
 * v2.21.1+ 会话内 /effort 注入额外接受的档位(peer owner 请求 2026-08-30)。
 * ultracode = xhigh + 动态 workflow 编排,CC 语义「this session only」——
 * 只在运行时切换有意义:不进启动 flag(重启即回落,存 registry 是谎言),
 * 不进全局默认。CC 2.1.247 实测 CLI 对它不警告(bogus 值会警告并回落默认),
 * 但语义仍按 CC 文档的 session-only 对待。
 */
export const RUNTIME_ONLY_EFFORT_LEVELS = ["ultracode"] as const;

export function isKnownEffort(e: string): boolean {
  return (KNOWN_EFFORT_LEVELS as readonly string[]).includes(e);
}

/** 会话内 /effort 注入的合法档位(启动档 + runtime-only 档)。 */
export function isKnownRuntimeEffort(e: string): boolean {
  return isKnownEffort(e) || (RUNTIME_ONLY_EFFORT_LEVELS as readonly string[]).includes(e);
}

/** 展示用：列出所有已知别名 + 对应 id。 */
export function listModelAliases(): Array<{ alias: string; model: string }> {
  return Object.entries(MODEL_ALIASES).map(([alias, model]) => ({ alias, model }));
}

export function listPresets(): string[] {
  return Object.keys(DISALLOWED_PRESETS);
}

export function isKnownPreset(name: string): boolean {
  return name in DISALLOWED_PRESETS;
}

/**
 * 解析 disallowedTools 来源。
 * raw 优先于 preset；都没给就用 default。
 */
export function resolveDisallowed(opts: {
  preset?: string;
  raw?: string;
}): string[] {
  if (opts.raw && opts.raw.trim()) {
    return opts.raw.trim().split(/\s+/).filter(Boolean);
  }
  const presetName = opts.preset || DEFAULT_PRESET;
  const preset = DISALLOWED_PRESETS[presetName];
  if (!preset) {
    throw new Error(
      `未知的权限预设: "${presetName}"。可用: ${listPresets().join(", ")}`
    );
  }
  return [...preset];
}

// ────────────────────────────────────────────────
// 启动命令构造
// ────────────────────────────────────────────────

export interface LaunchOptions {
  channelId: string;
  bridgeUrl?: string;
  /** 可选 session id（--session-id <uuid>） */
  sessionId?: string;
  /** resume 模式：传入要 resume 的 session id */
  resumeId?: string;
  /**
   * v2.7+ 与 resumeId 连用：`--fork-session` 分支一份副本而不抢占原 session。
   * 用于 (a) 原 session 被 Claude Code bg agent 占用时的自愈重启（占用的 session
   * 无法直接 resume，bg daemon 会把被杀的占用者 respawn 回来，进程层面赢不了——
   * 2026-07-09 事故实证），(b) 收编 bg 分身。fork 出的新 session id 需要启动后
   * 从 projects 目录 diff 探测并回写 registry。
   */
  forkSession?: boolean;
  /** resume 时的显示名 */
  displayName?: string;
  /** 已解析好的 disallowedTools 列表。与 preset 二选一 */
  disallowedTools?: readonly string[];
  /** 权限预设名称（default / strict / readonly / paranoid / 其他） */
  disallowedPreset?: string;
  /** 原始字符串覆盖（空格分隔的 entries） */
  disallowedRaw?: string;
  /**
   * 权限模式（`--permission-mode <mode>`）。见 PERMISSION_MODES。
   * 不传 → DEFAULT_PERMISSION_MODE（bypassPermissions，保持老行为）。
   * bypassPermissions 走经过验证的 `--dangerously-skip-permissions`，其余走
   * `--permission-mode`。
   */
  permissionMode?: string;
  /**
   * Session-scoped effort level（`--effort <level>`，只影响本 Claude Code session，
   * 不写到全局 user config）。支持 low / medium / high / xhigh / max。
   * 没传就不加 flag → Claude Code 用 `~/.claude/settings.json` 的全局 effortLevel。
   */
  effort?: string;
  /**
   * v2.4.20+ Session-scoped 模型（`--model <model>`）。给 create / resume / restart
   * 都生效。传模型 id（如 `claude-fable-5`）或别名（`fable` / `opus` / `sonnet` /
   * `haiku`）。没传就不加 flag → Claude Code 用全局 settings.json 的模型。
   *
   * 关键：resume/restart 用 `--resume` 会钉死会话原模型，只有显式 `--model` 才能
   * 覆盖 —— 这正是"改全局 settings 对已存在 agent 无效"的根因。
   */
  model?: string;
  /**
   * v2.16+ agent 职责注入（`--append-system-prompt`）。create 的 purpose 此前只进
   * registry（频道 topic 用），agent 本体从来看不到自己的职责描述——用户精心写的
   * purpose 等于白写。传了就以一行系统提示注入；resume 的占位 purpose
   * （"resumed: xxx"）由调用方负责过滤，这里不做启发式判断。
   */
  purpose?: string;
  /** purpose 注入时的自称名（registry 名，如 agent-foo）。 */
  agentName?: string;
  /**
   * v2.21+ project 上下文注入:一行「你属于 project X,目录有…,同伴有…」,与
   * purpose 合并成同一条 --append-system-prompt。让 review/测试类 agent 天然
   * 知道整个 project 的仓在哪、该找哪个同事协作。
   */
  projectContext?: string;
}

/** POSIX 单引号 shell 转义 */
function shellEscape(s: string): string {
  if (s === "") return "''";
  if (/^[a-zA-Z0-9_.\/:@-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 构造 Claude Code 启动命令行字符串（给 tmux send-keys 使用）。
 * 返回完整的 shell 命令，包含前导环境变量导出。
 */
export function buildClaudeCommand(opts: LaunchOptions): string {
  const bridgeUrl =
    opts.bridgeUrl || process.env.BRIDGE_URL || "ws://localhost:3847";

  const prefix =
    `DISCORD_CHANNEL_ID=${shellEscape(opts.channelId)} ` +
    `BRIDGE_URL=${shellEscape(bridgeUrl)} ` +
    `MCP_NAME=${shellEscape(MCP_NAME)}`;

  // 解析 disallowedTools
  const disallowed: string[] =
    opts.disallowedTools && opts.disallowedTools.length > 0
      ? [...opts.disallowedTools]
      : resolveDisallowed({
          preset: opts.disallowedPreset,
          raw: opts.disallowedRaw,
        });

  // v2.4.13+ "auto" deprecated → 归一到 bypassPermissions。三处都会兜：cmdCreate
  // / cmdResume 写 registry 之前已经归一了，这里再兜一层保护 cmdRestart 直读 registry
  // 的路径，并防止有人把 `--mode auto` 当 CLI 参数手敲。
  let mode =
    (opts.permissionMode && opts.permissionMode.trim()) || DEFAULT_PERMISSION_MODE;
  if (mode === "auto") mode = "bypassPermissions";

  const parts: string[] = [
    "claude",
    "--dangerously-load-development-channels",
    `server:${MCP_NAME}`,
  ];

  // bypassPermissions 走经过验证的 --dangerously-skip-permissions（语义相同，且它
  // 还顺带跳过 workspace trust dialog）；其余模式走 --permission-mode <mode>。
  // 非 bypass 模式启动期若弹 trust dialog，由 manager/launcher 的启动轮询
  // (isAutoConfirmableModal 几何识别) 自动 Enter 确认。
  if (mode === "bypassPermissions") {
    parts.push("--dangerously-skip-permissions");
  } else {
    parts.push("--permission-mode", shellEscape(mode));
    // v2.2.0+: 让 bypass 成为「可运行时切到的选项」（默认仍是上面的 mode）。这样
    // auto 拦截危险操作后，bridge 能用 Shift+Tab 把 agent 临时切到 bypass 重试，
    // 不用重启。没这个 flag，bypass 不在 Shift+Tab 循环里、运行时切不过去。
    // agent 自己提不了权（auto classifier 硬拦自我绕过），只有用户经 Discord 按钮
    // → bridge → tmux 发 Shift+Tab 才切得动。
    parts.push("--allow-dangerously-skip-permissions");
  }

  if (opts.resumeId) {
    parts.push("--resume", shellEscape(opts.resumeId));
    if (opts.forkSession) parts.push("--fork-session");
    if (opts.displayName) parts.push("--name", shellEscape(opts.displayName));
  } else if (opts.sessionId) {
    parts.push("--session-id", shellEscape(opts.sessionId));
  }

  if (opts.effort && opts.effort.trim() && opts.effort !== "default") {
    // ultracode 是 session-only 的运行时档,启动 flag 传它语义不明——防御性降到
    // xhigh(它的算力基底)。正常路径不会走到这:claude-settings 端点不把
    // ultracode 写进 registry。
    const eff = opts.effort.trim() === "ultracode" ? "xhigh" : opts.effort.trim();
    parts.push("--effort", shellEscape(eff));
  }

  // v2.4.20+ 显式 --model 覆盖会话原模型。放在 --resume 之后，Claude Code 以
  // 显式 flag 为准（这是"restart 改不掉已存在 agent 模型"的解法）。
  if (opts.model && opts.model.trim()) {
    parts.push("--model", shellEscape(resolveModelAlias(opts.model.trim())));
  }

  if (disallowed.length > 0) {
    parts.push("--disallowedTools", shellEscape(disallowed.join(" ")));
  }

  // v2.16+ purpose 注入:一行系统提示,让 agent 知道自己是谁、被派来干什么。
  // 截断 500 字防超长 purpose 撑爆 tmux send-keys 单行命令。
  // v2.21+ project 上下文并入同一条 --append-system-prompt(多条 flag 的合并
  // 语义不背书,单条最稳)。
  const sysLines: string[] = [];
  if (opts.purpose && opts.purpose.trim()) {
    const p = opts.purpose.trim().slice(0, 500);
    const who = opts.agentName ? `你是 Claudestra 编排系统中的 agent「${opts.agentName}」。` : "";
    sysLines.push(`${who}你的职责: ${p}`);
  }
  if (opts.projectContext && opts.projectContext.trim()) {
    sysLines.push(opts.projectContext.trim().slice(0, 600));
  }
  if (sysLines.length > 0) {
    parts.push("--append-system-prompt", shellEscape(sysLines.join("\n")));
  }

  return `${prefix} ${parts.join(" ")}`;
}

export { MCP_NAME, DEFAULT_DISALLOWED };
