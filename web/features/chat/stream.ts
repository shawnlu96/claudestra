import type { WebStreamEvent, WebComponentRow } from "@/lib/chat/events";
import type { PendingPermission, PendingAsk } from "./type";

/**
 * 消费流式事件的最小接口。ChatStore 实现它。
 * 事件是「段级」的（对应 v1 jsonl-watcher 摘要流），比 claude-os 的 token 级简单。
 */
export interface StreamSink {
  addToolCall(
    name: string,
    summary: string,
    state: "running" | "done" | "error",
    detail?: string,
    id?: string
  ): void;
  /** 工具状态更新（目前只有失败标红）——按 tool_use id 找回那张卡。 */
  updateToolState(id: string, state: "done" | "error"): void;
  appendAssistantText(text: string): void;
  /** 另一端用户的发言(user-in)——对账去重后画成用户气泡(附件已由 BFF 解析)。
   *  from:非本人的来源标签(peer/其它用户),UI 据此区分气泡样式。 */
  addRemoteUserMessage(text: string, attachments?: { name: string; kind: "image" | "file"; url?: string }[], from?: string): void;
  /** reply() 的最终回复：挂到当前 assistant 气泡的 replyText（回合外到达也定稿）。
   *  components：reply 附带的按钮/选单，挂到同一气泡供渲染。
   *  attachments：agent 出站附件（图片/文件），挂到气泡尾部渲染。 */
  setReplyText(
    text: string,
    components?: WebComponentRow[],
    attachments?: { name: string; kind: "image" | "file"; url: string }[]
  ): void;
  setStatus(status: "running" | "done" | "compacting"): void;
  /** v2.20.2+「✍️ 正在回复…」——watcher 见到 reply 工具调用。 */
  setReplying(): void;
  endTurn(interrupted?: boolean, bgPending?: boolean): void;
  /** 回合耗时——补到最后一条 assistant 气泡的完成标记上。 */
  turnDuration(ms: number): void;
  /** 回合出错——最后一条 assistant 气泡标红色「✕ 出错」。 */
  turnError(): void;
  /** Phase 2：待处理交互卡（null=清卡）。 */
  setPermission(p: PendingPermission | null): void;
  setAsk(a: PendingAsk | null): void;
  /** 后台任务（subagent / bg shell）跟踪。 */
  bgTaskStart(id: string, kind: "subagent" | "shell", title: string): void;
  bgTaskUpdate(id: string, items: string[]): void;
  bgTaskDone(id: string, durationMs?: number): void;
  /** 活跃任务全集快照：不在 ids 里的 running 卡标完成（bridge 重启丢事件兜底）。 */
  bgTaskSync(ids: string[]): void;
  /** compact 完成：插系统分隔线 + 该 agent contextTokens 即时更新为 post。 */
  compactDone(pre: number, post: number): void;
  /** v2.21.2+ 压缩进度百分比。 */
  compactProgress(pct: number): void;
  /** v2.15+ 思考遥测（3s 一条）：思考指示器显示耗时 + token 跳动。 */
  setTelemetry(t: { elapsed?: string; tokens?: number; effort?: string } | null): void;
}

/** 处理一条已解析的 Web 流事件。初次发送与断线重连共用。 */
export function processStreamEvent(sink: StreamSink, evt: WebStreamEvent) {
  switch (evt.t) {
    case "tool":
      sink.addToolCall(evt.name, evt.summary, evt.state, evt.detail, evt.id);
      break;
    case "tool-state":
      sink.updateToolState(evt.id, evt.state);
      break;
    case "text":
      sink.appendAssistantText(evt.text);
      break;
    case "user-in":
      sink.addRemoteUserMessage(evt.text, evt.attachments, evt.from);
      break;
    case "reply":
      sink.setReplyText(evt.text, evt.components, evt.attachments);
      break;
    case "status":
      sink.setStatus(evt.status);
      break;
    case "done":
      sink.endTurn(evt.interrupted, evt.bgPending);
      break;
    case "replying":
      sink.setReplying();
      break;
    case "turn":
      sink.turnDuration(evt.ms);
      break;
    case "error":
      sink.appendAssistantText(`\n[Error: ${evt.error}]`);
      sink.turnError();
      break;
    case "permission":
      sink.setPermission({
        id: evt.id,
        kind: evt.kind,
        title: evt.title,
        desc: evt.desc,
        actions: evt.actions,
      });
      break;
    case "permission-cleared":
      sink.setPermission(null);
      break;
    case "ask":
      sink.setAsk({ id: evt.id, questions: evt.questions });
      break;
    case "ask-cleared":
      sink.setAsk(null);
      break;
    case "bg-start":
      sink.bgTaskStart(evt.id, evt.kind, evt.title);
      break;
    case "bg-update":
      sink.bgTaskUpdate(evt.id, evt.items);
      break;
    case "bg-done":
      sink.bgTaskDone(evt.id, evt.durationMs);
      break;
    case "bg-sync":
      sink.bgTaskSync(evt.ids);
      break;
    case "compact":
      sink.compactDone(evt.pre, evt.post);
      break;
    case "compact-progress":
      sink.compactProgress(evt.pct);
      break;
    case "telemetry":
      sink.setTelemetry({ elapsed: evt.elapsed, tokens: evt.tokens, effort: evt.effort });
      break;
  }
}

/**
 * 读取 SSE 响应流并逐事件回调。流结束（连接关闭）即 resolve。
 * `data: [DONE]` 是心跳/占位，跳过。
 */
export async function consumeSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (evt: WebStreamEvent) => void
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const data = line.slice(6);
      if (data === "[DONE]") continue;
      try {
        onEvent(JSON.parse(data) as WebStreamEvent);
      } catch {
        /* 跳过坏帧 */
      }
    }
  }
}
