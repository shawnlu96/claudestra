/**
 * lab 隔离闸的绕过面（T81 第 1 轮对抗审查的反例，逐条钉住）：
 * - 出站：重定向跳到闸外、显式 proxy / unix、net / tls / Bun.connect 直连——一律拒；lab 带任何代理变量就不启动（第 2 轮的反例），
 *   而且断言的是「闸外替身一次连接都没收到」，不只是初始 URL 被拒；
 * - 默认生产端口 3847 不靠可选的拒绝清单：清单缺了也不许当 lab 中继 / 假推送 / 假 APNs / peer 入口端口，lab 缺清单直接不启动；
 * - 只设 lab 开关（或写错）而沙箱没开：真实入口（paths 加载）就报错，不按生产静默跑。
 * 都在子进程里真装闸门（import src/lib/paths.ts），测试进程本身不装。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isSandbox, sandboxBridgeEnvProblems, sandboxRelayUrlProblem } from "../src/lib/sandbox.js";
import { labProxyProblem, withoutProxyEnv } from "../src/lib/sandbox-lab.js";
import { OUTBOUND_BLOCKED_MARK } from "../src/lib/sandbox-outbound.js";
import { testChildEnv } from "./test-env.ts";

const PATHS = JSON.stringify(join(import.meta.dir, "..", "src", "lib", "paths.ts"));
const PROD = 3847;
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "lab-bypass-")));
const LAB = join(tmp, "lab");
const [RELAY, PUSH, APNS] = [24964, 24965, 24966];
mkdirSync(join(LAB, "a"), { recursive: true });
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function labEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  return testChildEnv({
    HOME: join(tmp, "home"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_SANDBOX_LAB: "1", CLAUDESTRA_SANDBOX_ROOT: join(LAB, "a"), CLAUDESTRA_LAB_ROOT: LAB,
    CLAUDESTRA_STATE_DIR: join(LAB, "a", "state"), CLAUDESTRA_RUNTIME_DIR: join(LAB, "a", "run"),
    CLAUDESTRA_LAB_RELAY_PORT: String(RELAY), CLAUDESTRA_LAB_PUSH_PORT: String(PUSH), CLAUDESTRA_LAB_APNS_PORT: String(APNS),
    CLAUDESTRA_LAB_PORTS: `24960,24962,${RELAY}`, CLAUDESTRA_SANDBOX_DENY_PORTS: `${PROD},3848`,
    BRIDGE_PORT: "24960", BRIDGE_URL: "ws://127.0.0.1:24960", HTTP_PROXY: undefined, HTTPS_PROXY: undefined, NO_PROXY: undefined, ...extra,
  });
}

async function run(code: string, childEnv: Record<string, string>) {
  const p = Bun.spawn([process.execPath, "--no-env-file", "-e", code], { cwd: tmp, stdout: "pipe", stderr: "pipe", env: childEnv });
  const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  return { code: await p.exited, out: out.trim(), err };
}

/**
 * 子进程开头：闸外替身（原始 TCP，任何协议连上来都计数）与放行端点（HTTP，/r/<码>/out 跳闸外、/r/<码>/in 跳自己的 /final），
 * 把放行端点的端口写进 lab 环境后再加载 paths 装闸门
 */
const PRELUDE = `
  const net = require("node:net"), tls = require("node:tls"), http = require("node:http");
  let hits = 0;
  const decoy = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() { hits++; },
    data(s) { s.write("HTTP/1.1 200 OK\\r\\ncontent-length: 5\\r\\nconnection: close\\r\\n\\r\\ndecoy"); s.end(); } } });
  const F = decoy.port;
  const allowed = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const u = new URL(req.url), [, r, code, where] = u.pathname.split("/");
    if (r === "r") return new Response(null, { status: Number(code), headers: { location: where === "out" ? "http://127.0.0.1:" + F + "/leak" : "/final" } });
    if (u.pathname === "/final") return new Response(req.method + ":" + (await req.text()) + ":" + (req.headers.get("authorization") || ""));
    return new Response("ok");
  } });
  const A = "http://127.0.0.1:" + allowed.port;
  Object.assign(process.env, { BRIDGE_PORT: String(allowed.port), BRIDGE_URL: "ws://127.0.0.1:" + allowed.port, CLAUDESTRA_LAB_PORTS: allowed.port + ",${RELAY}" });
  await import(${PATHS});
  const v = async (f) => { try { return "through:" + (await f()); } catch (e) { return String(e.message).includes("沙箱模式拒绝出站请求") ? "blocked" : "err:" + e.message; } };
  const sock = (mk) => new Promise((ok) => { const s = mk();
    s.on("error", (e) => ok(String(e.message).includes("沙箱模式拒绝出站请求") ? "blocked" : "err:" + e.message));
    s.on("connect", () => { s.destroy(); ok("through"); }); });
  const out = {};`;

