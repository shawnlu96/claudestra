/**
 * front：中继的 HTTPS 入口（docs/relay/protocol.md §6）。按主机名分两种：
 *   `<base>`          中继自己的页面（首页输短码、/c/<code>、/i 邀请落地、/healthz、/v1/ws 升级）；
 *   `<slug>.<base>`   隧道——把浏览器的 HTTP 请求变成 req 帧发给那台实例，响应帧流回浏览器。
 * 隧道不看路径、不验身份：浏览器没有实例密钥，身份由实例本机 Web 的会话决定。front 是 HTTPS 终点，能看见一切，
 * 所以日志只记方法、路径前缀、状态、耗时，不记头、正文、短码。
 */
import type { Server } from "bun";
import { randomBytes } from "node:crypto";
import { newRequestId, normalizeCode, RELAY_BASE_HEADER, RELAY_FROM, SLUG_RE, SUBPROTOCOL, type ResFrame } from "../lib/relay-protocol.js";
import { b64, forwardHeaders, headersToObject, NULL_BODY_STATUS, pumpBody, recordToHeaders, streamSink, type StreamSink } from "../lib/relay-stream.js";
import type { InstanceRecord } from "./directory.js";
import { KeyedWindows } from "./limiter.js";
import { homePage, invitePage, offlinePage, tooManyPage } from "./pages.js";
import type { Router } from "./router.js";
import type { Conn, ConnData, Logger } from "./server.js";

/** front 自己用到的三项配额（§6.1）；server 把整个 Limits 传进来，这里只挑这三个 */
interface FrontLimits {
  codeLookupPerIpPerMinute: number;
  tunnelPerIpPerMinute: number;
  maxTunnelInflightPerInstance: number;
}

export interface FrontDeps {
  base: string;
  trustProxy: boolean;
  version: string;
  commit?: string;
  headTimeoutMs: number;
  maxChunkBytes: number;
  limits: FrontLimits;
  online(): number;
  pending(): number;
  router: Router<Conn>;
  send(conn: Conn, frame: object): void;
  lookupCode(code: string): InstanceRecord | null;
  bySlug(slug: string): { record: InstanceRecord | null; conn: Conn | null };
  upgrade(req: Request, srv: Server<ConnData>, ip: string): Response | undefined;
  log: Logger;
}

const HSTS = "max-age=31536000";
const NO_BODY = new Set(["GET", "HEAD"]);

const withHsts = (r: Response): Response => {
  r.headers.set("strict-transport-security", HSTS);
  return r;
};
const html = (status: number, body: string): Response =>
  withHsts(new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }));
