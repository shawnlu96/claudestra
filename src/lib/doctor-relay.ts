/**
 * doctor 的「中继」一项（docs/relay/protocol.md）：问本机 bridge 的回环控制路由 GET /relay/status。
 * 中继是「手机访问」默认的出门路（setup 向导第一选项），所以 doctor-remote.ts 先拿它的状态，再决定 Tailscale
 * 没装 / 没连算不算问题。没配 RELAY_URL 是可选项没开、不是问题（ok + 一句怎么开）；配了没连上才 warn；
 * bridge 不在跑由 checkBridge 报，这里拿不到状态就不出这一项。判定是纯函数 relayChecks（tests/doctor-relay.test.ts）。
 */
import type { Check } from "./doctor.js";
import { bridgeHttpBase } from "./bridge-port.js";

/** GET /relay/status 回包里这里用到的字段（bridge/relay-routes.ts） */
export interface RelayStatusLike {
  enabled?: boolean;
  connected?: boolean;
  state?: string | null;
  url?: string | null;
  relayUrl?: string | null;
  retryAt?: number | null;
  lastError?: string | null;
}

export function relayChecks(st: RelayStatusLike, group: string, now = Date.now()): Check[] {
  const name = "中继";
  if (!st.enabled) {
    return [{ group, name, status: "ok",
      detail: "没配（可选）—— 出门访问只能靠 Tailscale；重跑 bun run setup 的「手机访问」一步选中继（手机不装任何东西），或 .env 加 RELAY_URL / RELAY_NAME 后重启 bridge" }];
  }
  if (st.connected && st.url) {
    return [{ group, name, status: "ok", detail: `${st.url}（手机 / 浏览器不装任何东西就能打开；claudestra pair 出配对码）` }];
  }
  const retry = st.retryAt && st.retryAt > now ? `，${Math.ceil((st.retryAt - now) / 1000)} 秒后重试` : "";
  const why = `${st.state ?? "unknown"}${st.lastError ? `: ${st.lastError}` : ""}`;
  return [{ group, name, status: "warn",
    detail: `${st.relayUrl ?? "RELAY_URL"} 没连上（${why}${retry}）—— 手机出门暂时只能靠 Tailscale（若装了）`,
    fix: "curl https://<中继主机>/healthz 看中继在不在；核对 RELAY_URL 拼写（wss://…）；bridge 日志里「🛰 中继」的行有原因" }];
}

/** bridge 回环路由拿状态；bridge 不在跑 / 老版本没有这个路由 → null（调用方不出「中继」项，按没中继判 Tailscale） */
export async function fetchRelayStatus(): Promise<RelayStatusLike | null> {
  try {
    const r = await fetch(`${bridgeHttpBase()}/relay/status`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? ((await r.json()) as RelayStatusLike) : null;
  } catch {
    return null; // bridge 没起来：checkBridge 那一组已经报了，这里再报一遍只是噪音
  }
}
