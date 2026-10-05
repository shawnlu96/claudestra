// 同端点直连 / 中继测量基线 harness（tests/relay-direct-baseline.ts）：只用合成身份与 127.0.0.1 回环 fixture，不碰真实 peer。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testChildEnv } from "./test-env.ts";
import {
  classify, collect, fetchPort, publicSummary, quantile, readPrivateManifest, redact, ROUND_MAX, runLoopback, stat, summarize,
  summarizeStartup, toMs, writePrivateManifest, type Probe, type ReadonlyRequestPort, type Sample, type StartupRecord,
} from "./relay-direct-baseline.ts";

const REPO = resolve(import.meta.dir, "..");
const META = { date: "2026-10-05", source: "unit-fixture" };
const BASE_KEY = { responder: "peer-alpha", endpoint: "/api/v1/agents", principal: "p-synthetic", responseVersion: "v1", encoding: "identity", bytes: 42, bodyHash: "h1" };

/** 一条合成样本：total = ms，send 紧跟 start，headers 在中间 */
function mk(path: "direct" | "relay", ms: number, over: Partial<Sample> = {}): Sample {
  return {
    ...BASE_KEY, path, session: "reused", round: 1, status: 200, shapeOk: true, verifyOk: true, unit: "ms",
    marks: { start: 1000, send: 1000, headers: 1000 + ms / 2, verified: 1000 + ms }, ...over,
  };
}

describe("分位数与单位", () => {
  test("最近秩分位数：1..100 → p50=50、p95=95；单样本两者相同；空为 null", () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(quantile(v, 0.5)).toBe(50);
    expect(quantile(v, 0.95)).toBe(95);
    expect(stat([7])).toEqual({ n: 1, p50: 7, p95: 7, unit: "ms" });
    expect(stat([])).toEqual({ n: 0, p50: null, p95: null, unit: "ms" });
    expect(stat([3, NaN, 1, 2]).n).toBe(3);
  });

  test("时钟单位统一换成 ms；未知单位抛错", () => {
    expect(toMs(1_500_000, "ns")).toBe(1.5);
    expect(toMs(2500, "us")).toBe(2.5);
    expect(() => toMs(1, "s" as never)).toThrow();
    const ns = classify(mk("direct", 0, { unit: "ns", marks: { start: 0, send: 0, headers: 4_000_000, verified: 10_000_000 } }));
    expect(ns.ok && ns.d).toEqual({ ttfb: 4, body: 6, total: 10 });
  });
});

describe("样本分类：失败单列不进 RTT", () => {
  test.each([
    ["phase_order", { marks: { start: 10, send: 12, headers: 11, verified: 13 } }],
    ["phase_order", { marks: { start: 10, hello: 9, send: 12, headers: 13, verified: 14 } }],
    ["bad_sample", { marks: { start: 10, send: 11, headers: NaN, verified: 12 } }],
    ["bad_sample", { marks: { start: 10, headers: 11, verified: 12 } }],
    ["bad_sample", { unit: "sec" as never }],
    ["bad_sample", { session: "warm" as never }],
    ["transport", { status: 0 }],
    ["status", { status: 503 }],
    ["shape", { shapeOk: false }],
    ["verify", { verifyOk: false }],
  ] as const)("%s", (reason, over) => {
    expect(classify(mk("direct", 10, over as Partial<Sample>))).toEqual({ ok: false, reason });
  });

  test("握手样本带 hello 才有 connect；复用样本不算 connect", () => {
    const marks = { start: 0, hello: 3, send: 4, headers: 8, verified: 10 };
    const h = classify(mk("direct", 0, { session: "handshake", marks }));
    expect(h.ok && h.d).toEqual({ connect: 3, ttfb: 4, body: 2, total: 10 });
    const r = classify(mk("direct", 0, { session: "reused", marks }));
    expect(r.ok && r.d.connect).toBeUndefined();
  });
});

