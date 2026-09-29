/**
 * 给 peer 专用入口（bridge/peer-ingress.ts）定端口、决定怎么对外：
 *   - 「peer 走 HTTPS」：setup 的 HTTPS 步骤、用户同意配置 serve 后，让 tailscale serve 把 /api/v1 转到它；
 *   - 「直连」：生成邀请时没有 HTTPS 入口、主端口又只听本机，就让它自己对外（openDirectPeerIngress）。
 * 升级本身绝不走到这里：都要用户做了对应的动作才写 .env。
 *
 * 端口为什么写死进 .env 而不是每次按「bridge 端口 + 1」算：反代规则指着的是具体端口，
 * BRIDGE_PORT 以后再改（自定义端口的人改过不止一次），算出来的端口就漂了，peer 悄悄断掉。
 */
import { existsSync, readFileSync } from "fs";
import { readFile } from "fs/promises";
import { REPO_ROOT } from "./repo-root.js";
import { mergeEnvContent, parseEnvRaw } from "./env-file.js";
import { listListeners, runCli, tcpOpen } from "./tailscale.js";
import { detectBridgeUrls } from "./net-addr.js";
import { bridgeHttpBase } from "./bridge-port.js";
import { probeBridgeApi } from "./peer-url.js";
import { assertNoRepoEnvWriteInTest } from "./test-guard.js";
import { writeTextAtomicSync } from "./state-file.js";
import { repoEnvVar } from "./env-file.js";
import { webPortFromStartScript } from "./cli-install.js";

const ENV_HEADER = "# Claudestra 运行时配置 (由 bun run setup 生成)";

/**
 * 整份 .env 原子替换（tmp + rename，保留原权限；新建时 0600——里面有 bot token）：原地 writeFile 中途失败会留下
 * 截断的 .env，bridge 下次启动就少了一半配置。测试里写仓库根的 .env 直接报错
 */
export function saveEnvText(envPath: string, text: string): void {
  assertNoRepoEnvWriteInTest(envPath);
  writeTextAtomicSync(envPath, text, { preserveMode: true, mode: 0o600 });
}

/** .env 补 / 改几个键（其余原文逐字节不动） */
export async function writeEnvKeys(updates: Record<string, string>, envPath = `${REPO_ROOT}/.env`): Promise<void> {
  const text = existsSync(envPath) ? await readFile(envPath, "utf8") : null;
  saveEnvText(envPath, mergeEnvContent(text, updates, ENV_HEADER));
}

/** 同一个 serve 端口上把 /api/v1 挂到 peer 入口（serve 剥不剥挂载前缀，入口都认） */
function servePeerArgs(httpsPort: number, ingressPort: number): string[] {
  return ["serve", "--bg", `--https=${httpsPort}`, "--set-path", "/api/v1", `http://127.0.0.1:${ingressPort}`];
}

/** Web 的端口：WEB_PORT 显式配置 > web/package.json 的 start 脚本 > 默认（中继隧道打它，peer 入口要避开它） */
export function resolveWebPort(): number {
  const env = Number(repoEnvVar("WEB_PORT"));
  if (Number.isInteger(env) && env > 0) return env;
  try {
    const pkg = JSON.parse(readFileSync(`${REPO_ROOT}/web/package.json`, "utf8")) as { scripts?: { start?: string } };
    return webPortFromStartScript(pkg.scripts?.start);
  } catch {
    return webPortFromStartScript(undefined); // web 没装：用默认端口，隧道请求会得到 local_unreachable，日志里看得到
  }
}

/** 从 bridge 端口 + 1 往后找第一个空闲、且不是网页端口的（纯函数，tests/peer-ingress.test.ts） */
export function pickIngressPort(bridgePort: number, busy: (p: number) => boolean, webPort?: number): number | null {
  for (let p = bridgePort + 1; p <= bridgePort + 10; p++) if (p !== webPort && !busy(p)) return p;
  return null;
}

/**
 * 端口占没占（纯函数，tests/peer-ingress.test.ts）：lsof 看得到就以它为准；lsof 不可用（launchd 的 PATH 常没有
 * /usr/sbin）就退回连接探测——能连上就是有人在听。以前 lsof 不可用一律按「占用」算，结果 10 个端口全被判满、入口开不出来。
 */
export function portBusy(listeners: { command: string; addr: string }[] | null, tcpConnected: boolean): boolean {
  return listeners ? listeners.length > 0 : tcpConnected;
}

