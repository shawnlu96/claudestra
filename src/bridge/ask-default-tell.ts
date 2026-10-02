/**
 * 测试类扩围自动批准的结论发给提问的执行者（i28-ASK4，lib/order-ask-default.ts SweepDeps.tell）。远端执行者是 worker@peer：
 * 和 PM 用 send_to_agent 回 worker@peer 同一条路（POST 对方的 /api/v1/agents/:name/messages，wait=0 只要回执，签名 + 中继同 http-peer.ts）。
 * 不是 worker@peer 的（本机执行者）不发：本机的默认做法提问执行者本来就照默认继续。没收下 = false，sweep 下次重发。
 * tests/order-ask-test-scope.test.ts。
 */
import type { Ask } from "../lib/ledger-asks.js";
import { signedFor } from "../lib/instance-key.js";
import { findHttpPeer, type HttpPeer } from "../lib/peers.js";
import { peerFetch } from "./relay-link.js";

export interface TellDeps {
  findPeer: (name: string) => Promise<HttpPeer | null>;
  fetchImpl?: typeof fetch;
}

const live: TellDeps = { findPeer: findHttpPeer };

export async function tellAsker(a: Ask, text: string, d: TellDeps = live): Promise<boolean> {
  const m = a.fromAgent?.match(/^([^@]+)@(.+)$/);
  if (!m) return true; // 本机执行者：没有要发的
  const peer = await d.findPeer(m[2]);
  if (!peer?.outToken || !peer.baseUrl) return false;
  const url = `${peer.baseUrl.replace(/\/+$/, "")}/api/v1/agents/${encodeURIComponent(m[1])}/messages`;
  const body = JSON.stringify({ text, wait: 0, nonce: crypto.randomUUID() });
  const res = await peerFetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${peer.outToken}`, "Content-Type": "application/json", ...signedFor("POST", url, body) },
    body,
    signal: AbortSignal.timeout(15_000),
  }, { ...(d.fetchImpl ? { fetchImpl: d.fetchImpl } : {}), timeoutMs: 15_000 });
  return res.ok || res.status === 202;
}
