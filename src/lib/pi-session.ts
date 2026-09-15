/**
 * Pi 会话文件的定位与解析（v2.23+）。
 *
 * 目录/文件名规则（pi 0.85.1 实测，dist/core/session-manager.js）：
 *   dir  = <agentDir>/sessions/--<cwd 去掉开头斜杠、/ \ : 全换 -> 下划线保留>--
 *   file = <ISO 时间戳，[:.] 换 -> >_<sessionId>.jsonl
 * 例：/Users/he/repos/piagent → --Users-he-repos-piagent--
 *     → 2026-09-14T07-14-15-025Z_75b423f1-….jsonl
 *
 * ⚠ cwd 取的是 **realpath**：Pi 建会话时用的是解析过软链的路径，所以 `/tmp/x` 落在
 * `--private-tmp-x--`（macOS 上 /tmp 是 /private/tmp 的软链）。不解析软链就永远找不到
 * 文件——而且症状是「静默没有会话记录」，不是报错。
 *
 * 行格式（v3，第一行是 header）：
 *   {type:"session", version:3, id, cwd}
 *   {type:"message", id, parentId, timestamp, message:{role, content:[…], …}}
 *     role=user        content:[{type:"text",text}]（或裸字符串）
 *     role=assistant   content:[text | thinking | toolCall{id,name,arguments}]
 *                      + model/provider/usage{input,output,cacheRead,cacheWrite,…}
 *     role=toolResult  toolCallId + toolName + content + isError（**单独一行**，
 *                      不像 Claude Code 塞在同一个 message 里）
 *     role=custom / bashExecution
 *   {type:"model_change" | "thinking_level_change" | "compaction" | "session_info" | "label" | "custom"}
 *
 * 下游（jsonl-watcher / session-history / jsonl-cost / session-tail / reply 兜底抽取）
 * 全都是照 Claude Code 的行形状写的，所以这里不重写五个消费者，而是把 Pi 的行
 * **翻译成 Claude Code 的形状**（`piLineToClaudeShape`）。翻译是纯函数、有单测；
 * 哪天消费者改成中立的中间层，删掉翻译层即可。
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** Pi 的 agent 目录（`~/.pi/agent`），可用环境变量覆盖（与 Pi 自身一致） */
export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** 解析软链；路径不存在时原样返回（不抛） */
export function resolveCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

/** 会话目录名编码：`--<去掉开头斜杠、分隔符换 ->--`（纯函数，便于单测） */
export function encodePiSessionDir(cwd: string): string {
  const stripped = resolveCwd(cwd).replace(/^[/\\]/, "");
  return `--${stripped.replace(/[/\\:]/g, "-")}--`;
}

/** 某个工作目录对应的 Pi 会话目录 */
export function piSessionsDir(cwd: string, agentDir = piAgentDir()): string {
  return join(agentDir, "sessions", encodePiSessionDir(cwd));
}

/**
 * 从 Pi 会话文件名取 sessionId（`<ISO时间戳>_<sessionId>.jsonl`）。
 * 时间戳里没有下划线，所以按**第一个**下划线切 —— 自造 id 里带下划线也能取全。
 */
export function piSessionIdFromFilename(file: string): string | null {
  const m = /^[^_]+_(.+)\.jsonl$/.exec(file);
  return m ? m[1] : null;
}

/** 列出该目录下的会话 jsonl（完整路径，按文件名排序） */
export function listPiSessionJsonls(cwd: string, agentDir = piAgentDir()): string[] {
  const dir = piSessionsDir(cwd, agentDir);
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl"))
      .sort()
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

/** 按 sessionId 在该工作目录下定位会话文件（文件名形如 `<ts>_<id>.jsonl`） */
export function piSessionPath(cwd: string, sessionId: string, agentDir = piAgentDir()): string | null {
  if (!sessionId) return null;
  const dir = piSessionsDir(cwd, agentDir);
  try {
    const hit = readdirSync(dir).find((n) => n.endsWith(`_${sessionId}.jsonl`));
    return hit ? join(dir, hit) : null;
  } catch {
    return null;
  }
}

/** 全库兜底查找（cwd 不对/记错时用；跨所有项目目录按 sessionId 找） */
export function findPiSessionBySessionId(sessionId: string, agentDir = piAgentDir()): string | null {
  if (!sessionId) return null;
  const root = join(agentDir, "sessions");
  let dirs: string[];
  try {
    dirs = readdirSync(root).filter((n) => n.startsWith("--"));
  } catch {
    return null;
  }
  for (const d of dirs) {
    try {
      const hit = readdirSync(join(root, d)).find((n) => n.endsWith(`_${sessionId}.jsonl`));
      if (hit) return join(root, d, hit);
    } catch { /* 单目录读不了就跳过 */ }
  }
  return null;
}

/** Pi 的 subagent 产物目录：`<sessions>/<dir>/<会话文件名>/<uuid>/`（与 CC 的 <sessionId>/subagents/ 不同构） */
export function piSubagentDir(cwd: string, sessionId: string, agentDir = piAgentDir()): string | null {
  const file = piSessionPath(cwd, sessionId, agentDir);
  if (!file) return null;
  const dir = file.replace(/\.jsonl$/, "");
  return existsSync(dir) ? dir : null;
}

// ────────────────────────────────────────────────────────────
// 格式翻译：Pi 的行 → Claude Code 的行形状
// ────────────────────────────────────────────────────────────

type AnyRecord = Record<string, any>;

/** Pi 的 usage → Claude Code 的 usage 字段名（下游的用量统计认后者） */
export function piUsageToClaude(usage: AnyRecord | undefined): AnyRecord | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    input_tokens: num(usage.input),
    output_tokens: num(usage.output),
    cache_read_input_tokens: num(usage.cacheRead),
    cache_creation_input_tokens: num(usage.cacheWrite),
  };
}


