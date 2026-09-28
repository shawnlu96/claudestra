/**
 * T11b 第 8 条「另一台设备 2 秒内消失」经中继的那一段：手机 → 中继 → bridge 的 /api/v1/events?types=ask。
 * bridge 一侧用真的 event-bus 订阅 + ledger-feed 的 sseEventAllow 过滤拼出和 bridge.ts handleEventsRequest 同形的 SSE 流，
 * 经假中继（tests/relay-fake-relay.ts）隧道到另一个客户端；断言 ask 事件一发出就到（中继客户端不攒到流结束才转），
 * 且「事件延迟 + 网页的重拉等待（ASK_EVENT_REFRESH_MS）」留给一次拉取的余量 ≥ 1 秒。
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASK_EVENT_REFRESH_MS } from "@/features/asks/asks-model";
import { emitEvent, subscribeEvents } from "../src/bridge/event-bus.js";
import { setLedgerFeedForTest, sseEventAllow } from "../src/bridge/ledger-feed.js";
import { effectivePrincipal } from "../src/lib/devices.js";
import { instanceKeySync } from "../src/lib/instance-key.js";
import type { Principal } from "../src/lib/principals.js";
import { connect, type InboundHandler, type RelayClient } from "../src/lib/relay-client.js";
import { keyFingerprint } from "../src/lib/relay-protocol.js";
import { startFakeRelay, type FakeRelay } from "./relay-fake-relay.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const at = "2026-09-29T00:00:00Z";
const OWNER: Principal = effectivePrincipal({
  principal: { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: at, terminal: true },
  credential: { id: "dev_1", v: 1, type: "bearer", hash: "h", deviceName: "phone", grant: { agents: ["*"], terminal: true, manage: true }, createdAt: at, expiresAt: "2099-01-01T00:00:00Z" },
});
const FAST = { heartbeatMs: 200, pongTimeoutMs: 150, backoffMs: [30, 60], stableMs: 50, fatalRetryMs: 400, headGraceMs: 300 };
const opened: Array<RelayClient | FakeRelay> = [];
afterAll(() => {
  for (const x of opened) ("stop" in x ? x.stop() : x.close());
  setLedgerFeedForTest(undefined);
});

/** 和 bridge.ts handleEventsRequest 同形：先发一行注释冲出响应头，之后每条过了过滤的事件一帧 */
const eventsHandler: InboundHandler = async (req) => {
  const allow = sseEventAllow(OWNER, new URL(`http://x${req.path}`).searchParams.get("types")?.split(","));
  const enc = new TextEncoder();
  let unsub = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(ctl) {
      ctl.enqueue(enc.encode(": connected\n\n"));
      unsub = subscribeEvents({}, (evt) => {
        if (allow(evt)) ctl.enqueue(enc.encode(`data: ${JSON.stringify(evt)}\n\n`));
      });
    },
    cancel: () => unsub(),
  });
  return { status: 200, headers: { "content-type": "text/event-stream" }, body };
};

function client(relay: FakeRelay, name: string, onInbound?: InboundHandler) {
  const key = instanceKeySync(mkdtempSync(join(tmpdir(), "asks-relay-")))!;
  const c = connect({ relayUrl: relay.url, key, name, slug: name.toLowerCase(), onInbound, timing: FAST, log: () => {} });
  opened.push(c);
  return { c, fp: keyFingerprint(key.publicKey) };
}

test("另一台设备：ask 事件经中继一发出就到（不等流结束），只收 ask 类；加上网页的重拉等待仍远在 2 秒内", async () => {
  setLedgerFeedForTest({ path: tempLedgerPath("asks-relay-"), emit: () => {} });
  const relay = startFakeRelay();
  opened.push(relay);
  const phone = client(relay, "Phone");
  const bridge = client(relay, "Bridge", eventsHandler);
  await Promise.all([relay.waitOnline(phone.fp), relay.waitOnline(bridge.fp)]);
  for (let i = 0; i < 300 && !(phone.c.state === "online" && bridge.c.state === "online"); i++) await Bun.sleep(10);
  const res = await phone.c.request(bridge.fp, { method: "GET", path: "/api/v1/events?types=ask", headers: {} });
  expect(res.headers["content-type"]).toBe("text/event-stream");
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = "";
  const until = async (pred: () => boolean, ms: number) => {
    const deadline = Date.now() + ms;
    while (!pred()) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("没等到");
      const r = await Promise.race([reader.read(), Bun.sleep(left).then(() => null)]);
      if (!r || r.done) continue;
      buf += dec.decode(r.value);
    }
  };
  await until(() => buf.includes(": connected"), 2000);
  const t0 = Date.now();
  emitEvent({ agent: "agent-x", chatId: "c1", type: "tool_start", data: { name: "Bash" } });
  emitEvent({ agent: "agent-x", chatId: "c1", type: "ask", data: { project: "p", askId: "ask_relay", state: "answered" } }, { transient: true });
  await until(() => buf.includes("ask_relay"), 2000);
  const lag = Date.now() - t0;
  expect(buf).not.toContain("tool_start");
  expect(lag + ASK_EVENT_REFRESH_MS).toBeLessThan(1000);
  await reader.cancel();
});
