/**
 * Pi 直连 rpc（spike：docs/design/pi-acp-eval.md）：窗口里一行输入 → `pi --mode rpc` 的一条命令，以及 stdout 事件 → 一行可读日志。
 * 纯函数，宿主入口在 src/pi-rpc-host.ts；tests/pi-rpc.test.ts。
 * 为什么按行映射：bridge 现在对 Pi 窗口做的事都是 tmux 发一行（/clear、/claudestra-model、/quit、斜杠直通），
 * 宿主把这几行翻成 rpc 命令，bridge 一行不用改；之后把这些改走扩展的 ws（见设计文档）就不再需要窗口输入。
 */

export type HostAction =
  | { kind: "rpc"; cmd: Record<string, unknown> }
  | { kind: "quit" }
  | { kind: "none" };

/** Pi 的 TUI 内置命令在 rpc 里不是命令（/new 会被当成普通文字发给模型，实测），这几条要翻成 rpc 命令 */
export function actionForLine(raw: string, busy: boolean): HostAction {
  const line = raw.replace(/\r$/, "").trim();
  if (!line) return { kind: "none" };
  if (line === "/quit" || line === "/exit") return { kind: "quit" };
  if (line === "/clear" || line === "/new") return { kind: "rpc", cmd: { type: "new_session" } };
  if (line === "/compact" || line.startsWith("/compact ")) {
    const custom = line.slice("/compact".length).trim();
    return { kind: "rpc", cmd: { type: "compact", ...(custom ? { customInstructions: custom } : {}) } };
  }
  // 扩展命令（/claudestra-model 等）在回合中也立即执行，普通文字回合中要带 streamingBehavior，否则 rpc 直接报错
  return { kind: "rpc", cmd: { type: "prompt", message: line, ...(busy ? { streamingBehavior: "steer" } : {}) } };
}

type Rec = Record<string, any>;
const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, " ");
const textOf = (content: unknown) =>
  Array.isArray(content) ? content.filter((c: Rec) => c?.type === "text").map((c: Rec) => String(c.text ?? "")).join("") : String(content ?? "");

/** 一条 stdout 记录 → 窗口里的一行（null = 不显示）。流式增量不逐字打，整条消息结束时一次打出 */
export function renderEvent(e: Rec): string | null {
  switch (e?.type) {
    case "agent_start": return "… 工作中";
    case "message_end": {
      const m = e.message ?? {};
      if (m.role === "user") return `› ${clip(textOf(m.content))}`;
      if (m.role === "assistant") { const t = textOf(m.content); return t.trim() ? `● ${clip(t, 400)}` : null; }
      return null;
    }
    case "tool_execution_start": return `⏺ ${e.toolName}(${clip(JSON.stringify(e.args ?? {}), 120)})`;
    case "tool_execution_end": return e.isError ? `  ✗ ${e.toolName}: ${clip(textOf(e.result?.content))}` : null;
    case "compaction_start": return "… 压缩上下文";
    case "response": return e.success ? null : `⚠ ${e.command}: ${e.error}`;
    case "extension_ui_request": return e.method === "notify" ? `ℹ ${e.message}` : null;
    default: return null;
  }
}

/** 扩展弹的对话框（select / confirm / input / editor）无人可答：立刻回取消，否则扩展那一侧一直阻塞 */
export function autoAnswer(e: Rec): Rec | null {
  if (e?.type !== "extension_ui_request" || !["select", "confirm", "input", "editor"].includes(e.method)) return null;
  return { type: "extension_ui_response", id: e.id, cancelled: true };
}

/** 严格按 LF 切 JSONL（rpc 文档：不能用把 U+2028 也当换行的 readline） */
export function splitJsonl(buf: string): { lines: string[]; rest: string } {
  const parts = buf.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.map((l) => l.replace(/\r$/, "")).filter((l) => l.trim()), rest };
}
