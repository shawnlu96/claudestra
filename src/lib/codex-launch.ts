/**
 * Codex agent 的启动命令与 exec 引导（纯函数，单测在 tests/codex-launch.test.ts）。
 *
 * 形状（0.153.4 实测）：new / restart / resume 共用 `codex resume <sid>`，fork 只把
 * `resume` 换成 `fork`。new 之所以也是 resume：新会话在第一轮之前没有 rollout，
 * `codex queue` 会报 `no rollout found`，所以先用 `codex exec --json` 跑一轮引导出
 * thread id（bootstrapArgs / parseBootstrapThreadId），再用 resume 起 TUI。
 *
 * 几个不能「顺手整理」的点：
 * - `-c` 的值是 TOML。字符串用 JSON.stringify 生成 basic string（JSON 的转义是 TOML
 *   的子集，DEL 与孤立代理对另行处理），再对整个 `key=value` 做 shellEscape。
 * - 目录信任必须写内联表 `projects={"<cwd>"={trust_level="trusted"}}`：点号路径
 *   `projects."<cwd>".trust_level=` 实测不生效，照样弹信任框。
 * - MCP 子进程只拿到白名单环境变量（HOME/PATH/…），DISCORD_CHANNEL_ID、TMUX_PANE
 *   都得经 `mcp_servers.<n>.env_vars` 显式放行。
 * - 不用 `notify`：它会顶掉用户全局 config.toml 里的 notify，且不能 block；回合结束走
 *   hooks.Stop（与 Claude Code 同构），打断走 hooks.Interrupt（打断时 Codex 不发 Stop）。
 * - 启动弹窗：`check_for_update_on_startup=false` 关掉默认高亮「Update now」的更新框，
 *   `--dangerously-bypass-hook-trust` 让我们注入的 hooks 免审（否则 Active=0）。
 * - developer_instructions **只在建线程那一轮生效**：TUI `resume` / `fork` 带新值都不会写进
 *   上下文（0.153.4 实测）。所以职责与回复规则真正生效的是 bootstrap 那一次；TUI 命令里
 *   照样带上，只为将来 Codex 改成 resume 也注入时不必改这里。接管外来会话、重启后改了
 *   职责/名册都拿不到新值——兜底是每条入站 `<channel>` 自带的 reply_via（codex-thread.ts）。
 */
import { existsSync } from "node:fs";
import { shellEscape } from "./claude-launch.js";
import { resolveLoginBinary, type LoginBinary, type Runner } from "./login-binary.js";
import { CONTEXT_PREAMBLE_MARKER, encodePreambleEnv } from "./codex-thread.js";

export { CONTEXT_PREAMBLE_MARKER };

export type CodexLaunchMode = "new" | "resume" | "fork";

export interface CodexLaunchSpec {
  mode: CodexLaunchMode;
  /** new：bootstrap 拿到的 id；resume/fork：源会话 id */
  sessionId: string;
  agentName: string;
  channelId: string;
  bridgeUrl: string;
  /** 与 BRIDGE_URL 同源的端口；hook 进程继承 TUI 的完整环境，靠它找 bridge */
  bridgePort: string;
  cwd: string;
  /** TUI 用的 codex（登录 shell 解析出的绝对路径） */
  codexBin: string;
  /** channel-server / typing-hook 用的 bun 绝对路径 */
  bunBin: string;
  /** Claudestra 仓库根 */
  claudestraHome: string;
  mcpName?: string;
  purpose?: string;
  projectContext?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
}

// ── TOML 值 ────────────────────────────────────────────────────────────────

/** TOML basic string。JSON.stringify 不转义 DEL，也会把孤立代理写成 TOML 不认的 \\udXXX */
export function tomlString(s: string): string {
  const scrubbed = s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
  return JSON.stringify(scrubbed).replace(/\x7f/g, "\\u007f");
}

export function tomlStringArray(items: readonly string[]): string {
  return `[${items.map(tomlString).join(",")}]`;
}

/** `-c key=value` 两个 argv 项，值整体 shellEscape */
function cfg(kv: string): string[] {
  return ["-c", shellEscape(kv)];
}

// ── 权限 / effort / model ─────────────────────────────────────────────────

