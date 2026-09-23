/**
 * channel-server 该连哪个 bridge（v2.24+）。纯逻辑，单测覆盖。
 *
 * ⚠ 这个文件的由来是一个静默到离谱的 bug（2026-09-22 试装现场）：
 * `setup` 把用户选的端口写成 `BRIDGE_PORT=13847`，但 **`BRIDGE_URL` 从不写**，
 * 而 manager / channel-server / claude-launch 三处各自兜底成写死的
 * `ws://localhost:3847`。于是只要用户改过端口：
 *
 *   - bridge 在 13847 上跑得好好的（HTTP、用量抓取、归档全正常）；
 *   - 每一个 channel-server 都去连 3847，那儿没人听，连不上也不报错（它按设计
 *     指数退避重连）；
 *   - 结果是 registry 里一个 `📌 注册频道` 都没有，网页上大总管和所有 agent
 *     **永远 offline**，而日志里没有任何一行说「我连错端口了」。
 *
 * 排查代价极高：bridge 看起来完全健康，症状却是「什么都连不上」。
 *
 * 规则：**显式 `BRIDGE_URL` 优先**（跨机场景要指向远程 bridge），没有就**从
 * `BRIDGE_PORT` 推**，两者都没有才回默认端口。
 */

export const DEFAULT_BRIDGE_PORT = 3847;

/** BRIDGE_PORT → 端口号；没设 / 不是 1-65535 的整数 → 默认端口（与 resolveBridgeUrl 同一口径） */
export function resolveBridgePort(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.BRIDGE_PORT);
  return env.BRIDGE_PORT && Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_BRIDGE_PORT;
}

export function resolveBridgeUrl(env: Record<string, string | undefined> = process.env): string {
  const explicit = (env.BRIDGE_URL || "").trim();
  if (explicit) return explicit;
  return `ws://localhost:${resolveBridgePort(env)}`;
}

/**
 * 显式 BRIDGE_URL 的端口跟 BRIDGE_PORT 对不上 → 返回提示语（体检用）。
 * 对得上 / 没显式设 / 解析不出端口都返回 null。
 */
export function bridgeUrlPortMismatch(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const explicit = (env.BRIDGE_URL || "").trim();
  if (!explicit || !env.BRIDGE_PORT) return null;
  const m = /:(\d+)(?:\/|$)/.exec(explicit);
  if (!m) return null;
  const urlPort = Number(m[1]);
  const envPort = Number(env.BRIDGE_PORT);
  if (!Number.isInteger(urlPort) || !Number.isInteger(envPort) || urlPort === envPort) return null;
  return `BRIDGE_URL 指向 :${urlPort}，但 BRIDGE_PORT 是 ${envPort} —— channel-server 会连到没人听的端口，所有 agent 都会显示离线`;
}

/**
 * peer 专用入口端口（bridge/peer-ingress.ts）。**只认 .env 显式配的 PEER_INGRESS_PORT，没配就不开**：
 * 升级不能凭空多占一个端口（「bridge 端口 + 1」可能正被别的服务用，bridge 先起还会把它抢走），
 * 也不能随 BRIDGE_PORT 改动漂走（反代规则指着的是写死的端口）。由 setup 的 HTTPS 步骤写入。
 */
export function configuredPeerIngressPort(env: Record<string, string | undefined> = process.env): number | null {
  const v = Number(env.PEER_INGRESS_PORT || "");
  return Number.isInteger(v) && v > 0 && v < 65536 ? v : null;
}
