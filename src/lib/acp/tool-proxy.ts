/**
 * ACP 宿主里给 channel-server 用的回环工具代理（T60，Shawn 定的问题 a）。acp 模式下频道在 bridge 上只登记一次、由宿主
 * 登记；reply 等工具仍由 Codex 起的 channel-server 提供（一行不改），它的 BRIDGE_URL 指到这里，请求经宿主那条连接转给
 * bridge——bridge 按 socket 认调用方，所以归属不变，也不会两个进程抢同一个频道。锁紧：
 * - 只绑 127.0.0.1 的随机端口；宿主生成一次性 token，写进 BRIDGE_URL 的查询参数（env_vars 白名单里本来就有 BRIDGE_URL），
 *   升级请求不带或带错一律 401，本机别的进程连不上来冒充这个 agent 调 reply；
 * - register 就地吞掉、回 registered（channel-server 据此标就绪、清排队），ping 就地回 pong，一概不往上转；
 * - 只转发 channel-server 现有的请求类型（PROXIED_TYPES），别的帧丢掉记日志；
 * - requestId 按连接改写再上送，回包按改写后的 id 找回原连接：Codex 的子线程会各起一个 channel-server，id 都从 req_1 数起。
 * - 调用方身份（T85）：bridge 把代理转上去的帧都算作宿主那条已验证的连接。token 在 BRIDGE_URL 里、Codex 的 shell 命令也继承得到，
 *   所以只有登记时没自报 outsideMcpLauncher 的连接才算 Codex 起的 MCP 服务，其余（含没登记就发请求的）转上去一律带 callerDowngraded。
 * tests/acp-tool-proxy.test.ts。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ServerWebSocket } from "bun";

/** channel-server 会发、且需要 bridge 回包的请求类型（src/channel-server.ts 的工具 + lib/agent-tool-calls.ts + lib/fleet-tool.ts） */
const PROXIED_TYPES = new Set([
  "reply",
  "fetch_messages",
  "react",
  "edit_message",
  "project_info",
  "list_channels",
  "forward_to_agent",
  "route_to_agent",
  "check_inbox",
  "fleet_state",
  "fleet_run",
  "whoami",
]);

interface Conn {
  id: number;
  /** 登记过、且不是 shell 起的（lib/whoami-tool.ts callerRegisterFields） */
  mcpLaunched?: boolean;
}

export interface ToolProxy {
  /** 给 channel-server 的 BRIDGE_URL（带 token） */
  readonly url: string;
  /** bridge 发给宿主的帧：是代理转上去的请求的回包就转回原连接并返回 true，否则返回 false（宿主自己处理） */
  onBridgeFrame(frame: Record<string, unknown>): boolean;
  /** 宿主和 bridge 的连接断了：在途的代理请求一律回错误，channel-server 那边不用干等 30s */
  failInFlight(reason: string): void;
  close(): void;
}

export interface ToolProxyDeps {
  channelId: string;
  /** 转给 bridge（宿主那条已登记的连接）；连接没好时返回 false，代理就地回错误 */
  toBridge(frame: Record<string, unknown>): boolean;
  log(msg: string): void;
  /** 单测指定端口；缺省 0 = 系统挑一个空闲端口 */
  port?: number;
}

function tokenOk(got: string | null, want: string): boolean {
  if (!got || got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

export function startToolProxy(deps: ToolProxyDeps): ToolProxy {
  const token = randomBytes(24).toString("hex");
  let nextConn = 0;
  /** 改写后的 requestId → [原连接, 原 requestId] */
  const inflight = new Map<string, { ws: ServerWebSocket<Conn>; orig: unknown }>();
  const send = (ws: ServerWebSocket<Conn>, frame: object) => {
    try {
      ws.send(JSON.stringify(frame));
    } catch (e) {
      deps.log(`工具代理：回帧失败（channel-server 已断开？）${e instanceof Error ? e.message : e}`);
    }
  };

  const onFrame = (ws: ServerWebSocket<Conn>, raw: string | Buffer) => {
    let m: Record<string, any>;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return deps.log("工具代理：丢掉一帧不是 JSON 的输入");
    }
    if (m?.type === "register") {
      ws.data.mcpLaunched = m.outsideMcpLauncher !== true;
      return send(ws, { type: "registered", channelId: deps.channelId });
    }
    if (m?.type === "ping") return send(ws, { type: "pong" });
    if (!PROXIED_TYPES.has(m?.type) || typeof m.requestId !== "string") return deps.log(`工具代理：不转发 ${String(m?.type)} 帧`);
    const upId = `acp${ws.data.id}_${m.requestId}`;
    inflight.set(upId, { ws, orig: m.requestId });
    const { callerCred: _cred, callerDowngraded: _down, ...frame } = m; // 身份字段只由代理决定，channel-server 自带的一概丢掉
    if (!deps.toBridge({ ...frame, requestId: upId, ...(ws.data.mcpLaunched ? {} : { callerDowngraded: true }) })) {
      inflight.delete(upId);
      send(ws, { type: "response", requestId: m.requestId, error: "宿主和 bridge 的连接还没好，稍后再试" });
    }
  };

  const server = Bun.serve<Conn>({
    hostname: "127.0.0.1",
    port: deps.port ?? 0,
    fetch(req, srv) {
      if (!tokenOk(new URL(req.url).searchParams.get("t"), token)) return new Response("unauthorized", { status: 401 });
      if (srv.upgrade(req, { data: { id: ++nextConn } })) return undefined;
      return new Response("websocket only", { status: 426 });
    },
    websocket: {
      message: onFrame,
      close(ws) {
        for (const [k, v] of inflight) if (v.ws === ws) inflight.delete(k);
      },
    },
  });

  return {
    url: `ws://127.0.0.1:${server.port}/?t=${token}`,
    onBridgeFrame(frame) {
      if (frame.type !== "response" || typeof frame.requestId !== "string") return false;
      const hit = inflight.get(frame.requestId);
      if (!hit) return false;
      inflight.delete(frame.requestId);
      send(hit.ws, { ...frame, requestId: hit.orig });
      return true;
    },
    failInFlight(reason) {
      for (const [k, v] of inflight) send(v.ws, { type: "response", requestId: v.orig, error: reason }), inflight.delete(k);
    },
    close() {
      server.stop(true);
    },
  };
}
