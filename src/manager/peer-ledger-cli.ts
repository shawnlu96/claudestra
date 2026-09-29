/**
 * `peer-ledger <peer> …`：受托方读写发起方台账里委托给自己的卡（对方 bridge 的 /api/v1/peer-ledger，docs/team/peer-delegation.md）。
 * 带我方持有的 outToken 签名调用；权限全在对方 bridge 判，这里只拼请求。pr 会先 GET 一次取 rev（CAS）。
 */
import { output } from "./core.js";
import { parseLedgerArgs } from "./ledger-identity.js";
import { peerCliFetch } from "./relay.js";

const USAGE =
  "peer-ledger <peer> list | show <task> | note <task> <text…> | accept <task> | pr <task> [--pr <url>] [--head <sha>] | " +
  "stage <task> --from <s> --to <s> [--text <t>] [--model <m>] | review <task> --verdict pass|changes|block [--p0 N --p1 N --p2 N] [--text <t>] [--model <m>]" +
  "（写命令都可带 --dedup <key>；accept 只在我方 owner 同意接这张卡之后跑，之后这张卡上的步骤单不再先问 owner）";

type Json = Record<string, any>;

export async function cmdPeerLedger(args: string[]): Promise<void> {
  const [peerName, sub, id, ...rest] = args;
  const { findHttpPeer } = await import("../lib/peers.js");
  const peer = peerName ? await findHttpPeer(peerName) : null;
  if (!peer) return output({ ok: false, error: `HTTP peer "${peerName ?? ""}" 不存在`, usage: USAGE });
  if (!peer.outToken || !peer.baseUrl) return output({ ok: false, error: "握手未完成（缺对方地址或 outToken）", usage: USAGE });
  const base = `${peer.baseUrl.replace(/\/+$/, "")}/api/v1/peer-ledger`;
  const call = async (path: string, body?: Json): Promise<Json> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${peer.outToken}`, ...(body ? { "Content-Type": "application/json" } : {}) };
    const init = { method: body ? "POST" : "GET", headers, signal: AbortSignal.timeout(30_000), ...(body ? { body: JSON.stringify(body) } : {}) };
    const res = await peerCliFetch(`${base}${path}`, init);
    return ((await res.json().catch(() => null)) as Json | null) ?? { ok: false, error: `对方返回 ${res.status}（不是 JSON）` }; // 非 JSON 多半是对方还没这个接口
  };
  if (sub === "list") return output(await call(""));
  if (!id) return output({ ok: false, error: "缺任务 id", usage: USAGE });
  const card = `/tasks/${encodeURIComponent(id)}`;
  if (sub === "show") return output(await call(card));
  const p = parseLedgerArgs(rest, ["pr", "head", "from", "to", "text", "verdict", "p0", "p1", "p2", "dedup", "model"]);
  if ("error" in p) return output({ ok: false, error: p.error, usage: USAGE });
  const f = p.flags;
  let body: Json;
  if (sub === "note") body = { op: "note", text: p.pos.join(" ") };
  else if (sub === "accept") {
    const r = await call(card, { op: "accept", ...(f.dedup ? { dedup: f.dedup } : {}) });
    // 对方卡上记下了才在本机记：注入头按本机这一笔放行步骤单（lib/peer-accepted.ts）
    if (r.ok) (await import("../lib/peer-accepted.js")).markPeerTaskAccepted(peerName!, id);
    return output(r);
  } else if (sub === "stage") body = { op: "stage", from: f.from, to: f.to, text: f.text, model: f.model };
  else if (sub === "review") body = { op: "review", verdict: f.verdict, p0: Number(f.p0 ?? 0), p1: Number(f.p1 ?? 0), p2: Number(f.p2 ?? 0), text: f.text, model: f.model };
  else if (sub === "pr") {
    const cur = await call(card);
    if (!cur.ok) return output(cur);
    body = { op: "pr", rev: cur.task?.rev, pr: f.pr, head: f.head };
  } else return output({ ok: false, error: `未知子命令 ${sub ?? ""}`, usage: USAGE });
  output(await call(card, { ...body, ...(f.dedup ? { dedup: f.dedup } : {}) }));
}
