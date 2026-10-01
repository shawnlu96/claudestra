/**
 * pi rpc（0.99）↔ ACP 的纯映射，形状对着宿主的翻译器（lib/acp/updates.ts）：
 * - 正文：message_update.text_delta → agent_message_chunk，每条助手消息一个 messageId；provider 不流式时在 message_end 补整段。
 * - 工具：tool_execution_start → tool_call，tool_execution_end → tool_call_update（completed / failed）。
 *   mcp__<server>__<tool> 拆进 rawInput 的 server / tool / arguments，宿主据此认 reply；内置工具按 kind 给标题和路径。
 *   tool_execution_update 不转：宿主只在结束时展示结果，bash 的中间结果每次都是整段，转了就是反复重发全文。
 * - 忙闲用中性的 _meta.claudestra.threadStatus（不冒充 _meta.codex）；配置项的 id 沿用宿主认的 model / reasoning_effort。
 * tests/pi-acp-map.test.ts。
 */

type Rec = Record<string, any>;

const obj = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** 回合结束时最后一条助手消息的结局（stopReason：stop / toolUse / length / error / aborted…） */
export interface TurnOutcome {
  stopReason?: string;
  errorMessage?: string;
}

/** idle 可带这一轮的结局（turnEnd）：steering 另起的回合没有 session/prompt 可回错误，宿主只能从这里知道它失败了 */
export function threadStatus(type: "active" | "idle", turn?: Rec): Rec {
  return { sessionUpdate: "session_info_update", _meta: { claudestra: { threadStatus: { type }, ...(turn ? { turn } : {}) } } };
}

/** 运行时无关的失败种类，宿主据此进额度 / 登录通道（lib/acp/failures.ts）。先认额度：429 insufficient_quota 不是限流 */
type PiFailureKind = "quota" | "auth" | "rate_limit" | "error";
const QUOTA_RE = /insufficient[_ ]quota|quota|credits?\b|billing|balance|usage limit|payment required|\b402\b/i;
const AUTH_RE = /\b401\b|unauthori[sz]ed|invalid[ _-]?api[ _-]?key|no api key|api key (?:is )?(?:missing|not (?:set|found))|authenticat|not logged in/i;
const RATE_RE = /\b429\b|rate[ _-]?limit|too many requests|overloaded|\b529\b/i;

function piFailureKind(message: string): PiFailureKind {
  if (QUOTA_RE.test(message)) return "quota";
  if (AUTH_RE.test(message)) return "auth";
  return RATE_RE.test(message) ? "rate_limit" : "error";
}

/** 回合结局 → 给宿主的结构化结果：stopReason 同 session/prompt；失败带 failure（种类 + 给人看的原因） */
export function turnEnd(o: TurnOutcome, cancelled: boolean): Rec {
  const stopReason = stopReasonOf(o, cancelled);
  if (stopReason) return { stopReason };
  const message = `Pi 回合失败：${o.errorMessage ?? "未说明原因"}`;
  return { stopReason: "error", failure: { kind: piFailureKind(o.errorMessage ?? ""), message } };
}

function chunk(messageId: string, text: string): Rec {
  return { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } };
}

/** 内容块里的文字（pi 的消息 / 工具结果、ACP 的 prompt 同形），其余类型丢掉 */
export const textOf = (content: unknown): string =>
  (Array.isArray(content) ? content : []).map((c) => (c?.type === "text" ? str(c.text) : "")).filter(Boolean).join("\n");

const MCP_TOOL = /^mcp__([A-Za-z0-9_-]+?)__(.+)$/;
const KINDS: Record<string, string> = { bash: "execute", read: "read", edit: "edit", write: "edit", grep: "search", find: "search" };

/**
 * 工具调用 → ACP tool_call。带 parentToolCallId 的是**嵌套调用**（codemode 脚本里的
 * `tools.x()`、扩展的 ctx.executeTool()）：pi 只把它们记在父结果的 nestedCalls 里，
 * 不进 transcript，但事件是发的 —— 标上「↳ 」和 _meta 才能让网页看出"脚本到底跑了什么"。
 */