describe("出站：重定向 / proxy / 底层 socket（闸外替身计数为 0）", () => {
  test("重定向逐跳过闸：跳到闸外的五种状态码都拒、正文没送出；闸内跳转照常跟随", async () => {
    const r = await run(`${PRELUDE}
      for (const c of [301, 302, 303, 307, 308]) out["out" + c] = await v(async () => (await fetch(A + "/r/" + c + "/out", { method: "POST", body: "lab-secret" })).text());
      out.in307 = await v(async () => (await fetch(A + "/r/307/in", { method: "POST", body: "lab-secret", headers: { authorization: "Bearer t" } })).text());
      out.in303 = await v(async () => (await fetch(A + "/r/303/in", { method: "POST", body: "lab-secret" })).text());
      out.manual = await v(async () => (await fetch(A + "/r/307/out", { method: "POST", body: "x", redirect: "manual" })).status);
      out.in302 = await v(async () => (await fetch(A + "/r/302/in")).text());
      await Bun.sleep(200);
      console.log(JSON.stringify({ out, hits })); process.exit(0);`, labEnv());
    const { out, hits } = JSON.parse(r.out || "{}");
    expect(hits, r.err).toBe(0);
    for (const c of [301, 302, 303, 307, 308]) expect(out[`out${c}`], String(c)).toBe("blocked");
    expect(out.in307).toBe("through:POST:lab-secret:Bearer t"); // 307 原样重发方法与正文，同源保留 Authorization
    expect(out.in303).toBe("through:GET::");
    expect(out.manual).toBe("through:307"); // 调用方自己要 manual：不跟随，也就不出闸
    expect(out.in302).toBe("through:GET::");
    expect(r.err.split(OUTBOUND_BLOCKED_MARK).length - 1).toBe(5);
    expect(r.err).toContain("重定向过去的");
  }, 30_000);

  test("显式 proxy / unix、net / tls / Bun.connect 直连闸外都拒；连放行端口的 net 照常通", async () => {
    const r = await run(`${PRELUDE}
      out.fetchProxy = await v(async () => (await fetch(A + "/", { proxy: "http://127.0.0.1:" + F })).text());
      out.fetchUnix = await v(async () => (await fetch(A + "/", { unix: "/tmp/x.sock" })).text());
      out.wsProxy = await v(() => { new WebSocket(A.replace("http", "ws"), { proxy: "http://127.0.0.1:" + F }); return "made"; });
      out.net = await sock(() => net.connect({ host: "127.0.0.1", port: F }));
      out.netPort = await sock(() => net.createConnection(F, "127.0.0.1"));
      out.netUnix = await sock(() => net.connect("/tmp/x.sock"));
      out.tls = await sock(() => tls.connect({ host: "127.0.0.1", port: F, rejectUnauthorized: false }));
      out.tlsProd = await sock(() => tls.connect({ host: "api.push.apple.com", port: 443 }));
      out.bun = await v(() => Bun.connect({ hostname: "127.0.0.1", port: F, socket: { data() {} } }).then(() => "connected"));
      out.bunUnix = await v(() => Bun.connect({ unix: "/tmp/x.sock", socket: { data() {} } }).then(() => "connected"));
      out.netAllowed = await sock(() => net.connect({ host: "127.0.0.1", port: allowed.port }));
      await Bun.sleep(200);
      console.log(JSON.stringify({ out, hits })); process.exit(0);`, labEnv());
    const { out, hits } = JSON.parse(r.out || "{}");
    expect(hits, r.err).toBe(0);
    for (const k of ["fetchProxy", "fetchUnix", "wsProxy", "net", "netPort", "netUnix", "tls", "tlsProd", "bun", "bunUnix"]) expect(out[k], k).toBe("blocked");
    expect(out.netAllowed).toBe("through");
    expect(r.err).toContain("api.push.apple.com");
  }, 30_000);

});

