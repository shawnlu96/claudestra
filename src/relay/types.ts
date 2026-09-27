/**
 * 中继服务端的公共类型（从 server.ts 搬出：server.ts 卡在 400 行上限，front.ts / push.ts / 测试都要这些类型，
 * 放这里谁都能 import 而不把 server.ts 拖进环）。运行时代码仍在 server.ts。
 */
import type { ServerWebSocket } from "bun";
import type { LIMITS } from "../lib/relay-protocol.js";
import type { Directory } from "./directory.js";
import type { SlidingWindow } from "./limiter.js";
import type { PushGatewayOptions } from "./push.js";

export type Logger = (level: "info" | "warn" | "error", msg: string) => void;
export type Limits = Record<keyof typeof LIMITS, number>; // 协议默认值可按项覆盖（测试把超时调短）

export interface RelayOptions {
  /** 公网主机名：front 按它切子域名 */
  base: string;
  port?: number;
  hostname?: string;
  /** SQLite 路径；测试用 ":memory:" */
  db?: string;
  /** 反代之后才开：用 X-Forwarded-* 当客户端地址与主机名。直接对外时开了等于限流可绕 */
  trustProxy?: boolean;
  version?: string;
  commit?: string;
  limits?: Partial<Limits>;
  /** 隧道请求等响应头的时长（浏览器那边的 API 调用可能长挂） */
  frontHeadTimeoutMs?: number;
  /** 前端静态导出目录；配了 front 就在 base 主机名下托管它 */
  staticDir?: string;
  /** 推送网关（§3.5）：VAPID 身份 / APNs 凭据；没配就不做 Web Push / APNs，push 帧一律回 unavailable */
  push?: PushGatewayOptions;
  sweepMs?: number;
  touchEveryMs?: number;
  log?: Logger;
}

export interface ConnData {
  ip: string;
  openedAt: number;
  lastFrameAt: number;
  lastTouch: number;
  /** 发过 hello、还没收到 auth 时非空；auth 一到就清，成败都不再接受第二次（nonce 一次性） */
  nonce: string | null;
  fp: string | null;
  key: string | null;
  slug: string;
  name: string;
  contacts: Set<string>;
  reqWindow: SlidingWindow;
  badFrames: number;
}
export type Conn = ServerWebSocket<ConnData>;

export interface Relay {
  port: number;
  directory: Directory;
  online(): string[];
  dropConnection(fp: string, code?: number, reason?: string): boolean; // 测试用：模拟中继重启 / 网络抖动
  stop(): void;
}
