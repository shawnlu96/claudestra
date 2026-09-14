/**
 * Pi agent 的启动命令构造器 —— 与 lib/claude-launch.ts 并列的**兄弟**，不是它的分支。
 *
 * 为什么不塞进 buildClaudeCommand：那个函数有 30+ 处调用和一个逐字符断言的测试
 * （tests/claude-launch.test.ts），在里面加 runtime 分支等于把 Pi 的回归面绑到
 * 全部 Claude Code agent 身上。这里只做「Pi 怎么起」，选谁起由 lib/launch-command.ts 分发。
 *
 * 关键差异（相对 Claude Code）：
 * - 没有 channel 协议，消息进上下文靠 Pi 扩展（src/pi/claudestra-extension.ts）
 * - 权限靠扩展/工具白名单，没有 --permission-mode / --disallowedTools
 * - 会话 id 是 open-or-create：`--session-id <id>` 存在就打开、不存在就新建
 *   —— create 与 restart 用同一条命令，不需要 Claude Code 那套 --resume/--fork-session
 * - `--approve` 跳过项目信任弹窗（等价于 CC 的 --dangerously-skip-permissions 里
 *   那一半「别问我信不信任这个目录」）
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { shellEscape } from "./claude-launch.js";

/** Claudestra 注入的 Pi 扩展：绝对路径（扩展必须能被 Pi 直接 -e 加载） */
export const PI_EXTENSION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "pi",
  "claudestra-extension.ts",
);

/** Pi 的 --thinking 合法值（与 claude 的 effort 档位不完全重合，只放行交集） */
const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface PiLaunchOptions {
  channelId: string;
  bridgeUrl?: string;
  /** 会话 id。Pi 的 --session-id 是 open-or-create，create/restart 共用 */
  sessionId?: string;
  /** registry 名（agent-xxx），注入给扩展做注册用 */
  agentName?: string;
  purpose?: string;
  projectContext?: string;
  /** Pi 的模型写法是 provider/model（如 cc-switch-open-code-go/glm-5.3-flash） */
  model?: string;
  /** claude 的 effort 档位，能对上 Pi 的 --thinking 才传 */
  effort?: string;
}

/** 构造 pi 启动命令行字符串（含前导环境变量导出），供 tmux send-keys 使用。 */
export function buildPiCommand(opts: PiLaunchOptions): string {
  const bridgeUrl = opts.bridgeUrl || process.env.BRIDGE_URL || "ws://localhost:3847";

  const prefix =
    `DISCORD_CHANNEL_ID=${shellEscape(opts.channelId)} ` +
    `BRIDGE_URL=${shellEscape(bridgeUrl)} ` +
    `CLAUDESTRA_AGENT=${shellEscape(opts.agentName || "")}`;

  const parts: string[] = [
    "pi",
    "--approve",
    "--extension",
    shellEscape(PI_EXTENSION_PATH),
  ];

  if (opts.sessionId) parts.push("--session-id", shellEscape(opts.sessionId));
  if (opts.agentName) parts.push("--name", shellEscape(opts.agentName));
  if (opts.model && opts.model.trim()) parts.push("--model", shellEscape(opts.model.trim()));

  const thinking = (opts.effort || "").trim();
  if (thinking && PI_THINKING_LEVELS.includes(thinking)) {
    parts.push("--thinking", shellEscape(thinking));
  }

  // 与 Claude Code 路径同样的 purpose / project 注入（v2.16+ / v2.21+ 的能力对齐）
  const sysLines: string[] = [];
  if (opts.purpose && opts.purpose.trim()) {
    const who = opts.agentName ? `你是 Claudestra 编排系统中的 agent「${opts.agentName}」。` : "";
    sysLines.push(`${who}你的职责: ${opts.purpose.trim().slice(0, 500)}`);
  }
  if (opts.projectContext && opts.projectContext.trim()) {
    sysLines.push(opts.projectContext.trim().slice(0, 600));
  }
  if (sysLines.length > 0) {
    parts.push("--append-system-prompt", shellEscape(sysLines.join("\n")));
  }

  return `${prefix} ${parts.join(" ")}`;
}
