/**
 * 沙箱 lab 模式的脚本侧（scripts/sandbox.ts `--lab` 调，docs/architecture/sandbox.md「Lab mode」）：lab 目录布局、端口分配、
 * 给沙箱环境加的 lab 键、起停 lab 中继、`--pair` 的自动互邀、假推送订阅。运行期的闸在 src/lib/sandbox-lab.ts。
 *
 * 布局：<lab>/a、<lab>/b 各是一个完整的沙箱根（自己的标记、状态、tmux），<lab>/lab 是中继与假推送的数据。
 * 端口从 --port N 往后排：A=N、B=N+1、A 的 peer 入口 N+2、B 的 N+3、lab 中继 N+4、假推送 N+5、假 APNs N+6。
 */
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  LAB_APNS_PORT_ENV, LAB_FLAG, LAB_MARKER, LAB_PORTS_ENV, LAB_PUSH_PORT_ENV, LAB_RELAY_PORT_ENV, LAB_ROOT_ENV, labProxyProblem,
} from "../src/lib/sandbox-lab.js";
import { canonicalPath } from "../src/lib/sandbox.js";
import { labFiles } from "./sandbox-lab-relay.ts";
import { newWebPushBrowserKeys } from "./lab-push-fakes.ts";

export type LabSide = "a" | "b";

export interface LabPlan {
  root: string;
  side: LabSide;
  pair: boolean;
  ports: { a: number; b: number; ingressA: number; ingressB: number; relay: number; push: number; apns: number };
}

/** lab 目录的标记（建 lab 时写）：记根、基准端口、有没有 B——之后的 manager / down 按它算环境，与 up 时一致 */
interface LabMarker { root: string; port: number; pair: boolean }

function readLabMarker(root: string): LabMarker | null {
  try {
    const m = JSON.parse(readFileSync(join(root, LAB_MARKER), "utf8")) as LabMarker;
    return m.root === canonicalPath(root) ? m : null;
  } catch {
    return null; // 没有 / 读不了：当作还没建（up 之前的检查会据此判断目录能不能用）
  }
}

/**
 * lab 的控制请求（就绪探测、lab-push 登记）由 sandbox.ts 进程自己 fetch，Bun 会让它们走环境代理：带任何代理变量就拒绝运行，
 * 不替用户剔（剔了 env，Bun 已缓存的代理仍在）。lab 子进程另外剔掉并在加载时再查一次
 */
export function refuseLabControlProxy(fail: (msg: string) => never): void {
  const problem = labProxyProblem(process.env);
  if (problem) fail(problem);
}

/** --lab 的参数 → 布局。up 以外的命令 pair 以 lab 标记为准（up 时带没带 --pair），不看这次的参数 */
export function labPlan(basePort: number, rootArg: string, side: LabSide, pairFlag: boolean, isUp: boolean): LabPlan {
  const root = rootArg ? resolve(rootArg) : `/tmp/claudestra-lab-${basePort}`;
  const marker = readLabMarker(root);
  const pair = isUp ? pairFlag : marker?.pair ?? pairFlag;
  const n = isUp || !marker ? basePort : marker.port;
  return { root, side, pair, ports: { a: n, b: n + 1, ingressA: n + 2, ingressB: n + 3, relay: n + 4, push: n + 5, apns: n + 6 } };
}

export const sidePort = (p: LabPlan, side: LabSide = p.side): number => (side === "a" ? p.ports.a : p.ports.b);
export const sideIngress = (p: LabPlan, side: LabSide = p.side): number => (side === "a" ? p.ports.ingressA : p.ports.ingressB);
export const sideRoot = (p: LabPlan, side: LabSide = p.side): string => join(p.root, side);
export const labSides = (p: LabPlan): LabSide[] => (p.pair ? ["a", "b"] : ["a"]);

/** lab 占的全部端口（up 前逐个查：不是生产端口、没被占） */
function labPorts(p: LabPlan): number[] {
  const o = p.ports;
  return [o.a, o.ingressA, ...(p.pair ? [o.b, o.ingressB] : []), o.relay, o.push, o.apns];
}