/**
 * 只放行 bypassPermissions：其余 Claude Code 档位在 Codex 里会弹审批框，而
 * permission-watcher 不认 Codex 的 UI，没人去点 → agent 永远卡住。宁可启动前报错。
 */
export function codexPermissionFlags(mode: string | undefined): string[] {
  const m = (mode || "").trim() || "bypassPermissions";
  if (m === "bypassPermissions" || m === "auto") return ["--dangerously-bypass-approvals-and-sandbox"];
  throw new Error(`Codex agent 不支持权限模式「${m}」：只支持 bypassPermissions（其它档位会弹审批框，没人能点）`);
}

export const CODEX_EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;

/** Claude Code 的 effort → Codex 的 model_reasoning_effort；max 映射到 Codex 的最高档 */
export function codexEffort(effort: string | undefined): string | null {
  const e = (effort || "").trim();
  if (!e || e === "default" || e === "auto") return null;
  if (e === "max" || e === "ultracode") return "xhigh";
  if ((CODEX_EFFORT_LEVELS as readonly string[]).includes(e)) return e;
  throw new Error(`Codex 不认识的 effort「${e}」（可用：${CODEX_EFFORT_LEVELS.join(" / ")}）`);
}

/** Claude 的模型名/别名传给 Codex 只会在启动后报错，提前拦 */
export function codexModel(model: string | undefined): string | null {
  const m = (model || "").trim();
  if (!m) return null;
  if (/^(claude|opus|sonnet|haiku|fable)\b/i.test(m)) {
    throw new Error(`「${m}」是 Claude 的模型，Codex agent 用不了`);
  }
  return m;
}

function modelFlags(spec: { model?: string; effort?: string }): string[] {
  const out: string[] = [];
  const m = codexModel(spec.model);
  if (m) out.push("-m", shellEscape(m));
  const e = codexEffort(spec.effort);
  if (e) out.push(...cfg(`model_reasoning_effort=${tomlString(e)}`));
  return out;
}

// ── developer_instructions ─────────────────────────────────────────────────

/**
 * Codex 不把 MCP server 的 instructions 放进模型上下文（实测 rollout 里没有），所以
 * 职责、project 上下文和频道回复规则经 developer_instructions 注入——只在 exec 引导建线程
 * 时生效一次（见文件头）。
 */
export function codexDeveloperInstructions(opts: {
  agentName?: string;
  purpose?: string;
  projectContext?: string;
  channelRules: string;
}): string {
  return [...codexRoleLines(opts), opts.channelRules].join("\n\n");
}

/**
 * 职责 / project 上下文 / 回复规则三段——developer_instructions 与重启后的前言共用这一份，
 * 两处不会各写各的、慢慢漂移。
 */
export function codexRoleLines(opts: { agentName?: string; purpose?: string; projectContext?: string }): string[] {
  const lines: string[] = [];
  if (opts.purpose && opts.purpose.trim()) {
    const who = opts.agentName ? `你是 Claudestra 编排系统中的 agent「${opts.agentName}」。` : "";
    lines.push(`${who}你的职责: ${opts.purpose.trim().slice(0, 500)}`);
  }
  if (opts.projectContext && opts.projectContext.trim()) lines.push(opts.projectContext.trim().slice(0, 600));
  lines.push(
    "用 <channel …> 包着的 user 消息来自 Claudestra 频道（Discord / Web）。你的纯文字输出对方看不到，" +
      "回复一律调用 claudestra 的 reply 工具（chat_id 取 <channel> 标签里的 chat_id）。",
  );
  return lines;
}

/**
 * 重启 / 收编后第一条投递消息前附的前言。
 *
 * 为什么要它：developer_instructions 只在 exec 引导建线程那一轮生效（TUI 的 resume / fork
 * 带新值不写进上下文，0.153.4 实测），所以收编来的外来会话从没见过回复规则，重启前改过的
 * 职责 / project 名册也送不进去。前言与 developer_instructions 同源（codexRoleLines），
 * 刻意只放短的三段，完整频道规则太长、每次重启都塞一遍不划算。
 */
export function codexContextPreamble(opts: { agentName?: string; purpose?: string; projectContext?: string }): string {
  return [
    `${CONTEXT_PREAMBLE_MARKER} 会话刚由 Claudestra 重启或收编，以下是当前生效的身份与规则（以此为准）：`,
    ...codexRoleLines(opts),
  ].join("\n");
}