/**
 * Pi 的工具名/参数 → Claude Code 的工具名/参数。
 *
 * 为什么要映射：下游的摘要渲染（jsonl-watcher.formatTool）与详情渲染是按 Claude Code
 * 的工具名写的（Read/Bash/Edit/Glob/Grep + file_path/old_string…）。Pi 的内置工具是
 * 小写、参数用 `path`，不映射的话 Discord/网页上只剩「🔧 bash」这种没有信息量的卡片，
 * 而用户要看的就是「它在动哪个文件」。
 *
 * 非内置工具（Claudestra 的 reply/send_to_agent、MCP 工具、扩展工具）原样透传。
 */
export function mapPiToolCall(name: string, args: unknown): { name: string; input: AnyRecord } {
  const a = (args && typeof args === "object" ? args : {}) as AnyRecord;
  const pick = (keys: string[]): AnyRecord => {
    const out: AnyRecord = {};
    for (const k of keys) if (a[k] !== undefined) out[k] = a[k];
    return out;
  };
  switch (name) {
    case "read":
      return { name: "Read", input: { file_path: a.path, ...pick(["offset", "limit"]) } };
    case "write":
      return { name: "Write", input: { file_path: a.path, content: a.content } };
    case "edit": {
      // Pi: {path, edits:[{oldText,newText}]}；CC: {file_path, old_string, new_string}
      const first = Array.isArray(a.edits) ? (a.edits[0] as AnyRecord | undefined) : undefined;
      return {
        name: "Edit",
        input: {
          file_path: a.path,
          old_string: first?.oldText ?? "",
          new_string: first?.newText ?? "",
        },
      };
    }
    case "find": // Pi 的 find ≈ CC 的 Glob（按 glob 找文件）
      return { name: "Glob", input: pick(["pattern", "path"]) };
    case "grep":
      return { name: "Grep", input: pick(["pattern", "path", "glob"]) };
    case "ls":
      return { name: "LS", input: pick(["path"]) };
    case "bash":
      return { name: "Bash", input: pick(["command", "description"]) };
    default:
      return { name, input: a };
  }
}

/**
 * bridge 注入头的识别（renderContentForLocal 写的那几种：🌐 Web/API 用户、🤖 本地 agent、
 * 🤝 跨机 peer、📢 广播）。Pi 侧的消息是**裸文本**（没有 Claude Code 的 <channel> 包装），
 * 所以历史面板会把它当成一条普通用户消息 —— 注入头留在正文里、且与网页自己渲染的那条
 * 重复。这里把它**还原成 Claude Code 的 <channel> 形状**，后面的解包 / 剥头 / 作者标签
 * 就全部复用既有逻辑（session-history.unwrapChannelMessage + stripChannelHeader）。
 */
const BRIDGE_INBOUND_RE = /^\s*\[(🌐|🤖|🤝|📢|📣)[^\]]*\]/;

export function wrapPiInboundAsChannel(text: string): string {
  if (!BRIDGE_INBOUND_RE.test(text)) return text;
  // header 块与正文之间必有空行（bridge 的拼装方式）；没有就当普通消息
  if (!/\]\r?\n\r?\n/.test(text)) return text;
  const head = text.split(/\]\r?\n\r?\n/)[0];
  const from = /[「"]([^」"]+)[」"]/.exec(head)?.[1] ?? "";
  return `<channel source="claudestra"${from ? ` user="${from}"` : ""}>\n${text}\n</channel>`;
}

/** 把 content（字符串或块数组）转成"可包 channel 的正文" */
function inboundWrapped(text: string): string {
  return wrapPiInboundAsChannel(text);
}

