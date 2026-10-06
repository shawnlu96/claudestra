/**
 * 工具调用的人话摘要（formatTool）与完整详情（formatToolDetail，4k 截断）——纯输出函数。
 * 由 bridge/jsonl-watcher.ts 抽出（hardening-JFORMAT），逐字节保持原语义；watcher 仍 re-export
 * 原导出名，直播 tool_start、历史 formatToolFn/toolDetailFn、bg-activity-watcher 共用这一份。
 * 只依赖 lib/forward 的 isForwardTool：不 import bridge、不读 env、不做 IO。
 */
import { isForwardTool } from "./forward.js";

export function formatTool(name: string, input: any): string {
  const E: Record<string, string> = {
    Read: "📖", Edit: "✏️", Write: "📝", Bash: "💻",
    Glob: "🔍", Grep: "🔎", Agent: "🤖", WebSearch: "🌐",
  };
  const e = E[name] || "🔧";
  switch (name) {
    case "Read": return `${e} Read ${input?.file_path?.split("/").pop() || ""}`;
    case "Edit": return `${e} Edit ${input?.file_path?.split("/").pop() || ""}`;
    case "Write": return `${e} Write ${input?.file_path?.split("/").pop() || ""}`;
    case "Bash":
      if (input?.description) return `${e} ${input.description} ||${(input?.command || "").replace(/\n/g, " ").slice(0, 200)}||`;
      return `${e} ${(input?.command || "").split("\n")[0].split("&&")[0].trim()}`;
    case "Glob": return `${e} Glob ${input?.pattern || ""}`;
    case "Grep": return `${e} Grep ${input?.pattern || ""}`;
    // v2.15+ 任务清单工具:通用「🔧 TaskCreate」不知所云,渲染成人话
    case "TaskCreate": return `🗒️ 新任务：${(input?.subject || "").slice(0, 80)}`;
    case "TaskUpdate": {
      const st = input?.status ? ` → ${input.status}` : "";
      return `🗒️ 任务 #${input?.taskId ?? "?"}${st}`;
    }
    default: {
      // send_to_agent 的 target 和正文没有别的渠道显示（不像 reply 本身就作为消息渲染），只剩工具名等于
      // 丢掉半边对话（peer 2026-08-09）。Pi 侧是裸名，与 mcp__x__send_to_agent 同款渲染
      if (name === "send_to_agent" || name.endsWith("__send_to_agent")) {
        const target = input?.target ? `→ ${input.target}` : "";
        const body = String(input?.text || "").replace(/\n/g, " ").trim().slice(0, 200);
        return `🤝 send_to_agent ${target}${body ? `：${body}` : ""}`.trim();
      }
      if (isForwardTool(name)) return `↪ 转交给 ${input?.target ?? "?"}${input?.reason ? `：${input.reason}` : ""}`;
      // v2.23+ Claudestra 自有工具在 Pi 侧是裸名（无 mcp__ 前缀），渲染成人话
      if (name === "reply") return `💬 回复`;
      if (name === "fetch_messages") return `📥 取消息`;
      if (name === "project_info") return `📁 project 信息`;
      // mcp__server__tool → server/tool
      const short = name.startsWith("mcp__") ? name.replace("mcp__", "").replace("__", "/") : name;
      return `${e} ${short}`;
    }
  }
}

/**
 * 工具调用完整详情——web 工具卡点开后展示（摘要只够一眼扫过，
 * 「mem0 write 到底写了啥」这类问题要看完整入参）。随 tool_start 事件
 * 和历史 tools[] 一起下发。截断上限防单条事件撑爆 SSE / 环形缓冲。
 */
const TOOL_DETAIL_MAX = 4000;

export function formatToolDetail(name: string, input: any): string {
  let out: string;
  switch (name) {
    case "Read":
      out = [
        input?.file_path || "",
        input?.offset != null ? `offset=${input.offset}` : "",
        input?.limit != null ? `limit=${input.limit}` : "",
      ].filter(Boolean).join("\n");
      break;
    case "Edit":
      out = `${input?.file_path || ""}\n─── old ───\n${input?.old_string ?? ""}\n─── new ───\n${input?.new_string ?? ""}`;
      break;
    case "Write":
      out = `${input?.file_path || ""}\n───\n${input?.content ?? ""}`;
      break;
    case "Bash":
      out = [input?.description, input?.command].filter(Boolean).join("\n───\n");
      break;
    default:
      // send_to_agent 详情:target + expecting + 正文原文(不 JSON 转义——正文是
      // 给人读的长文,几千字的 bug 报告 JSON.stringify 成一坨 \n 没法看,peer 2026-08-09)
      if (name.endsWith("__send_to_agent")) {
        out = [
          input?.target ? `→ ${input.target}` : "",
          input?.expecting ? `[期望] ${input.expecting}` : "",
          input?.text || "",
        ].filter(Boolean).join("\n───\n");
        break;
      }
      try {
        out = JSON.stringify(input ?? {}, null, 2);
      } catch {
        out = String(input);
      }
  }
  out = (out || "").trim();
  if (out.length > TOOL_DETAIL_MAX) {
    out = out.slice(0, TOOL_DETAIL_MAX) + `\n… (已截断，完整 ${out.length} 字符)`;
  }
  return out;
}
