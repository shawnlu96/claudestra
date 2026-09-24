/**
 * peer-http-tidy：把同一个对方散落的多条 peer 记录合成一条（规则见 lib/peer-tidy.ts）。
 * 默认只输出计划；--apply 才写。principals 与 peers 是两个文件没法一起原子写——先写 principals
 * （吊销被取代的 token、把保留的 token 改挂到合并后的名字），再写 peers；中途失败重跑一次会收拢到同一结果。
 */
import { output } from "./core.js";

export async function cmdPeerHttpTidy(apply: boolean) {
  const { readPeers, writePeers } = await import("../lib/peers.js");
  const { readPrincipals, writePrincipals } = await import("../lib/principals.js");
  const { activePeerTokens, applyPeerTidy, planPeerTidy } = await import("../lib/peer-tidy.js");
  const [data, pf] = await Promise.all([readPeers(), readPrincipals()]);
  const peers = data.httpPeers || [];
  const plan = planPeerTidy(peers, activePeerTokens(pf.principals));
  const todo = plan.filter((g) => !g.skip);
  if (!apply) {
    output({ ok: true, plan });
    return;
  }
  if (todo.length === 0) {
    output({ ok: true, applied: 0, note: "没有要整理的 peer 记录", plan });
    return;
  }
  const r = applyPeerTidy(peers, pf.principals, plan);
  await writePrincipals(pf);
  data.httpPeers = r.httpPeers;
  await writePeers(data);
  output({
    ok: true,
    applied: todo.length,
    done: todo.map((g) => g.desc),
    revokedTokens: r.revoked,
    peers: r.httpPeers.map((p) => p.name),
    ...(todo.length < plan.length ? { skipped: plan.filter((g) => g.skip).map((g) => g.desc) } : {}),
  });
}