describe("matched 汇总", () => {
  test("同 key 两侧配对；失败样本只计 excluded；CLI 启动独列不并入 total", () => {
    const samples = [
      ...[10, 20, 30, 40].map((ms) => mk("direct", ms, { cliStartup: 200 })),
      ...[50, 60, 70, 80].map((ms) => mk("relay", ms)),
      mk("relay", 5, { status: 500 }),
      mk("relay", 5, { shapeOk: false }),
      mk("direct", 5, { verifyOk: false }),
    ];
    const s = summarize(samples, META);
    expect(s.excluded).toEqual({ status: 1, shape: 1, verify: 1 });
    expect(s.groups).toHaveLength(1);
    const g = s.groups[0]!;
    expect(g.status).toBe("matched");
    expect(g.direct.total).toEqual({ n: 4, p50: 20, p95: 40, unit: "ms" });
    expect(g.relay.total).toEqual({ n: 4, p50: 60, p95: 80, unit: "ms" });
    expect(g.direct.cliStartup).toEqual({ n: 4, p50: 200, p95: 200, unit: "ms" });
    expect(g.relay.cliStartup.n).toBe(0);
    expect(s).toMatchObject({ date: META.date, source: META.source, units: "ms", samples: 11 });
  });

  test("正文 / 压缩 / 版本不同 → body_mismatch unavailable，不跨 key 比较", () => {
    const s = summarize([mk("direct", 10), mk("relay", 20, { bytes: 99, bodyHash: "h2" }), mk("relay", 20, { encoding: "gzip" })], META);
    expect(s.groups.every((g) => g.status === "unavailable" && g.reason === "body_mismatch")).toBe(true);
    expect(s.groups).toHaveLength(3);
  });

  test("不同 responder 各成一组，明确 unavailable，绝不互比", () => {
    const s = summarize([mk("direct", 10), mk("relay", 20, { responder: "peer-beta" })], META);
    expect(s.groups.map((g) => [g.key.responder, g.status, g.reason])).toEqual([
      ["peer-alpha", "unavailable", "no_relay"],
      ["peer-beta", "unavailable", "no_direct"],
    ]);
  });

  test("握手与 session 复用分开成组", () => {
    const s = summarize([mk("direct", 10, { session: "handshake" }), mk("relay", 30, { session: "handshake" }), mk("direct", 1), mk("relay", 2)], META);
    expect(s.groups.map((g) => [g.session, g.status, g.direct.total.p50, g.relay.total.p50])).toEqual([
      ["handshake", "matched", 10, 30],
      ["reused", "matched", 1, 2],
    ]);
  });

  test("空样本：没有组；缺 date / source 拒绝", () => {
    expect(summarize([], META).groups).toEqual([]);
    expect(() => summarize([], { date: "", source: "x" })).toThrow();
  });
});

/** 合成 port：可编排的单调假时钟，记录并发度 */
function fakePort(path: "direct" | "relay", script: { body?: string; status?: number; fail?: boolean; hello?: boolean } = {}) {
  const st = { inflight: 0, maxInflight: 0, calls: 0 };
  const port: ReadonlyRequestPort = {
    path, responder: "peer-alpha", principal: "p-synthetic",
    async get(_ep, hooks) {
      st.calls++;
      st.inflight++;
      st.maxInflight = Math.max(st.maxInflight, st.inflight);
      if (script.hello) hooks.mark("hello");
      hooks.mark("send");
      await Bun.sleep(1);
      st.inflight--;
      if (script.fail) throw new Error("connect ECONNREFUSED 10.1.2.3 token=SEKRET");
      const body = new TextEncoder().encode(script.body ?? '{"agents":[]}');
      return { status: script.status ?? 200, headers: { ETag: "\"v7\"" }, readBody: async () => body };
    },
  };
  return { port, st };
}
const PROBE: Probe = { endpoint: "/api/v1/agents", validate: (j) => Array.isArray((j as { agents?: unknown }).agents) };
const clock = () => {
  let t = 0;
  return () => (t += 5);
};