/** 加在沙箱环境上的 lab 键：中继地址、peer 入口、各实例端口的放行名单 */
export function labEnv(p: LabPlan): Record<string, string> {
  const allowed = labSides(p).flatMap((s) => [sidePort(p, s), sideIngress(p, s)]);
  return {
    [LAB_FLAG]: "1",
    [LAB_ROOT_ENV]: p.root,
    [LAB_RELAY_PORT_ENV]: String(p.ports.relay),
    [LAB_PUSH_PORT_ENV]: String(p.ports.push),
    [LAB_APNS_PORT_ENV]: String(p.ports.apns),
    [LAB_PORTS_ENV]: [...allowed, p.ports.relay].join(","),
    RELAY_URL: `ws://127.0.0.1:${p.ports.relay}`,
    RELAY_NAME: `lab-${p.side}`,
    PEER_INGRESS_PORT: String(sideIngress(p)),
    WEB_PORT: String(sidePort(p)), // 中继隧道打「网页端口」：lab 里就是本实例 bridge（--static 时它托管网页）
  };
}

/** 实例沙箱标记里的 lab 字段（lib/sandbox-lab.ts readLabInstances 按它认 peer） */
export function labMarkerFields(p: LabPlan): Record<string, unknown> {
  return { lab: canonicalPath(p.root), ingressPort: sideIngress(p) };
}

/** 建 lab 之前的检查：目录要么是空的 / 不存在，要么是本脚本建过的 lab；端口不是生产的 */
export function labUpProblems(p: LabPlan, denyPorts: number[], portFree: (n: number) => boolean): string[] {
  const out: string[] = [];
  if (existsSync(p.root) && readdirSync(p.root).length && !readLabMarker(p.root)) out.push(`${p.root} 已存在且不是 lab 目录，换一个 --root`);
  for (const n of labPorts(p)) {
    if (denyPorts.includes(n)) out.push(`端口 ${n} 是生产在用的端口（lab 用 --port 起的连续 7 个端口）`);
    else if (!portFree(n)) out.push(`端口 ${n} 已被占用；换一个 --port（lab 用连续 7 个端口）`);
  }
  return out;
}

export function writeLabMarker(p: LabPlan): void {
  const m: LabMarker = { root: canonicalPath(p.root), port: p.ports.a, pair: p.pair };
  writeFileSync(join(p.root, LAB_MARKER), JSON.stringify(m) + "\n");
}

export function labMarkerProblem(p: LabPlan): string | null {
  return readLabMarker(p.root) ? null : `${p.root} 没有 lab 标记（${LAB_MARKER}），不是本脚本建的 lab`;
}

// ── lab 中继进程 ─────────────────────────────────────────────────────────

function relayPid(p: LabPlan): number | null {
  try {
    const pid = Number(readFileSync(labFiles(p.root).pid, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 1) return null;
    const cmd = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]).stdout.toString();
    return cmd.includes("__lab-relay") ? pid : null; // pid 被复用成别的进程：不认，也就不会去杀它
  } catch {
    return null; // 没有 pid 文件 = 没在跑
  }
}

async function relayReady(p: LabPlan, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const ok = await fetch(`http://127.0.0.1:${p.ports.relay}/healthz`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
    if (ok) return true;
    await Bun.sleep(300);
  }
  return false;
}

/** 起 lab 中继（本脚本的 __lab-relay 子命令，环境与实例 A 相同外加 lab 键）；已在跑就不重起 */
export async function startLabRelay(p: LabPlan, spawn: () => number): Promise<string | null> {
  if (relayPid(p)) return null;
  spawn();
  return (await relayReady(p, 15_000)) ? null : `lab 中继 15 秒内没起来，看日志：${labFiles(p.root).log}`;
}

export async function stopLabRelay(p: LabPlan): Promise<void> {
  const pid = relayPid(p);
  if (!pid) return;
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 30 && relayPid(p); i++) await Bun.sleep(100);
  if (relayPid(p)) process.kill(pid, "SIGKILL");
  console.log(`🛑 lab 中继已停（pid ${pid}）`);
}

export const labRelayRunning = (p: LabPlan): boolean => relayPid(p) !== null;

// ── --pair：两边各建一个 stub agent，一次互邀覆盖两种传输 ──────────────────

export type ManagerCall = (side: LabSide, args: string[]) => { code: number; json: Record<string, unknown> | null; text: string };

export const LAB_AGENT = (side: LabSide): string => `lab-${side}`;

/**
 * A 连着 lab 中继、不带 --url 生成邀请（地址 = relay://<A 指纹>）；B 带 --url http://127.0.0.1:<B 的 peer 入口> 加入并反向开放。
 * 结果：B→A 经 lab 中继（relay://），A→B 走 http；两边都是带密钥的邀请，peer 整体加密（required）。
 * agent 用 Codex ACP stub（沙箱里固定是本仓的 scripts/acp-stub.ts，不连模型），带 --external（peer scope 只收 external）。
 */
