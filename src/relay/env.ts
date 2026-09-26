/**
 * 中继运行配置只从环境变量来（systemd 的 Environment= 或仓库根 .env，Bun 自动读后者）。
 * RELAY_BASE 是公网主机名，front 靠它切子域名、实例靠它拼网页地址——没配就起不来，宁可报错也别把 slug 路由算错。
 */
import { LIMITS } from "../lib/relay-protocol.js";

export interface RelayEnv {
  port: number;
  hostname: string;
  base: string;
  db: string;
  trustProxy: boolean;
  maxFrameBytes: number;
  commit?: string;
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const num = (v: string | undefined, d: number): number => (v && Number.isFinite(Number(v)) ? Number(v) : d);

/** SQLite 落点：RELAY_DB 指定文件 > RELAY_DATA 目录下的 relay.sqlite > 仓库根 data/relay.sqlite */
function dbPathFromEnv(env: Record<string, string | undefined>): string {
  if (env.RELAY_DB) return env.RELAY_DB;
  if (env.RELAY_DATA) return `${env.RELAY_DATA.replace(/\/+$/, "")}/relay.sqlite`;
  return "data/relay.sqlite";
}

/** base 必须是合法主机名（小写、带点）；不是就抛，调用方决定怎么退出 */
export function relayEnv(env: Record<string, string | undefined> = process.env): RelayEnv {
  const base = (env.RELAY_BASE || "").trim().toLowerCase().replace(/\.+$/, "");
  if (!HOST_RE.test(base)) throw new Error("RELAY_BASE 必须是中继的公网主机名（如 relay.example.com），front 靠它区分子域名");
  return {
    port: num(env.RELAY_PORT, 8787),
    hostname: env.RELAY_HOST || "127.0.0.1",
    base,
    db: dbPathFromEnv(env),
    trustProxy: env.RELAY_TRUST_PROXY === "1",
    maxFrameBytes: num(env.RELAY_MAX_FRAME_BYTES, LIMITS.maxFrameBytes),
    commit: env.RELAY_COMMIT?.trim() || undefined,
  };
}
