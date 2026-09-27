/**
 * GET /local-probe —— 中继网页问「你是不是就在我这台电脑上」：浏览器从 https://<中继> 直接请求 http://127.0.0.1:<端口>/local-probe，
 * 拿得到且 fp 与当前机器一致 = 浏览器就跑在这台电脑上，前端切到本机直连（web/features/machines/local-hop.ts）。
 * 只答真实回环；跨源只放中继自己的 origin（其余跨源照旧在 bridge.ts 被拒）；不看凭据、只回中继页面本就知道的 fp / 名字 / 端口。
 * OPTIONS 回 Private Network Access 预检头：老版 Chrome 对「公网页面 → 回环」的请求先预检，不回这个头就直接失败。
 */
import { BRIDGE_PORT } from "./config.js";
import { machineIdentity } from "./local-api/version.js";
import { relayInfo } from "./relay-link.js";
import { requestContextOf } from "./request-context.js";

const LOCAL_PROBE_PATH = "/local-probe";

interface ProbeDeps {
  relayBase: () => string | null;
  identity: () => { fp: string | null; machineName: string };
  port: number;
}
const realDeps: ProbeDeps = { relayBase: () => relayInfo().base, identity: machineIdentity, port: BRIDGE_PORT };

/** 不是这个路径 → null（交给后面的路由）；是 → 一定给出响应 */
export function localProbeResponse(req: Request, deps: ProbeDeps = realDeps): Response | null {
  if (new URL(req.url).pathname !== LOCAL_PROBE_PATH) return null;
  if (requestContextOf(req).source !== "loopback") return new Response("not found", { status: 404 });
  const origin = req.headers.get("origin");
  const base = deps.relayBase();
  const allowed = !origin || (!!base && origin === `https://${base}`);
  if (!allowed) return new Response("cross-origin probe refused", { status: 403 });
  const cors: Record<string, string> = origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET", "Access-Control-Allow-Private-Network": "true" } });
  }
  if (req.method !== "GET") return new Response("method not allowed", { status: 405, headers: cors });
  const body = { ok: true, ...deps.identity(), port: deps.port };
  return new Response(JSON.stringify(body), { headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
