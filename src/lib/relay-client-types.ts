/**
 * 中继客户端（src/lib/relay-client.ts 及其出站 / 入站两个子模块）对外的类型与错误类。
 * 单独一个文件是为了让子模块与调用方（bridge/relay-link.ts）都能 import 而不形成环。
 */
import type { Headers } from "./relay-protocol.js";

export type RelayErrorOrigin = "relay" | "peer" | "client";

/** 中继 / 对方 / 本地客户端产生的错误；code 见 docs/relay/protocol.md §7 */
export class RelayError extends Error {
  constructor(
    readonly code: string,
    readonly origin: RelayErrorOrigin,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "RelayError";
  }
}

/** 出站请求：body 可以是整段字节，也可以是流（都会按块切成 data 帧） */
export interface RelayRequest {
  method: string;
  path: string;
  headers: Headers;
  body?: Uint8Array | ReadableStream<Uint8Array> | null;
}

/** 出站请求的响应：头一到就 resolve，正文从流里读 */
export interface RelayResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array>;
}

/** 入站请求：正文统一给流（小正文也是），处理方按需 collectBody */
export interface InboundRequest {
  method: string;
  path: string;
  headers: Headers;
  body: ReadableStream<Uint8Array>;
}

export interface InboundContext {
  /** 发起方指纹，隧道请求是 "relay" */
  from: string;
  /** 发起方取消 / 中继超时 / 断线时触发 */
  signal: AbortSignal;
}

export interface InboundResponse {
  status: number;
  headers: Headers;
  body: Uint8Array | ReadableStream<Uint8Array> | null;
}

/** 处理方抛 RelayError 时其 code 会原样送回发起方（peer 路径）；其他异常按 local_unreachable */
export type InboundHandler = (req: InboundRequest, ctx: InboundContext) => Promise<InboundResponse>;

export type RelayState = "connecting" | "online" | "offline" | "closed";

export interface RelayInfo {
  state: RelayState;
  connected: boolean;
  fp: string | null;
  slug: string | null;
  base: string | null;
  relayUrl: string;
}

/** bridge 对外（GET /relay/status、manager）报的中继链路状态；bridge/relay-link.ts 生产，manager/relay.ts 消费 */
export interface RelayLinkInfo {
  /** .env 配了 RELAY_URL */
  enabled: boolean;
  connected: boolean;
  state: RelayState | null;
  fp: string | null;
  slug: string | null;
  base: string | null;
  /** 这台机器的网页地址 https://<slug>.<base>；没连上是 null */
  url: string | null;
  relayUrl: string | null;
  retryAt: number | null;
  lastError: string | null;
}