function toolCall(ev: Rec): Rec {
  const out = toolCallFields(ev);
  const parent = str(ev.parentToolCallId);
  if (!parent) return out;
  return {
    ...out,
    title: `↳ ${str(out.title).trim()}`,
    _meta: { ...obj(out._meta), parentToolCallId: parent },
  };
}

function toolCallFields(ev: Rec): Rec {
  const name = str(ev.toolName) || "tool";
  const args = obj(ev.args);
  const base = { sessionUpdate: "tool_call", toolCallId: str(ev.toolCallId), status: "in_progress" };
  const mcp = MCP_TOOL.exec(name);
  if (mcp) return { ...base, kind: "other", title: name, rawInput: { server: mcp[1], tool: mcp[2], arguments: args }, _meta: { is_mcp_tool_call: true } };
  const kind = KINDS[name] ?? "other";
  const path = str(args.path);
  const title = kind === "execute" ? str(args.command) : kind === "search" ? str(args.pattern) : path;
  return { ...base, kind, title: kind === "other" ? name : title || name, rawInput: args, ...(path ? { locations: [{ path }] } : {}) };
}

function toolDone(ev: Rec): Rec {
  const text = textOf(obj(ev.result).content);
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: str(ev.toolCallId),
    status: ev.isError === true ? "failed" : "completed",
    content: text ? [{ type: "content", content: { type: "text", text } }] : [],
  };
}

/** 一个 pi 会话一个：pi 事件 → 零到多条 session/update 的 update 字段，顺带记下本回合最后一条助手消息的结局 */
export function createPiEventMapper() {
  let seq = 0;
  let messageId = "";
  let streamed = false;
  let outcome: TurnOutcome = {};
  return {
    push(ev: Rec): Rec[] {
      const m = obj(ev.message);
      switch (ev.type) {
        case "message_start":
          if (m.role === "assistant") {
            messageId = `msg-${++seq}`;
            streamed = false;
          }
          return [];
        case "message_update": {
          const d = obj(ev.assistantMessageEvent);
          if (d.type !== "text_delta" || !str(d.delta)) return [];
          streamed = true;
          return [chunk(messageId, d.delta)];
        }
        case "message_end": {
          if (m.role !== "assistant") return [];
          outcome = { stopReason: str(m.stopReason) || undefined, errorMessage: str(m.errorMessage) || undefined };
          const text = streamed ? "" : textOf(m.content);
          return text ? [chunk(messageId, text)] : [];
        }
        case "tool_execution_start":
          return [toolCall(ev)];
        case "tool_execution_end":
          return [toolDone(ev)];
        default:
          return [];
      }
    },
    /** 取走本回合的结局并清空（下一回合从头记） */
    takeOutcome(): TurnOutcome {
      const o = outcome;
      outcome = {};
      return o;
    },
  };
}

/** 整条 prompt 是 `/compact [指示]` → rpc compact 命令；别的（含带 <channel> 头的普通消息）返回 null */
export function compactCommand(text: string): Rec | null {
  const m = /^\/compact(?:\s+([\s\S]+))?$/.exec(text.trim());
  if (!m) return null;
  const customInstructions = m[1]?.trim();
  return { type: "compact", ...(customInstructions ? { customInstructions } : {}) };
}

/** compact 的回包 / 失败原因 → 给网页看的一句话（压缩本身不产生助手消息，不说一声就像什么都没发生） */
export function compactNotice(result: unknown, error?: string): Rec {
  const r = obj(result);
  const after = typeof r.estimatedTokensAfter === "number" ? ` → 约 ${r.estimatedTokensAfter}` : "";
  const text = error ? `上下文没有压缩：${error}` : typeof r.tokensBefore === "number" ? `上下文已压缩：${r.tokensBefore}${after} tokens` : "上下文已压缩";
  return chunk(`compact-${Date.now()}`, text);
}

