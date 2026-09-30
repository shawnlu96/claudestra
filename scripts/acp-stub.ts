/**
 * 假的 ACP agent（T60 沙箱端到端用，owner 定的：沙箱不碰真 Codex 登录和 ~/.codex）。只讲协议、不连模型，但行为照着 codex-acp：
 * - 像 Codex 一样按 CODEX_CONFIG 的 mcp_servers 起 MCP server（我们的 channel-server，经宿主的回环代理），回合里真的调 reply；
 * - 流式：正文增量、一个命令工具调用（带终端输出增量）、用量、线程状态（active / idle）；
 * - steering：有回合在跑就 injected，没有就自己另起一轮、答 startedNewTurn（结束只靠线程状态 idle，和真适配器一样）；
 * - 注入：正文带 [stub:slow] = 慢回合（等 session/cancel），[stub:pause] = 暂停 1.5 秒供忙时插话验收，[stub:quota] = 撞额度（声明了 AIR 给 sessionFailure，没声明给
 *   legacy 的 usageLimitExceeded 错误），[stub:perm] = 跑命令前向宿主要权限（session/request_permission，答案写进回复），
 *   [stub:send:<目标>] = 回复后再调 send_to_agent 发给目标（沙箱 lab 的跨实例实测：<agent>@<peer>）；
 *   环境变量 STUB_AUTH_REQUIRED=1 = 没登录（接线程时回 -32000）。
 * 沙箱里 acp 固定起它（lib/acp/stub.ts，不用也不认 CLAUDESTRA_ACP_AGENT）；沙箱外单测 / 排查可用 CLAUDESTRA_ACP_AGENT='["bun","<repo>/scripts/acp-stub.ts"]'。
 */
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type Rec = Record<string, any>;
const out = (m: Rec) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let sessionId = "";
let air = false;
let mcp: { client: Client; server: string } | null = null;
let running: { cancelled: boolean; steered: string[] } | null = null;
const config: Rec[] = [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "stub-sol", options: [{ value: "stub-sol", name: "stub-sol" }, { value: "stub-luna", name: "stub-luna" }] },
  { id: "reasoning_effort", name: "Reasoning Effort", type: "select", currentValue: "medium", options: ["low", "medium", "high"].map((v) => ({ value: v, name: v })) },
];

/** 向宿主发的请求（只有权限请求）：按 id 等回包 */
const waiting = new Map<number, (r: Rec) => void>();
let nextReq = 0;
const requestHost = (method: string, params: Rec) => new Promise<Rec>((resolve) => {
  const id = 900_000 + ++nextReq;
  waiting.set(id, resolve);
  out({ id, method, params });
});

const update = (u: Rec) => out({ method: "session/update", params: { sessionId, update: u } });
const status = (type: string) => update({ sessionUpdate: "session_info_update", _meta: { codex: { threadStatus: { type, ...(type === "active" ? { activeFlags: [] } : {}) } } } });

/** 和 Codex 一样：线程起来时按 CODEX_CONFIG 起 MCP server，环境只给 env_vars 白名单里的 */
async function startMcp(): Promise<void> {
  if (mcp) return;
  const servers = (JSON.parse(process.env.CODEX_CONFIG || "{}").mcp_servers ?? {}) as Rec;
  const [name, s] = Object.entries(servers).find(([, v]) => v && typeof v.command === "string") ?? [];
  if (!name) return;
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  for (const k of (s.env_vars ?? []) as string[]) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  // 测试 / 沙箱标记和目录照带（CLAUDESTRA_*：状态 / 运行目录、沙箱开关、测试标记）：真 Codex 只给 env_vars 白名单，但 stub 起的
  // channel-server 丢了它们就会按生产规则跑（lib/test-guard.ts、沙箱闸）。stub 自己不引 src/lib：沙箱闸会在加载时查 bridge 地址
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && (k.startsWith("CLAUDESTRA_") || k === "NODE_ENV" || k === "TMPDIR")) env[k] ??= v;
  const client = new Client({ name: "acp-stub", version: "1" });
  await client.connect(new StdioClientTransport({ command: s.command, args: s.args ?? [], env, stderr: "ignore" }));
  mcp = { client, server: name };
}

async function callMcp(tool: string, args: Rec): Promise<void> {
  const id = `mcp-${randomUUID().slice(0, 8)}`;
  const rawInput = { server: mcp?.server ?? "claudestra", tool, arguments: args };
  update({ sessionUpdate: "tool_call", toolCallId: id, kind: "execute", title: `mcp.${rawInput.server}.${tool}`, status: "in_progress", rawInput, _meta: { is_mcp_tool_call: true } });
  let result: Rec = { content: [{ type: "text", text: "no mcp" }] };
  let error: Rec | null = null;
  try {
    if (mcp) result = (await mcp.client.callTool({ name: tool, arguments: args })) as Rec;
  } catch (e) {
    error = { message: e instanceof Error ? e.message : String(e) };
  }
  update({ sessionUpdate: "tool_call_update", toolCallId: id, status: error ? "failed" : "completed", rawOutput: { result, error } });
}

