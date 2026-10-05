/**
 * ACP 的线路层：JSON-RPC 2.0，一行一个 JSON（ndjson），跑在 codex-acp 子进程的 stdio 上。
 * 手写而不是加 @agentclientprotocol/sdk：owner 只批了适配器本身，协议面就这么几个方法（docs/runtimes/codex-acp.md）。
 * - 两个方向都有请求。没注册处理器的请求回 -32601，绝不悬着不答——适配器会一直等，那个回合就卡死了。
 * - 入站先分清 request / notification / response，形状不合规的不算数：畸形响应让对应请求失败，不当成功（`{"id":1}` 不是 result:undefined）。
 * - 单行与未收完的半行都有字节上限（maxLineBytes）：超了就整条连接作废、在途请求全部失败，日志只留截断摘要，不截断后接着解析。
 * - 流断了（适配器退出）同样全部失败，调用方据此重启宿主。tests/acp-rpc.test.ts。
 * - 请求失败带投递状态（RpcLostError.sent）：带用户输入的请求据此判断能不能重发（session.ts）。
 */

export const METHOD_NOT_FOUND = -32601;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;

/** 缺省单行上限：要容得下整段工具输出和 base64 图片，又不能让一行没有换行的输出把宿主内存吃光 */
const DEFAULT_MAX_LINE_BYTES = 32 * 1024 * 1024;
const LOG_SNIPPET = 200;

/** 对端回的 JSON-RPC 错误（code / data 原样保留：额度、未登录都靠它们认，见 failures.ts） */
export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = "RpcError";
  }
}

/**
 * 请求没拿到可信结果。sent=true：已经尝试写给对端（之后断线、超时、回包不合规，或写入时抛错——可能写了一半），对端可能已经执行；
 * sent=false：连接早就断了，一个字节都没写。用户输入只有 sent=false 才能重发，否则会重复执行（session.ts）。
 * message 与以前的普通 Error 逐字相同、name 不改（String(e) 仍是 "Error: …"），按文字认错误的调用方不受影响。
 */
export class RpcLostError extends Error {
  constructor(message: string, readonly sent: boolean) {
    super(message);
  }
}

/** 线路：写一行、收字节、断开。宿主接子进程 stdio，单测接内存管道 */
export interface RpcWire {
  write(line: string): void;
  onData(cb: (chunk: string | Uint8Array) => void): void;
  onClose(cb: (why: string) => void): void;
  /** 本端判定线路坏了（超长行）主动断开：宿主据此结束子进程 */
  close(why: string): void;
}

type Handler = (params: any) => unknown;

export interface RpcPeer {
  /**
   * onResult：成功回包到达时**同步**调用，在处理下一行之前。宿主靠它在 steer 回包那一刻就登记等待——之后的线程状态行
   * 一定晚于它被处理，不会「先完成、后挂监听」（promise 的 then 要等微任务，下一行可能已经处理完了）。
   */
  request<T = any>(method: string, params?: unknown, opts?: { timeoutMs?: number; onResult?: (result: T) => void }): Promise<T>;
  notify(method: string, params?: unknown): void;
  /** 对端发来的请求（要回结果）。处理器抛 RpcError 原样回，抛别的回 -32603 */
  onRequest(method: string, h: Handler): void;
  /** 对端发来的通知（不回）。同名只留最后一个 */
  onNotification(method: string, h: Handler): void;
  readonly closed: boolean;
  /** 连接作废（对端退出 / 超长行）之后调，在途请求已经全部 reject。线路只有一个 onClose 槽，别人要听断开都走这里 */
  onClosed(cb: (why: string) => void): void;
}

