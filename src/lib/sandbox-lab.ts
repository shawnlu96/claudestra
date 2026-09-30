/**
 * 沙箱的「实验室」模式（`bun run sandbox up --lab`，docs/architecture/sandbox.md）：在沙箱之上只多开三样——本机回环上的
 * lab 中继、同一个 lab 目录下沙箱实例之间的 peer、落盘的假推送端点。每一样都由这里的纯函数判「是不是 lab 自己的」，
 * 不是就拒；判不了（配置缺、写法怪）一律当作不是。
 *
 * lab 开关只在沙箱开着时有意义：只设 lab 不设沙箱直接抛错——那等于带着 lab 意图跑生产。
 * 本文件只依赖 node: 模块：lib/sandbox.ts 单向 import 它（反过来会成环）。
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";

export const LAB_FLAG = "CLAUDESTRA_SANDBOX_LAB";
/** lab 目录：下面是各实例的沙箱根（a/ b/）与 lab 自己的中继 / 假推送数据（lab/） */
export const LAB_ROOT_ENV = "CLAUDESTRA_LAB_ROOT";
export const LAB_RELAY_PORT_ENV = "CLAUDESTRA_LAB_RELAY_PORT";
/** 假推送端点：Web Push（HTTP/1.1）与假 APNs（h2）各一个端口，只有 lab 中继进程连它们（scripts/sandbox-lab-relay.ts） */
export const LAB_PUSH_PORT_ENV = "CLAUDESTRA_LAB_PUSH_PORT";
export const LAB_APNS_PORT_ENV = "CLAUDESTRA_LAB_APNS_PORT";
/** lab 的实例端口：各实例的 bridge 与 peer 入口、lab 中继（peer 地址只认实例端口，见 readLabInstances） */
export const LAB_PORTS_ENV = "CLAUDESTRA_LAB_PORTS";
/** lab 目录里的标记文件（scripts/sandbox-lab.ts 建），down / clean 靠它认目录 */
export const LAB_MARKER = ".claudestra-lab";

type Env = Record<string, string | undefined>;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** 只认 1（开）与空 / 0（关）；开 lab 必须同时开沙箱（CLAUDESTRA_SANDBOX=1），否则抛错 */
export function isLab(env: Env): boolean {
  const v = (env[LAB_FLAG] || "").trim();
  if (v === "" || v === "0") return false;
  if (v !== "1") throw new Error(`${LAB_FLAG}=${v} 不认识：开 lab 写 1，关掉就不设`);
  if ((env.CLAUDESTRA_SANDBOX || "").trim() !== "1") throw new Error(`${LAB_FLAG}=1 只能和 CLAUDESTRA_SANDBOX=1 一起用（lab 是沙箱的一种）`);
  return true;
}

function port(v: string | undefined): number | null {
  const n = Number((v || "").trim());
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

function portOf(u: URL): number {
  if (u.port) return Number(u.port);
  return u.protocol === "https:" || u.protocol === "wss:" ? 443 : 80;
}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p); // 还不存在（up 之前的检查）：按字面比，lab 目录由脚本建在它自己算出的路径上
  }
}

/** lab 的实例端口（bridge、peer 入口、lab 中继）；非 lab 为空 */
export function labInstancePortsOf(env: Env): number[] {
  return isLab(env) ? labInstancePorts(env) : [];
}

function labInstancePorts(env: Env): number[] {
  return (env[LAB_PORTS_ENV] || "").split(",").map((s) => port(s)).filter((n): n is number => n !== null);
}

/**
 * lab 里出站可以连的端口（出站闸门放行名单的 lab 部分）：实例端口 + 假推送的两个端口。假推送端点是 lab 自己起的替身，
 * 谁连都无害；lab 中继进程与 bridge 共用这份名单（中继也在沙箱环境里跑）。非 lab 为空
 */
export function labOutboundPorts(env: Env): number[] {
  if (!isLab(env)) return [];
  return [...labInstancePorts(env), ...[port(env[LAB_PUSH_PORT_ENV]), port(env[LAB_APNS_PORT_ENV])].filter((n): n is number => n !== null)];
}

/** lab 中继的唯一合法地址 */
export function labRelayUrl(env: Env): string | null {
  const p = port(env[LAB_RELAY_PORT_ENV]);
  return p ? `ws://127.0.0.1:${p}` : null;
}

/**
 * lab 配置自洽：lab 目录是绝对路径、本实例的沙箱根就在它下面一层；各端口合法、互不重复、都不是生产端口；
 * 中继端口在实例端口名单里。沙箱进程加载时经 lib/sandbox.ts 调。
 * bridgePort 是这个进程连的 bridge 地址的端口，不要求在名单里：ACP 宿主给 channel-server 的是它自己的回环代理端口
 * （lib/acp/adapter-proc.ts）；这个端口是不是生产端口由 sandboxBridgeUrlProblem 另查。
 */
