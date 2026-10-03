/**
 * The bridge's push loop for lend protocol v2 (logic in lib/lend-dispatch.ts): every PUSH_TICK_MS it announces pooled orders to
 * v2 lenders over `peerFetch(<peer>/api/v1/lend/offer, { e2eOnly })` — E2E only: the peer record must pass peerLendProblem first,
 * and the transport refuses outright if the target stopped being an E2E peer since (disabled / address changed), so nothing goes
 * out in plaintext — and writes the answers through `ledger lend-pushed`. Pooled orders past
 * the push TTL are withdrawn by `ledger lend-sweep`. Ledger reads go through the bridge's read-only connection.
 */
import { readJsonCapped } from "../lib/body-reader.js";
import { signedFor } from "../lib/instance-key.js";
import { createPushLoop, PUSH_TICK_MS } from "../lib/lend-dispatch.js";
import { peerLendProblem, proxyVarsIn } from "../lib/lend-remote.js";
import { queueNoticeDue } from "../lib/ledger-lend-queue.js";
import { pushCandidates } from "../lib/ledger-lend-peers.js";
import { pushTtlDue } from "../lib/ledger-lend-peers-ttl.js";
import { isE2eResponse } from "../lib/peer-e2e-client.js";
import { readPeers } from "../lib/peers.js";
import { runManagerProcess } from "../lib/run-manager.js";
import { sandboxDisabledOutsideLab } from "../lib/sandbox.js";
import { BUN_PATH, ENV_WITH_BUN, MANAGER_PATH } from "./config.js";
import { ledgerDb } from "./ledger-feed.js";
import { peerFetch } from "./relay-link.js";

const SEND_TIMEOUT_MS = 20_000;
/** owner identity (no channel), as local-api/lend.ts runs the other lend commands */
const ENV = { ...ENV_WITH_BUN, DISCORD_CHANNEL_ID: "" };
const manager = (args: string[]) => runManagerProcess(args, { bunPath: BUN_PATH, managerPath: MANAGER_PATH, env: ENV, timeoutMs: 30_000 });

const loop = createPushLoop({
  now: () => Date.now(),
  candidates: (now) => {
    const db = ledgerDb();
    return db ? pushCandidates(db, now) : [];
  },
  problem: async (name) => {
    const proxies = proxyVarsIn(process.env);
    if (proxies.length) return `环境里有代理变量 ${proxies.join(", ")}`;
    return peerLendProblem((await readPeers()).httpPeers?.find((p) => p.name === name), name);
  },
  send: async (name, offer) => {
    const peer = (await readPeers()).httpPeers?.find((p) => p.name === name);
    if (!peer?.baseUrl || !peer.outToken) throw new Error(`peer ${name} 握手不完整`);
    const url = `${peer.baseUrl.replace(/\/+$/, "")}/api/v1/lend/offer`;
    const body = JSON.stringify(offer);
    const started = await manager(["ledger", "lend-pushing", "--", name, body]);
    if (!started?.ok) throw new Error(`重推起点没入账：${started?.error ?? "无输出"}`);
    const res = await peerFetch(url, {
      method: "POST", headers: { Authorization: `Bearer ${peer.outToken}`, "Content-Type": "application/json", ...signedFor("POST", url, body) },
      body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    }, { timeoutMs: SEND_TIMEOUT_MS, e2eOnly: true });
    return { status: res.status, e2e: isE2eResponse(res), body: await readJsonCapped(res) };
  },
  record: async (peer, answer) => {
    const r = await manager(["ledger", "lend-pushed", "--", peer, JSON.stringify(answer)]);
    if (!r?.ok) console.warn(`⚠️ [lend] 推送应答没入账（${peer}）：${r?.error ?? "无输出"}`);
    return !!r?.ok;
  },
  ttlDue: (now) => {
    const db = ledgerDb();
    return !!db && (pushTtlDue(db, now).length > 0 || queueNoticeDue(db, now));
  },
  sweep: async () => {
    const r = await manager(["ledger", "lend-sweep"]);
    if (!r?.ok) console.warn(`⚠️ [lend] 推送超时撤回失败（5 秒后再查）：${r?.error ?? "无输出"}`);
  },
  log: (msg) => console.warn(`⚠️ [lend] ${msg}`),
});

let timer: ReturnType<typeof setInterval> | null = null;
/** 持单期间的规格追加 / 复述答复（i28-RS1，`ledger lend-relay`）：这么久查一次；只在有持单中的写单或待发段时才起 manager */
const RELAY_TICK_MS = 30_000;
let relayAt = 0;
let relaying = false;

function relayDue(now: number): boolean {
  const db = ledgerDb();
  if (!db || now - relayAt < RELAY_TICK_MS || relaying) return false;
  try {
    return !!db.query(`SELECT 1 FROM lend_orders WHERE status = 'claimed' AND step IN ('write','fix') LIMIT 1`).get()
      || !!db.query("SELECT 1 FROM lend_relays WHERE state IN ('pending','sending') LIMIT 1").get();
  } catch {
    return false; // 旧库还没有这两张表
  }
}

function relayTick(): void {
  const now = Date.now();
  if (!relayDue(now)) return;
  relayAt = now;
  relaying = true;
  manager(["ledger", "lend-relay"])
    .then((r) => { if (!r?.ok) console.warn(`⚠️ [lend] lend-relay 失败（下轮再试）：${r?.error ?? "无输出"}`); })
    .catch((e) => console.warn(`⚠️ [lend] lend-relay 起不来：${(e as Error).message}`))
    .finally(() => { relaying = false; });
}

export function startLendDispatch(): void {
  if (timer || sandboxDisabledOutsideLab("出借推送")) return; // 沙箱不对外推送；lab 的 peer 只可能是 lab 实例
  timer = setInterval(() => {
    // 一轮出错（库暂时读不了、peers.json 读坏）只记日志：发送状态在内存里，下一轮照常重试，推不出去的单由推送 TTL 收走
    loop.tick().catch((e) => console.warn(`⚠️ [lend] 推送循环这一轮出错：${(e as Error).message}`));
    relayTick();
  }, PUSH_TICK_MS);
  timer.unref?.();
}