interface Pending {
  resolve: (v: any) => void;
  onResult?: (v: any) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const snippet = (s: string) => (s.length > LOG_SNIPPET ? `${s.slice(0, LOG_SNIPPET)}…（共 ${s.length} 字符）` : s);

/**
 * 字节流 → 行：跨 chunk 的半行攒着，空行丢掉。整行或攒着的半行超过 maxBytes 就调 onOverflow 并从此不再吐行
 * （超长行里的 JSON 不能截断了接着解析）。按字节算：UTF-8 的中文一个字三字节。
 */
export function lineSplitter(onLine: (line: string) => void, maxBytes = DEFAULT_MAX_LINE_BYTES, onOverflow: (why: string) => void = () => {}): (chunk: string | Uint8Array) => void {
  const dec = new TextDecoder();
  let buf = "";
  let bufBytes = 0;
  let dead = false;
  const overflow = (bytes: number, head: string) => {
    dead = true;
    buf = "";
    onOverflow(`单行超过 ${maxBytes} 字节（至少 ${bytes}）：${snippet(head)}`);
  };
  return (chunk) => {
    if (dead) return;
    buf += typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true });
    bufBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    // 按下标扫、最后切一次：一个 chunk 里成千上万行时不反复拷贝剩余缓冲
    let start = 0;
    let i: number;
    while (!dead && (i = buf.indexOf("\n", start)) >= 0) {
      const line = buf.slice(start, i);
      start = i + 1;
      const bytes = Buffer.byteLength(line);
      if (bytes > maxBytes) return overflow(bytes, line);
      if (line.trim()) onLine(line.trim());
    }
    if (start) {
      buf = buf.slice(start);
      bufBytes = Buffer.byteLength(buf);
    }
    if (bufBytes > maxBytes) overflow(bufBytes, buf);
  };
}

const isId = (v: unknown): v is string | number => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

/** 响应的形状：jsonrpc 2.0、合法 id、result 与 error 恰好一个（result:null 合法），error 要有整数 code 和字符串 message */
function responseProblem(m: Record<string, any>): string | null {
  if (m.jsonrpc !== "2.0") return "缺 jsonrpc:\"2.0\"";
  const hasResult = "result" in m;
  const hasError = "error" in m;
  if (hasResult === hasError) return "result 与 error 必须二选一";
  if (hasError && !(m.error && typeof m.error === "object" && Number.isInteger(m.error.code) && typeof m.error.message === "string")) return "error 缺整数 code 或字符串 message";
  return null;
}

type Inbound =
  | { t: "request"; id: string | number; method: string; params: unknown }
  | { t: "bad-request"; id: string | number }
  | { t: "notification"; method: string; params: unknown }
  | { t: "response"; m: Record<string, any> }
  | { t: "drop"; why: string };