/** get_session_stats 的 contextUsage → usage_update；压缩后 tokens 为 null 时没有可报的 */
export function usageUpdate(stats: unknown): Rec | null {
  const c = obj(obj(stats).contextUsage);
  if (typeof c.tokens !== "number" || typeof c.contextWindow !== "number") return null;
  return { sessionUpdate: "usage_update", used: c.tokens, size: c.contextWindow };
}

const modelValue = (m: unknown): string => {
  const o = obj(m);
  return str(o.provider) && str(o.id) ? `${o.provider}/${o.id}` : "";
};

/** "provider/model" → set_model 的参数；模型 id 自己可以带斜杠，按第一个斜杠切 */
export function splitModelValue(value: string): { provider: string; modelId: string } | null {
  const i = value.indexOf("/");
  return i > 0 && i < value.length - 1 ? { provider: value.slice(0, i), modelId: value.slice(i + 1) } : null;
}

/** get_state + 可用模型 + 当前模型可用的思考档 → ACP configOptions；currentValue 一律取 pi 回报的实际值 */
export function configOptions(state: unknown, models: unknown, levels: unknown): Rec[] {
  const st = obj(state);
  const current = modelValue(st.model);
  const modelChoices = (Array.isArray(models) ? models : []).filter((m) => modelValue(m)).map((m) => ({ value: modelValue(m), name: str(m.name) || modelValue(m) }));
  if (current && !modelChoices.some((c) => c.value === current)) modelChoices.unshift({ value: current, name: str(st.model.name) || current });
  const level = str(st.thinkingLevel) || "off";
  const levelList = (Array.isArray(levels) ? levels : []).filter((l): l is string => typeof l === "string");
  if (!levelList.includes(level)) levelList.unshift(level);
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: current, options: modelChoices },
    { id: "reasoning_effort", name: "Thinking", category: "thought_level", type: "select", currentValue: level, options: levelList.map((v) => ({ value: v, name: v })) },
  ];
}

/** pi 把 MCP env 的值当模板（`$X` / `${X}` 换成环境变量，开头 `!` 当 shell 命令跑），转义成字面量：`$` → `$$`，开头 `!` → `$!` */
const piLiteral = (v: string) => v.replace(/\$/g, "$$$$").replace(/^!/, "$$!");

/** ACP 的 stdio mcpServers → 挂载扩展要的 {name: {command, args, env}}；别的传输拒掉（initialize 已声明不支持） */
export function mcpServersForPi(servers: unknown): { servers: Record<string, Rec> } | { error: string } {
  const out: Record<string, Rec> = {};
  for (const s of Array.isArray(servers) ? servers : []) {
    const o = obj(s);
    if (!str(o.name) || !str(o.command)) return { error: `只支持 stdio 的 MCP server（要有 name 和 command）：${JSON.stringify(s).slice(0, 120)}` };
    const env = Object.fromEntries((Array.isArray(o.env) ? o.env : []).filter((e: Rec) => str(e?.name)).map((e: Rec) => [e.name, piLiteral(str(e.value))]));
    out[o.name] = { command: o.command, args: (Array.isArray(o.args) ? o.args : []).map(String), env };
  }
  return { servers: out };
}

const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

/** 扩展弹框（owner 定的：一律取消，不接权限卡）→ 要回给 pi 的记录；通知类（不等回复）返回 null */
export function dialogCancel(req: Rec): Rec | null {
  return DIALOGS.has(str(req.method)) ? { type: "extension_ui_response", id: req.id, cancelled: true } : null;
}

/** 回合结局 → session/prompt 的 stopReason；error 返回 null（调用方回 JSON-RPC 错误，宿主据此出失败卡） */
export function stopReasonOf(o: TurnOutcome, cancelled: boolean): string | null {
  if (cancelled || o.stopReason === "aborted") return "cancelled";
  if (o.stopReason === "error") return null;
  return o.stopReason === "length" ? "max_tokens" : "end_turn";
}
