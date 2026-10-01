/**
 * The bridge end of a peer PR push (i28-A2 §5): the scheduler's `peer_pr_push` frame. Nothing here trusts the frame: peer-prs.json
 * is re-read on every call and the (peer, fp, agent) triple must be configured; peers.json must have that peer enabled, fully
 * handshaken and pinned to the same fp; the secret gate runs again on the exact text (commit ids re-checked in repoDir) and the
 * size cap holds. Any miss answers a typed `rejected` and sends zero bytes. Otherwise one signed POST through peerFetch (E2E when
 * the peer requires it); the answer carries the peer's HTTP status, and only the scheduler decides what counts as delivered.
 */
import { randomUUID } from "node:crypto";
import { signedFor } from "../lib/instance-key.js";
import { readPeerPrConfig, type PeerPrConfigRead } from "../lib/peer-pr-config.js";
import { knownCommits } from "../lib/peer-pr-github.js";
import { GATE_REJECTED, PUSH_MAX_BYTES } from "../lib/peer-pr-message.js";
import { peerPrSecretHit } from "../lib/peer-pr-redact.js";
import { readPeers, type HttpPeer } from "../lib/peers.js";
import { peerFetch } from "./relay-link.js";

const SEND_TIMEOUT_MS = 20_000;

export interface PeerPrSendDeps {
  readConfig(): PeerPrConfigRead;
  peers(): Promise<HttpPeer[]>;
  commits(repoDir: string, shas: readonly string[]): Promise<Set<string>>;
  /** One POST; resolves with the HTTP status, throws on timeout / network failure (outcome unknown). */
  post(url: string, headers: Record<string, string>, body: string): Promise<number>;
}

export type PeerPrSendAnswer = { result: { status: number } } | { error: string; rejected?: string };

const live: PeerPrSendDeps = {
  readConfig: () => readPeerPrConfig(),
  peers: async () => (await readPeers()).httpPeers ?? [],
  commits: (repoDir, shas) => knownCommits(repoDir, shas),
  post: async (url, headers, body) => {
    const res = await peerFetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) }, { timeoutMs: SEND_TIMEOUT_MS });
    await res.body?.cancel().catch((e: unknown) => console.warn(`⚠️ [peer-pr] 丢弃对方响应体失败（状态码已拿到，不影响结论）：${(e as Error).message}`));
    return res.status;
  },
};

const reject = (rejected: string, error: string): PeerPrSendAnswer => ({ error, rejected });
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;

export async function handlePeerPrPush(msg: Record<string, unknown>, fromAgent: boolean, deps: PeerPrSendDeps = live): Promise<PeerPrSendAnswer> {
  if (fromAgent) return reject("peer_pr_caller", "agent 频道不能发 peer PR 推送帧");
  const { peer, fp, agent, key, text } = msg;
  const shas = Array.isArray(msg.shas) ? msg.shas : [];
  if (!str(peer) || !str(fp) || !str(agent) || !str(key) || typeof text !== "string" || !text || shas.length > 200 || shas.some((s) => typeof s !== "string")) {
    return reject("peer_pr_frame", "peer_pr_push 帧字段不合规");
  }
  if (Buffer.byteLength(text) > PUSH_MAX_BYTES) return reject("peer_pr_size", `正文超过 ${PUSH_MAX_BYTES} 字节`);
  const read = deps.readConfig();
  if (read.kind !== "on") return reject("peer_pr_config", read.kind === "error" ? read.error : "peer-prs.json 没开");
  if (!read.config.peers.some((p) => p.peer === peer && p.fp === fp && p.agent === agent)) return reject("peer_pr_target", "收件方不是 peer-prs.json 里配的那一组");
  const hp = (await deps.peers()).find((p) => p.name === peer);
  if (!hp || hp.disabled || !hp.baseUrl || !hp.outToken || hp.fp?.toLowerCase() !== fp) {
    return reject("peer_pr_peer", `peers.json 里的 ${peer} 被禁用、握手不全或指纹对不上`);
  }
  const hit = peerPrSecretHit(text, await deps.commits(read.config.repoDir, shas as string[]));
  if (hit) return reject(GATE_REJECTED, `门拦下（${hit}）`);
  const url = `${hp.baseUrl.replace(/\/+$/, "")}/api/v1/agents/${encodeURIComponent(agent)}/messages`;
  const body = JSON.stringify({ text, wait: 0, nonce: randomUUID() });
  const headers = { Authorization: `Bearer ${hp.outToken}`, "Content-Type": "application/json", ...signedFor("POST", url, body) };
  try {
    return { result: { status: await deps.post(url, headers, body) } };
  } catch (e) {
    return { error: `发给 ${peer} 失败（结果不明）：${(e as Error).message.slice(0, 200)}` };
  }
}

/** bridge.ts `case "peer_pr_push"`; fromAgent = the socket is a registered agent channel (only the scheduler's bare socket may push). */
export async function answerPeerPrPush(ws: { send(data: string): unknown }, msg: Record<string, unknown>, fromAgent: boolean): Promise<void> {
  const a = await handlePeerPrPush(msg, fromAgent).catch((e: unknown): PeerPrSendAnswer => ({ error: `peer PR 推送处理出错：${(e as Error).message}` }));
  ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, ...a }));
}