/** 一行 → 哪一类消息。合不合规在这里分清：缺 jsonrpc 的请求要回 -32600，缺 jsonrpc 的通知丢掉，响应的形状由 settle 查 */
function classify(line: string): Inbound {
  let m: Record<string, any>;
  try {
    m = JSON.parse(line);
  } catch {
    return { t: "drop", why: "不是 JSON" }; // 没有 id 可回，只能记下
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return { t: "drop", why: "不是对象" };
  if (typeof m.method !== "string") return "id" in m ? { t: "response", m } : { t: "drop", why: "既不是请求、通知也不是响应" };
  const bad = m.jsonrpc !== "2.0";
  if (!("id" in m) || m.id === null) return bad ? { t: "drop", why: "通知缺 jsonrpc:\"2.0\"" } : { t: "notification", method: m.method, params: m.params };
  if (!isId(m.id)) return { t: "drop", why: "请求的 id 不合法" };
  return bad ? { t: "bad-request", id: m.id } : { t: "request", id: m.id, method: m.method, params: m.params };
}

function rejectAll(pending: Map<number, Pending>, why: string): void {
  for (const [, p] of pending) {
    if (p.timer) clearTimeout(p.timer);
    p.reject(new RpcLostError(`acp 连接断了（${why}）`, true));
  }
  pending.clear();
}

/** 一条响应 → 对应的在途请求：不合规的让它失败，错误变 RpcError，成功先同步调 onResult 再交结果 */
function settleResponse(pending: Map<number, Pending>, m: Record<string, any>, log: (msg: string) => void): void {
  const p = typeof m.id === "number" ? pending.get(m.id) : undefined;
  if (!p) return log(`acp rpc: 收到没人等的响应 id=${JSON.stringify(m.id)}（超时后才到，或不是我们发的 id）`);
  pending.delete(m.id);
  if (p.timer) clearTimeout(p.timer);
  const problem = responseProblem(m);
  if (problem) return p.reject(new RpcLostError(`acp 对端回了不合规的响应（${problem}）`, true));
  if ("error" in m) return p.reject(new RpcError(m.error.code, m.error.message, m.error.data));
  try {
    p.onResult?.(m.result);
  } catch (e) {
    log(`acp rpc: 回包同步钩子出错：${e}`); // 钩子坏了不能连带把这个请求挂死：结果照常交出去
  }
  p.resolve(m.result);
}

/** 处理器抛的错 → 回给对端的 error 对象 */
function errorBody(e: unknown): { code: number; message: string; data?: unknown } {
  const err = e instanceof RpcError ? e : new RpcError(INTERNAL_ERROR, e instanceof Error ? e.message : String(e));
  return { code: err.code, message: err.message, ...(err.data === undefined ? {} : { data: err.data }) };
}

export function createRpcPeer(wire: RpcWire, opts: { log?: (msg: string) => void; maxLineBytes?: number } = {}): RpcPeer {
  const log = opts.log ?? console.error;
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, Pending>();
  const requests = new Map<string, Handler>();
  const notifications = new Map<string, Handler>();
  const frame = (msg: object) => JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n";
  const send = (msg: object) => {
    if (!closed) wire.write(frame(msg));
  };

  const closedListeners: ((why: string) => void)[] = [];
  const shutdown = (why: string) => {
    if (closed) return;
    closed = true;
    rejectAll(pending, why);
    for (const cb of closedListeners) cb(why);
  };

  const answer = async (id: string | number, method: string, params: unknown) => {
    const h = requests.get(method);
    if (!h) return send({ id, error: { code: METHOD_NOT_FOUND, message: `method not found: ${method}` } });
    try {
      send({ id, result: (await h(params)) ?? null });
    } catch (e) {
      send({ id, error: errorBody(e) });
    }
  };

  const settle = (m: Record<string, any>) => settleResponse(pending, m, log);

  const notified = (method: string, params: unknown) => {
    const h = notifications.get(method);
    if (!h) return;
    try {
      void Promise.resolve(h(params)).catch((e) => log(`acp rpc: 通知 ${method} 处理出错：${e}`));
    } catch (e) {
      log(`acp rpc: 通知 ${method} 处理出错：${e}`);
    }
  };

  const onLine = (line: string) => {
    const c = classify(line);
    if (c.t === "request") void answer(c.id, c.method, c.params);
    else if (c.t === "bad-request") send({ id: c.id, error: { code: INVALID_REQUEST, message: "Invalid Request: jsonrpc must be \"2.0\"" } });
    else if (c.t === "notification") notified(c.method, c.params);
    else if (c.t === "response") settle(c.m);
    else log(`acp rpc: 丢掉一行（${c.why}）：${snippet(line)}`);
  };

  wire.onData(
    lineSplitter(onLine, opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES, (why) => {
      log(`acp rpc: ${why}，断开连接`);
      shutdown("对端输出超长行");
      wire.close("line too long");
    }),
  );
  wire.onClose(shutdown);

  return {
    onClosed(cb) {
      closedListeners.push(cb);
    },
    get closed() {
      return closed;
    },
    request(method, params, ropts) {
      if (closed) return Promise.reject(new RpcLostError(`acp 连接已断，${method} 发不出去`, false));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const line = frame({ id, method, ...(params === undefined ? {} : { params }) }); // 序列化抛错 = 还没写：普通错误交出去
        const p: Pending = { resolve, reject, onResult: ropts?.onResult };
        if (ropts?.timeoutMs) {
          p.timer = setTimeout(() => {
            pending.delete(id);
            reject(new RpcLostError(`${method} 超时（${ropts.timeoutMs}ms）`, true));
          }, ropts.timeoutMs);
        }
        pending.set(id, p);
        try {
          wire.write(line);
        } catch (e) {
          pending.delete(id);
          if (p.timer) clearTimeout(p.timer);
          reject(new RpcLostError(`${method} 写出时出错（${e instanceof Error ? e.message : String(e)}）`, true));
        }
      });
    },
    notify(method, params) {
      send({ method, ...(params === undefined ? {} : { params }) });
    },
    onRequest(method, h) {
      requests.set(method, h);
    },
    onNotification(method, h) {
      notifications.set(method, h);
    },
  };
}
