/**
 * 本地假 OpenAI Responses 服务：给真实 `codex app-server` 当 model provider，按剧本回流式 SSE，并记下每个 HTTP 请求。
 * 只绑 127.0.0.1、不校验也不需要任何凭据；Authorization 之类的头记录前就抹掉，记录可以直接落盘。
 * Codex 侧的配置（0.159.3 实测，见 docs/runtimes/codex-app-server-probe.md）：
 *   model_provider = "fake"
 *   [model_providers.fake]  name = "fake"  base_url = "<baseUrl>"  wire_api = "responses"
 * 剧本是一个函数：拿到这次请求（路径 + 解析好的正文），返回一个 Reply；同一个函数既管 /responses 也管别的路径。
 */

export interface RecordedRequest {
  seq: number;
  at: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export type Reply =
  /** 一条 assistant 文字消息；chunks 段 delta，段间隔 chunkDelayMs（拉长回合，好在中途 steer / interrupt） */
  | { type: "text"; text: string; chunks?: number; chunkDelayMs?: number; usage?: Usage }
  /** 一次 function_call；name 取请求里 tools 实际提供的那个（见 toolNames） */
  | { type: "tool"; name: string; args: Record<string, unknown>; callId?: string; usage?: Usage }
  /** 只发 response.created，然后挂住直到客户端断开（模拟模型一直在想） */
  | { type: "hang" }
  /** 流里发 response.failed（status 省略）或直接回 HTTP 错误码 */
  | { type: "fail"; message: string; status?: number }
  /** 非 SSE 的 JSON 响应（/models、/responses/compact 之类） */
  | { type: "json"; body: unknown; status?: number };

type Responder = (req: RecordedRequest) => Reply | Promise<Reply>;

export interface FakeResponses {
  baseUrl: string;
  requests: RecordedRequest[];
  stop(): void;
}

const REDACT = /^(authorization|cookie|openai-organization|openai-project|chatgpt-account-id|x-api-key)$/i;
const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_USAGE: Usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };

/** 一个 SSE 帧：event 行 + data 行（data 里也带 type，Codex 按 data.type 分派） */
function sseFrame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function completed(id: string, usage: Usage | undefined): string {
  return sseFrame("response.completed", { response: { id, usage: usage ?? DEFAULT_USAGE } });
}

function split(text: string, n: number): string[] {
  const size = Math.max(1, Math.ceil(text.length / Math.max(1, n)));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}

/** 一个 Reply 的完整帧序列（hang 只有开头那帧）；纯函数，单测直接断言它 */
export function replyFrames(reply: Reply, seq: number): string[] {
  const rid = `resp_${seq}`;
  const head = sseFrame("response.created", { response: { id: rid } });
  if (reply.type === "hang") return [head];
  if (reply.type === "fail") return [head, sseFrame("response.failed", { response: { id: rid, error: { code: "server_error", message: reply.message } } })];
  if (reply.type === "tool") {
    const item = { type: "function_call", id: `fc_${seq}`, call_id: reply.callId ?? `call_${seq}`, name: reply.name, arguments: JSON.stringify(reply.args) };
    return [head, sseFrame("response.output_item.added", { output_index: 0, item }), sseFrame("response.output_item.done", { output_index: 0, item }), completed(rid, reply.usage)];
  }
  if (reply.type === "json") return [];
  const id = `msg_${seq}`;
  const parts = split(reply.text, reply.chunks ?? 1);
  return [
    head,
    sseFrame("response.output_item.added", { output_index: 0, item: { type: "message", id, role: "assistant", content: [] } }),
    ...parts.map((delta) => sseFrame("response.output_text.delta", { item_id: id, output_index: 0, content_index: 0, delta })),
    sseFrame("response.output_item.done", {
      output_index: 0,
      item: { type: "message", id, role: "assistant", content: [{ type: "output_text", text: reply.text, annotations: [] }] },
    }),
    completed(rid, reply.usage),
  ];
}

function sseResponse(reply: Reply, seq: number): Response {
  const frames = replyFrames(reply, seq);
  // 文字分段时：开头 created + added 一起发，每段 delta 之间等 chunkDelayMs，结尾两帧一起发
  const gap = reply.type === "text" ? (reply.chunkDelayMs ?? 0) : 0;
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      try {
        for (const [i, f] of frames.entries()) {
          if (gap && i >= 2 && i < frames.length - 2) await sleep(gap);
          ctrl.enqueue(enc.encode(f));
        }
        if (reply.type !== "hang") ctrl.close();
      } catch (err) {
        // 客户端（被 interrupt 的回合）提前断开时 enqueue 会抛：这一次响应本来就没人要了
        if (!String(err).includes("closed")) throw err;
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

function readHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => (out[k] = REDACT.test(k) ? "<redacted>" : v));
  return out;
}

async function readBody(req: Request): Promise<unknown> {
  const raw = await req.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // 不是 JSON（压缩过的正文之类）也要留痕：原样存字符串，剧本照样能看
    return raw;
  }
}

export function startFakeResponses(responder: Responder, opts: { port?: number } = {}): FakeResponses {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const rec: RecordedRequest = {
        seq: requests.length + 1,
        at: Date.now(),
        method: req.method,
        path: url.pathname + url.search,
        headers: readHeaders(req.headers),
        body: await readBody(req),
      };
      requests.push(rec);
      const reply = await responder(rec);
      if (reply.type === "json") return Response.json(reply.body, { status: reply.status ?? 200 });
      if (reply.type === "fail" && reply.status) return Response.json({ error: { message: reply.message } }, { status: reply.status });
      return sseResponse(reply, rec.seq);
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}

/** Codex 在 x-codex-turn-metadata 头里标的请求种类："turn" 普通采样、"compaction" 本地压缩（0.159.3 实测）；没有就 undefined */
export function requestKind(req: RecordedRequest): string | undefined {
  try {
    return JSON.parse(req.headers["x-codex-turn-metadata"] ?? "{}").request_kind;
  } catch {
    // 头不是 JSON 就当没标：剧本按「普通请求」处理，不影响记录
    return undefined;
  }
}

/** 请求里 tools 提供的函数名（Codex 按模型家族给 shell / shell_command / exec_command 之一） */
export function toolNames(body: unknown): string[] {
  const tools = (body as { tools?: Array<{ name?: string; type?: string }> } | null)?.tools ?? [];
  return tools.map((t) => t.name ?? t.type ?? "").filter(Boolean);
}

/** 请求 input 里所有文字片段（user / developer 消息的 input_text、function_call_output 的 output），按出现顺序 */
export function inputTexts(body: unknown): string[] {
  const input = (body as { input?: unknown[] } | null)?.input ?? [];
  const out: string[] = [];
  for (const it of input as Array<Record<string, unknown>>) {
    if (typeof it.output === "string") out.push(it.output);
    for (const c of (Array.isArray(it.content) ? it.content : []) as Array<Record<string, unknown>>) {
      if (typeof c.text === "string") out.push(c.text);
    }
  }
  return out;
}
