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

import { resolveBridgeUrl } from "./bridge-url.js";
import { bridgePortOf } from "./bridge-port.js";

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { shellEscape } from "./claude-launch.js";
import { piEnvFlags, type PiEnvProfile } from "./pi-env.js";

/** Claudestra 注入的 Pi 扩展：绝对路径（扩展必须能被 Pi 直接 -e 加载） */
export const PI_EXTENSION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "pi",
  "claudestra-extension.ts",
);

/** Pi 的 --thinking 合法值（与 claude 的 effort 档位不完全重合，只放行交集） */
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** api 侧 effort 白名单（pi-settings 端点把它原样送进 tmux，不校验 = 换行注入面） */
export function isPiThinkingLevel(level: string): boolean {
  return PI_THINKING_LEVELS.includes(level);
}

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
  /**
   * v2.23+ 能力档案：决定这个 agent 带哪些扩展/技能/工具/MCP。
   * 缺省（undefined）= 继承用户全局 Pi 环境，与引入档案之前的行为逐字节一致。
   */
  piEnv?: PiEnvProfile;
}

/** 构造 pi 启动命令行字符串（含前导环境变量导出），供 tmux send-keys 使用。 */
export function buildPiCommand(opts: PiLaunchOptions): string {
  // ⚠ 与 claude-launch 同一条：兜底从 BRIDGE_PORT 推，写死 3847 会让改过端口的
  //   机器上所有 Pi agent 静默连不上 bridge（见 lib/bridge-url.ts）。
  const bridgeUrl = opts.bridgeUrl || resolveBridgeUrl();

  // BRIDGE_PORT 显式带上的理由同 claude-launch（tmux 全局环境会停在旧端口）
  const port = bridgePortOf(bridgeUrl);
  const prefix =
    `DISCORD_CHANNEL_ID=${shellEscape(opts.channelId)} ` +
    `BRIDGE_URL=${shellEscape(bridgeUrl)} ` +
    (port ? `BRIDGE_PORT=${port} ` : "") +
    `CLAUDESTRA_AGENT=${shellEscape(opts.agentName || "")}`;

  // 可执行文件名与 piAvailable() 的探测**同源**：tmux 窗口不继承 manager 的 env，
  // 这里写死 "pi" 而预检认 PI_BIN 的话 → 预检通过、窗口里 command not found、
  // 120s 假超时、create 把刚建的 agent 清掉。
  const parts: string[] = [shellEscape(process.env.PI_BIN || process.env.PI_CODING_AGENT_BIN || "pi")];

  // ⚠ 参数顺序有语义（实测 pi 0.85.1）：
  //   ① 信任开关 → ② 发现开关与额外扩展（包源必须在路径之前，见 pi-env.ts 注释）
  //   → ③ Claudestra 自己的通道扩展（路径）→ ④ 其余
  // 把通道扩展放最后是因为它是路径，而**任何路径之前**不能插包源；反过来说，
  // 包源必须全部排在第一个路径之前。
  parts.push(opts.piEnv?.trustProject === false ? "--no-approve" : "--approve");

  // 能力档案的开关（--no-extensions / -e 额外扩展 / --tools / --exclude-tools …）。
  // 带值的 flag 要成对处理 —— 不能靠「以 -- 开头」猜，值本身也可能是路径。
  const VALUE_FLAGS = new Set(["--extension", "--skill", "--tools", "--exclude-tools", "--mcp-config"]);
  const envFlags = piEnvFlags(opts.piEnv);
  for (let i = 0; i < envFlags.length; i++) {
    const flag = envFlags[i];
    parts.push(flag);
    if (VALUE_FLAGS.has(flag) && i + 1 < envFlags.length) parts.push(shellEscape(envFlags[++i]));
  }

  // Claudestra 通道扩展：base=minimal 下 --no-extensions 关掉了发现，但显式 -e 仍然生效
  // （实测：--no-extensions 下只剩内置 8 个工具 + 我们的通道工具）。
  parts.push("--extension", shellEscape(PI_EXTENSION_PATH));

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
