/**
 * `manager lend call <peer> poll|claim|lease|result --body '<json>'`：调度服务的 lend 循环经它调 A 的出借接口（lib/lend-remote.ts 解析）。
 * 只给调度服务用（同 ledger 的调度服务身份：CLAUDESTRA_SCHEDULER_SERVICE=1 且不在 agent 频道里）；前提不满足（peer 没钉钥 / 没 E2E、
 * 环境里有代理变量）就不发请求。出站只走 E2E（relay.ts peerE2eOnlyFetch），不退回明文。
 * 输出 {ok:true, status, body}：只要请求到了对方并拿回响应就是 ok:true，对方的拒绝在 body 里；发不出去 / 不知道发没发出去是 ok:false。
 */
import { proxyVarsIn, peerLendProblem, type LendOp } from "../lib/lend-remote.js";
import { output } from "./core.js";
import { peerE2eOnlyFetch } from "./relay.js";

const OPS: readonly LendOp[] = ["poll", "claim", "lease", "result"];
const USAGE = "usage: lend call <peer> poll|claim|lease|result --body '<json>'（调度服务专用）";
const MAX_BODY = 96 * 1024;

export async function cmdLendCall(args: string[]): Promise<void> {
  if (process.env.CLAUDESTRA_SCHEDULER_SERVICE !== "1" || process.env.DISCORD_CHANNEL_ID) return output({ ok: false, code: "forbidden", error: "lend call 只给调度服务用" });
  const [peerName, op, flag, body] = args;
  if (!peerName || !OPS.includes(op as LendOp) || flag !== "--body" || body === undefined || args.length !== 4) return output({ ok: false, error: USAGE });
  if (Buffer.byteLength(body) > MAX_BODY) return output({ ok: false, error: `请求体超过 ${MAX_BODY} 字节` });
  const proxies = proxyVarsIn(process.env);
  if (proxies.length) return output({ ok: false, code: "precondition", error: `环境里有代理变量 ${proxies.join(", ")}，不发出借请求` });
  const { findHttpPeer } = await import("../lib/peers.js");
  const peer = (await findHttpPeer(peerName)) ?? undefined;
  const problem = peerLendProblem(peer, peerName);
  if (problem) return output({ ok: false, code: "precondition", error: problem });
  try {
    const res = await peerE2eOnlyFetch(`${peer!.baseUrl!.replace(/\/+$/, "")}/api/v1/lend/${op}`, {
      method: "POST", headers: { Authorization: `Bearer ${peer!.outToken}`, "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(45_000),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; /* 不是 JSON：交给 lend-remote 按 bad_response 处理，状态码照带 */ }
    output({ ok: true, status: res.status, body: parsed });
  } catch (e) {
    output({ ok: false, code: "transport", error: (e as Error).message });
  }
}