/** .env 已配就沿用；否则挑一个空闲、不是网页端口的写进去（入口把回环来的请求当本机反代，中继隧道打的网页端口不能是它） */
export async function ensurePeerIngressPort(bridgePort: number, webPort?: number, envPath = `${REPO_ROOT}/.env`): Promise<number | null> {
  const text = existsSync(envPath) ? await readFile(envPath, "utf8") : null;
  const cur = Number(parseEnvRaw(text ?? "").PEER_INGRESS_PORT || "");
  if (Number.isInteger(cur) && cur > 0) return cur;
  const busy = new Set<number>();
  let lsofMissing = false;
  for (let p = bridgePort + 1; p <= bridgePort + 10; p++) {
    const l = await listListeners(p);
    if (l === null) lsofMissing = true;
    if (portBusy(l, l === null ? await tcpOpen("127.0.0.1", p, 800) : false)) busy.add(p);
  }
  if (lsofMissing) console.warn("⚠️ lsof 跑不起来（PATH 里没有 /usr/sbin？），peer 入口端口改用连接探测判断占用");
  const port = pickIngressPort(bridgePort, (p) => busy.has(p), webPort);
  if (port) saveEnvText(envPath, mergeEnvContent(text, { PEER_INGRESS_PORT: String(port) }, ENV_HEADER));
  return port;
}

/**
 * 没有 HTTPS 入口、bridge 主端口又只听本机（默认）时，邀请改写 peer 专用端口的直连地址：.env 标
 * PEER_INGRESS_PUBLIC=1，bridge 把专用入口从 127.0.0.1 换到 0.0.0.0（有 peer token 时才对外，见
 * bridge/peer-ingress.ts syncPeerIngress）。对外的只有「peer token + 兑换邀请」，主端口照旧只听本机。
 * null = 开不出来（附近端口全占 / 没有对外网卡），调用方退回 bridge 端口地址 + 只听本机的警告。
 */
export async function openDirectPeerIngress(bridgePort: number, envPath = `${REPO_ROOT}/.env`): Promise<{ url: string; note: string } | null> {
  const port = await ensurePeerIngressPort(bridgePort, resolveWebPort(), envPath);
  const best = port ? detectBridgeUrls(port)[0] : undefined;
  if (!best) return null;
  const text = existsSync(envPath) ? await readFile(envPath, "utf8") : null;
  if (parseEnvRaw(text ?? "").PEER_INGRESS_PUBLIC !== "1") saveEnvText(envPath, mergeEnvContent(text, { PEER_INGRESS_PUBLIC: "1" }, ENV_HEADER));
  // hold：邀请的 token 还没签出来，先让 bridge 别因「还没有 peer」又把入口收回本机
  const synced = await fetch(`${bridgeHttpBase()}/peer-ingress/sync`, { method: "POST", body: '{"hold":true}', signal: AbortSignal.timeout(5000) })
    .then((r) => r.ok)
    .catch(() => false); // bridge 没在跑：地址照写（它起来就会按 .env 开），提示里说明
  const ok = synced && (await probeBridgeApi(best.url));
  const lan = best.kind === "lan" ? "；这是内网地址，只在同一局域网可达" : "";
  return {
    url: best.url,
    note: ok
      ? `用 peer 专用端口 ${best.url}（只收 peer token；bridge 主端口仍只听本机）${lan}`
      : `⚠️ peer 专用端口 ${best.url} 本机实测不通${synced ? "" : "（bridge 没响应）"}——对方多半也连不上，先跑 doctor 看 bridge${lan}`,
  };
}

type T = (zh: string, en: string) => string;

/** setup 用：定端口 + 挂 serve 路径，返回一行给用户看的结果（失败不影响网页入口，peer 退回 bridge 端口地址） */
export async function setupPeerHttps(t: T, cli: string, httpsPort: number, bridgePort: number, webPort: number): Promise<string> {
  const port = await ensurePeerIngressPort(bridgePort, webPort);
  if (!port) return t(`peer 的 HTTPS 入口没开：${bridgePort + 1}–${bridgePort + 10} 端口都被占用`, `Peer HTTPS entry skipped: ports ${bridgePort + 1}–${bridgePort + 10} are all in use`);
  const r = await runCli(cli, servePeerArgs(httpsPort, port), 20_000);
  return r.code === 0
    ? t(`peer 也走这个 HTTPS 入口（/api/v1 → 本机 ${port}），bridge 端口不必对外开放`, `Peers use this HTTPS entry too (/api/v1 → local ${port}); the bridge port stays closed`)
    : t(`peer 的 HTTPS 路径没挂上：${(r.err || r.out).trim().slice(0, 160)}`, `Couldn't add the peer HTTPS path: ${(r.err || r.out).trim().slice(0, 160)}`);
}