export function labConfigProblems(env: Env, bridgePort: number, denyPorts: number[]): string[] {
  if (!isLab(env)) return [];
  const out: string[] = [];
  const root = (env[LAB_ROOT_ENV] || "").trim();
  if (!root || !isAbsolute(root)) out.push(`${LAB_ROOT_ENV} 要是绝对路径（收到 ${root || "空"}）`);
  const sbx = (env.CLAUDESTRA_SANDBOX_ROOT || "").trim();
  if (root && sbx && canonical(dirname(resolve(sbx))) !== canonical(root)) out.push(`沙箱根 ${sbx} 不在 lab 目录 ${root} 下一层`);
  const relay = port(env[LAB_RELAY_PORT_ENV]);
  const push = [port(env[LAB_PUSH_PORT_ENV]), port(env[LAB_APNS_PORT_ENV])];
  if (!relay) out.push(`${LAB_RELAY_PORT_ENV} 没设或不合法`);
  if (push.some((p) => p === null)) out.push(`${LAB_PUSH_PORT_ENV} / ${LAB_APNS_PORT_ENV} 没设或不合法`);
  const raw = (env[LAB_PORTS_ENV] || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ports = raw.map((s) => port(s));
  if (!raw.length || ports.some((p) => p === null)) out.push(`${LAB_PORTS_ENV} 没设或有不合法的端口`);
  const all = [...ports, ...push].filter((p): p is number => p !== null);
  if (new Set(all).size !== all.length) out.push(`lab 端口有重复（${all.join(", ")}）`);
  const prod = all.filter((p) => denyPorts.includes(p));
  if (prod.length) out.push(`lab 端口 ${prod.join(", ")} 是生产端口`);
  if (relay && !ports.includes(relay)) out.push(`lab 中继端口 ${relay} 不在 ${LAB_PORTS_ENV} 里`);
  if (relay && relay === bridgePort) out.push("lab 中继端口与 bridge 端口相同");
  return out;
}

/** RELAY_URL 必须逐字等于 lab 中继地址（回环 + lab 中继端口 + ws）；生产中继、别的写法一律拒 */
export function labRelayUrlProblem(url: string, env: Env): string | null {
  const want = labRelayUrl(env);
  if (!want) return `没有 lab 中继（${LAB_RELAY_PORT_ENV} 没设），中继地址 ${url} 一律拒绝`;
  return url.trim() === want ? null : `中继地址 ${url} 不是 lab 中继 ${want}`;
}

/** 推送订阅的 endpoint 只许是 lab 假推送端点（https://127.0.0.1:<假推送端口>/…，不带用户名密码） */
export function labPushEndpointProblem(endpoint: string, env: Env): string | null {
  const p = port(env[LAB_PUSH_PORT_ENV]);
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return `推送 endpoint ${endpoint} 不是合法 URL`;
  }
  if (!p) return `没有 lab 假推送端点（${LAB_PUSH_PORT_ENV} 没设）`;
  const ok = u.protocol === "https:" && u.hostname === "127.0.0.1" && portOf(u) === p && !u.username && !u.password;
  return ok ? null : `推送 endpoint ${u.origin} 不是 lab 假推送端点 https://127.0.0.1:${p}`;
}

/** lab 目录下的一个沙箱实例（它自己的沙箱标记里记的） */
export interface LabInstance {
  root: string;
  ports: number[];
}

/**
 * 读 lab 目录下各实例的沙箱标记：标记记的根就是它所在目录、记的 lab 就是这个 lab 目录，才算 lab 的实例。
 * 标记由 scripts/sandbox-lab.ts 建（port = bridge、ingressPort = peer 入口）。
 */
export function readLabInstances(labRoot: string, marker: string): LabInstance[] {
  const lab = canonical(labRoot);
  const out: LabInstance[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(lab);
  } catch {
    return out; // lab 目录读不了：没有实例 = 一律拒
  }
  for (const n of names) {
    const f = join(lab, n, marker);
    if (!existsSync(f)) continue;
    try {
      const m = JSON.parse(readFileSync(f, "utf8")) as { root?: string; lab?: string; port?: number; ingressPort?: number };
      if (m.root !== canonical(join(lab, n)) || m.lab !== lab) continue;
      out.push({ root: m.root, ports: [m.port, m.ingressPort].filter((x): x is number => Number.isInteger(x) && (x as number) > 0) });
    } catch {
      /* 坏标记：不算 lab 实例，指向它的 peer 被拒 */
    }
  }
  return out;
}

/**
 * peer 地址只能落在 lab 实例上（纯函数）：http(s) 要回环 + 某个 lab 实例的 bridge / peer 入口端口，不带用户名密码；
 * relay://<指纹> 放行——它只能经本实例连着的中继走，而中继地址已被 labRelayUrlProblem 钉死在 lab 中继上。
 */
export function labPeerUrlProblem(url: string, instances: LabInstance[]): string | null {
  if (url.startsWith("relay://")) return null; // 大小写不同的写法不认：peerFetch 只按小写前缀走中继
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `peer 地址 ${url} 不是合法 URL`;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return `peer 地址 ${url} 不是 http(s) / relay://`;
  if (!LOOPBACK.has(u.hostname) || u.username || u.password) return `peer 地址 ${u.origin} 不在本机回环上（lab 只许同一 lab 目录下的沙箱实例互连）`;
  const hit = instances.some((i) => i.ports.includes(portOf(u)));
  return hit ? null : `peer 地址 ${u.origin} 不是本 lab 目录下任何沙箱实例的端口`;
}
