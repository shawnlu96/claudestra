/**
 * Codex 会话记录的定位与翻译（v2.24+）。纯逻辑，单测在 tests/codex-session.test.ts。
 *
 * owner 2026-09-22 拍板：对外说「your coding agents」就不能只有 Claude Code 和 Pi。
 *
 * ## 边界：能读，不能跑
 *
 * Codex 与 Pi **不是一个级别**，这一点在类型上也保持着：`AgentRuntime` 仍然只有
 * `claude-code | pi`（那是「我们能启动并对话的运行时」），Codex 只作为**只读的会话
 * 来源**接进 session-source。原因很实在——我们对 Codex 只有 `codex exec` 一条通路
 * （agent 的 ask_codex 工具），没有任何往它会话里注入消息的手段，所以建不了
 * Codex agent。硬把它塞进 AgentRuntime 就等于在类型里承诺一件做不到的事。
 *
 * ## 文件布局
 *
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<sessionId>.jsonl`
 * ——按日期分层，文件名带时间戳前缀，所以**跟 Pi 一样只能扫目录**，不能按 id 直接拼路径。
 *
 * ## 行格式
 *
 * 每行 `{timestamp, ordinal, type, payload}`。本机 26 个会话全量统计下来只有这些：
 *   顶层 type：session_meta / event_msg / response_item / world_state / turn_context /
 *             token_usage_record
 *   response_item.payload.type：message / reasoning / custom_tool_call / custom_tool_call_output
 *   message.role：developer / user / assistant
 *
 * 翻译成 Claude Code 形状的取舍：
 *   - `developer` 角色的 message **丢掉**：那是系统提示 / skills 说明块，不是对话，
 *     而且每条都是几 KB，混进历史面板就是刷屏；
 *   - `reasoning` **丢掉**：`encrypted_content` 读不了、`summary` 实测恒空，
 *     留下来只会变成一堆空气泡；
 *   - `event_msg` 只取 `item_completed` 里的结构化工具记录（见 codexLineToClaudeShape），
 *     其余与 `world_state` / `turn_context` 一样**丢掉**：遥测与内部状态；
 *   - `token_usage_record` 暂不翻译（用量归并是另一条链路，没接就别假装有）。
 */

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type AnyRecord = Record<string, any>;

export function codexSessionsRoot(home: string = homedir()): string {
  return join(home, ".codex", "sessions");
}

/** `rollout-2026-09-04T20-48-22-01a06c3f-….jsonl` → `01a06c3f-…`（取不出返回 null） */
export function codexSessionIdFromFilename(name: string): string | null {
  const m = /^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-([0-9a-fA-F-]{36})\.jsonl$/.exec(name);
  return m ? m[1] : null;
}

export function isCodexSessionPath(path: string | undefined | null, home: string = homedir()): boolean {
  return !!path && path.startsWith(codexSessionsRoot(home) + "/");
}

/**
 * 返回所有会话文件（新的在前）。
 *
 * ⚠ 按 **dirent 是不是目录** 递归，不要数层数：布局是 `YYYY/MM/DD/文件` ——四层，
 * 第一版写成「深度 ≥3 就当文件」，于是 `DD` 这一层目录被当成文件名去匹配、一个
 * 会话都扫不出来（实测 0 条）。层数是会变的约定，dirent 不会。
 */
export function listCodexSessionFiles(root: string = codexSessionsRoot()): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return; // 防环/防意外深目录
    let ents: ReturnType<typeof readdirSync>;
    try { ents = readdirSync(dir, { withFileTypes: true }) as never; } catch { return; }
    for (const ent of ents as unknown as Array<{ name: string; isDirectory(): boolean }>) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) { walk(p, depth + 1); continue; }
      if (codexSessionIdFromFilename(ent.name)) out.push(p);
    }
  };
  walk(root, 1);
  return out.sort((a, b) => {
    const ma = (() => { try { return statSync(a).mtimeMs; } catch { return 0; } })();
    const mb = (() => { try { return statSync(b).mtimeMs; } catch { return 0; } })();
    return mb - ma;
  });
}

export function findCodexSessionPath(sessionId: string, root: string = codexSessionsRoot()): string | null {
  if (!sessionId) return null;
  for (const p of listCodexSessionFiles(root)) {
    const id = codexSessionIdFromFilename(p.split("/").pop() || "");
    if (id === sessionId || (sessionId.length >= 8 && id?.startsWith(sessionId))) return p;
  }
  return null;
}

/**
 * 读完整的第一行（`session_meta`）并取出 sessionId / cwd。
 *
 * ⚠ 不能「截前 N 字节再 JSON.parse」：这一行里塞着 `base_instructions`，实测**单行
 * 超过 8KB**（首个样本 8188 字节还没结束），截断后必然是 `Unterminated string`，
 * cwd 取不到 ⇒ 整个会话被悄悄跳过（第一版就是这么扫出 0 条的）。
 * 这里按需倍增到找到换行为止，封顶 4MB 防着坏文件。
 */
