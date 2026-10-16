/**
 * OCR-1B 探针：把 `opencode acp` 当 ACP agent 起起来，按场景跑一遍真实往返，逐帧落盘（夹具来源），再拿宿主自己的
 * checkInitialize（lib/acp/protocol.ts）和 createAcpTranslator（lib/acp/updates.ts）对照，看能不能直挂。
 * 只读宿主代码、不改；OpenCode 的配置 / 数据目录全部指向 --home（隔离，不碰 owner 家目录）。结论见 docs/runtimes/opencode-acp.md。
 *
 *   bun scripts/opencode-acp-probe.ts <场景> --home <隔离目录> --cwd <工作目录> --out <输出目录> [--model opencode/big-pickle] [--session <id>]
 *   场景：basic（initialize → session/new → 带工具调用的 prompt）| cancel | load（要 --session）| perm | mcp | compact（要 --session）| models | model
 *   --mcp-echo：自己当一个最小 stdio MCP server（mcp 场景挂给 OpenCode 用），不是给人跑的
 * 落盘：<out>/<场景>.raw.jsonl（原始帧，含本机路径，不提交）；--sanitize <raw> <dst> --root <临时根> 把路径 / 用户名换成占位符后写夹具。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { permissionCard, permissionResponse } from "../src/lib/acp/permissions.ts";
import { checkInitialize } from "../src/lib/acp/protocol.ts";
import { createAcpTranslator } from "../src/lib/acp/updates.ts";
import { resolveNpm } from "../src/lib/npm-path.ts";

type Rec = Record<string, any>;
type Frame = { t: number; dir: "host→agent" | "agent→host"; msg: Rec };

const FREE_DEFAULT = "opencode/big-pickle";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** 隔离环境：HOME / XDG_* 全指到 home 下，OpenCode 的 auth.json、opencode.db、日志都落在这里 */
function isolatedEnv(home: string): Record<string, string> {
  const npm = resolveNpm();
  const path = [npm?.binDir, process.env.PATH].filter(Boolean).join(":");
  return {
    PATH: path,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    // OpenCode 认的整份配置内容（JSON）：model 场景用它验「启动时给缺省模型」，不落盘、不碰任何配置文件
    ...(process.env.OPENCODE_CONFIG_CONTENT ? { OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT } : {}),
    ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
    ...(process.env.HTTP_PROXY ? { HTTP_PROXY: process.env.HTTP_PROXY } : {}),
  };
}

function opencodeBin(): string {
  const npm = resolveNpm();
  if (!npm) throw new Error("找不到 npm（resolveNpm），也就找不到 npm 全局装的 opencode");
  return join(npm.binDir, "opencode");
}

/** 一条到 `opencode acp` 的 NDJSON 连接：逐帧记录，agent 发来的请求交给 onRequest 回 */
class AcpProbe {
  readonly frames: Frame[] = [];
  readonly updates: Rec[] = [];
  private readonly t0 = Date.now();
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();
  private readonly proc: ReturnType<typeof Bun.spawn>;
  stderr = "";
  /** 缺省照宿主走：权限请求过 permissionCard，没人点 = cancelled（fail closed）；别的请求（fs / terminal，我们没声明）回错 */
  onRequest: (method: string, params: Rec) => Promise<unknown> = async (method, params) => {
    if (method !== "session/request_permission") throw new Error(`未声明的能力：${method}`);
    const card = permissionCard(params, "OpenCode");
    return card ? permissionResponse(card, null) : { outcome: { outcome: "cancelled" } };
  };

  constructor(home: string, cwd: string) {
    this.proc = Bun.spawn([opencodeBin(), "acp", "--cwd", cwd], { env: isolatedEnv(home), cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    void this.pump(this.proc.stdout as ReadableStream<Uint8Array>, (line) => this.onLine(line));
    void this.pump(this.proc.stderr as ReadableStream<Uint8Array>, (line) => void (this.stderr += `${line}\n`));
  }

  private async pump(stream: ReadableStream<Uint8Array>, onLine: (l: string) => void): Promise<void> {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of stream) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    }
  }