const text = (status: number, body: string): Response => withHsts(new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } }));
const redirect = (to: string): Response => withHsts(new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store" } }));

/** Cookie 头里某个名字的值（只取第一个；这里只读 cstra_home，值形状再用 SLUG_RE 校验） */
function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

const SWEEP_EVERY_MS = 60_000;

export class Front {
  private readonly codeWindows: KeyedWindows;
  private readonly tunnelWindows: KeyedWindows;
  private lastSweep = 0;

  constructor(private readonly d: FrontDeps) {
    this.codeWindows = new KeyedWindows(d.limits.codeLookupPerIpPerMinute);
    this.tunnelWindows = new KeyedWindows(d.limits.tunnelPerIpPerMinute);
  }

  /** 限流窗口按请求顺带清扫（front 没有自己的定时器，不然 stop 时还得记着停它） */
  private sweep(now: number): void {
    if (now - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = now;
    this.codeWindows.sweep(now);
    this.tunnelWindows.sweep(now);
  }

  /** 请求来自哪个主机名：反代之后认 X-Forwarded-Host；去端口、小写 */
  private hostOf(req: Request): string {
    const raw = (this.d.trustProxy && req.headers.get("x-forwarded-host")) || req.headers.get("host") || "";
    return raw.split(",")[0].trim().toLowerCase().replace(/:\d+$/, "");
  }

  private clientIp(req: Request, srv: Server<ConnData>): string {
    const fwd = this.d.trustProxy ? req.headers.get("x-forwarded-for")?.split(",")[0].trim() : undefined;
    return fwd || srv.requestIP(req)?.address || "?";
  }

  handle(req: Request, srv: Server<ConnData>): Response | Promise<Response> | undefined {
    const url = new URL(req.url);
    this.sweep(Date.now());
    // /v1/ws 与 /healthz 不看主机名：反代可能不透传 Host，握手不能因此失败
    if (url.pathname === "/v1/ws") return this.ws(req, srv);
    if (url.pathname === "/healthz") return this.healthz();
    const host = this.hostOf(req);
    const ip = this.clientIp(req, srv);
    if (host === this.d.base) return this.basePages(req, url, ip);
    if (host.endsWith(`.${this.d.base}`)) {
      const slug = host.slice(0, -(this.d.base.length + 1));
      if (SLUG_RE.test(slug)) return this.tunnel(req, url, slug, host, ip);
    }
    return text(404, "unknown host");
  }

  private healthz(): Response {
    const body = { ok: true, online: this.d.online(), pending: this.d.pending(), version: this.d.version, ...(this.d.commit ? { commit: this.d.commit } : {}) };
    return withHsts(Response.json(body, { headers: { "cache-control": "no-store" } }));
  }

  private ws(req: Request, srv: Server<ConnData>): Response | undefined {
    const protos = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((s) => s.trim());
    if (!protos.includes(SUBPROTOCOL)) return text(426, `subprotocol ${SUBPROTOCOL} required`);
    return this.d.upgrade(req, srv, this.clientIp(req, srv));
  }

  private basePages(req: Request, url: URL, ip: string): Response {
    if (req.method !== "GET" && req.method !== "HEAD") return text(405, "method not allowed");
    const p = url.pathname;
    if (p === "/") return html(200, homePage(this.d.base, url.searchParams.get("e") ?? undefined));
    if (p === "/c") return redirect(`/c/${encodeURIComponent(url.searchParams.get("code") ?? "")}`);
    if (p.startsWith("/c/")) return this.byCode(decodeURIComponent(p.slice(3)), ip);
    if (p === "/i") {
      const home = cookieValue(req.headers.get("cookie"), "cstra_home");
      return home && SLUG_RE.test(home) ? redirect(`https://${home}.${this.d.base}/join`) : html(200, invitePage(this.d.base));
    }
    return text(404, "not found");
  }

  /** 短码 → 实例网页的 /pair#<code>。302 的 Location 带 fragment，浏览器会原样保留。同一地址每分钟只能查几十次：短码 40 位，别让人枚举 */
  private byCode(raw: string, ip: string): Response {
    if (!this.codeWindows.tryAcquire(ip)) {
      this.d.log("info", `short code lookup rate limited ip=${ip}`);
      return html(429, tooManyPage(this.d.base));
    }
    const code = normalizeCode(raw);
    const rec = code ? this.d.lookupCode(code) : null;
    if (!code || !rec) {
      this.d.log("info", `short code lookup failed`);
      return redirect("/?e=code");
    }
    return redirect(`https://${rec.slug}.${this.d.base}/pair#${code}`);
  }

  // ── 隧道 ───────────────────────────────────────────────────────────────

  /** 隧道请求进门前的三道闸（§6.1）：每 IP 限流、目标登记且在线、每实例在途上限。返回 Response 就是被挡下了 */
  private admit(slug: string, ip: string): Response | { record: InstanceRecord; conn: Conn } {
    if (!this.tunnelWindows.tryAcquire(ip)) {
      this.d.log("info", `tunnel ${slug} rate limited ip=${ip}`);
      const headers = { "retry-after": "60", "content-type": "text/plain; charset=utf-8" };
      return withHsts(new Response("too many requests from this address", { status: 429, headers }));
    }
    const { record, conn } = this.d.bySlug(slug);
    if (!record) return html(404, offlinePage(slug, this.d.base, false));
    if (!conn) return html(503, offlinePage(slug, this.d.base, true));
    if (this.d.router.tunnelInflightOf(conn) >= this.d.limits.maxTunnelInflightPerInstance) {
      // 一台实例的在途隧道请求撑满了：多半是它的 Web 卡住不回或被人灌，再往上加只会把中继的内存一起拖进去
      this.d.log("warn", `tunnel ${slug} inflight cap ${this.d.limits.maxTunnelInflightPerInstance} reached`);
      return withHsts(Response.json({ ok: false, error: "too many concurrent requests" }, { status: 503, headers: { "retry-after": "5" } }));
    }
    return { record, conn };
  }

  private async tunnel(req: Request, url: URL, slug: string, host: string, ip: string): Promise<Response> {
    if (req.headers.get("upgrade")) return text(426, "websocket is not tunnelled by the relay");
    const admitted = this.admit(slug, ip);
    if (admitted instanceof Response) return admitted;
    const { record, conn } = admitted;
    const id = newRequestId(randomBytes);
    const method = req.method.toUpperCase();
    const headers = forwardHeaders(headersToObject(req.headers), (k) => k.startsWith("x-forwarded-") || k === RELAY_BASE_HEADER);
    Object.assign(headers, { "x-forwarded-for": ip, "x-forwarded-proto": "https", "x-forwarded-host": host, [RELAY_BASE_HEADER]: this.d.base });
    const hasBody = !NO_BODY.has(method) && req.body !== null;
    const t0 = Date.now();
    const path = url.pathname + url.search;
    const done = (status: number | string) => this.d.log("info", `tunnel ${slug} ${method} ${url.pathname.slice(0, 60)} → ${status} ${Date.now() - t0}ms`);

    let resolveHead!: (r: Response) => void;
    const head = new Promise<Response>((r) => (resolveHead = r));
    let headDone = false;
    let sink: StreamSink | null = null;
    // Bun.serve 要等到流里有第一块非空数据才把响应头发出去（空流会一直挂着），所以 res.more 且没首块时
    // 先把头存着，等第一块 data 到了再连头一起交给浏览器；end 先到就按空正文结束
    let held: { status: number; headers: Record<string, string> } | null = null;
    const cancel = () => {
      if (this.d.router.remove(p)) this.d.send(conn, { t: "cancel", id, from: RELAY_FROM });
    };
    const finish = (status: number, headers: Record<string, string>, body: Uint8Array | ReadableStream<Uint8Array> | null) => {
      headDone = true;
      done(status);
      resolveHead(new Response(NULL_BODY_STATUS.has(status) || method === "HEAD" ? null : body, { status, headers: recordToHeaders(headers) }));
    };
    const openStream = (status: number, headers: Record<string, string>, first: Uint8Array) => {
      sink = streamSink(cancel);
      sink.push(first);
      finish(status, headers, sink.stream);
    };
    const p = this.d.router.add(
      {
        id, from: RELAY_FROM, to: record.fp, fromConn: null, toConn: conn,
        waiter: {
          head: (res: ResFrame) => {
            const h = forwardHeaders(res.headers);
            h["strict-transport-security"] = HSTS;
            const first = res.body ? b64.dec(res.body) : new Uint8Array();
            if (!res.more) return finish(res.status, h, first);
            if (first.length) return openStream(res.status, h, first);
            held = { status: res.status, headers: h };
          },
          data: (bytes) => {
            if (sink) return sink.push(bytes);
            if (held && bytes.length) openStream(held.status, held.headers, bytes);
          },
          end: () => {
            if (sink) return sink.end();
            if (held) finish(held.status, held.headers, new Uint8Array());
          },
          fail: (code, message) => {
            if (sink) return sink.fail(new Error(code));
            if (held) return finish(held.status, held.headers, new Uint8Array());
            if (!headDone) {
              headDone = true;
              done(code);
              resolveHead(withHsts(Response.json({ ok: false, error: code, message: message ?? "" }, { status: 502 })));
            }
          },
        },
      },
      this.d.headTimeoutMs,
      {
        onTimeout: (pp) => {
          pp.waiter!.fail("timeout", `no response within ${this.d.headTimeoutMs} ms`);
          this.d.send(conn, { t: "cancel", id, from: RELAY_FROM });
        },
        onStreamTimeout: (pp, why) => {
          pp.waiter!.fail(why);
          this.d.send(conn, { t: "cancel", id, from: RELAY_FROM });
        },
      },
    );
    req.signal.addEventListener("abort", cancel);
    this.d.send(conn, { t: "req", id, from: RELAY_FROM, timeoutMs: this.d.headTimeoutMs, method, path, headers, body: "", more: hasBody });
    if (hasBody) {
      const emit = (chunk: Uint8Array | null) => this.d.send(conn, chunk ? { t: "data", id, from: RELAY_FROM, b64: b64.enc(chunk) } : { t: "end", id, from: RELAY_FROM });
      pumpBody(req.body, emit, req.signal, this.d.maxChunkBytes)
        .catch((e) => {
          // 浏览器半路断了或正文读失败：接收方那边的处理已无人接收，取消掉即可
          this.d.log("info", `tunnel ${slug} request body aborted: ${(e as Error).message}`);
          cancel();
          p.waiter!.fail("aborted", "request body aborted");
        });
    }
    return head;
  }
}