describe("采集器", () => {
  test("严格串行、每个 port 第一条为 handshake、阶段单调", async () => {
    const a = fakePort("direct", { hello: true });
    const b = fakePort("relay");
    const samples = await collect([a.port, b.port], [PROBE], { perRound: 3, rounds: 2, now: clock() });
    expect(samples).toHaveLength(12);
    expect(a.st.maxInflight + b.st.maxInflight).toBe(2);
    expect(samples.filter((s) => s.session === "handshake").map((s) => s.path)).toEqual(["direct", "relay"]);
    for (const s of samples) expect(classify(s).ok).toBe(true);
    expect(samples[0]!.marks.hello).toBeDefined();
    expect(samples[0]).toMatchObject({ responseVersion: "\"v7\"", encoding: "identity", bytes: 13 });
    expect(summarize(samples, META).groups.map((g) => g.status)).toEqual(["matched", "matched"]);
  });

  test("每轮最多 ROUND_MAX 条，超了直接拒绝", async () => {
    const { port, st } = fakePort("direct");
    await expect(collect([port], [PROBE], { perRound: ROUND_MAX + 1 })).rejects.toThrow();
    expect(st.calls).toBe(0);
  });

  test("非 JSON / shape 不符 / 传输失败 / 非 2xx 都按原因单列，错误原文不进样本", async () => {
    const ports = [
      fakePort("direct", { body: "<html>" }).port,
      fakePort("direct", { body: '{"x":1}' }).port,
      fakePort("relay", { fail: true }).port,
      fakePort("relay", { status: 401 }).port,
    ];
    const samples = await collect(ports, [PROBE], { perRound: 1, now: clock() });
    expect(summarize(samples, META).excluded).toEqual({ shape: 2, transport: 1, status: 1 });
    expect(JSON.stringify(samples)).not.toContain("SEKRET");
  });

  test("fetchPort 只发 GET，签名头由注入方给，harness 不造凭据", async () => {
    const seen: { url: string; method: string; headers: Record<string, string> }[] = [];
    const port = fetchPort({
      path: "direct", responder: "r", principal: "p", baseUrl: "http://fixture.invalid/",
      headersFor: () => ({ "x-test": "1" }),
      fetchLike: async (url, init) => (seen.push({ url, method: init.method, headers: init.headers }), new Response('{"agents":[]}')),
    });
    const [s] = await collect([port], [PROBE], { perRound: 1 });
    expect(seen).toEqual([{ url: "http://fixture.invalid/api/v1/agents", method: "GET", headers: { "x-test": "1" } }]);
    expect(classify(s!).ok).toBe(true);
  });
});

describe("desktop / iOS 启动", () => {
  const rec = (over: Partial<StartupRecord>): StartupRecord => ({
    platform: "ios", temperature: "cold", visibility: "foreground", source: "device", unit: "ms",
    phases: { navigation: 100, api: 40, headers: 30, body: 10, firstUsableRender: 300 }, ...over,
  });

  test("冷暖 / 前后台分组；只有 pending 的组列 PM/owner 待测；simulated 与坏标签拒收", () => {
    const r = summarizeStartup([
      rec({}),
      rec({ temperature: "warm", phases: { firstUsableRender: 90 } }),
      rec({ platform: "desktop", source: "pending" }),
      rec({ source: "simulated" }),
      rec({ temperature: "lukewarm" as never }),
      rec({ visibility: "background", unit: "us", phases: { api: 5000 }, networkSwitch: "wifi→cellular via 100.64.1.2 token=SEKRET" }),
    ]);
    expect(r.rejected).toBe(2);
    expect(r.groups.map((g) => [g.platform, g.temperature, g.visibility, g.status])).toEqual([
      ["ios", "cold", "foreground", "measured"],
      ["ios", "warm", "foreground", "measured"],
      ["desktop", "cold", "foreground", "pending_pm_owner"],
      ["ios", "cold", "background", "measured"],
    ]);
    expect(r.groups[1]!.phases.firstUsableRender!.p50).toBe(90);
    expect(r.groups[2]!.phases.firstUsableRender!.n).toBe(0);
    expect(r.groups[3]!.phases.api!.p50).toBe(5);
    expect(r.networkSwitches).toEqual(["wifi→cellular via <redacted> token=<redacted>"]);
  });
});