export async function pairLab(p: LabPlan, manager: ManagerCall): Promise<string | null> {
  for (const side of ["a", "b"] as const) {
    const r = manager(side, ["create", LAB_AGENT(side), join(sideRoot(p, side), "work"), "lab stub", "--runtime", "codex", "--transport", "acp", "--external"]);
    if (r.code !== 0) return `建 ${LAB_AGENT(side)} 失败：${r.text.slice(0, 400)}`;
  }
  let invite: string | null = null;
  for (let i = 0; i < 40 && !invite; i++) {
    const r = manager("a", ["peer-invite-new", "--agents", LAB_AGENT("a")]);
    const url = String(r.json?.myUrl ?? "");
    if (r.json?.ok && url.startsWith("relay://")) invite = String(r.json.invite);
    else await Bun.sleep(500); // A 还没连上 lab 中继：邀请会因为探不到地址而失败，稍等再试
  }
  if (!invite) return "A 20 秒内没连上 lab 中继，生成不了 relay:// 邀请（看 a/bridge.log 与 lab/relay.log）";
  const url = `http://127.0.0.1:${sideIngress(p, "b")}`;
  for (let i = 0; i < 40; i++) {
    const r = manager("b", ["peer-join-auto", invite, "--agents", LAB_AGENT("b"), "--url", url]);
    if (r.json?.ok) return null;
    if (!/relay 未启用|not connected|未连接|offline/i.test(r.text)) return `B 加入失败：${r.text.slice(0, 400)}`;
    await Bun.sleep(500); // B 还没连上 lab 中继
  }
  return "B 20 秒内没连上 lab 中继，加入不了 A 的邀请";
}

// ── 假推送订阅 ───────────────────────────────────────────────────────────

/** 生成一个「浏览器」：私钥落在 lab 目录（假端点据此解密），返回要提交给 bridge 的订阅 */
function labPushSubscription(p: LabPlan): { endpoint: string; keys: { p256dh: string; auth: string } } {
  const id = randomBytes(8).toString("hex");
  const k = newWebPushBrowserKeys();
  writeFileSync(join(labFiles(p.root).subs, `${id}.json`), JSON.stringify(k) + "\n", { mode: 0o600 });
  return { endpoint: `https://127.0.0.1:${p.ports.push}/wp/${id}`, keys: { p256dh: k.raw, auth: k.auth } };
}

type Capture = (args: string[]) => { json: Record<string, unknown> | null; text: string };

/**
 * 给一个 lab 实例登记假 Web Push 订阅（私钥留在 lab 目录供假端点解密）和一台假 APNs 设备（64 位十六进制 token）。
 * 经 bridge 的真接口登记：订阅的 endpoint 过的是 lab 的推送闸（只认假端点）。返回错误说明，null = 成功
 */
export async function registerLabPush(p: LabPlan, port: number, manager: Capture): Promise<string | null> {
  const t = manager(["token-add", `lab-push-${Date.now()}`, "--agents", "*", "--force"]);
  const secret = t.json?.secret;
  if (typeof secret !== "string") return `发 token 失败：${t.text.slice(0, 300)}`;
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method, headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null };
  };
  const cfg = await api("GET", "/push/config");
  const vapidKey = (cfg.json?.webPush as { vapidPublicKey?: string } | null)?.vapidPublicKey;
  if (!vapidKey || cfg.json?.mode !== "relay") return `实例 ${p.side} 还没经 lab 中继拿到推送能力：${JSON.stringify(cfg.json)}`;
  const sub = await api("POST", "/push/subscriptions", { subscription: labPushSubscription(p), userAgent: "claudestra-lab", vapidKey });
  const dev = await api("POST", "/push/apns", { token: randomBytes(32).toString("hex"), device: "lab-device" });
  if (sub.status !== 200 || dev.status !== 200) return `登记失败：subscription ${sub.status} ${JSON.stringify(sub.json)}；apns ${dev.status} ${JSON.stringify(dev.json)}`;
  return null;
}

export const labDataDir = (p: LabPlan): string => labFiles(p.root).dir;
export const labRelayLog = (p: LabPlan): string => labFiles(p.root).log;
export const labSinkDir = (p: LabPlan): string => labFiles(p.root).sink;