/**
 * 代理场景的子进程：闸外代理替身（原始 TCP，记下收到的字节）与放行端点；setup 在加载 paths 之前跑、after 在之后跑，
 * 加载成功才发带 token 与正文的 POST。输出加载结果、代理连接数、token / 正文有没有到代理
 */
const proxyCase = (setup: string, after = "") => `
  let hits = 0, seen = "";
  const proxy = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() { hits++; }, data(s, d) { seen += d.toString();
    s.write("HTTP/1.1 200 OK\\r\\ncontent-length: 5\\r\\nconnection: close\\r\\n\\r\\nproxy"); s.end(); } } });
  const allowed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("direct") });
  const A = "http://127.0.0.1:" + allowed.port + "/", P = "http://127.0.0.1:" + proxy.port;
  Object.assign(process.env, { BRIDGE_PORT: String(allowed.port), BRIDGE_URL: "ws://127.0.0.1:" + allowed.port, CLAUDESTRA_LAB_PORTS: allowed.port + ",${RELAY}" });
  ${setup}
  hits = 0; seen = "";
  let load = "loaded", post = "skipped";
  try { await import(${PATHS}); } catch (e) { load = "refused:" + e.message; }
  if (load === "loaded") { ${after}
    post = await fetch(A, { method: "POST", body: "lab-secret", headers: { authorization: "Bearer lab-token" } }).then((r) => r.text(), (e) => "err:" + e.message); }
  await Bun.sleep(100);
  console.log(JSON.stringify({ load, post, hits, leaked: seen.includes("lab-token") || seen.includes("lab-secret") })); process.exit(0);`;

describe("lab 不支持代理：带任何代理变量就不启动", () => {
  const outcome = async (setup: string, after?: string) => {
    const r = await run(proxyCase(setup, after), labEnv());
    return { ...(JSON.parse(r.out || "{}") as { load?: string; post?: string; hits?: number; leaked?: boolean }), err: r.err };
  };

  test("NO_PROXY 与 no_proxy 冲突（Bun 按小写走代理）：加载就拒，代理没收到连接、token、正文", async () => {
    const o = await outcome(`Object.assign(process.env, { HTTP_PROXY: P, NO_PROXY: "127.0.0.1", no_proxy: "other.example" });`);
    expect(o.load, o.err).toContain("lab 不支持代理");
    expect(o.load).toContain("HTTP_PROXY, NO_PROXY, no_proxy");
    expect(o).toMatchObject({ post: "skipped", hits: 0, leaked: false });
  }, 30_000);

  test("预热（Bun 已缓存代理）→ 装闸 → 删 env → guarded POST：装闸时就拒，代理计数为 0", async () => {
    const o = await outcome(`process.env.HTTP_PROXY = P; await (await fetch(A)).text();`, `delete process.env.HTTP_PROXY;`);
    expect(o.load, o.err).toContain("lab 不支持代理");
    expect(o).toMatchObject({ post: "skipped", hits: 0, leaked: false });
  }, 30_000);

  test("八个名字的大小写写法、混写都拒；空值与不带代理照常加载", async () => {
    const names = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "Https_Proxy"];
    for (const k of names) {
      const r = await run(`await import(${PATHS}); console.log("loaded");`, labEnv({ [k]: "http://127.0.0.1:9" }));
      expect(r.out, k).not.toContain("loaded");
      expect(r.err, k).toContain(`lab 不支持代理，环境里有 ${k}`);
    }
    expect((await run(`await import(${PATHS}); console.log("loaded");`, labEnv({ HTTP_PROXY: "" }))).out).toBe("loaded");
    expect((await run(`await import(${PATHS}); console.log("loaded");`, labEnv())).out).toBe("loaded");
  }, 60_000);

  test("sandbox 脚本给 lab 子进程的环境剔掉全部代理变量（非 lab 沙箱照旧继承）", () => {
    const env = { PATH: "/bin", HTTP_PROXY: "http://p:1", no_proxy: "x", All_Proxy: "socks5://p:2", CLAUDESTRA_SANDBOX: "1" };
    expect(withoutProxyEnv(env)).toEqual({ PATH: "/bin", CLAUDESTRA_SANDBOX: "1" });
    expect(labProxyProblem(withoutProxyEnv(env))).toBeNull();
  });
});

