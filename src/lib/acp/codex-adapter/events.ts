/**
 * 一轮里的 app-server 事件 → ACP session/update（形状对着宿主翻译器 lib/acp/updates.ts）。这里是最小可用的一版：
 * 正文增量、命令与 MCP 调用的起止、命令输出增量、压缩状态；标题去 shell 前缀、读 / 搜类命令、plan、用量等字段映射在 CX-3 补。
 * 回合收尾时（不论什么 status）给还开着的工具调用补一条 failed（B60：被打断的命令只有 item/started），没收到终态的压缩
 * 按 turn/completed 的 status 补 failed / cancelled（B28：失败或被打断时没有 item/completed）。tests/codex-adapter-turns.test.ts。
 */
import type { NotificationEvent } from "./app-server.js";

type Rec = Record<string, unknown>;
type Ok<E> = E extends { ok: true } ? E : never;
type Event = Ok<NotificationEvent>;

/** 宿主在 initialize 声明的输出形状（B4）：没声明就不发对应的更新 */
export interface HostCaps {
  air: boolean;
  outputDelta: boolean;
  compaction: boolean;
}

export interface EventState {
  open: Set<string>;
  /** 收到过增量的正文 / 命令：item/completed 时不再补整段 */
  streamed: Set<string>;
  compaction: string | null;
}

export const eventState = (): EventState => ({ open: new Set(), streamed: new Set(), compaction: null });

const text = (t: string) => [{ type: "content", content: { type: "text", text: t } }];
const compaction = (id: string, status: string): Rec => ({ sessionUpdate: "compaction_update", compactionId: id, status });

function started(st: EventState, item: Extract<Event, { method: "item/started" }>["params"]["item"], caps: HostCaps): Rec[] {
  if (item.type === "commandExecution") {
    st.open.add(item.id);
    return [{ sessionUpdate: "tool_call", toolCallId: item.id, kind: "execute", title: item.command, status: "in_progress", rawInput: { command: item.command, cwd: item.cwd } }];
  }
  if (item.type === "mcpToolCall") {
    st.open.add(item.id);
    const rawInput = { server: item.server, tool: item.tool, arguments: item.arguments };
    return [{ sessionUpdate: "tool_call", toolCallId: item.id, kind: "execute", title: `mcp.${item.server}.${item.tool}`, status: "in_progress", rawInput, _meta: { is_mcp_tool_call: true } }];
  }
  if (item.type === "contextCompaction" && caps.compaction) {
    st.compaction = item.id;
    return [compaction(item.id, "in_progress")];
  }
  return [];
}

function completed(st: EventState, item: Extract<Event, { method: "item/completed" }>["params"]["item"], caps: HostCaps): Rec[] {
  if (item.type === "agentMessage") {
    return st.streamed.has(item.id) || !item.text ? [] : [{ sessionUpdate: "agent_message_chunk", messageId: item.id, content: { type: "text", text: item.text } }];
  }
  if (item.type === "commandExecution") {
    if (!st.open.delete(item.id)) return [];
    const ok = item.status === "completed" && (item.exitCode ?? 0) === 0;
    const out = !st.streamed.has(item.id) && item.aggregatedOutput ? { content: text(item.aggregatedOutput) } : {};
    return [{ sessionUpdate: "tool_call_update", toolCallId: item.id, status: ok ? "completed" : "failed", ...out }];
  }
  if (item.type === "mcpToolCall") {
    if (!st.open.delete(item.id)) return [];
    const rawOutput = { result: item.result ?? null, error: item.error ?? null };
    return [{ sessionUpdate: "tool_call_update", toolCallId: item.id, status: item.status === "completed" ? "completed" : "failed", rawOutput }];
  }
  if (item.type === "contextCompaction" && caps.compaction && st.compaction === item.id) {
    st.compaction = null;
    return [compaction(item.id, "completed")];
  }
  return [];
}

/** 一条已校验、已归到这一轮的事件 → 更新（userMessage 只做投递记录，不出更新） */
export function updatesFor(st: EventState, ev: Event, caps: HostCaps): Rec[] {
  switch (ev.method) {
    case "item/started":
      return started(st, ev.params.item, caps);
    case "item/completed":
      return completed(st, ev.params.item, caps);
    case "item/agentMessage/delta":
      st.streamed.add(ev.params.itemId);
      return ev.params.delta ? [{ sessionUpdate: "agent_message_chunk", messageId: ev.params.itemId, content: { type: "text", text: ev.params.delta } }] : [];
    case "item/commandExecution/outputDelta":
      st.streamed.add(ev.params.itemId);
      return caps.outputDelta ? [{ sessionUpdate: "tool_call_update", toolCallId: ev.params.itemId, _meta: { terminal_output_delta: { data: ev.params.delta } } }] : [];
    case "thread/compacted": {
      const id = st.compaction;
      st.compaction = null;
      return id ? [compaction(id, "completed")] : [];
    }
    default:
      return [];
  }
}

/** 回合收尾：补齐悬空的工具调用和压缩 */
export function closeTurn(st: EventState, status: "completed" | "interrupted" | "failed"): Rec[] {
  const out: Rec[] = [...st.open].map((id) => ({ sessionUpdate: "tool_call_update", toolCallId: id, status: "failed", content: text("回合已结束，这个工具调用的结果未知") }));
  st.open.clear();
  if (st.compaction) out.push(compaction(st.compaction, status === "interrupted" ? "cancelled" : "failed"));
  st.compaction = null;
  return out;
}
