/**
 * front：中继的 HTTPS 入口（docs/relay/protocol.md §6；路径模式见 docs/design-hosted-frontend.md §4）。按主机名与路径分三种：
 *   `<base>/…`          中继自己的页面与 API（首页、/c/<code>、/i、/healthz、/v1/ws、/api/v1/codes/lookup、/app-config.json）；
 *                       配了 staticDir 就在这里托管前端静态站（lib/static-site.ts 的导出布局）；
 *   `<base>/m/<fp>/…`   路径模式：转给指纹 fp 的实例，只放 /api/v1 下的路径，请求与响应头按 lib/relay-machine-path.ts 过滤；
 *   `<slug>.<base>/…`   旧子域名模式：路径与头原样转给实例（保留到兼容截止）。
 * 隧道不验身份：身份由实例自己判。日志只记方法、路径前缀、状态、耗时，不记头、正文、短码。
 */
import type { Server } from "bun";
import { randomBytes } from "node:crypto";
import { newRequestId, normalizeCode, RELAY_BASE_HEADER, RELAY_FROM, SLUG_RE, SUBPROTOCOL, type ResFrame } from "../lib/relay-protocol.js";
import { b64, forwardHeaders, headersToObject, NULL_BODY_STATUS, pumpBody, recordToHeaders, streamSink, type StreamSink } from "../lib/relay-stream.js";
import {
  filterMachineRequestHeaders, filterMachineResponseHeaders, MACHINE_PREFIX, parseMachinePath, RELAY_MODE_API, RELAY_MODE_HEADER, RELAY_PREFIX_HEADER, type MachinePath,
} from "../lib/relay-machine-path.js";
import { resolveExportedPath, STATIC_SITE_CSP } from "../lib/static-site.js";
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
  byFp(fp: string): { record: InstanceRecord | null; conn: Conn | null };
  /** 前端静态导出目录（RELAY_STATIC_DIR）；没配就只有中继自己的页面 */
  staticDir?: string;
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
const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  withHsts(Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } }));

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
    // 反代前面还有一层四层分流（nginx stream 按 SNI 转发）又没开 PROXY protocol 时，反代看到的客户端全是回环地址，
    // 按 IP 的限流就悄悄变成全局限流。只提醒一次，修法在 docs/relay/self-host.md §4
    if (fwd && !this.warnedSharedIp && /^(127\.|::1$|::ffff:127\.)/.test(fwd)) {
      this.warnedSharedIp = true;
      this.d.log("warn", `X-Forwarded-For 里是回环地址 ${fwd}：反代没拿到真实客户端 IP，按 IP 的限流会变成全局限流（见 self-host.md §4）`);
    }
    return fwd || srv.requestIP(req)?.address || "?";
  }
  private warnedSharedIp = false;

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

  private basePages(req: Request, url: URL, ip: string): Response | Promise<Response> {
    const p = url.pathname;
    if (p.startsWith(MACHINE_PREFIX)) return this.machine(req, url, ip);
    if (p === "/api/v1/codes/lookup") return req.method === "POST" ? this.codeLookup(req, ip) : text(405, "method not allowed");
    if (req.method !== "GET" && req.method !== "HEAD") return text(405, "method not allowed");
    if (p === "/app-config.json") return json(200, { mode: "relay", relayBase: this.d.base, version: this.d.version, ...(this.d.commit ? { commit: this.d.commit } : {}) });
    if (p === "/c") return redirect(`/c/${encodeURIComponent(url.searchParams.get("code") ?? "")}`);
    if (p.startsWith("/c/")) return this.byCode(decodeURIComponent(p.slice(3)), ip);
    if (p === "/i") {
      const home = cookieValue(req.headers.get("cookie"), "cstra_home");
      if (home && SLUG_RE.test(home)) return redirect(`https://${home}.${this.d.base}/join`);
      if (!this.d.staticDir) return html(200, invitePage(this.d.base));
    }
    // 托管的前端静态站：命中就发文件（HTML 不长缓存、_next/static 永久缓存）；没配或没命中再落到中继自己的页面
    const hit = this.d.staticDir ? resolveExportedPath(this.d.staticDir, p) : null;
    if (hit) {
      const file = Bun.file(hit.path);
      const csp = hit.path.endsWith(".html") ? { "content-security-policy": STATIC_SITE_CSP } : {};
      return withHsts(new Response(req.method === "HEAD" ? null : file, { status: hit.status, headers: { "content-type": file.type, "cache-control": hit.cacheControl, ...csp } }));
    }
    if (p === "/") return html(200, homePage(this.d.base, url.searchParams.get("e") ?? undefined));
    return text(404, "not found");
  }

  /** POST /api/v1/codes/lookup {code} → 这个短码属于哪台机器（新前端的配对页用）；与 /c/ 共用一个限流窗口 */
  private async codeLookup(req: Request, ip: string): Promise<Response> {
    if (!this.codeWindows.tryAcquire(ip)) return json(429, { ok: false, error: "rate_limited" }, { "retry-after": "60" });
    const body = (await req.json().catch(() => null)) as { code?: unknown } | null; // 坏 JSON 按没带码处理，下面回 404
    const code = typeof body?.code === "string" ? normalizeCode(body.code) : null;
    const rec = code ? this.d.lookupCode(code) : null;
    if (!rec) return json(404, { ok: false, error: "code_invalid" });
    return json(200, { ok: true, fp: rec.fp, name: rec.name, slug: rec.slug });
  }

  /** /m/<fp>/api/v1/…：错误全是 JSON——调用方是前端的 API 客户端，不是人看的页面 */
  private machine(req: Request, url: URL, ip: string): Response | Promise<Response> {
    const m = parseMachinePath(url.pathname);
    if (m === "path_forbidden") return json(400, { ok: false, error: "path_forbidden" });
    if (typeof m === "string") return json(404, { ok: false, error: "machine_unknown" });
    return this.tunnel(req, url, m.fp, this.d.base, ip, m);
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

  /** 隧道请求进门前的三道闸（§6.1）：每 IP 限流、目标登记且在线、每实例在途上限。返回 Response 就是被挡下了；路径模式的错误是 JSON */
  private admit(target: { record: InstanceRecord | null; conn: Conn | null }, label: string, ip: string, api: boolean): Response | { record: InstanceRecord; conn: Conn } {
    if (!this.tunnelWindows.tryAcquire(ip)) {
      this.d.log("info", `tunnel ${label} rate limited ip=${ip}`);
      const headers = { "retry-after": "60", "content-type": "text/plain; charset=utf-8" };
      return withHsts(new Response("too many requests from this address", { status: 429, headers }));
    }
    const { record, conn } = target;
    if (!record) return api ? json(404, { ok: false, error: "machine_unknown" }) : html(404, offlinePage(label, this.d.base, false));
    if (!conn) return api ? json(503, { ok: false, error: "machine_offline" }, { "retry-after": "10" }) : html(503, offlinePage(label, this.d.base, true));
    if (this.d.router.tunnelInflightOf(conn) >= this.d.limits.maxTunnelInflightPerInstance) {
      // 一台实例的在途隧道请求撑满了：多半是它的 Web 卡住不回或被人灌，再往上加只会把中继的内存一起拖进去
      this.d.log("warn", `tunnel ${label} inflight cap ${this.d.limits.maxTunnelInflightPerInstance} reached`);
      return withHsts(Response.json({ ok: false, error: "too many concurrent requests" }, { status: 503, headers: { "retry-after": "5" } }));
    }
    return { record, conn };
  }

  /** 发给实例的头：客户端自带的 x-forwarded-* / x-claudestra-relay-* 一律不信；路径模式再过滤 cookie 并加模式头 */
  private tunnelHeaders(req: Request, ip: string, host: string, mode?: MachinePath): Record<string, string> {
    const untrusted = (k: string) => k.startsWith("x-forwarded-") || k === RELAY_BASE_HEADER || k.startsWith("x-claudestra-relay-");
    const headers = forwardHeaders(headersToObject(req.headers), untrusted);
    Object.assign(headers, { "x-forwarded-for": ip, "x-forwarded-proto": "https", "x-forwarded-host": host, [RELAY_BASE_HEADER]: this.d.base });
    return mode ? { ...filterMachineRequestHeaders(headers), [RELAY_MODE_HEADER]: RELAY_MODE_API, [RELAY_PREFIX_HEADER]: mode.prefix } : headers;
  }

  /** slug 模式 label = slug；路径模式 label = fp 且带 mode（去前缀、过滤） */
  private async tunnel(req: Request, url: URL, label: string, host: string, ip: string, mode?: MachinePath): Promise<Response> {
    if (req.headers.get("upgrade")) return text(426, "websocket is not tunnelled by the relay");
    const admitted = this.admit(mode ? this.d.byFp(mode.fp) : this.d.bySlug(label), label, ip, !!mode);
    if (admitted instanceof Response) return admitted;
    const { record, conn } = admitted;
    const id = newRequestId(randomBytes);
    const method = req.method.toUpperCase();
    const headers = this.tunnelHeaders(req, ip, host, mode);
    const hasBody = !NO_BODY.has(method) && req.body !== null;
    const t0 = Date.now();
    const path = (mode ? mode.rest : url.pathname) + url.search;
    const done = (status: number | string) => this.d.log("info", `tunnel ${label} ${method} ${url.pathname.slice(0, 60)} → ${status} ${Date.now() - t0}ms`);

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
            const h = mode ? filterMachineResponseHeaders(forwardHeaders(res.headers), mode.prefix) : forwardHeaders(res.headers);
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
          this.d.log("info", `tunnel ${label} request body aborted: ${(e as Error).message}`);
          cancel();
          p.waiter!.fail("aborted", "request body aborted");
        });
    }
    return head;
  }
}