  private record(dir: Frame["dir"], msg: Rec): void {
    this.frames.push({ t: Date.now() - this.t0, dir, msg });
  }

  private onLine(line: string): void {
    let msg: Rec;
    try {
      msg = JSON.parse(line);
    } catch {
      this.stderr += `[stdout 非 JSON] ${line}\n`; // 协议流里混了非 JSON：记下来当证据（直挂时宿主的 rpc 会判线路作废）
      return;
    }
    this.record("agent→host", msg);
    if (msg.method === "session/update") this.updates.push(msg.params?.update ?? {});
    if (msg.method && msg.id !== undefined) return void this.answer(msg);
    const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(Object.assign(new Error(msg.error.message ?? "rpc error"), { data: msg.error }));
    else p.resolve(msg.result);
  }

  private async answer(msg: Rec): Promise<void> {
    try {
      this.send({ jsonrpc: "2.0", id: msg.id, result: await this.onRequest(msg.method, msg.params ?? {}) });
    } catch (e) {
      this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
    }
  }

  private send(msg: Rec): void {
    this.record("host→agent", msg);
    const stdin = this.proc.stdin as import("bun").FileSink;
    stdin.write(`${JSON.stringify(msg)}\n`);
    stdin.flush();
  }

  request(method: string, params: Rec, timeoutMs = 120_000): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => (this.pending.delete(id), reject(new Error(`${method} 超时 ${timeoutMs}ms`))), timeoutMs);
      this.pending.set(id, { resolve: (r) => (clearTimeout(timer), resolve(r)), reject: (e) => (clearTimeout(timer), reject(e)) });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Rec): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async close(): Promise<void> {
    (this.proc.stdin as import("bun").FileSink).end();
    await Promise.race([this.proc.exited, sleep(3_000)]);
    if (this.proc.exitCode === null) this.proc.kill();
  }
}

/** 宿主 initialize 时发的同一份参数（与 lib/acp/session.ts 的 CLIENT_CAPABILITIES 对齐，不 import 它免得拉起 rpc 等模块） */
const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { compaction: {} }, _meta: { terminal_output_delta: true } },
  clientInfo: { name: "claudestra-acp-host", version: "1" },
};

async function init(p: AcpProbe): Promise<Rec> {
  const r = await p.request("initialize", INIT_PARAMS, 60_000);
  return { initialize: r, hostVerdict: checkInitialize(r) };
}

/** 选模型：session/new 回包里有 models / configOptions 就按它们的形状切，两条都试，结果都记下 */
async function pickModel(p: AcpProbe, sessionId: string, created: Rec, model: string): Promise<Rec> {
  const tried: Rec = {};
  const modelOpt = (created.configOptions ?? []).find((o: Rec) => o.id === "model" || o.category === "model");
  if (modelOpt) {
    tried.set_config_option = await p.request("session/set_config_option", { sessionId, configId: modelOpt.id, value: model }).catch((e: Error) => ({ error: e.message }));
  }
  if (created.models) {
    tried.set_model = await p.request("session/set_model", { sessionId, modelId: model }).catch((e: Error) => ({ error: e.message }));
  }
  return tried;
}

/** 等到 prompt 结束；期间把 agent 发来的权限请求按 decide 回 */
async function promptOnce(p: AcpProbe, sessionId: string, text: string, timeoutMs = 240_000): Promise<Rec> {
  const t = Date.now();
  try {
    const r = await p.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, timeoutMs);
    return { result: r, ms: Date.now() - t };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), data: (e as { data?: unknown }).data, ms: Date.now() - t };
  }
}

/** 拿宿主的 translator 把收到的 update 翻一遍：看我们的 transcript / watcher 能拿到哪些条目 */
function translate(updates: Rec[]): Rec[] {
  const tr = createAcpTranslator(() => "T", { from: "compaction-update" });
  return [...updates.flatMap((u) => tr.push(u)), ...tr.flush()];
}

function kinds(updates: Rec[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const u of updates) out[u.sessionUpdate ?? "?"] = (out[u.sessionUpdate ?? "?"] ?? 0) + 1;
  return out;
}