describe("secret 不输出 / 私密 manifest", () => {
  test("公开汇总匿名化 responder / principal、去 query、不带版本与正文哈希", () => {
    const secret = "tok_" + "A".repeat(40);
    const s = summarize([mk("direct", 10, { endpoint: `/api/v1/agents?token=${secret}` }), mk("relay", 20, { endpoint: `/api/v1/agents?token=${secret}` })], META);
    const pub = JSON.stringify(publicSummary(s, "f".repeat(64)));
    for (const leak of [secret, "peer-alpha", "p-synthetic", "h1", "responseVersion"]) expect(pub).not.toContain(leak);
    expect(pub).toContain('"responder":"R1"');
    expect(redact(`Authorization: Bearer ${secret}`)).toBe("Authorization: Bearer <redacted>");
  });

  test("manifest 拒绝写进仓库；仓库外 0600 落盘、哈希可复核、篡改即拒", () => {
    expect(() => writePrivateManifest(join(REPO, "tests", "tmp-private"), REPO, {})).toThrow();
    expect(() => writePrivateManifest(REPO, REPO, {})).toThrow();
    const dir = join(mkdtempSync(join(tmpdir(), "rdb-")), "private");
    const payload = { samples: [mk("direct", 10)], meta: META };
    const m = writePrivateManifest(dir, REPO, payload);
    expect(statSync(m.file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readPrivateManifest(m.file)).toEqual(payload);
    writeFileSync(m.file, readFileSync(m.file, "utf8").replace("peer-alpha", "peer-gamma"));
    expect(() => readPrivateManifest(m.file)).toThrow();
  });
});

describe("回环 fixture", () => {
  test("进程内回环：direct 与回环中继同 key 配对", async () => {
    const { samples, summary } = await runLoopback({ perRound: 3 });
    expect(samples).toHaveLength(6);
    expect(summary.source).toBe("loopback-fixture");
    expect(summary.excluded).toEqual({});
    expect(summary.groups.map((g) => [g.session, g.status])).toEqual([["handshake", "matched"], ["reused", "matched"]]);
  });

  test("文档里的 CLI 命令能跑通（临时 HOME、--no-env-file、repo 路径参数化），stdout 不带原始标识", () => {
    const tmp = mkdtempSync(join(tmpdir(), "rdb-cli-"));
    const out = join(tmp, "private");
    const r = Bun.spawnSync([process.execPath, "--no-env-file", join(REPO, "tests/relay-direct-baseline.ts"), "loopback", "--out", out, "--repo", REPO], {
      cwd: tmp, env: testChildEnv({ HOME: tmp, TMPDIR: tmp }),
    });
    expect(r.exitCode).toBe(0);
    const stdout = r.stdout.toString();
    const res = JSON.parse(stdout) as { manifest: string; summary: { source: string; groups: { status: string }[]; manifestSha256: string } };
    expect(res.summary.source).toBe("loopback-fixture");
    expect(res.summary.groups.every((g) => g.status === "matched")).toBe(true);
    expect(stdout).not.toContain("loopback-responder");
    const again = Bun.spawnSync([process.execPath, "--no-env-file", join(REPO, "tests/relay-direct-baseline.ts"), "summarize", res.manifest], {
      cwd: tmp, env: testChildEnv({ HOME: tmp, TMPDIR: tmp }),
    });
    expect(again.exitCode).toBe(0);
    expect(JSON.parse(again.stdout.toString()).manifestSha256).toBe(res.summary.manifestSha256);
  });
});
