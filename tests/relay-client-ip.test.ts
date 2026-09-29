/**
 * 中继认客户端地址（src/relay/limiter.ts forwardedClientIp / ipLimitKey）：反代之后按受信层数从右取 X-Forwarded-For，
 * IPv6 按 /64 计数；再用真中继（:memory:，回环随机端口）核握手限额不会被改写 XFF 左边或换 v6 后缀绕开。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { relayEnv } from "../src/relay/env.ts";
import { forwardedClientIp, ipLimitKey } from "../src/relay/limiter.ts";
import { createRelay, type Relay } from "../src/relay/server.ts";
import { SUBPROTOCOL } from "../src/lib/relay-protocol.ts";

describe("forwardedClientIp", () => {
  test("一层受信反代取最右一项；两层取倒数第二项；项数不够不认（用连接对端）", () => {
    expect(forwardedClientIp("10.9.9.1, 198.51.100.1", 1)).toBe("198.51.100.1");
    expect(forwardedClientIp("10.9.9.1, 198.51.100.1, 172.16.0.2", 2)).toBe("198.51.100.1");
    expect(forwardedClientIp("198.51.100.1", 2)).toBeUndefined();
    expect(forwardedClientIp(" 198.51.100.1 ,, ", 1)).toBe("198.51.100.1");
  });
  test("不在反代之后或没有头：undefined（用连接对端）", () => {
    expect(forwardedClientIp("198.51.100.1", 0)).toBeUndefined();
    expect(forwardedClientIp(null, 1)).toBeUndefined();
    expect(forwardedClientIp(" , ", 1)).toBeUndefined();
  });
});

describe("ipLimitKey", () => {
  test("IPv6 同一段 /64 同一个键，写法不同也一样；不同 /64 不同键", () => {
    const k = ipLimitKey("2001:db8:1:2::1");
    expect(ipLimitKey("2001:0db8:0001:0002:ffff:1:2:3")).toBe(k);
    expect(ipLimitKey("[2001:DB8:1:2::abcd]")).toBe(k);
    expect(ipLimitKey("2001:db8:1:2::1%en0")).toBe(k);
    expect(ipLimitKey("2001:db8:1:3::1")).not.toBe(k);
    expect(ipLimitKey("2001:db8:1:2:3:4:5:6")).toBe(k);
    expect(ipLimitKey("2001:db8::")).toBe("2001:db8:0:0::/64");
  });
  test("IPv4 与 IPv4 映射地址按 IPv4；认不出的原样", () => {
    expect(ipLimitKey("198.51.100.1")).toBe("198.51.100.1");
    expect(ipLimitKey("::ffff:198.51.100.1")).toBe("198.51.100.1");
    expect(ipLimitKey("198.51.100.1:5678")).toBe("198.51.100.1");
    expect(ipLimitKey("[2001:db8:1:2::9]:443")).toBe(ipLimitKey("2001:db8:1:2::1"));
    expect(ipLimitKey("[2001:db8:1:2:3:4:5:6]:443")).toBe(ipLimitKey("[2001:db8:1:2:3:4:5:7]:443"));
  });
  test("内嵌 IPv4 的 IPv6 写法按那个 IPv4 计，不同 IPv4 不并桶", () => {
    for (const w of ["::ffff:c633:6401", "::ffff:0:198.51.100.1", "::ffff:0:c633:6401", "64:ff9b::198.51.100.1", "64:ff9b::c633:6401", "::198.51.100.1",
      "0:0:0:0:0:ffff:198.51.100.1", "[::ffff:198.51.100.1]:80"]) expect([w, ipLimitKey(w)]).toEqual([w, "198.51.100.1"]);
    expect(ipLimitKey("64:ff9b::198.51.100.2")).toBe("198.51.100.2");
    expect(ipLimitKey("::ffff:c633:6402")).toBe("198.51.100.2");
  });
  test("认不出的写法共用一个桶（原样当键会让每种写法各一桶）", () => {
    const bad = ["1::2::3", "?", "unknown", "_hidden", "300.1.1.1", "1:2:3:4:5:6:7:8:9", "gggg::1", "1.2.3.4.5"].map(ipLimitKey);
    expect(new Set(bad).size).toBe(1);
    expect(bad[0]).not.toBe("?");
  });
});

test("RELAY_TRUST_PROXY：层数 0–5；旧写法 1 仍是一层；超过 5 或认不出的当 0", () => {
  const hops = (v?: string) => relayEnv({ RELAY_BASE: "r.test", RELAY_TRUST_PROXY: v }, () => undefined).trustProxy;
  expect([hops("1"), hops("2"), hops("5"), hops("0"), hops(undefined), hops("yes"), hops("-1"), hops("6"), hops("99")]).toEqual([1, 2, 5, 0, 0, 0, 0, 0, 0]);
});

describe("真中继：握手限额按受信反代写的那项计", () => {
  let relay: Relay, twoHops: Relay;
  beforeAll(() => {
    const opts = { base: "relay.test", port: 0, hostname: "127.0.0.1", db: ":memory:", limits: { authPerIpPerMinute: 3 }, log: () => {} };
    relay = createRelay({ ...opts, trustProxy: true });
    twoHops = createRelay({ ...opts, trustProxy: 2 });
  });
  afterAll(() => { relay.stop(); twoHops.stop(); });

  const open = (xff: string, port = relay.port) => new Promise<string>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { protocols: [SUBPROTOCOL], headers: { "x-forwarded-for": xff } } as unknown as string[]);
    const t = setTimeout(() => { resolve("timeout"); ws.close(); }, 3000);
    ws.onmessage = (m) => {
      const f = JSON.parse(String(m.data));
      clearTimeout(t);
      resolve(f.t === "hello" ? "hello" : `${f.t}:${f.code ?? ""}`);
      ws.close();
    };
    ws.onclose = () => { clearTimeout(t); resolve("closed"); };
  });
  const tally = async (xffs: string[], port = relay.port) => {
    const out: Record<string, number> = {};
    for (const x of xffs) { const r = await open(x, port); out[r] = (out[r] ?? 0) + 1; }
    return out;
  };

  test("每次改写 XFF 左边：同一个最右项，超过限额就拒", async () => {
    const got = await tally(Array.from({ length: 6 }, (_, i) => `10.9.${i}.1, 198.51.100.7`));
    expect(got.hello).toBe(3);
    expect(got["error:rate_limited"]).toBe(3);
  });
  test("层数配多了（配 2 层、XFF 只有一项）：不认 XFF，按连接对端计，改写也绕不开", async () => {
    const got = await tally(Array.from({ length: 5 }, (_, i) => `10.8.${i}.1`), twoHops.port);
    expect(got.hello).toBe(3);
    expect(got["error:rate_limited"]).toBe(2);
  });
  test("同一段 /64 换后缀算同一个来源；另一段 /64 有自己的额度", async () => {
    const same = await tally(Array.from({ length: 5 }, (_, i) => `2001:db8:7:7::${(i + 1).toString(16)}`));
    expect(same.hello).toBe(3);
    expect((await tally(["2001:db8:7:8::1"])).hello).toBe(1);
  });
});