export async function readCodexMeta(path: string): Promise<{ sessionId: string; cwd: string } | null> {
  const MAX = 4 * 1024 * 1024;
  for (let want = 64 * 1024; ; want = Math.min(want * 4, MAX)) {
    let chunk: string;
    try { chunk = await Bun.file(path).slice(0, want).text(); } catch { return null; }
    const nl = chunk.indexOf("\n");
    if (nl < 0) {
      if (want >= MAX || chunk.length < want) return null; // 到顶了 / 文件本身就这么短且没换行
      continue;
    }
    try {
      const obj = JSON.parse(chunk.slice(0, nl));
      if (obj?.type !== "session_meta") return null;
      const cwd = typeof obj?.payload?.cwd === "string" ? obj.payload.cwd : "";
      const sessionId = String(obj?.payload?.session_id ?? obj?.payload?.id ?? "");
      return cwd && sessionId ? { sessionId, cwd } : null;
    } catch {
      return null;
    }
  }
}

/** content 数组（`[{type:"input_text"|"output_text", text}]`）→ 纯文本 */
export function codexTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && typeof (c as AnyRecord).text === "string" ? (c as AnyRecord).text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * 翻译状态（按轮）。流式消费者（watcher / 历史分页）逐行调用，同一文件共用一份即可；
 * 不传就走无状态近似（见 codexLineToClaudeShape）。
 */
export interface CodexTranslateState {
  /** 本轮已见过 item_completed 事件 = 这一版 rollout 有结构化工具记录 */
  turnHasItems: boolean;
  /** 被丢掉的 code-mode exec 的 call_id，其输出一并丢 */
  droppedCalls: Set<string>;
  /** 本轮是 Claudestra 的 exec 引导轮（整轮不进历史） */
  bootstrapTurn: boolean;
}

export function newCodexTranslateState(): CodexTranslateState {
  return { turnHasItems: false, droppedCalls: new Set(), bootstrapTurn: false };
}

/** Claudestra exec 引导轮的标记（与 codex-launch.BOOTSTRAP_MARKER 同值；这里不 import，免得只读路径拖进启动器依赖） */
const BOOTSTRAP_MARKER = "[claudestra:bootstrap]";