/** 一轮：正文 → 命令 → （慢回合等打断）→ reply → 用量 */
async function turn(text: string): Promise<Rec> {
  running = { cancelled: false, steered: [] };
  status("active");
  try {
    if (text.includes("[stub:quota]")) {
      const failure = { id: `${randomUUID()}:error`, revision: 1, category: "limit", severity: "error", title: "You've hit your usage limit. (stub)", actions: [] };
      if (air) return { stopReason: "end_turn", _meta: { jetbrains: { air: { version: 1, sessionFailure: failure } } } };
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "You've hit your usage limit. (stub)\n\n" } });
      throw { code: -32603, message: "Internal error", data: { message: "You've hit your usage limit. (stub)", codexErrorInfo: "usageLimitExceeded" } };
    }
    const msgId = randomUUID();
    for (const piece of ["stub 收到了，", "看一眼再回。"]) update({ sessionUpdate: "agent_message_chunk", messageId: msgId, content: { type: "text", text: piece } }), await sleep(50);
    const cid = `call-${randomUUID().slice(0, 8)}`;
    const rawInput = { command: "/bin/zsh -lc 'echo stub'", cwd: process.cwd() };
    update({ sessionUpdate: "tool_call", toolCallId: cid, kind: "execute", title: "echo stub", status: "in_progress", rawInput, content: [{ type: "terminal", terminalId: cid }] });
    let perm = "";
    if (text.includes("[stub:perm]")) {
      const options = [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }, { optionId: "reject_once", name: "Reject", kind: "reject_once" }];
      const r = await requestHost("session/request_permission", { sessionId, toolCall: { toolCallId: cid, title: "echo stub", kind: "execute", rawInput }, options });
      perm = `（权限：${r?.outcome?.outcome === "selected" ? r.outcome.optionId : "cancelled"}）`;
    }
    update({ sessionUpdate: "tool_call_update", toolCallId: cid, _meta: { terminal_output_delta: { data: "stub\n", terminal_id: cid } } });
    update({ sessionUpdate: "tool_call_update", toolCallId: cid, status: "completed", _meta: { terminal_exit: { exit_code: 0, terminal_id: cid } } });
    if (text.includes("[stub:pause]")) await sleep(1_500);
    if (text.includes("[stub:slow]")) for (let i = 0; i < 300 && !running.cancelled; i++) await sleep(100);
    if (running.cancelled) return { stopReason: "cancelled" };
    const chatId = /chat_id="([^"]+)"/.exec(text)?.[1];
    const model = config[0].currentValue;
    const extra = `${perm}${running.steered.length ? `（途中插话 ${running.steered.length} 条）` : ""}`;
    const reply = `stub 回复（${model} / ${config[1].currentValue}）${extra}：${text.replace(/<[^>]+>/g, "").trim().slice(0, 80)}`;
    if (chatId && !text.includes("[stub:noreply]")) await callMcp("reply", { chat_id: chatId, text: reply });
    const sendTo = /\[stub:send:([^\]\s]+)\]/.exec(text)?.[1];
    if (sendTo) await callMcp("send_to_agent", { target: sendTo, text: `stub ${sessionId.slice(0, 8)} 跨实例问候（lab）` });
    update({ sessionUpdate: "usage_update", used: 1234 + text.length, size: 272000 });
    return { stopReason: "end_turn" };
  } finally {
    running = null;
    status("idle");
  }
}

async function handle(m: Rec): Promise<Rec | undefined> {
  const p = m.params ?? {};
  switch (m.method) {
    case "initialize":
      air = Array.isArray(p.clientCapabilities?._meta?.jetbrains?.air?.capabilities) && p.clientCapabilities._meta.jetbrains.air.capabilities.includes("sessionFailure");
      return {
        protocolVersion: 1,
        agentInfo: { name: "acp-stub", version: "0" },
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, fork: {} } },
        _meta: { steering: { supported: true } },
      };
    case "session/new":
      sessionId = randomUUID();
      return { sessionId, configOptions: config };
    case "session/fork":
      if (typeof p.sessionId !== "string" || !p.sessionId) throw { code: -32602, message: "Missing source sessionId" };
      sessionId = randomUUID();
      return { sessionId, configOptions: config };
    case "session/resume":
    case "session/load":
      if (process.env.STUB_AUTH_REQUIRED === "1") throw { code: -32000, message: "Authentication required" };
      sessionId = String(p.sessionId);
      await startMcp();
      return { configOptions: config };
    case "session/prompt":
      return turn((p.prompt ?? []).map((b: Rec) => b.text ?? "").join("\n"));
    case "_session/steering": {
      const text = (p.prompt ?? []).map((b: Rec) => b.text ?? "").join("\n");
      if (running) return running.steered.push(text), update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "（收到插话）" } }), { outcome: "injected" };
      void turn(text);
      return { outcome: "startedNewTurn" };
    }
    case "session/set_config_option": {
      const o = config.find((c) => c.id === p.configId);
      if (!o || !o.options.some((x: Rec) => x.value === p.value)) throw { code: -32602, message: "Invalid params" };
      o.currentValue = p.value;
      return { configOptions: config };
    }
    case "session/cancel":
      if (running) running.cancelled = true;
      return undefined;
    default:
      throw { code: -32601, message: `method not found: ${m.method}` };
  }
}

let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line) as Rec;
    if (!m.method) {
      waiting.get(m.id)?.(m.result ?? {}); // 宿主对权限请求的回包；出错按空结果（= cancelled）算
      waiting.delete(m.id);
      continue;
    }
    void handle(m).then(
      (result) => m.id !== undefined && out({ id: m.id, result: result ?? null }),
      (e) => m.id !== undefined && out({ id: m.id, error: { code: e?.code ?? -32603, message: e?.message ?? String(e), ...(e?.data ? { data: e.data } : {}) } }),
    );
  }
});
process.stdin.on("end", () => void mcp?.client.close().finally(() => process.exit(0)));