async function newSession(p: AcpProbe, cwd: string, model: string, mcpServers: Rec[] = []): Promise<{ sessionId: string; created: Rec; model: Rec }> {
  const created = await p.request("session/new", { cwd, mcpServers });
  const sessionId = created.sessionId as string;
  return { sessionId, created, model: await pickModel(p, sessionId, created, model) };
}

type Ctx = { home: string; cwd: string; model: string; session?: string };

const TOOL_PROMPT = "Use your shell/bash tool to run exactly `ls -1` in the current directory, then tell me how many entries it printed. Keep the answer to one sentence.";

async function scenarioBasic(p: AcpProbe, c: Ctx): Promise<Rec> {
  const out: Rec = await init(p);
  const s = await newSession(p, c.cwd, c.model);
  Object.assign(out, { sessionNew: s.created, modelSwitch: s.model });
  out.prompt = await promptOnce(p, s.sessionId, TOOL_PROMPT);
  await sleep(1_500); // prompt 回包后迟到的 update（用量等）
  return { ...out, sessionId: s.sessionId };
}

/** 打断：等工具真的跑起来（tool_call_update in_progress）再发 session/cancel；之后再问一句，看被打断的那句还在不在上下文里 */
async function scenarioCancel(p: AcpProbe, c: Ctx): Promise<Rec> {
  const out: Rec = await init(p);
  const s = await newSession(p, c.cwd, c.model);
  const running = () => p.updates.some((u) => u.sessionUpdate === "tool_call_update" && u.status === "in_progress");
  const pending = promptOnce(p, s.sessionId, "Run exactly `sleep 60 && echo done` with your shell tool and wait for it. Do nothing else.");
  for (let i = 0; i < 600 && !running(); i++) await sleep(250);
  out.toolRunningBeforeCancel = running();
  const cancelAt = Date.now();
  p.notify("session/cancel", { sessionId: s.sessionId });
  out.prompt = await pending;
  out.cancelToStopMs = Date.now() - cancelAt;
  await sleep(1_000);
  const mark = p.updates.length;
  out.afterCancel = await promptOnce(p, s.sessionId, "Reply with exactly the single word: ok", 180_000);
  out.afterCancelUpdates = kinds(p.updates.slice(mark));
  return { ...out, sessionId: s.sessionId };
}

async function scenarioLoad(p: AcpProbe, c: Ctx): Promise<Rec> {
  if (!c.session) throw new Error("load 场景要 --session <basic 场景的 sessionId>");
  const out: Rec = await init(p);
  out.load = await p.request("session/load", { sessionId: c.session, cwd: c.cwd, mcpServers: [] }).catch((e: Error) => ({ error: e.message }));
  out.replayed = p.updates.length;
  out.resume = await p.request("session/resume", { sessionId: c.session, cwd: c.cwd, mcpServers: [] }).catch((e: Error) => ({ error: e.message }));
  out.prompt = await promptOnce(p, c.session, "What shell command did you run earlier in this conversation? Answer in one short sentence.");
  return { ...out, sessionId: c.session };
}

/**
 * 权限：OpenCode 缺省对 cwd 外的路径（external_directory）要授权。第一次答 allow_once、之后答 cancelled（宿主没人点时的回法），
 * 看 session/request_permission 的形状、两种答法各自的工具结局。
 */
async function scenarioPerm(p: AcpProbe, c: Ctx): Promise<Rec> {
  const asked: Rec[] = [];
  p.onRequest = async (method, params) => {
    asked.push({ method, params, hostCard: permissionCard(params, "OpenCode") });
    if (method !== "session/request_permission") throw new Error(`未声明的能力：${method}`);
    const card = permissionCard(params, "OpenCode");
    if (!card) return { outcome: { outcome: "cancelled" } };
    return permissionResponse(card, asked.length === 1 ? (card.options.find((o) => o.style === "success")?.id ?? null) : null);
  };
  const out: Rec = await init(p);
  const s = await newSession(p, c.cwd, c.model);
  const text = "Use your shell tool to run `cat ../perm-a.txt`, then use it again to run `cat ../perm-b.txt`. Report both results verbatim. Do not use any other tool.";
  out.prompt = await promptOnce(p, s.sessionId, text);
  return { ...out, asked, sessionId: s.sessionId };
}