/** Codex 自己注入的上下文块，以 user 角色落盘但不是用户说的话 */
const INJECTED_USER_RE = /^\s*(# AGENTS\.md instructions|<INSTRUCTIONS>|<environment_context>|<user_instructions>|<recommended_plugins>)/;

const HOOK_PROMPT_RE = /^\s*<hook_prompt\b[^>]*>([\s\S]*?)<\/hook_prompt>\s*$/;

/** code-mode exec 的输出签名（无状态时靠它认出要跟着 exec 一起丢的输出） */
const CODE_MODE_OUTPUT_RE = /^Script [\w ]+\nWall time /;

/** ["/bin/zsh","-lc","sleep 20"] → "sleep 20"；其它形状按空格拼 */
export function codexCommandText(command: unknown): string {
  if (typeof command === "string") return command;
  if (!Array.isArray(command)) return "";
  const parts = command.map(String);
  if (parts.length >= 3 && /(^|\/)(ba|z)?sh$/.test(parts[0]) && /^-l?c$/.test(parts[1])) return parts.slice(2).join(" ");
  return parts.join(" ");
}

/** item_completed 里的结构化工具记录 → tool_use；不是工具（或与 response_item 重复）返回 null */
function codexItemToolUse(item: AnyRecord): { id: string; name: string; input: AnyRecord } | null {
  const id = String(item.id ?? "");
  switch (item.type) {
    case "McpToolCall": {
      const server = String(item.server ?? "mcp");
      const tool = String(item.tool ?? "tool");
      // 与 Claude Code 的 mcp__<server>__<tool> 同名：reply 的识别（session-history.isReplyTool、
      // jsonl-watcher）直接复用
      const input = item.arguments && typeof item.arguments === "object" ? item.arguments : {};
      return { id, name: `mcp__${server}__${tool}`, input };
    }
    case "CommandExecution":
      return { id, name: "Bash", input: { command: codexCommandText(item.command) } };
    case "ImageView": {
      const path = typeof item.path === "string" ? item.path.replace(/^file:\/\//, "") : "";
      return { id, name: "Read", input: { file_path: path } };
    }
    case "Extension": {
      // web.search 带 query（多条查询时是截断后的拼接）→ WebSearch 卡片显示查询词
      if (item.kind === "web.search") {
        const action = item.action && typeof item.action === "object" ? (item.action as AnyRecord) : {};
        const query = [item.query, action.query, Array.isArray(action.queries) ? action.queries[0] : undefined]
          .find((q) => typeof q === "string" && q.trim());
        return { id, name: "WebSearch", input: { query: (query as string | undefined) ?? "" } };
      }
      return { id, name: String(item.kind ?? "extension"), input: {} };
    }
    default:
      // UserMessage / AgentMessage 与 response_item 重复；Reasoning 恒空；HookPrompt 由 response_item 的
      // <hook_prompt> 承担
      return null;
  }
}

/**
 * 一行 Codex 记录 → Claude Code 形状（不是对话内容就返回 null）。
 *
 * 新版 Codex（0.149+ 的 code mode）把工具调用包在 `custom_tool_call name:"exec"` 里
 * （input 是一段 JS），真正的结构化信息在 `event_msg item_completed` 的
 * McpToolCall / CommandExecution。以后者为准，前者及其输出丢掉——否则 reply 被渲染成
 * 一段脚本，历史里一个 mcp__claudestra__reply 都认不出。
 *
 * 带 state：exec 只在「本轮已有 item 事件」时丢（每轮开头的 UserMessage item 先于任何
 * exec），输出按 call_id 精确丢。不带 state：本机全部 code-mode rollout 都带 item 事件，
 * 所以 exec 一律丢，输出按 code-mode 签名丢。
 */
export function codexLineToClaudeShape(line: string, state?: CodexTranslateState): AnyRecord | null {
  let e: AnyRecord;
  try { e = JSON.parse(line); } catch { return null; }
  if (!e || typeof e !== "object") return null;
  const ts = typeof e.timestamp === "string" ? e.timestamp : undefined;
  const p: AnyRecord = (e.payload && typeof e.payload === "object" ? e.payload : {}) as AnyRecord;

  if (e.type === "session_meta") {
    return { type: "system", subtype: "codex_session_start", timestamp: ts, sessionId: p.session_id ?? p.id, cwd: p.cwd };
  }
  if (e.type === "event_msg") {
    if (p.type === "task_started") {
      if (state) { state.turnHasItems = false; state.bootstrapTurn = false; state.droppedCalls.clear(); }
      return null;
    }
    if (p.type !== "item_completed" || !p.item || typeof p.item !== "object") return null;
    if (state) state.turnHasItems = true;
    if (state?.bootstrapTurn) return null;
    const tu = codexItemToolUse(p.item as AnyRecord);
    if (!tu) return null;
    return { type: "assistant", timestamp: ts, message: { content: [{ type: "tool_use", ...tu }] } };
  }
  if (e.type !== "response_item") return null;

  switch (p.type) {
    case "message": {
      const text = codexTextOf(p.content);
      if (!text) return null;
      // developer = 系统提示 / skills 块，不是对话（每条几 KB）
      if (p.role === "developer" || p.role === "system") return null;
      if (p.role === "user") {
        if (INJECTED_USER_RE.test(text)) return null;
        if (text.trimStart().startsWith(BOOTSTRAP_MARKER)) {
          if (state) state.bootstrapTurn = true;
          return null;
        }
        // Stop hook 的 block reason 以 <hook_prompt> 回灌成 user 消息：是系统提示，不是用户发言
        const hook = HOOK_PROMPT_RE.exec(text);
        if (hook) return { type: "system", subtype: "hook_prompt", level: "info", timestamp: ts, content: hook[1] };
        // channel-server 的 Codex 模式按 CC 同款 <channel> 包装投递 → 标 isMeta，历史面板照 CC 的路子解包
        if (/^\s*<channel\s/.test(text)) return { type: "user", isMeta: true, timestamp: ts, message: { content: text } };
        return { type: "user", timestamp: ts, message: { content: text } };
      }
      if (state?.bootstrapTurn) return null;
      return { type: "assistant", timestamp: ts, message: { content: [{ type: "text", text }] } };
    }
    case "custom_tool_call":
    case "function_call": {
      const name = typeof p.name === "string" ? p.name : "tool";
      if (p.type === "custom_tool_call" && name === "exec" && (!state || state.turnHasItems)) {
        if (state && p.call_id) state.droppedCalls.add(String(p.call_id));
        return null;
      }
      // Codex 的 input 是字符串（exec 是一段脚本）；下游卡片期待对象，包一层
      const input = typeof p.input === "string" ? { command: p.input } : (p.input ?? p.arguments ?? {});
      return {
        type: "assistant",
        timestamp: ts,
        message: { content: [{ type: "tool_use", id: p.call_id ?? p.id, name, input }] },
      };
    }
    case "custom_tool_call_output":
    case "function_call_output": {
      const text = codexTextOf(p.output);
      if (p.type === "custom_tool_call_output") {
        if (state ? state.droppedCalls.has(String(p.call_id)) : CODE_MODE_OUTPUT_RE.test(text)) return null;
      }
      return {
        type: "user",
        timestamp: ts,
        message: { content: [{ type: "tool_result", tool_use_id: p.call_id ?? p.id, content: text }] },
      };
    }
    default:
      return null; // reasoning（加密且 summary 恒空）与其它内部记录
  }
}
