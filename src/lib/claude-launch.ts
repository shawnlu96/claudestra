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
  "Bash(:(){ :|:&};:)", // fork bomb
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
  /** resume 时的显示名 */
  displayName?: string;
  /** 已解析好的 disallowedTools 列表。与 preset 二选一 */
  disallowedTools?: readonly string[];
  /** 权限预设名称（default / strict / readonly / paranoid / 其他） */
  disallowedPreset?: string;
  /** 原始字符串覆盖（空格分隔的 entries） */
  disallowedRaw?: string;
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

  const parts: string[] = [
    "claude",
    "--dangerously-load-development-channels",
    `server:${MCP_NAME}`,
    "--dangerously-skip-permissions",
  ];

  if (opts.resumeId) {
    parts.push("--resume", shellEscape(opts.resumeId));
    if (opts.displayName) parts.push("--name", shellEscape(opts.displayName));
  } else if (opts.sessionId) {
    parts.push("--session-id", shellEscape(opts.sessionId));
  }

  if (disallowed.length > 0) {
    parts.push("--disallowedTools", shellEscape(disallowed.join(" ")));
  }

  return `${prefix} ${parts.join(" ")}`;
}

export { MCP_NAME, DEFAULT_DISALLOWED };
