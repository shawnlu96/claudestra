/**
 * 给 peer 专用入口（bridge/peer-ingress.ts）定端口、决定怎么对外：
 *   - 「peer 走 HTTPS」：setup 的 HTTPS 步骤、用户同意配置 serve 后，让 tailscale serve 把 /api/v1 转到它；
 *   - 「直连」：生成邀请时没有 HTTPS 入口、主端口又只听本机，就让它自己对外（openDirectPeerIngress）。
 * 升级本身绝不走到这里：都要用户做了对应的动作才写 .env。
 *
 * 端口为什么写死进 .env 而不是每次按「bridge 端口 + 1」算：反代规则指着的是具体端口，
 * BRIDGE_PORT 以后再改（自定义端口的人改过不止一次），算出来的端口就漂了，peer 悄悄断掉。
 */
import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { REPO_ROOT } from "./repo-root.js";
import { mergeEnvContent, parseEnvRaw } from "./env-file.js";
import { listListeners, runCli } from "./tailscale.js";
import { detectBridgeUrls } from "./net-addr.js";
import { bridgeHttpBase } from "./bridge-port.js";
import { probeBridgeApi } from "./peer-url.js";

const ENV_HEADER = "# Claudestra 运行时配置 (由 bun run setup 生成)";

/** 同一个 serve 端口上把 /api/v1 挂到 peer 入口（serve 剥不剥挂载前缀，入口都认） */
function servePeerArgs(httpsPort: number, ingressPort: number): string[] {
  return ["serve", "--bg", `--https=${httpsPort}`, "--set-path", "/api/v1", `http://127.0.0.1:${ingressPort}`];
}

/** 从 bridge 端口 + 1 往后找第一个空闲、且不是网页端口的（纯函数，tests/peer-ingress.test.ts） */
export function pickIngressPort(bridgePort: number, busy: (p: number) => boolean, webPort?: number): number | null {
  for (let p = bridgePort + 1; p <= bridgePort + 10; p++) if (p !== webPort && !busy(p)) return p;
  return null;
}

/** .env 已配就沿用；否则挑一个空闲端口写进去。lsof 失败按「占用」算，宁可不开也不抢别人的端口 */
async function ensurePeerIngressPort(bridgePort: number, webPort?: number, envPath = `${REPO_ROOT}/.env`): Promise<number | null> {
  const text = existsSync(envPath) ? await readFile(envPath, "utf8") : null;
  const cur = Number(parseEnvRaw(text ?? "").PEER_INGRESS_PORT || "");
  if (Number.isInteger(cur) && cur > 0) return cur;
  const busy = new Set<number>();
  for (let p = bridgePort + 1; p <= bridgePort + 10; p++) {
    const l = await listListeners(p);
    if (l === null || l.length) busy.add(p);
  }
  const port = pickIngressPort(bridgePort, (p) => busy.has(p), webPort);
  if (port) await writeFile(envPath, mergeEnvContent(text, { PEER_INGRESS_PORT: String(port) }, ENV_HEADER));
  return port;
}

/**
 * 没有 HTTPS 入口、bridge 主端口又只听本机（默认）时，邀请改写 peer 专用端口的直连地址：.env 标
 * PEER_INGRESS_PUBLIC=1，bridge 把专用入口从 127.0.0.1 换到 0.0.0.0（有 peer token 时才对外，见
 * bridge/peer-ingress.ts syncPeerIngress）。对外的只有「peer token + 兑换邀请」，主端口照旧只听本机。
 * null = 开不出来（附近端口全占 / 没有对外网卡），调用方退回 bridge 端口地址 + 只听本机的警告。
 */
export async function openDirectPeerIngress(bridgePort: number, envPath = `${REPO_ROOT}/.env`): Promise<{ url: string; note: string } | null> {
  const port = await ensurePeerIngressPort(bridgePort, undefined, envPath);
  const best = port ? detectBridgeUrls(port)[0] : undefined;
  if (!best) return null;
  const text = existsSync(envPath) ? await readFile(envPath, "utf8") : null;
  if (parseEnvRaw(text ?? "").PEER_INGRESS_PUBLIC !== "1") {
    await writeFile(envPath, mergeEnvContent(text, { PEER_INGRESS_PUBLIC: "1" }, ENV_HEADER));
  }
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