/** MCP：session/new 带一个 stdio MCP server（本脚本 --mcp-echo），看 OpenCode 会不会起它、工具名长什么样、调用怎么报 */
async function scenarioMcp(p: AcpProbe, c: Ctx): Promise<Rec> {
  const out: Rec = await init(p);
  const echo = { name: "probe", command: process.execPath, args: [import.meta.path, "--mcp-echo"], env: [{ name: "PROBE_ECHO", value: "1" }] };
  const s = await newSession(p, c.cwd, c.model, [echo]);
  out.sessionNew = s.created;
  out.prompt = await promptOnce(p, s.sessionId, "Call the MCP tool named `ping` (from the `probe` server) with text \"hello\" and tell me exactly what it returned.");
  return { ...out, sessionId: s.sessionId };
}

/** 压缩 / 清空：看 available_commands_update 里有哪些斜杠命令，再按 ACP 的约定把 /compact 当 prompt 发 */
async function scenarioCompact(p: AcpProbe, c: Ctx): Promise<Rec> {
  if (!c.session) throw new Error("compact 场景要 --session");
  const out: Rec = await init(p);
  out.load = await p.request("session/load", { sessionId: c.session, cwd: c.cwd, mcpServers: [] }).catch((e: Error) => ({ error: e.message }));
  await sleep(1_000);
  const mark = p.updates.length;
  out.compact = await promptOnce(p, c.session, "/compact");
  out.compactUpdates = kinds(p.updates.slice(mark));
  return { ...out, sessionId: c.session };
}

/** 按会话换模型：session/new 看缺省（OPENCODE_CONFIG_CONTENT 给了 model 就该是它）→ set_config_option 换到 --model → 跑一轮 */
async function scenarioModel(p: AcpProbe, c: Ctx): Promise<Rec> {
  const out: Rec = await init(p);
  const created = await p.request("session/new", { cwd: c.cwd, mcpServers: [] });
  const cur = (r: Rec) => (r.configOptions ?? []).find((o: Rec) => o.id === "model")?.currentValue;
  out.defaultModel = cur(created);
  const switched = await p.request("session/set_config_option", { sessionId: created.sessionId, configId: "model", value: c.model });
  out.afterSwitch = cur(switched);
  const bad = { sessionId: created.sessionId, configId: "model", value: "opencode/no-such-model" };
  out.badValue = await p.request("session/set_config_option", bad).catch((e: Error) => ({ error: e.message, data: (e as { data?: unknown }).data }));
  out.prompt = await promptOnce(p, created.sessionId, "Reply with exactly the single word: hi");
  return { ...out, sessionId: created.sessionId };
}

async function scenarioModels(p: AcpProbe, c: Ctx): Promise<Rec> {
  const out: Rec = await init(p);
  const created = await p.request("session/new", { cwd: c.cwd, mcpServers: [] });
  return { ...out, models: created.models ?? null, configOptions: created.configOptions ?? null, modes: created.modes ?? null };
}

const SCENARIOS: Record<string, (p: AcpProbe, c: Ctx) => Promise<Rec>> = {
  basic: scenarioBasic, cancel: scenarioCancel, load: scenarioLoad, perm: scenarioPerm, mcp: scenarioMcp, compact: scenarioCompact, models: scenarioModels, model: scenarioModel,
};

/** 最小 stdio MCP server：一个 ping 工具，回 pong:<text>:env=<PROBE_ECHO>（mcp 场景用；顺带验 mcpServers 的 env 交到了子进程） */
async function runEchoServer(): Promise<void> {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const server = new Server({ name: "probe", version: "1" }, { capabilities: { tools: {} } });
  const inputSchema = { type: "object" as const, properties: { text: { type: "string" } }, required: ["text"] };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "ping", description: "Echo back the given text prefixed with pong:", inputSchema }] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const text = String((req.params.arguments as Rec | undefined)?.text ?? "");
    return { content: [{ type: "text" as const, text: `pong:${text}:env=${process.env.PROBE_ECHO ?? "missing"}` }] };
  });
  await server.connect(new StdioServerTransport());
}

