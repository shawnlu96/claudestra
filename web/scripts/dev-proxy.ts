/**
 * `npm run dev` 的入口：前端没有服务端了（静态导出），dev 页面要的 /api/v1 由本机 bridge 答。
 *   http://127.0.0.1:33333  ← 浏览器开这个
 *     /api/v1/*、/app-config.json、/local-probe → bridge（默认 http://127.0.0.1:3847，CLAUDESTRA_DEV_BRIDGE 可改）
 *     其余（页面、_next 资源、HMR websocket）       → next dev（127.0.0.1:33334，本脚本拉起）
 * 转给 bridge 时去掉 Origin、不加 X-Forwarded-For：在 bridge 看来就是本机同源页面，本机一键配对、本机打开目录都能用。
 * 所以代理**只绑 127.0.0.1**：绑到网卡上等于让局域网里的人冒充本机拿全权凭据。手机真机调试请 build 后走 bridge 直托管。
 * 额外参数原样交给 next dev（如 `npm run dev -- --webpack`）。
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";

const PORT = Number(process.env.WEB_DEV_PORT || 33333);
const NEXT_PORT = PORT + 1;
const BRIDGE = (process.env.CLAUDESTRA_DEV_BRIDGE || "http://127.0.0.1:3847").replace(/\/+$/, "");
const NEXT = `http://127.0.0.1:${NEXT_PORT}`;
const TO_BRIDGE = (path: string): boolean => path.startsWith("/api/v1/") || path === "/app-config.json" || path === "/local-probe";
const DROP = new Set(["host", "origin", "connection", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"]);

const next = spawn(join(import.meta.dir, "..", "node_modules", ".bin", "next"), ["dev", "-p", String(NEXT_PORT), "-H", "127.0.0.1", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "development" },
});
next.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => next.kill(sig));

function forwardHeaders(h: Headers): Headers {
  const out = new Headers();
  h.forEach((v, k) => {
    if (!DROP.has(k)) out.set(k, v);
  });
  return out;
}

interface Pipe {
  upstream: WebSocket | null;
  queue: (string | Buffer)[];
  target: string;
}

Bun.serve<Pipe>({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 0, // SSE（/events）与 HMR 都是长连接
  async fetch(req, server) {
    const url = new URL(req.url);
    const bridge = TO_BRIDGE(url.pathname);
    if (!bridge && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const target = `ws://127.0.0.1:${NEXT_PORT}${url.pathname}${url.search}`;
      return server.upgrade(req, { data: { upstream: null, queue: [], target } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    const base = bridge ? BRIDGE : NEXT;
    // decompress:false：原样转压缩过的字节——Bun 默认会解压却留着 content-encoding 头，浏览器再解一次就 ERR_CONTENT_DECODING_FAILED
    const init: RequestInit & { duplex?: "half"; decompress?: boolean } = { method: req.method, headers: forwardHeaders(req.headers), redirect: "manual", decompress: false };
    if (req.method !== "GET" && req.method !== "HEAD") Object.assign(init, { body: req.body, duplex: "half" });
    try {
      return await fetch(`${base}${url.pathname}${url.search}`, init);
    } catch (e) {
      return new Response(`dev proxy: ${bridge ? "bridge" : "next dev"} unreachable at ${base} (${(e as Error).message})`, { status: 502 });
    }
  },
  websocket: {
    open(ws: ServerWebSocket<Pipe>) {
      const up = new WebSocket(ws.data.target);
      up.binaryType = "arraybuffer";
      ws.data.upstream = up;
      up.onopen = () => {
        for (const m of ws.data.queue) up.send(m);
        ws.data.queue = [];
      };
      up.onmessage = (e) => ws.send(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer));
      up.onclose = () => ws.close();
      up.onerror = () => ws.close();
    },
    message(ws, msg) {
      const up = ws.data.upstream;
      if (up?.readyState === WebSocket.OPEN) up.send(msg);
      else ws.data.queue.push(msg);
    },
    close(ws) {
      ws.data.upstream?.close();
    },
  },
});
console.log(`dev: http://127.0.0.1:${PORT}  (next dev ${NEXT} · bridge ${BRIDGE})`);
