/**
 * 中继运行配置只从环境变量来（systemd 的 Environment= 或仓库根 .env，Bun 自动读后者）。
 * RELAY_BASE 是公网主机名，front 靠它切子域名、实例靠它拼网页地址——没配就起不来，宁可报错也别把 slug 路由算错。
 * commit 号：RELAY_COMMIT 没设就读仓库根 .relay-commit（deploy/relay/deploy.sh 每次部署写入），/healthz 带出去，
 * 才能一眼核对线上跑的是哪一版；两处都没有就不带，healthz 照常。
 */
import { readFileSync } from "node:fs";
import { apnsConfigFromEnv, type ApnsConfig } from "../lib/apns.js";
import { LIMITS } from "../lib/relay-protocol.js";
import { REPO_ROOT } from "../lib/repo-root.js";

export interface RelayEnv {
  port: number;
  hostname: string;
  base: string;
  db: string;
  /** RELAY_TRUST_PROXY：受信反代层数，0 = 不在反代之后 */
  trustProxy: number;
  maxFrameBytes: number;
  commit?: string;
  /** RELAY_STATIC_DIR：前端静态导出目录（web/out）；没配就不托管前端 */
  staticDir?: string;
  /** RELAY_VAPID_KEYS：VAPID 密钥对文件；默认与 SQLite 同目录的 vapid.json，缺文件首次启动生成（src/relay.ts） */
  vapidKeysPath: string;
  /** RELAY_VAPID_SUBJECT：默认 mailto:relay@<base>（Apple 校验它必须是合法 mailto / https） */
  vapidSubject: string;
  /** RELAY_APNS_*（KEY_PATH / KEY_ID / TEAM_ID / TOPIC / ENV）：全给了才开 APNs；apnsWhy 说明为什么没开 */
  apns?: ApnsConfig;
  apnsWhy?: string;
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/;
const COMMIT_FILE = ".relay-commit";

const num = (v: string | undefined, d: number): number => (v && Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * RELAY_TRUST_PROXY：受信反代层数 0–5（旧写法 "1" 即一层）；空、认不出、超过 5 的一律 0，不看转发头。
 * 必须等于实际层数：配多了 XFF 项数不够，只能退回连接对端（限流偏严）；上限挡住 "99" 这种手滑。
 */
const proxyHops = (v: string | undefined): number => (v && /^[0-5]$/.test(v.trim()) ? Number(v.trim()) : 0);

/** 数据目录：RELAY_DATA > 仓库根 data；SQLite 与 VAPID 密钥文件都落在这里 */
const dataDirFromEnv = (env: Record<string, string | undefined>): string => (env.RELAY_DATA ? env.RELAY_DATA.replace(/\/+$/, "") : "data");

/** SQLite 落点：RELAY_DB 指定文件 > 数据目录下的 relay.sqlite */
function dbPathFromEnv(env: Record<string, string | undefined>): string {
  return env.RELAY_DB || `${dataDirFromEnv(env)}/relay.sqlite`;
}

/** 仓库根 .relay-commit 的一行短 sha；没有文件或内容不像 sha 都算没有 */
export function commitFromFile(read: (path: string) => string = (p) => readFileSync(p, "utf8")): string | undefined {
  let raw: string;
  try {
    raw = read(`${REPO_ROOT}/${COMMIT_FILE}`);
  } catch {
    return undefined; // 没部署脚本写过这个文件（本地开发、手工 rsync）：healthz 不带 commit 即可
  }
  const s = raw.trim().toLowerCase();
  return COMMIT_RE.test(s) ? s : undefined;
}

/** base 必须是合法主机名（小写、带点）；不是就抛，调用方决定怎么退出 */
export function relayEnv(env: Record<string, string | undefined> = process.env, readCommit: () => string | undefined = commitFromFile): RelayEnv {
  const base = (env.RELAY_BASE || "").trim().toLowerCase().replace(/\.+$/, "");
  if (!HOST_RE.test(base)) throw new Error("RELAY_BASE 必须是中继的公网主机名（如 relay.example.com），front 靠它区分子域名");
  const apns = apnsConfigFromEnv((k) => env[k], { prefix: "RELAY_APNS_" });
  return {
    port: num(env.RELAY_PORT, 8787),
    hostname: env.RELAY_HOST || "127.0.0.1",
    base,
    db: dbPathFromEnv(env),
    trustProxy: proxyHops(env.RELAY_TRUST_PROXY),
    maxFrameBytes: num(env.RELAY_MAX_FRAME_BYTES, LIMITS.maxFrameBytes),
    commit: env.RELAY_COMMIT?.trim() || readCommit(),
    ...(env.RELAY_STATIC_DIR?.trim() ? { staticDir: env.RELAY_STATIC_DIR.trim() } : {}),
    vapidKeysPath: env.RELAY_VAPID_KEYS?.trim() || `${dataDirFromEnv(env)}/vapid.json`,
    vapidSubject: env.RELAY_VAPID_SUBJECT?.trim() || `mailto:relay@${base}`,
    ...(apns.config ? { apns: apns.config } : { apnsWhy: apns.why }),
  };
}