const SECRET_KEY = /^(?:apiKey|api_key|token|authorization|key)$/i;
const SECRET_TEXT_RE = /("(?:apiKey|api_key|token|authorization|key)"\s*:\s*")(?:[^"\\]|\\.)*"/gi;

/** 按 JSON 结构打码：敏感字段整值换掉；字符串值本身是一段 JSON（嵌套的字符串化 JSON）就解析后递归再序列化回去 */
function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) && x !== null ? "<redacted>" : redact(x)]));
  if (typeof v === "string" && /^\s*[[{]/.test(v)) {
    try {
      return JSON.stringify(redact(JSON.parse(v)));
    } catch {
      return v; // 只是以括号开头的普通文本，不是 JSON：没有结构可打码，原样留着
    }
  }
  return v;
}

/** 夹具脱敏：本机路径、用户名、会话目录换成占位符；每行按 JSON 结构给 token / key 字段打码，不是 JSON 的行退回按文本打码（认转义引号） */
export function sanitize(text: string, subs: Array<[string, string]>): string {
  let s = text;
  for (const [from, to] of [...subs].sort((a, b) => b[0].length - a[0].length)) if (from) s = s.split(from).join(to);
  return s.split("\n").map((line) => {
    if (!line.trim()) return line;
    try {
      return JSON.stringify(redact(JSON.parse(line)));
    } catch {
      return line.replace(SECRET_TEXT_RE, '$1<redacted>"'); // 不是一行完整 JSON（日志 / 半截帧）：退回文本打码
    }
  }).join("\n");
}

/** --root：探针的临时根目录（隔离 HOME 和 cwd 都在它下面），整段换成 <tmp>；家目录和带用户名的 slug 也换掉 */
function sanitizeFile(raw: string, dst: string): void {
  const root = arg("root") ?? "";
  const home = process.env.HOME ?? "";
  const slug = home.replace(/\//g, "-");
  const subs: Array<[string, string]> = [
    [root, "<tmp>"], [root.replace(/^\//, ""), "<tmp>"], [root.replace(/^\/private/, ""), "<tmp>"],
    [import.meta.dir.replace(/\/scripts$/, ""), "<repo>"], [process.execPath, "<bun>"], [home, "<home>"], [slug, "-<home>"],
  ];
  writeFileSync(dst, sanitize(readFileSync(raw, "utf8"), subs.filter(([from]) => from.length > 1)));
}

async function main(): Promise<void> {
  if (process.argv.includes("--mcp-echo")) return runEchoServer();
  const san = process.argv.indexOf("--sanitize");
  if (san > 0) return sanitizeFile(process.argv[san + 1], process.argv[san + 2]);
  const name = process.argv[2] ?? "";
  const run = SCENARIOS[name];
  const home = arg("home"), cwd = arg("cwd"), outDir = arg("out");
  if (!run || !home || !cwd || !outDir) throw new Error(`用法见文件头；场景：${Object.keys(SCENARIOS).join(" | ")}`);
  mkdirSync(outDir, { recursive: true });
  const p = new AcpProbe(home, cwd);
  const ctx: Ctx = { home, cwd, model: arg("model") ?? FREE_DEFAULT, session: arg("session") };
  let summary: Rec;
  try {
    summary = await run(p, ctx);
  } catch (e) {
    summary = { fatal: e instanceof Error ? e.message : String(e) };
  } finally {
    await p.close();
  }
  summary = { ...summary, updateKinds: kinds(p.updates), hostEntries: translate(p.updates), stderrTail: p.stderr.slice(-4_000) };
  writeFileSync(join(outDir, `${name}.raw.jsonl`), p.frames.map((f) => JSON.stringify(f)).join("\n") + "\n");
  writeFileSync(join(outDir, `${name}.summary.json`), JSON.stringify(summary, null, 2));
  process.stdout.write(`${JSON.stringify({ scenario: name, sessionId: summary.sessionId, updateKinds: summary.updateKinds, fatal: summary.fatal })}\n`);
}

if (import.meta.main) await main();