// ── 启动命令 ───────────────────────────────────────────────────────────────

/** channel-server 要从 Codex 拿到的环境变量（Codex 给 MCP 子进程的环境是白名单） */
export const CODEX_MCP_ENV_VARS = [
  "DISCORD_CHANNEL_ID",
  "BRIDGE_URL",
  "BRIDGE_PORT",
  "CLAUDESTRA_AGENT",
  "CLAUDESTRA_RUNTIME",
  "CLAUDESTRA_SESSION_ID",
  "CLAUDESTRA_CODEX_BIN",
  "CLAUDESTRA_CODEX_PREAMBLE",
  "MCP_NAME",
  "TMUX",
  "TMUX_PANE",
] as const;

export function buildCodexCommand(spec: CodexLaunchSpec, channelRules: string): string {
  const mcpName = spec.mcpName || "claudestra";
  if (!/^[A-Za-z0-9_-]+$/.test(mcpName)) throw new Error(`非法 MCP 名: ${mcpName}`);
  if (!spec.sessionId) throw new Error("Codex 启动需要 sessionId（new 先跑 exec 引导）");

  // fork 的新 id 要等 TUI 起来才知道：不报 sid，由 channel-server 按线程锁自己发现
  const envSid = spec.mode === "fork" ? "" : spec.sessionId;
  const prefix = [
    `DISCORD_CHANNEL_ID=${shellEscape(spec.channelId)}`,
    `BRIDGE_URL=${shellEscape(spec.bridgeUrl)}`,
    `BRIDGE_PORT=${shellEscape(spec.bridgePort)}`,
    `CLAUDESTRA_AGENT=${shellEscape(spec.agentName)}`,
    `CLAUDESTRA_RUNTIME=codex`,
    `CLAUDESTRA_SESSION_ID=${shellEscape(envSid)}`,
    `CLAUDESTRA_CODEX_BIN=${shellEscape(spec.codexBin)}`,
    // new 的职责已经由 exec 引导写进线程；resume / fork 的 developer_instructions 不生效，
    // 靠 channel-server 在第一条投递前附前言送达
    ...(spec.mode === "new"
      ? []
      : [
          `CLAUDESTRA_CODEX_PREAMBLE=${encodePreambleEnv(
            codexContextPreamble({ agentName: spec.agentName, purpose: spec.purpose, projectContext: spec.projectContext }),
          )}`,
        ]),
    `MCP_NAME=${shellEscape(mcpName)}`,
  ].join(" ");

  const hookCmd = `${shellEscape(spec.bunBin)} ${shellEscape(`${spec.claudestraHome}/src/hooks/typing-hook.ts`)}`;
  const hook = (event: string) =>
    `hooks.${event}=[{hooks=[{type="command",command=${tomlString(hookCmd)},timeout=10}]}]`;

  const parts: string[] = [
    shellEscape(spec.codexBin),
    spec.mode === "fork" ? "fork" : "resume",
    shellEscape(spec.sessionId),
    ...codexPermissionFlags(spec.permissionMode),
    "--dangerously-bypass-hook-trust",
    ...cfg("check_for_update_on_startup=false"),
    ...cfg(`projects={${tomlString(spec.cwd)}={trust_level="trusted"}}`),
    ...cfg(`mcp_servers.${mcpName}.command=${tomlString(spec.bunBin)}`),
    ...cfg(`mcp_servers.${mcpName}.args=${tomlStringArray([`${spec.claudestraHome}/src/channel-server.ts`])}`),
    ...cfg(`mcp_servers.${mcpName}.env_vars=${tomlStringArray(CODEX_MCP_ENV_VARS)}`),
    ...cfg(hook("Stop")),
    ...cfg(hook("Interrupt")),
    ...cfg(
      `developer_instructions=${tomlString(
        codexDeveloperInstructions({
          agentName: spec.agentName,
          purpose: spec.purpose,
          projectContext: spec.projectContext,
          channelRules,
        }),
      )}`,
    ),
    ...modelFlags(spec),
  ];
  return `${prefix} ${parts.join(" ")}`;
}

