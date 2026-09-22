import http from "node:http";
import { PEER_HEADER } from "./client-ip";

/**
 * 给每个进来的 HTTP 请求盖上真实对端地址（PEER_HEADER），供登录限流判断「是不是来自
 * 本机反代」（见 client-ip.ts）。Next 的 Route Handler 拿不到 socket，只能在这里补。
 *
 * 做法是包一层 http.Server.prototype.emit 的 "request" 事件：原型级，所以不管 next start
 * 的 server 何时创建都生效；**总是覆盖**该头，客户端自己带的会被冲掉。任何异常都吞掉——
 * 这只是限流的输入，不能让它影响请求本身。
 */
const FLAG = Symbol.for("claudestra.peerStamp");

export function installPeerStamp(): void {
  const proto = http.Server.prototype as unknown as Record<symbol, unknown> & {
    emit: (this: unknown, ev: string | symbol, ...args: unknown[]) => boolean;
  };
  if (proto[FLAG]) return;
  const orig = proto.emit;
  proto.emit = function (this: unknown, ev: string | symbol, ...args: unknown[]) {
    if (ev === "request") {
      try {
        const req = args[0] as http.IncomingMessage;
        req.headers[PEER_HEADER] = req.socket?.remoteAddress ?? "";
      } catch {
        /* 盖不上就算了：client-ip 会退回 XFF 最右一项 */
      }
    }
    return orig.call(this, ev, ...args);
  };
  proto[FLAG] = true;
}
