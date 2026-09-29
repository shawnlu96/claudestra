/**
 * ACP 的线路层：JSON-RPC 2.0，一行一个 JSON（ndjson），跑在 codex-acp 子进程的 stdio 上。
 * 手写而不是加 @agentclientprotocol/sdk：owner 只批了适配器本身，协议面就这么几个方法（docs/runtimes/codex-acp.md）。
 * 两个方向都有请求：我们调 session/*，适配器反过来调 session/request_permission 等。没注册处理器的请求回 -32601，
 * 绝不悬着不答——适配器会一直等，那个回合就卡死了。流断了（适配器退出）所有在途请求一起失败，调用方据此重启宿主。
 * tests/acp-rpc.test.ts。
 */

export const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

/** 对端回的 JSON-RPC 错误（code / data 原样保留：额度、未登录都靠它们认，见 failures.ts） */
export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = "RpcError";
  }
}

/** 线路：写一行、收一行、断开。宿主接子进程 stdio，单测接内存管道 */
export interface RpcWire {
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  onClose(cb: (why: string) => void): void;
}

type Handler = (params: any) => unknown;

export interface RpcPeer {
  request<T = any>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T>;
  notify(method: string, params?: unknown): void;
  /** 对端发来的请求（要回结果）。处理器抛 RpcError 原样回，抛别的回 -32603 */
  onRequest(method: string, h: Handler): void;
  /** 对端发来的通知（不回）。同名只留最后一个 */
  onNotification(method: string, h: Handler): void;
  readonly closed: boolean;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** 字节流 → 行：跨 chunk 的半行攒着，空行丢掉 */
export function lineSplitter(onLine: (line: string) => void): (chunk: string | Uint8Array) => void {
  const dec = new TextDecoder();
  let buf = "";
  return (chunk) => {
    buf += typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  };
}

export function createRpcPeer(wire: RpcWire, log: (msg: string) => void = console.error): RpcPeer {
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, Pending>();
  const requests = new Map<string, Handler>();
  const notifications = new Map<string, Handler>();
  const send = (msg: object) => {
    if (!closed) wire.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  };

  const answer = async (id: unknown, method: string, params: unknown) => {
    const h = requests.get(method);
    if (!h) return send({ id, error: { code: METHOD_NOT_FOUND, message: `method not found: ${method}` } });
    try {
      send({ id, result: (await h(params)) ?? null });
    } catch (e) {
      const err = e instanceof RpcError ? e : new RpcError(INTERNAL_ERROR, e instanceof Error ? e.message : String(e));
      send({ id, error: { code: err.code, message: err.message, ...(err.data === undefined ? {} : { data: err.data }) } });
    }
  };

  const settle = (msg: Record<string, any>) => {
    const p = pending.get(msg.id);
    if (!p) return log(`acp rpc: 收到没人等的响应 id=${msg.id}（超时后才到）`);
    pending.delete(msg.id);
    if (p.timer) clearTimeout(p.timer);
    if (msg.error) p.reject(new RpcError(Number(msg.error.code), String(msg.error.message ?? "error"), msg.error.data));
    else p.resolve(msg.result);
  };

  wire.onLine((line) => {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(line);
    } catch {
      return log(`acp rpc: 丢掉一行不是 JSON 的输出：${line.slice(0, 200)}`); // 没有 id 可回，只能记下
    }
    if (!msg || typeof msg !== "object") return;
    const hasId = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method === "string") {
      if (hasId) return void answer(msg.id, msg.method, msg.params);
      const h = notifications.get(msg.method);
      if (!h) return;
      try {
        void Promise.resolve(h(msg.params)).catch((e) => log(`acp rpc: 通知 ${msg.method} 处理出错：${e}`));
      } catch (e) {
        log(`acp rpc: 通知 ${msg.method} 处理出错：${e}`);
      }
      return;
    }
    if (hasId) settle(msg);
  });

  wire.onClose((why) => {
    closed = true;
    for (const [, p] of pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(`acp 连接断了（${why}）`));
    }
    pending.clear();
  });

  return {
    get closed() {
      return closed;
    },
    request(method, params, opts) {
      if (closed) return Promise.reject(new Error(`acp 连接已断，${method} 发不出去`));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const p: Pending = { resolve, reject };
        if (opts?.timeoutMs) {
          p.timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`${method} 超时（${opts.timeoutMs}ms）`));
          }, opts.timeoutMs);
        }
        pending.set(id, p);
        send({ id, method, ...(params === undefined ? {} : { params }) });
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