// ── exec 引导 ──────────────────────────────────────────────────────────────

/** 引导轮的 user 消息带这个标记，codex-session 的历史翻译据此把它滤掉 */
export const BOOTSTRAP_MARKER = "[claudestra:bootstrap]";
export const BOOTSTRAP_PROMPT = `${BOOTSTRAP_MARKER} 只回复 OK，不要调用任何工具。`;

/**
 * `codex exec --json` 的 argv（调用方直接 spawn，stdin 给 /dev/null——否则 exec 会等
 * stdin 的「additional input」）。**不挂 claudestra MCP 与 hooks**：挂了的话引导进程会
 * 抢注频道，还会多报一次 Stop。
 */
export function bootstrapArgs(spec: {
  codexBin: string;
  cwd: string;
  agentName?: string;
  purpose?: string;
  projectContext?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  channelRules: string;
}): string[] {
  const args = [
    spec.codexBin,
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-C",
    spec.cwd,
    ...codexPermissionFlags(spec.permissionMode),
    "-c",
    "check_for_update_on_startup=false",
    "-c",
    `developer_instructions=${tomlString(codexDeveloperInstructions(spec))}`,
  ];
  const m = codexModel(spec.model);
  if (m) args.push("-m", m);
  const e = codexEffort(spec.effort);
  if (e) args.push("-c", `model_reasoning_effort=${tomlString(e)}`);
  args.push(BOOTSTRAP_PROMPT);
  return args;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** exec --json 的 stdout（首个非空行应是 thread.started）→ thread id；取不出返回 null */
export function parseBootstrapThreadId(stdout: string): string | null {
  const first = stdout.split("\n").find((l) => l.trim());
  if (!first) return null;
  try {
    const o = JSON.parse(first);
    if (o?.type !== "thread.started") return null;
    const id = String(o.thread_id ?? "");
    return UUID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

// ── 二进制 ──────────────────────────────────────────────────────────────

const NATIVE_TRIPLES: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
};

/**
 * npm 装的 codex 是 node 壳（`@openai/codex/bin/codex.js`），它 spawn 原生二进制且不转发
 * SIGKILL——直接起壳会让原生进程成为 pane 的孙进程，按 pane 找进程 / 杀进程都会落到壳上。
 * 能定位到原生二进制就用它（与壳里 findCodexExecutable 同一布局）；不是 npm 壳（brew cask、
 * 自编译）原样返回。
 */
export function nativeCodexCandidates(real: string, platform: string = process.platform, arch: string = process.arch): string[] {
  const m = /^(.*\/@openai\/codex)\/bin\/codex\.js$/.exec(real);
  if (!m) return [];
  const triple = NATIVE_TRIPLES[`${platform}-${arch}`];
  if (!triple) return [];
  const pkg = m[1];
  return [
    `${pkg}/node_modules/@openai/codex-${platform}-${arch}/vendor/${triple}/bin/codex`,
    `${pkg}/vendor/${triple}/bin/codex`,
  ];
}

/**
 * 交互式 agent 用的 codex：`CODEX_TUI_BIN` 覆盖，否则按登录 shell 解析，npm 壳换成原生
 * 二进制（找不到原生的才退回壳）。与 ask_codex 用的 ChatGPT.app 内置版本（CODEX_BIN）刻意分开。
 * 返回值的 `real` 是该拿去启动的路径。
 */
export async function resolveCodexBinary(
  run: Runner,
  env: Record<string, string | undefined> = process.env,
  exists: (p: string) => boolean = existsSync,
): Promise<LoginBinary | null> {
  const override = env.CODEX_TUI_BIN?.trim();
  if (override) return { link: override, real: override };
  const found = await resolveLoginBinary(run, "codex");
  if (!found) return null;
  const native = nativeCodexCandidates(found.real).find(exists);
  return native ? { link: found.link, real: native } : found;
}

/**
 * 能不能当 Codex agent 的底座：入站全靠 `codex queue`，没有这个子命令（旧版）就别建 agent，
 * 免得建出一个收不到消息的频道。
 */
export async function probeCodexQueue(run: Runner, codexBin: string): Promise<boolean> {
  return (await run([codexBin, "queue", "--help"], 20_000)).ok;
}
