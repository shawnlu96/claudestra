/**
 * rename-floka-CENTER2：中继正式入口接通 rename 档位，front 的握手按接收档认新族。全部跑在本机真实端口上：
 *   握手：真中心（createRelay）× 裸 WebSocket（自己挑提议的子协议）；426 用普通 GET 看（front 在升级之前就回）；
 *   接通：relay 入口（src/relay.ts，子进程真起一份）读改名环境变量、bridge 入口（relayConnectOptions）读实例配置。
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelay, type Relay } from "../src/relay/server.ts";
import { connect, type RelayClient } from "../src/lib/relay-client.ts";
import { instanceKeySync, type InstanceKey } from "../src/lib/instance-key.ts";
import { authSignature, SUBPROTOCOL } from "../src/lib/relay-protocol.ts";
import { signRelayAuth } from "../src/lib/floka-compat/relay/handshake.ts";
import { flokaName, legacyName } from "../src/lib/floka-env/names.ts";
import { relayConnectOptions } from "../src/bridge/relay-link.ts";
import { testChildEnv } from "./test-env.ts";

const BASE = "relay.test";
const FLOKA = "floka-relay.v2";
const REPO = join(import.meta.dir, "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newKey = (): InstanceKey => instanceKeySync(mkdtempSync(join(tmpdir(), "floka-center-wire-")))!;

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting");
    await sleep(15);
  }
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});
afterAll(() => {
  for (const f of cleanup.splice(0)) f();
});

function center(rename: object | undefined, logs: string[] = []): Relay {
  const r = createRelay({ base: BASE, port: 0, db: ":memory:", log: (_, m) => void logs.push(m), ...(rename ? { rename } : {}) });
  cleanup.push(() => r.stop());
  return r;
}

/** 普通 GET 带上子协议头：front 在升级之前就判 426，不必真的握手 */
const probe = (port: number, offer: string[]) =>
  fetch(`http://127.0.0.1:${port}/v1/ws`, { headers: { "sec-websocket-protocol": offer.join(", ") } });

/** 说协议的裸客户端：握手、按 hello 报的族签名，直到 welcome 或被关 */
async function handshake(port: number, offer: string[], signAs: "legacy" | "floka") {
  const key = newKey();
  const frames: Record<string, unknown>[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, offer);
  cleanup.push(() => ws.close());
  ws.onmessage = (ev) => {
    const f = JSON.parse(String(ev.data));
    frames.push(f);
    if (f.t !== "hello") return;
    const a = { key: key.publicKey, nonce: f.nonce, name: "raw", slug: "raw" };
    const sig = signAs === "legacy" ? authSignature(key.privateKey, a.nonce, a.key, a.name, a.slug) : signRelayAuth("floka", key.privateKey, a);
    ws.send(JSON.stringify({ t: "auth", v: 2, ...a, sig }));
  };
  const opened = await new Promise<boolean>((r) => {
    ws.onopen = () => r(true);
    ws.onerror = () => r(false);
  });
  if (opened) await waitFor(() => frames.some((f) => f.t === "welcome" || f.t === "error"));
  return { opened, hello: frames.find((f) => f.t === "hello"), welcome: frames.find((f) => f.t === "welcome") };
}

// ── 验收线 1：握手按接收档 ─────────────────────────────────────────────

describe("[验收线 1] front 握手按 centerReceive 认族", () => {
  test("on：只提新族的握手成功、回选新族；只提旧族的回选旧族；两族并提按 CENTER1 规则选新族", async () => {
    const relay = center({ centerReceive: "on" });
    expect((await probe(relay.port, [FLOKA])).status).not.toBe(426);

    const onlyNew = await handshake(relay.port, [FLOKA], "floka");
    expect(onlyNew.opened).toBe(true);
    expect(onlyNew.hello?.subprotocol).toBe(FLOKA);
    expect(onlyNew.welcome).toBeDefined();

    const onlyOld = await handshake(relay.port, [SUBPROTOCOL], "legacy");
    expect(onlyOld.opened).toBe(true);
    expect(onlyOld.hello && "subprotocol" in onlyOld.hello).toBe(false);
    expect(onlyOld.welcome).toBeDefined();

    const both = await handshake(relay.port, [FLOKA, SUBPROTOCOL], "floka");
    expect(both.hello?.subprotocol).toBe(FLOKA);
    expect(both.welcome).toBeDefined();
  });

  test("on：一条连接只属于一族——只提新族却按旧族签名，认证失败", async () => {
    const relay = center({ centerReceive: "on" });
    const r = await handshake(relay.port, [FLOKA], "legacy");
    expect(r.opened).toBe(true);
    expect(r.welcome).toBeUndefined();
  });

  test("on：两族都没提的照旧 426", async () => {
    const relay = center({ centerReceive: "on" });
    for (const offer of [[], ["x"], ["floka-relay.v1"]]) expect((await probe(relay.port, offer)).status).toBe(426);
  });

  for (const rename of [undefined, { centerReceive: "off" }, { centerReceive: "bogus" }, { centerReceive: "observe" }]) {
    test(`${JSON.stringify(rename)}：只提新族照旧 426（正文同旧），旧族照常；observe 多记一条报告`, async () => {
      const logs: string[] = [];
      const relay = center(rename, logs);
      const res = await probe(relay.port, [FLOKA]);
      expect(res.status).toBe(426);
      expect(await res.text()).toBe(`subprotocol ${SUBPROTOCOL} required`);
      expect((await handshake(relay.port, [FLOKA], "floka")).opened).toBe(false);
      const old = await handshake(relay.port, [SUBPROTOCOL], "legacy");
      expect(old.welcome).toBeDefined();
      const reports = logs.filter((l) => l.includes("开到 on 会认成 floka"));
      expect(reports.length).toBe(rename?.centerReceive === "observe" ? 2 : 0);
    });
  }
});

