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

/**
 * Bash 命令 → 一行看得懂的摘要（ACP 窗口会话用；网页 / Discord 仍走 formatTool，不受影响）：剥开头的 `cd … &&` 和
 * env 赋值；`;` / `&&` / `||` 串只留第一条加「＋N 条」；多行脚本 / heredoc 留第一行加「（N 行脚本）」；读文件、搜索类
 * 认得出就写成「读 path」「搜 'pat'」，认不出退回原命令。不解析完整 shell 语法，只做引号 / 括号感知的切分。
 * 调用方先脱敏再传进来。tests/acp-transcript-view.test.ts。
 */
export function summarizeCommand(raw: string): string {
  const lines = unwrapShell(raw.trim()).split("\n").filter((l) => l.trim());
  if (!lines.length) return "";
  const cmds = splitTop(lines[0]!, ["&&", "||", ";"]).map(stripEnv).filter(Boolean);
  while (cmds.length > 1 && /^(cd|pushd)(\s|$)/.test(cmds[0]!)) cmds.shift();
  const extra = cmds.length > 1 ? ` ＋${cmds.length - 1} 条` : "";
  return `${describeCommand(cmds[0] ?? lines[0]!)}${extra}${lines.length > 1 ? `（${lines.length} 行脚本）` : ""}`;
}

/** codex 有时把整条命令包在 `/bin/zsh -lc '…'` 里 */
function unwrapShell(s: string): string {
  const m = /^(?:\/\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(s);
  return m ? (m[1] === "'" ? m[2]!.replace(/'\\''/g, "'") : m[2]!) : s;
}

const stripEnv = (s: string): string => s.replace(/^(?:[A-Za-z_]\w*=(?:'[^']*'|"[^"]*"|\S*)\s+)+/, "").trim();

/** 在不在引号 / 括号里的分隔符处切开（seps 长的在前） */
function splitTop(s: string, seps: string[]): string[] {
  const parts: string[] = [];
  let quote = "", depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "\\") { i++; continue; }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    const sep = depth ? undefined : seps.find((x) => s.startsWith(x, i));
    if (!sep) continue;
    parts.push(s.slice(start, i));
    i += sep.length - 1;
    start = i + 1;
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** 按 shell 规则拆词、去引号（够摘要用：不展开变量、不认 $(…)） */
function words(s: string): string[] {
  const out: string[] = [];
  let cur = "", quote = "", has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') { quote = c; has = true; }
    else if (c === "\\" && i + 1 < s.length) { cur += s[++i]; has = true; }
    else if (/\s/.test(c)) { if (has) out.push(cur); cur = ""; has = false; }
    else { cur += c; has = true; }
  }
  if (has) out.push(cur);
  return out;
}

/** 管道后面只是翻页 / 截行的，不改变「读了什么」 */
const VIEWERS = new Set(["nl", "sed", "head", "tail", "cat", "less", "more"]);

function describeCommand(cmd: string): string {
  const stages = splitTop(cmd, ["|"]);
  const sem = semanticOf(words(stages[0] ?? ""));
  if (!sem) return stages.length > 1 ? `${stages[0]} | …` : cmd;
  const rest = stages.slice(1).every((st) => VIEWERS.has(words(st)[0]?.split("/").pop() ?? ""));
  return rest ? sem : `${sem} | …`;
}

/** 位置参数（去掉选项；valued 里的选项吃掉下一个词） */
function positional(args: string[], valued: RegExp): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") return [...out, ...args.slice(i + 1)];
    if (a.startsWith("-") && a.length > 1) { if (valued.test(a)) i++; }
    else out.push(a);
  }
  return out;
}

const SEARCH_VALUED = /^(-[ABCefgtTmMj]|--(glob|type|type-not|max-count|context|after-context|before-context|regexp|file|max-columns|sort|replace|include|exclude))$/;

function semanticOf(w: string[]): string | null {
  const bin = w[0]?.split("/").pop() ?? "";
  const args = w.slice(1);
  if (bin === "sed") {
    if (!args.includes("-n")) return null;
    const [script, ...files] = positional(args, /^-[ef]$/);
    const range = /^(\d+)(?:,(\d+))?p$/.exec(script ?? "");
    return files.length ? `读 ${files.join(" ")}${range ? `:${range[1]}${range[2] ? `-${range[2]}` : ""}` : ""}` : null;
  }
  if (["cat", "nl", "head", "tail", "less", "bat"].includes(bin)) {
    const files = positional(args, /^-[nc]$/);
    return files.length ? `读 ${files.join(" ")}` : null;
  }
  if (bin === "git" && args[0] === "show") {
    const target = positional(args.slice(1), /^--format$/)[0] ?? "HEAD";
    const colon = target.indexOf(":");
    return colon > 0 ? `读 ${target.slice(colon + 1)}（${target.slice(0, colon)}）` : `看提交 ${target}`;
  }
  if (bin === "rg" && args.includes("--files")) {
    const dirs = positional(args, SEARCH_VALUED);
    return `列文件 ${dirs.length ? dirs.join(" ") : "."}`;
  }
  if (["rg", "grep", "egrep"].includes(bin)) {
    const e = args.findIndex((a) => a === "-e" || a === "--regexp");
    const pos = positional(args, SEARCH_VALUED);
    const pattern = e >= 0 ? args[e + 1] : pos.shift();
    if (pattern === undefined) return null;
    return `搜 '${pattern}'${pos.length ? ` 于 ${pos.join(" ")}` : ""}`;
  }
  return null;
}
