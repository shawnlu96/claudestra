/**
 * `peer-ledger <peer> …`：受托方读写发起方台账里委托给自己的卡（对方 bridge 的 /api/v1/peer-ledger，docs/team/peer-delegation.md）。
 * 带我方持有的 outToken 签名调用；权限全在对方 bridge 判，这里只拼请求。pr 会先 GET 一次取 rev（CAS）。
 */
import type { Database } from "bun:sqlite";
import { bindHash, checkAsk, type AskCheckResult } from "../lib/ask-bind.js";
import { repoEnvVar } from "../lib/env-file.js";
import { getAsk, hasAsksTable } from "../lib/ledger-asks.js";
import { loadRegistry, output } from "./core.js";
import { parseLedgerArgs, resolveActor } from "./ledger-identity.js";
import { peerCliFetch } from "./relay.js";

/**
 * accept 要绑一张 owner 答过的授权卡（同 `ledger ask-check`）：action peer_accept、params {peer, task}、问的就是调用者本人。
 * agent 自己跑得了这条命令，对方一句「owner 已同意」就可能骗它跑——有这张卡，agent 伪造不了 owner 的点击（tests/ledger-steps.test.ts）
 */
export function checkAcceptAsk(db: Database, askId: string, peer: string, task: string, caller: string, now: number): AskCheckResult {
  const a = hasAsksTable(db) ? getAsk(db, askId) : null;
  if (a?.bind && a.bind.action !== "peer_accept") return { ok: false, reason: `${askId} 授权的是 ${a.bind.action}，不是 peer_accept` };
  return checkAsk(a, a?.bind ? bindHash({ ...a.bind, params: { peer, task } }, caller) : "", caller, now);
}

async function acceptApproved(askId: string | undefined, peer: string, task: string): Promise<string | null> {
  if (!askId) return "accept 要带 --ask <askId>：先用 reply 的 ask（kind authorize，bind.action peer_accept，params {peer, task}）问 owner，owner 点了同意再跑";
  const who = resolveActor({ channelId: process.env.DISCORD_CHANNEL_ID, controlChannelId: repoEnvVar("CONTROL_CHANNEL_ID") }, (await loadRegistry()).agents);
  if (!who.ok) return who.error;
  const { openLedger } = await import("../lib/ledger-store.js");
  const r = checkAcceptAsk(openLedger(), askId, peer, task, who.actor, Date.now());
  return r.ok ? null : `owner 的授权没核过：${r.reason}`;
}

const USAGE =
  "peer-ledger <peer> list | show <task> | note <task> <text…> | accept <task> --ask <askId> | pr <task> [--pr <url>] [--head <sha>] | " +
  "stage <task> --from <s> --to <s> [--text <t>] [--model <m>] | review <task> --verdict pass|changes|block [--p0 N --p1 N --p2 N] [--text <t>] [--model <m>]" +
  "（写命令都可带 --dedup <key>；accept 要绑 owner 答过的授权卡，之后这张卡上的步骤单不再先问 owner）";

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
  const p = parseLedgerArgs(rest, ["pr", "head", "from", "to", "text", "verdict", "p0", "p1", "p2", "dedup", "model", "ask"]);
  if ("error" in p) return output({ ok: false, error: p.error, usage: USAGE });
  const f = p.flags;
  let body: Json;
  if (sub === "note") body = { op: "note", text: p.pos.join(" ") };
  else if (sub === "accept") {
    const denied = await acceptApproved(f.ask, peerName!, id);
    if (denied) return output({ ok: false, code: "forbidden", error: denied, usage: USAGE });
    const r = await call(card, { op: "accept" });
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