// ── 验收线 2：正式入口接通配置 ─────────────────────────────────────────

describe("[验收线 2] relay 入口读改名环境变量（子进程真起 src/relay.ts）", () => {
  const RECEIVE = "RENAME_CENTER_RECEIVE";

  async function startEntry(extra: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "floka-center-wire-relay-"));
    const env = testChildEnv({ HOME: dir, RELAY_BASE: BASE, RELAY_PORT: "0", RELAY_HOST: "127.0.0.1", RELAY_DATA: dir, RELAY_COMMIT: "abcdef0", ...extra });
    const proc = Bun.spawn([process.execPath, "--no-env-file", join(REPO, "src/relay.ts")], { env, cwd: dir, stdout: "pipe", stderr: "pipe" });
    cleanup.push(() => proc.kill());
    let out = "";
    const drain = async (s: ReadableStream<Uint8Array>) => {
      for await (const chunk of s) out += new TextDecoder().decode(chunk);
    };
    void drain(proc.stdout);
    void drain(proc.stderr);
    await waitFor(() => /中继监听 [^:]+:(\d+)/.test(out), 15_000);
    return { port: Number(/中继监听 [^:]+:(\d+)/.exec(out)![1]), log: () => out };
  }

  test("旧名写 centerReceive=on：createRelay 拿到 on，只提新族的握手成功、回选新族", async () => {
    const e = await startEntry({ [legacyName(RECEIVE)]: "on" });
    expect(e.log()).toContain("接收 on，发送 off");
    const r = await handshake(e.port, [FLOKA], "floka");
    expect(r.hello?.subprotocol).toBe(FLOKA);
    expect(r.welcome).toBeDefined();
  }, 20_000);

  test("新名按 floka-env 档位认：rename.env on 时新名生效", async () => {
    const e = await startEntry({ FLOKA_RENAME_ENV: "on", [flokaName(RECEIVE)]: "on" });
    expect(e.log()).toContain("接收 on");
    expect((await handshake(e.port, [FLOKA], "floka")).welcome).toBeDefined();
  }, 20_000);

  for (const [what, extra] of [
    ["不写", {}],
    ["rename.env off 时只写新名", { [flokaName(RECEIVE)]: "on" }],
    ["写错值", { [legacyName(RECEIVE)]: "bogus" }],
  ] as const) {
    test(`${what}：按 off（只提新族 426），错值在启动日志里有 problems 原文`, async () => {
      const e = await startEntry(extra);
      expect(e.log()).toContain("接收 off，发送 off");
      expect((await probe(e.port, [FLOKA])).status).toBe(426);
      if (what === "写错值") expect(e.log()).toContain('rename.centerReceive: "bogus"');
    }, 20_000);
  }
});

describe("[验收线 2] bridge 入口读实例配置", () => {
  const url = (port: number) => `ws://127.0.0.1:${port}/v1/ws`;
  const NEW = { centerReceive: "on", centerSend: "on" };

  function bridgeClient(port: number, cfg: object, logs: string[]): RelayClient {
    const opts = relayConnectOptions(url(port), newKey(), null, 1, {}, cfg, (_, m) => void logs.push(m));
    const c = connect({ ...opts, timing: { backoffMs: [30], fatalRetryMs: 30, heartbeatMs: 60_000 } });
    cleanup.push(() => c.close());
    return c;
  }

  async function reconnect(relay: Relay, c: RelayClient): Promise<void> {
    await waitFor(() => c.state === "online");
    expect(relay.dropConnection(c.info().fp!)).toBe(true);
    await waitFor(() => c.state !== "online");
    await waitFor(() => c.state === "online");
  }

  test("配置写 on：传进 connect 的 rename 是配置原样，重连后按新族握手", async () => {
    const cfg = { rename: { state: "off", ...NEW } };
    expect(relayConnectOptions(url(1), newKey(), null, 1, {}, cfg).rename).toEqual(cfg.rename);
    const relay = center(NEW);
    const c = bridgeClient(relay.port, cfg, []);
    await reconnect(relay, c);
    expect(c.family).toBe("floka");
  });

  for (const cfg of [{}, { rename: { state: "on" } }, { rename: { centerReceive: "bogus", centerSend: "on" } }, { rename: "on" }]) {
    test(`配置 ${JSON.stringify(cfg)}：按 off，重连后仍是旧族；错值在日志里有 problems 原文`, async () => {
      const logs: string[] = [];
      const relay = center(NEW);
      const c = bridgeClient(relay.port, cfg, logs);
      await reconnect(relay, c);
      expect(c.family).toBe("legacy");
      if (JSON.stringify(cfg).includes("bogus")) expect(logs.some((l) => l.includes('rename.centerReceive: "bogus"'))).toBe(true);
      if (typeof (cfg as { rename?: unknown }).rename === "string") expect(logs.some((l) => l.includes("rename: 要是对象"))).toBe(true);
    });
  }
});
