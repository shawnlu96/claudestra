/**
 * 假的 ACP agent（T60 沙箱端到端用，owner 定的：沙箱不碰真 Codex 登录和 ~/.codex）。只讲协议、不连模型，但行为照着 codex-acp：
 * - 像 Codex 一样按 CODEX_CONFIG 的 mcp_servers 起 MCP server（我们的 channel-server，经宿主的回环代理），回合里真的调 reply；
 * - 流式：正文增量、一个命令工具调用（带终端输出增量）、用量、线程状态（active / idle）；
 * - steering：有回合在跑就 injected，没有就自己另起一轮、答 startedNewTurn（结束只靠线程状态 idle，和真适配器一样）；
 * - 注入：正文带 [stub:slow] = 慢回合（等 session/cancel），[stub:pause] = 暂停 1.5 秒供忙时插话验收，[stub:quota] = 撞额度（声明了 AIR 给 sessionFailure，没声明给
 *   legacy 的 usageLimitExceeded 错误），[stub:perm] = 跑命令前向宿主要权限（session/request_permission，答案写进回复），
 *   [stub:send:<目标>] = 回复后再调 send_to_agent 发给目标（沙箱 lab 的跨实例实测：<agent>@<peer>），[stub:whoami] = 先调 whoami、结果写进回复（T85）；
 *   [stub:call:<工具>:<base64url 的 JSON 参数>] = 先调这个 MCP 工具、结果写进回复（T96 派单工具实测，可写多个，按顺序调）；
 *   环境变量 STUB_AUTH_REQUIRED=1 = 没登录（接线程时回 -32000）。
 * 沙箱里 acp 固定起它（lib/acp/stub.ts，不用也不认 CLAUDESTRA_ACP_AGENT）；沙箱外单测 / 排查可用 CLAUDESTRA_ACP_AGENT='["bun","<repo>/scripts/acp-stub.ts"]'。
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
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

async function callMcp(tool: string, args: Rec): Promise<Rec> {
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
  return error ?? result;
}

/**
 * 沙箱里的出借 worker（T94；写单见 lendWork）：派单尾注里有本机写的 `<bun> --no-env-file --config=/dev/null <manager.ts> lend submit <orderId>`（lib/lend-deps.ts）就在当前目录
 * 交一份 pass。子进程挂在这个 stub 下面，lend submit 的三条绑定（cwd / 会话 / 窗口进程祖先）照真的走。lab 实测走通一单用。
 */
function lendSubmit(text: string): string {
  const w = /^(\S+) --no-env-file --config=\/dev\/null (\S+manager\.ts) lend submit (\S+) --summary-file/m.exec(text);
  if (w) return lendWork(w[1], w[2], w[3]);
  const m = /^(\S+) --no-env-file --config=\/dev\/null (\S+manager\.ts) lend submit (\S+) --verdict/m.exec(text);
  if (!m) return "";
  writeFileSync("findings.json", "[]");
  writeFileSync("report.md", "stub 审过：没有发现问题（lab）\n");
  const r = Bun.spawnSync([m[1], "--no-env-file", "--config=/dev/null", m[2], "lend", "submit", m[3], "--verdict", "pass", "--findings-file", "findings.json", "--report", "report.md"],
    { stdout: "pipe", stderr: "pipe" });
  return `（lend submit：${(r.stdout.toString() || r.stderr.toString()).trim().slice(0, 200)}）`;
}

/**
 * 写单（i28-R6）：在当前分支上改一个文件、git commit，再交一行摘要与自查。副本上了锁推不出去，这里也不试；
 * 摘要 / 自查写成文件交（不进命令行参数），同 lib/lend-deps.ts 的尾注。
 */
function lendWork(bun: string, manager: string, orderId: string): string {
  const run = (argv: string[]) => Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  appendFileSync("LEND_STUB.md", `stub 改了一行（${orderId}，${new Date().toISOString()}）\n`);
  const add = run(["git", "add", "LEND_STUB.md"]);
  const commit = run(["git", "commit", "-q", "-m", `lend stub：${orderId}`]);
  if (add.exitCode !== 0 || commit.exitCode !== 0) return `（git commit 失败：${(commit.stderr.toString() || add.stderr.toString()).trim().slice(0, 200)}）`;
  const push = run(["git", "push", "origin", "HEAD:main"]); // 反例：副本上了锁，worker 推 main 一定失败
  writeFileSync("summary.txt", "stub 在 LEND_STUB.md 加了一行（lab）");
  writeFileSync("selfcheck.md", `- 只在当前分支提交\n- 试推 main：${push.exitCode === 0 ? "竟然成功了（锁没上）" : "被拒（锁生效）"}\n`);
  const r = run([bun, "--no-env-file", "--config=/dev/null", manager, "lend", "submit", orderId, "--summary-file", "summary.txt", "--self-check-file", "selfcheck.md"]);
  return `（lend submit：${(r.stdout.toString() || r.stderr.toString()).trim().slice(0, 200)}）`;
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
    const slowSec = /\[stub:slow(?::(\d{1,4}))?\]/.exec(text); // [stub:slow] = 30 秒；[stub:slow:N] = N 秒（lab 验长回合不被误杀）
    if (slowSec) for (let i = 0; i < Number(slowSec[1] ?? 30) * 10 && !running.cancelled; i++) await sleep(100);
    if (running.cancelled) return { stopReason: "cancelled" };
    const chatId = /chat_id="([^"]+)"/.exec(text)?.[1];
    const model = config[0].currentValue;
    const who = text.includes("[stub:whoami]") ? `（whoami ${JSON.stringify(await callMcp("whoami", {}))}）` : "";
    const lend = lendSubmit(text);
    let calls = "";
    for (const [, tool, arg] of text.matchAll(/\[stub:call:([\w-]+):([\w-]*)\]/g)) {
      calls += `（${tool} ${JSON.stringify(await callMcp(tool, arg ? JSON.parse(Buffer.from(arg, "base64url").toString()) : {}))}）`;
    }
    const extra = `${perm}${who}${lend}${calls}${running.steered.length ? `（途中插话 ${running.steered.length} 条）` : ""}`;
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
