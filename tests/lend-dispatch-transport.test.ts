/**
 * i28-W2 推送的传输边界：bridge/lend-dispatch.ts 用 peerFetch(…, { e2eOnly: true }) 推单。推送前的 peerLendProblem 和真正发送之间
 * peers.json 可能变（peer 刚被禁用、地址改了）——这时 E2E 出口认不出目标，带 e2eOnly 的调用直接抛错、一个字节都不发；
 * 不带 e2eOnly 的其他调用方照旧走明文（行为不变）。
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { peerFetch } from "../src/bridge/relay-link.js";
import { peerLendProblem } from "../src/lib/lend-remote.js";
import { readPeers, writePeers, type HttpPeer, type PeersData } from "../src/lib/peers.js";

const BASE = "https://peer.test";
const URL_ = `${BASE}/api/v1/lend/offer`;
const REC = { name: "mate", addedAt: "x", baseUrl: BASE, outToken: "t", publicKey: "k", e2e: { idk: "i", ek: {} } } as unknown as HttpPeer;
const INIT = { method: "POST", headers: { Authorization: "Bearer t", "Content-Type": "application/json" }, body: '{"v":1}' };
let saved: PeersData;
let calls: string[];
const fetchImpl = (async (u: string | URL | Request) => {
  calls.push(String(u));
  return new Response("{}");
}) as typeof fetch;

saved = await readPeers();
afterAll(() => writePeers(saved));
beforeEach(() => {
  calls = [];
});

describe("e2eOnly：推送检查之后 peer 变了", () => {
  test("检查时合格，发送前被禁用：带 e2eOnly 抛错，fetchImpl 一次都没被调", async () => {
    expect(peerLendProblem(REC, "mate")).toBeNull();
    await writePeers({ ...saved, httpPeers: [{ ...REC, disabled: true }] });
    await expect(peerFetch(URL_, INIT, { fetchImpl, e2eOnly: true })).rejects.toThrow(/不发明文/);
    expect(calls).toEqual([]);
  });

  test("地址改了（推送用的 URL 不再对得上任何记录）、记录被删：同样抛错不发", async () => {
    await writePeers({ ...saved, httpPeers: [{ ...REC, baseUrl: "https://moved.test" }] });
    await expect(peerFetch(URL_, INIT, { fetchImpl, e2eOnly: true })).rejects.toThrow(/不发明文/);
    await writePeers({ ...saved, httpPeers: [] });
    await expect(peerFetch(URL_, INIT, { fetchImpl, e2eOnly: true })).rejects.toThrow(/不发明文/);
    expect(calls).toEqual([]);
  });

  test("回归：不带 e2eOnly 时非 E2E 目标仍按原样走明文（其他调用方行为不变）", async () => {
    await writePeers({ ...saved, httpPeers: [{ ...REC, disabled: true }] });
    expect((await peerFetch(URL_, INIT, { fetchImpl })).status).toBe(200);
    expect(calls).toEqual([URL_]);
  });
});