describe("默认生产端口不靠可选清单", () => {
  const load = (extra: Record<string, string | undefined>) => run(`await import(${PATHS}); console.log("loaded");`, labEnv({ CLAUDESTRA_SANDBOX_DENY_PORTS: undefined, ...extra }));

  test("缺拒绝清单时 3847 当 lab 中继 / 假推送 / 假 APNs / peer 入口端口，加载 paths 就拒", async () => {
    const cases: Array<Record<string, string>> = [
      { CLAUDESTRA_LAB_RELAY_PORT: String(PROD), CLAUDESTRA_LAB_PORTS: `24960,${PROD}` },
      { CLAUDESTRA_LAB_PUSH_PORT: String(PROD) },
      { CLAUDESTRA_LAB_APNS_PORT: String(PROD) },
      { CLAUDESTRA_LAB_PORTS: `24960,${PROD},${RELAY}` }, // peer 入口端口在实例端口名单里
    ];
    for (const extra of cases) {
      const r = await load(extra);
      expect(r.out, JSON.stringify(extra)).not.toContain("loaded");
      expect(r.err, JSON.stringify(extra)).toContain(`lab 端口 ${PROD} 是生产端口`);
    }
  }, 30_000);

  test("lab 配置本身没毛病、只缺清单：也不启动；带上清单才加载", async () => {
    const missing = await load({});
    expect(missing.out).not.toContain("loaded");
    expect(missing.err).toContain("生产端口清单");
    expect((await load({ CLAUDESTRA_SANDBOX_DENY_PORTS: `${PROD}` })).out).toBe("loaded");
  }, 30_000);

  test("bridge 环境：缺清单时 RELAY_URL / PEER_INGRESS_PORT 指到 3847 仍拒", () => {
    const env = { ...labEnv({ CLAUDESTRA_SANDBOX_DENY_PORTS: undefined }), CLAUDESTRA_LAB_PORTS: `24960,${PROD}` };
    expect(sandboxBridgeEnvProblems(PROD, { ...env, PEER_INGRESS_PORT: String(PROD) }).join()).toContain("PEER_INGRESS_PORT");
    const relay = { ...env, CLAUDESTRA_LAB_RELAY_PORT: String(PROD), RELAY_URL: `ws://127.0.0.1:${PROD}` };
    expect(sandboxBridgeEnvProblems(PROD, relay).join()).toContain("RELAY_URL");
  });
});

describe("lab 开关没和沙箱一起开：真实入口报错，不按生产跑", () => {
  const plain = { CLAUDESTRA_STATE_DIR: join(tmp, "p", "state"), CLAUDESTRA_RUNTIME_DIR: join(tmp, "p", "run"), HOME: join(tmp, "home") };
  const load = (extra: Record<string, string | undefined>) => run(`await import(${PATHS}); console.log("loaded");`, testChildEnv({ ...plain, ...extra }));

  test("仅 lab=1、lab=yes 无沙箱、lab=1 且 SANDBOX=0：加载 paths 就拒", async () => {
    for (const extra of [{ CLAUDESTRA_SANDBOX_LAB: "1" }, { CLAUDESTRA_SANDBOX_LAB: "yes" }, { CLAUDESTRA_SANDBOX_LAB: "1", CLAUDESTRA_SANDBOX: "0" }]) {
      const r = await load(extra);
      expect(r.code, JSON.stringify(extra)).not.toBe(0);
      expect(r.out).not.toContain("loaded");
      expect(r.err).toContain("lab 只能和 CLAUDESTRA_SANDBOX=1 一起用");
    }
  }, 30_000);

  test("完全不带 lab / 沙箱环境（及 lab=0）的进程照常加载；各闸的短路口也先报错", async () => {
    expect((await load({})).out).toBe("loaded");
    expect((await load({ CLAUDESTRA_SANDBOX_LAB: "0" })).out).toBe("loaded");
    expect(() => isSandbox({ CLAUDESTRA_SANDBOX_LAB: "1" })).toThrow("lab 只能和");
    expect(() => sandboxRelayUrlProblem("wss://relay.example.com", { CLAUDESTRA_SANDBOX_LAB: "1" })).toThrow("lab 只能和");
    expect(isSandbox({})).toBe(false);
  }, 30_000);
});
