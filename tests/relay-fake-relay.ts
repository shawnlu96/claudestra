/**
 * 测试用的极简中继（docs/relay/protocol.md 的服务端行为只取客户端测试需要的部分）：
 * hello / auth 验签 / welcome、contacts → peers、code 登记、ping → pong、按 to 转帧并盖 from。
 * 不带 to 的帖子（隧道响应）记进 received 供断言；sendTo 可以把任意帧塞给某个实例（模拟隧道请求、presence）。
 */
import type { ServerWebSocket } from "bun";
import { randomBytes } from "node:crypto";
import { PROTOCOL_VERSION, SUBPROTOCOL, keyFingerprint, parseFrame, verifyAuthSignature, type PeerRecord } from "../src/lib/relay-protocol.js";

export interface FakeRelayOptions {
  base?: string;
  /** auth 一律拒绝并回这个错误码（测致命退避） */
  rejectAuthWith?: string;
  /** 不回 pong（测心跳判死） */
  noPong?: boolean;
  /** contacts 帧的应答 */
  peersFor?: (fp: string, fps: string[]) => PeerRecord[];
  /** welcome 里的 slug 覆盖（模拟中继改名） */
  slug?: string;
}

interface Data { nonce: string; fp: string | null; slug: string }
type Conn = ServerWebSocket<Data>;

interface Received { fp: string; frame: Record<string, unknown> }

export interface FakeRelay {
  url: string;
  base: string;
  conns: Map<string, Conn>;
  received: Received[];
  authCount: number;
  sendTo(fp: string, frame: object): boolean;
  drop(fp: string, code?: number, reason?: string): boolean;
  dropAll(code?: number): void;
  waitFor(pred: (r: Received) => boolean, timeoutMs?: number): Promise<Received>;
  waitOnline(fp: string, timeoutMs?: number): Promise<void>;
  stop(): void;
}

export function startFakeRelay(opts: FakeRelayOptions = {}): FakeRelay {
  const base = opts.base ?? "relay.test";
  const conns = new Map<string, Conn>();
  const received: Received[] = [];
  const counters = { auth: 0 };
  const send = (ws: Conn, f: object) => {
    try {
      ws.send(JSON.stringify(f));
    } catch {
      // 对端已经关了：测试里断线本来就是预期动作，这一帧没人收
    }
  };
  const server = Bun.serve<Data>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const protos = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((s) => s.trim());
      if (!protos.includes(SUBPROTOCOL)) return new Response("subprotocol", { status: 426 });
      const data: Data = { nonce: randomBytes(32).toString("base64url"), fp: null, slug: "" };
      return srv.upgrade(req, { data, headers: { "Sec-WebSocket-Protocol": SUBPROTOCOL } }) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        send(ws, { t: "hello", v: PROTOCOL_VERSION, nonce: ws.data.nonce, ts: Math.floor(Date.now() / 1000), limits: {} });
      },
      message(ws, msg) {
        const f = parseFrame(String(msg));
        if (!f) return;
        if (f.t === "auth") {
          counters.auth++;
          if (opts.rejectAuthWith) {
            send(ws, { t: "error", code: opts.rejectAuthWith, origin: "relay" });
            return ws.close(4401, opts.rejectAuthWith);
          }
          const ok = verifyAuthSignature(String(f.key), ws.data.nonce, String(f.name), String(f.slug), String(f.sig));
          if (!ok) {
            send(ws, { t: "error", code: "auth_failed", origin: "relay" });
            return ws.close(4401, "auth_failed");
          }
          const fp = keyFingerprint(String(f.key));
          const prev = conns.get(fp);
          if (prev && prev !== ws) {
            send(prev, { t: "error", code: "replaced", origin: "relay" });
            prev.close(4409, "replaced");
          }
          ws.data.fp = fp;
          ws.data.slug = opts.slug ?? String(f.slug);
          conns.set(fp, ws);
          return send(ws, { t: "welcome", v: PROTOCOL_VERSION, fp, slug: ws.data.slug, name: f.name, base });
        }
        const fp = ws.data.fp;
        if (!fp) return;
        received.push({ fp, frame: f });
        if (f.t === "ping") return opts.noPong ? undefined : send(ws, { t: "pong", ts: f.ts });
        if (f.t === "contacts") return send(ws, { t: "peers", peers: opts.peersFor?.(fp, f.fps as string[]) ?? [] });
        if (typeof f.to === "string") {
          const target = conns.get(f.to);
          const { to: _to, ...rest } = f;
          if (!target) return send(ws, { t: "error", id: f.id, code: "peer_offline", message: `${f.to} not connected`, origin: "relay" });
          return send(target, { ...rest, from: fp });
        }
      },
      close(ws) {
        if (ws.data.fp && conns.get(ws.data.fp) === ws) conns.delete(ws.data.fp);
      },
    },
  });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    url: `ws://127.0.0.1:${server.port}/v1/ws`,
    base,
    conns,
    received,
    get authCount() {
      return counters.auth;
    },
    sendTo(fp, frame) {
      const ws = conns.get(fp);
      if (!ws) return false;
      send(ws, frame);
      return true;
    },
    drop(fp, code = 1012, reason = "restart") {
      const ws = conns.get(fp);
      if (!ws) return false;
      ws.close(code, reason);
      return true;
    },
    dropAll(code = 1012) {
      for (const ws of [...conns.values()]) ws.close(code, "restart");
    },
    async waitFor(pred, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      let seen = 0;
      while (Date.now() < deadline) {
        for (; seen < received.length; seen++) if (pred(received[seen])) return received[seen];
        await sleep(5);
      }
      throw new Error(`fake relay: no matching frame within ${timeoutMs} ms`);
    },
    async waitOnline(fp, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (conns.has(fp)) return;
        await sleep(5);
      }
      throw new Error(`fake relay: ${fp} not online within ${timeoutMs} ms`);
    },
    stop() {
      server.stop(true);
    },
  };
}