/** Pi 的 content 块 → Claude Code 的 content 块（toolCall→tool_use 等） */
export function piBlocksToClaude(content: unknown): any {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return [];
  const out: AnyRecord[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as AnyRecord;
    switch (block.type) {
      case "text":
        if (typeof block.text === "string" && block.text) out.push({ type: "text", text: block.text });
        break;
      case "thinking":
        if (typeof block.thinking === "string" && block.thinking) {
          out.push({ type: "thinking", thinking: block.thinking });
        }
        break;
      case "toolCall": {
        const mapped = mapPiToolCall(typeof block.name === "string" ? block.name : "", block.arguments);
        out.push({ type: "tool_use", id: typeof block.id === "string" ? block.id : undefined, ...mapped });
        break;
      }
      default:
        // image / 未知块：保留 type 让下游自己决定（下游只认 text/thinking/tool_use）
        break;
    }
  }
  return out;
}

/**
 * 把一行 Pi 会话记录翻译成 Claude Code 的形状；不是对话行（model_change 等）返回 null。
 * 纯函数：不读文件、不看时间，方便单测。
 */
export function piLineToClaudeShape(line: string): AnyRecord | null {
  let entry: AnyRecord;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!entry || typeof entry !== "object") return null;
  const ts = typeof entry.timestamp === "string" ? entry.timestamp : undefined;

  if (entry.type === "session") {
    // header 行：下游不需要，但返回一条 system 让它知道「会话从这里开始」
    return { type: "system", subtype: "pi_session_start", timestamp: ts, sessionId: entry.id, cwd: entry.cwd };
  }

  if (entry.type === "compaction") {
    // 压缩检查点：下游（历史）认 compact_boundary
    return {
      type: "system",
      subtype: "compact_boundary",
      timestamp: ts,
      compactSummary: typeof entry.summary === "string" ? entry.summary : undefined,
    };
  }

  if (entry.type === "thinking_level_change") {
    // 思考档位：session-tail 用它显示 effort（CC 那边靠 /effort 命令的 stdout 自述）
    return {
      type: "system",
      subtype: "thinking_level_change",
      timestamp: ts,
      thinkingLevel: typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : undefined,
    };
  }

  if (entry.type !== "message") return null;
  const msg = entry.message;
  if (!msg || typeof msg !== "object") return null;
  const role = msg.role;

  if (role === "assistant") {
    return {
      type: "assistant",
      timestamp: ts,
      message: {
        role: "assistant",
        model: typeof msg.model === "string" ? msg.model : undefined,
        usage: piUsageToClaude(msg.usage),
        content: piBlocksToClaude(msg.content),
      },
    };
  }

  if (role === "toolResult") {
    // 工具结果在 Pi 里是独立一行，在 CC 里是 user 消息里的 tool_result 块
    const content = Array.isArray(msg.content)
      ? msg.content.filter((c: AnyRecord) => c?.type === "text").map((c: AnyRecord) => ({ type: "text", text: String(c.text ?? "") }))
      : typeof msg.content === "string"
        ? [{ type: "text", text: msg.content }]
        : [];
    return {
      type: "user",
      timestamp: ts,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: typeof msg.toolCallId === "string" ? msg.toolCallId : undefined,
            content,
            is_error: msg.isError === true,
          },
        ],
      },
    };
  }

  if (role === "user") {
    // v2.23+ 入站消息（带 bridge 注入头）包成 <channel>，让历史面板按 Claude Code
    // 同款路径解包：正文干净、作者标签正确、且能与网页本地那条按正文去重
    const blocks = piBlocksToClaude(msg.content);
    // ⚠ 入站消息必须落成**字符串** content：session-history.unwrapChannelMessage 只对
    // 字符串做 <channel> 解包（Claude Code 的 channel 记录就是字符串）。做成块数组
    // 时标签会原样留在正文里（实测过——所以这里把块数组的文本也拼出来判一次）。
    const joined =
      typeof blocks === "string"
        ? blocks
        : Array.isArray(blocks)
          ? blocks.filter((b: AnyRecord) => b?.type === "text").map((b: AnyRecord) => String(b.text ?? "")).join("\n")
          : "";
    if (joined && BRIDGE_INBOUND_RE.test(joined)) {
      // ⚠ isMeta:true 是 Claude Code 侧 channel 记录的标记，session-history 只在
      // isMeta 为真时才走 unwrapChannelMessage（其余 isMeta 是 caveat 之类，过滤）。
      // 不带这个标记 ⇒ <channel> 标签原样留在正文里（实测过）。
      return {
        type: "user",
        timestamp: ts,
        isMeta: true,
        message: { role: "user", content: inboundWrapped(joined) },
      };
    }
    return {
      type: "user",
      timestamp: ts,
      message: { role: "user", content: blocks },
    };
  }

  // custom / bashExecution：不进对话流（custom 是扩展状态；bashExecution 是 ! 命令）
  return null;
}

/** 读一个 Pi 会话文件并翻译成 Claude Code 形状的行（读不了返回空数组，不抛） */
export function readPiSessionAsClaudeShape(path: string): AnyRecord[] {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: AnyRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const translated = piLineToClaudeShape(line);
    if (translated) out.push(translated);
  }
  return out;
}
