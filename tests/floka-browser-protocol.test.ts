/**
 * 浏览器协议两族（src/lib/floka-browser-protocol）：设备 / 领取 cookie、CSRF 头、CORS 允许头、handoff 键、邀请 scheme、SW 消息。
 * 真端口（Bun.serve）+ 真鉴权（authenticateApi / 设备端点）跑矩阵；中继与 peer 入口的清洗两族都剥 / 都钉；
 * SW 在假 ServiceWorkerGlobalScope 里跑 web/public/sw.js 本体（新）与基线版本（旧），对旧新页面各处理一次。
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { authenticateApi, setApiAuthPrincipalsPathForTest } from "../src/bridge/api-auth.js";
import { renewDeviceCookie, noteDeviceAuth, setDeviceCookieRenewForTest } from "../src/bridge/device-cookie-renew.js";
import { handleDevicesPublic, setDevicesPrincipalsPathForTest } from "../src/bridge/devices.js";
import { cleanEntries, handleHandoff } from "../src/bridge/local-api/handoff.js";
import { invitePageResponse } from "../src/bridge/invite-page.js";
import { ingressRequest } from "../src/bridge/peer-ingress.js";
import { setRequestContext, type RequestContext } from "../src/bridge/request-context.js";
import { corsHeadersFor } from "../src/bridge/web-gateway.js";
import { attachCredential, cookieValueFrom, DEVICE_COOKIE, DEVICE_HEADER, deviceCookieHeader, deviceCookieHeaders, ensureOwnerPrincipal, fullGrant } from "../src/lib/devices.js";
import { RELAY_FAMILIES } from "../src/lib/floka-compat/relay/families.js";
import { readBrowserCookie, readCsrfHeader, relayCookieNames } from "../src/lib/floka-browser-protocol/credentials.js";
import { inviteSchemes, parseInviteLink } from "../src/lib/floka-browser-protocol/invite.js";
import { BROWSER_NAMES, LEGACY_SESSION_COOKIE_NAME } from "../src/lib/floka-browser-protocol/names.js";
import { BROWSER_OFF, parseBrowserProtocol, setBrowserPolicyForTest, type BrowserPolicy } from "../src/lib/floka-browser-protocol/policy.js";
import { notificationTag, swOpenMessage } from "../src/lib/floka-browser-protocol/sw.js";
import { LEGACY_SESSION_COOKIE } from "../src/lib/legacy-web.js";
import type { Principal, PrincipalsFile } from "../src/lib/principals.js";
import { filterMachineRequestHeaders, filterMachineResponseHeaders, pinDeviceCookie } from "../src/lib/relay-machine-path.js";
import { dropForPeer, forwardHeaders, SET_COOKIE_SEP } from "../src/lib/relay-stream.js";
import { createSwInbox, onSwOpen, SW_OPEN_TYPES, type SwOpen } from "../web/lib/sw-inbox";

const OLD = BROWSER_NAMES.claudestra, NEW = BROWSER_NAMES.floka;
const OBSERVE: BrowserPolicy = { receive: "observe", write: "off" };
const RECEIVE: BrowserPolicy = { receive: "on", write: "off" };
const WRITE: BrowserPolicy = { receive: "on", write: "on" };
const ROOT = join(import.meta.dir, "..");
const LAN: RequestContext = { source: "lan", clientIp: "192.168.1.9", https: false };

let dir: string, tokenA: string, tokenB: string;
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "floka-browser-"));
  const file: PrincipalsFile = { principals: [] };
  const owner = ensureOwnerPrincipal(file);
  tokenA = attachCredential(owner, "iPhone", fullGrant()).token;
  tokenB = attachCredential(owner, "Mac", fullGrant()).token;
  writeFileSync(join(dir, "principals.json"), JSON.stringify(file));
  setApiAuthPrincipalsPathForTest(join(dir, "principals.json"));
  setDevicesPrincipalsPathForTest(join(dir, "principals.json"));
  // 假 HTTP：真端口、真鉴权；来源按主端口经本机反代（lan）
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => {
    setRequestContext(req, LAN);
    const p = await authenticateApi(req, new URL(req.url), { rateLimit: false });
    return p instanceof Response ? p : Response.json({ ok: true, id: p.id, credential: p.credential });
  } });
});
afterAll(() => {
  server.stop(true);
  setApiAuthPrincipalsPathForTest(undefined);
  setDevicesPrincipalsPathForTest(undefined);
  setBrowserPolicyForTest(undefined);
  setDeviceCookieRenewForTest(undefined);
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => setBrowserPolicyForTest(undefined));

interface Probe { cookies?: Record<string, string>; csrf?: Record<string, string>; method?: string }
async function hit(policy: BrowserPolicy, p: Probe): Promise<{ status: number; code?: string }> {
  setBrowserPolicyForTest(policy);
  const cookie = Object.entries(p.cookies ?? {}).map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/agents`, {
    method: p.method ?? "POST", headers: { ...(cookie ? { cookie } : {}), ...(p.csrf ?? {}) },
  });
  const body = await res.json() as { code?: string };
  return { status: res.status, code: body.code };
}

describe("名字只定义一处：bridge / relay / web 同值", () => {
  test("设备头与中继族表一致，旧族等于现行常量；web 侧的同值常量", () => {
    expect(NEW.deviceHeader).toBe(RELAY_FAMILIES.floka.headers.device);
    expect(OLD.deviceHeader).toBe(RELAY_FAMILIES.legacy.headers.device);
    expect(DEVICE_HEADER).toBe(OLD.deviceHeader);
    expect(DEVICE_COOKIE).toBe(OLD.deviceCookie);
    expect(LEGACY_SESSION_COOKIE).toBe(LEGACY_SESSION_COOKIE_NAME);
    const client = readFileSync(join(ROOT, "web/lib/api/client.ts"), "utf8");
    expect(client).toContain(`export const DEVICE_HEADER = "${OLD.deviceHeader}";`);
    expect(client).toContain(`export const FLOKA_DEVICE_HEADER = "${NEW.deviceHeader}";`);
    const manifest = readFileSync(join(ROOT, "web/app/manifest.ts"), "utf8");
    for (const f of [OLD, NEW]) expect(manifest).toContain(`{ protocol: "${f.webScheme}", url: "/join?i=%s" }`);
    const sw = readFileSync(join(ROOT, "web/public/sw.js"), "utf8");
    for (const f of [OLD, NEW]) expect(sw).toContain(`{ openAgent: "${f.openAgent}", openAsk: "${f.openAsk}", tag: "${f.notificationTag}" }`);
    expect(sw).toContain(`const DEVICE_HEADER = "${OLD.deviceHeader}";`);
    expect(sw).not.toMatch(/\bcaches\b/);
    // 页面侧收件箱（web/lib/sw-inbox.ts）的类型名与 names.ts 同值
    expect(SW_OPEN_TYPES as Record<string, readonly string[]>).toEqual({ agent: [OLD.openAgent, NEW.openAgent], ask: [OLD.openAsk, NEW.openAsk] });
  });

  test("rename.browserProtocol：缺省 / 写错 = off；字符串只开接收；write 要 receive=on 才算", () => {
    expect(parseBrowserProtocol({})).toEqual(BROWSER_OFF);
    expect(parseBrowserProtocol({ rename: { browserProtocol: "yes" } })).toEqual(BROWSER_OFF);
    expect(parseBrowserProtocol({ rename: { browserProtocol: "observe" } })).toEqual(OBSERVE);
    expect(parseBrowserProtocol({ rename: { browserProtocol: "on" } })).toEqual(RECEIVE);
    expect(parseBrowserProtocol({ rename: { browserProtocol: { receive: "observe", write: "on" } } })).toEqual(OBSERVE);
    expect(parseBrowserProtocol({ rename: { browserProtocol: { receive: "on", write: "on" } } })).toEqual(WRITE);
  });
});

describe("[验收线 1] 真端口：旧新 cookie × CSRF 矩阵，冲突凭据拒", () => {
  test("on：四种组合都过；两族 cookie 同值算一把", async () => {
    for (const [cookie, csrf] of [[OLD, OLD], [NEW, NEW], [OLD, NEW], [NEW, OLD]] as const) {
      expect(await hit(RECEIVE, { cookies: { [cookie.deviceCookie]: tokenA }, csrf: { [csrf.deviceHeader]: "1" } })).toEqual({ status: 200, code: undefined });
    }
    expect((await hit(WRITE, { cookies: { [OLD.deviceCookie]: tokenA, [NEW.deviceCookie]: tokenA }, csrf: { [NEW.deviceHeader]: "1" } })).status).toBe(200);
    expect((await hit(RECEIVE, { cookies: { [NEW.deviceCookie]: tokenA }, method: "GET" })).status).toBe(200);
  });

  test("on：两族 cookie 值不同 → 401 device_conflict；两族 CSRF 头同时出现 → 403 csrf；缺头照拒", async () => {
    expect(await hit(RECEIVE, { cookies: { [OLD.deviceCookie]: tokenA, [NEW.deviceCookie]: tokenB }, csrf: { [OLD.deviceHeader]: "1" } }))
      .toEqual({ status: 401, code: "device_conflict" });
    expect(await hit(RECEIVE, { cookies: { [OLD.deviceCookie]: tokenA, [NEW.deviceCookie]: "dev_forged" }, method: "GET" }))
      .toEqual({ status: 401, code: "device_conflict" });
    expect(await hit(RECEIVE, { cookies: { [NEW.deviceCookie]: tokenA }, csrf: { [OLD.deviceHeader]: "1", [NEW.deviceHeader]: "1" } }))
      .toEqual({ status: 403, code: "csrf" });
    expect(await hit(RECEIVE, { cookies: { [NEW.deviceCookie]: tokenA } })).toEqual({ status: 403, code: "csrf" });
  });

  test("设备端点的 CSRF 门（取消本机待批）：on 认新头、两族同时出现拒；off 不认新头", async () => {
    const cancel = async (policy: BrowserPolicy, csrf: Record<string, string>) => {
      setBrowserPolicyForTest(policy);
      const req = new Request("http://127.0.0.1/api/v1/devices/local/cancel", { method: "POST", headers: { "content-type": "application/json", ...csrf }, body: "{}" });
      setRequestContext(req, { source: "loopback", clientIp: "127.0.0.1", https: false });
      const res = (await handleDevicesPublic(req, new URL(req.url)))!;
      return { status: res.status, error: (await res.json() as { error: string }).error };
    };
    const csrfDenied = { status: 403, error: `${DEVICE_HEADER} header required` };
    expect(await cancel(RECEIVE, { [NEW.deviceHeader]: "1" })).not.toEqual(csrfDenied); // 过了 CSRF，卡在领取 cookie 上
    expect(await cancel(RECEIVE, { [OLD.deviceHeader]: "1", [NEW.deviceHeader]: "1" })).toEqual(csrfDenied);
    expect(await cancel(BROWSER_OFF, { [NEW.deviceHeader]: "1" })).toEqual(csrfDenied);
    expect(await cancel(BROWSER_OFF, { [OLD.deviceHeader]: "1" })).not.toEqual(csrfDenied);
  });

  test("Set-Cookie：off / observe 只种旧族（与现行逐字相同）；只开接收 种旧族并删残留新族；write=on 两族同值；删除时接收 on 两族一起删", () => {
    const opts = { path: "/", secure: false };
    for (const p of [BROWSER_OFF, OBSERVE]) expect(deviceCookieHeaders(tokenA, opts, p)).toEqual([deviceCookieHeader(tokenA, opts)]);
    expect(deviceCookieHeaders(tokenA, opts, RECEIVE)).toEqual([deviceCookieHeader(tokenA, opts), deviceCookieHeader(null, opts, NEW.deviceCookie)]);
    const both = deviceCookieHeaders(tokenA, opts, WRITE);
    expect(both).toEqual([deviceCookieHeader(tokenA, opts), deviceCookieHeader(tokenA, opts).replace(`${OLD.deviceCookie}=`, `${NEW.deviceCookie}=`)]);
    expect(deviceCookieHeaders(null, opts, BROWSER_OFF)).toEqual([deviceCookieHeader(null, opts)]);
    expect(deviceCookieHeaders(null, opts, RECEIVE).map((c) => c.split("=")[0])).toEqual([OLD.deviceCookie, NEW.deviceCookie]);
  });

  test("续发：write=on 两族一起续；业务已写了任一族的设备 cookie 就不续", () => {
    setDeviceCookieRenewForTest("on");
    const renew = (policy: BrowserPolicy, res: Response) => {
      setBrowserPolicyForTest(policy);
      const req = new Request("http://127.0.0.1/api/v1/agents");
      setRequestContext(req, LAN);
      noteDeviceAuth(req, `cred-${Math.random()}`, tokenA);
      return renewDeviceCookie(req, res).headers.getSetCookie().map((c) => c.split("=")[0]);
    };
    expect(renew(BROWSER_OFF, new Response("{}"))).toEqual([OLD.deviceCookie]);
    expect(renew(WRITE, new Response("{}"))).toEqual([OLD.deviceCookie, NEW.deviceCookie]);
    const cleared = new Response("{}", { headers: { "set-cookie": `${NEW.deviceCookie}=; Path=/; Max-Age=0` } });
    expect(renew(WRITE, cleared)).toEqual([NEW.deviceCookie]);
  });

  test("handoff：off 静默丢 floka_ 键（与现行同）；on 收；同后缀两族不同值整份拒，经 HTTP 也一样", async () => {
    const raw = { cstra_theme: "dark", floka_font: "16", other: "x" };
    expect(cleanEntries(raw, BROWSER_OFF)).toEqual({ cstra_theme: "dark" });
    expect(cleanEntries(raw, OBSERVE)).toEqual({ cstra_theme: "dark" });
    expect(cleanEntries(raw, RECEIVE)).toEqual({ cstra_theme: "dark", floka_font: "16" });
    expect(cleanEntries({ cstra_theme: "dark", floka_theme: "light" }, RECEIVE)).toBeNull();
    expect(cleanEntries({ cstra_theme: "dark", floka_theme: "dark" }, RECEIVE)).toEqual({ cstra_theme: "dark", floka_theme: "dark" });
    expect(cleanEntries({ cstra_theme: "dark", floka_theme: "light" }, BROWSER_OFF)).toEqual({ cstra_theme: "dark" });
    setBrowserPolicyForTest(RECEIVE);
    const me = { id: "owner:self", credential: "dev_1" } as unknown as Principal;
    const post = (entries: unknown) => handleHandoff(new Request("http://x/api/v1/handoff", { method: "POST", body: JSON.stringify({ entries }) }), "/handoff", me);
    expect((await post({ cstra_a: "1", floka_a: "2" }))!.status).toBe(400);
    const made = await (await post({ floka_a: "2" }))!.json() as { id: string };
    const taken = await (await handleHandoff(new Request(`http://x/api/v1/handoff/${made.id}`), `/handoff/${made.id}`, me))!.json();
    expect(taken).toEqual({ ok: true, entries: { floka_a: "2" } });
  });

  test("邀请 scheme：write=on 才给新 scheme；旧链接各档都能开，新链接只在接收 on 时认", async () => {
    expect(inviteSchemes(BROWSER_OFF)).toEqual({ web: "web+claudestra:", app: "claudestra://join#" });
    expect(inviteSchemes(RECEIVE)).toEqual({ web: "web+claudestra:", app: "claudestra://join#" });
    expect(inviteSchemes(WRITE)).toEqual({ web: "web+floka:", app: "floka://join#" });
    const code = "eyJ2IjoyLCJuYW1lIjoieCJ9xxxxxx";
    for (const p of [BROWSER_OFF, OBSERVE, RECEIVE, WRITE]) {
      expect(parseInviteLink(`web+claudestra:${code}`, p)).toEqual({ family: "claudestra", code });
      expect(parseInviteLink(`claudestra://join#${code}`, p)).toEqual({ family: "claudestra", code });
    }
    expect(parseInviteLink(`web+floka:${code}`, BROWSER_OFF)).toBeNull();
    expect(parseInviteLink(`floka://join#${code}`, RECEIVE)).toEqual({ family: "floka", code });
    expect(parseInviteLink(`web+floka:${code}<script>`, RECEIVE)).toBeNull();
    expect(await invitePageResponse(WRITE).text()).toContain(`open.href = (mobile ? "floka://join#" : "web+floka:") + code;`);
  });

  test("CORS 允许头：off 与现行逐字相同；旧族设备头不在表里，新族也不进来", () => {
    const base = "Authorization, Content-Type, Last-Event-ID";
    for (const p of [BROWSER_OFF, OBSERVE, RECEIVE, WRITE]) expect(corsHeadersFor("https://a.example", "https://a.example", p)!["Access-Control-Allow-Headers"]).toBe(base);
  });
});

describe("[验收线 1] 清洗：经中继 / peer 入口的新名字不论档位都剥、都钉", () => {
  test("peer 帧：两族设备头与 cookie 都剥", () => {
    const h = forwardHeaders({ cookie: `${NEW.deviceCookie}=dev_x`, [OLD.deviceHeader]: "1", [NEW.deviceHeader]: "1", accept: "*/*" }, dropForPeer);
    expect(h).toEqual({ accept: "*/*" });
  });

  test("peer 入口（非回环）：伪造的新名 cookie / 设备头进不了下游，off 也一样", async () => {
    for (const p of [BROWSER_OFF, WRITE]) {
      setBrowserPolicyForTest(p);
      let seen: Record<string, string> = {};
      const req = new Request("http://peer.test/api/v1/invite", {
        headers: { cookie: `${NEW.deviceCookie}=dev_forged; ${OLD.deviceCookie}=dev_forged`, [NEW.deviceHeader]: "1", [OLD.deviceHeader]: "1" },
      });
      const res = await ingressRequest(req, async (r) => { seen = Object.fromEntries(r.headers); return Response.json({ ok: true }); }, "203.0.113.7");
      expect(res.status).toBe(200);
      expect(Object.keys(seen).filter((k) => k === "cookie" || k === OLD.deviceHeader || k === NEW.deviceHeader)).toEqual([]);
    }
  });

  test("中继路径模式：请求只带两族设备 cookie（各第一对），响应两族同一套钉法，别的 cookie 一律丢", () => {
    expect(filterMachineRequestHeaders({ cookie: `a=1; ${NEW.deviceCookie}=dev_n; ${OLD.deviceCookie}=dev_o; ${NEW.deviceCookie}=dev_2` }))
      .toEqual({ cookie: `${OLD.deviceCookie}=dev_o; ${NEW.deviceCookie}=dev_n` });
    expect(filterMachineRequestHeaders({ cookie: `a=1; ${OLD.deviceCookie}=dev_o` })).toEqual({ cookie: `${OLD.deviceCookie}=dev_o` });
    const prefix = "/m/16f9-b5d1-30fb-8923";
    for (const name of [OLD.deviceCookie, NEW.deviceCookie]) {
      expect(pinDeviceCookie(`${name}=dev_x; Path=/; Max-Age=60; SameSite=Lax; Domain=evil`, prefix)).toBe(`${name}=dev_x; Path=${prefix}/; Max-Age=60; HttpOnly; Secure; SameSite=Strict`);
    }
    const out = filterMachineResponseHeaders({ "set-cookie": [`${NEW.deviceCookie}=dev_x; Path=/`, `${NEW.localClaimCookie}=x; Path=/`, "floka_session=x"].join(SET_COOKIE_SEP) }, prefix);
    expect(out["set-cookie"]).toBe(`${NEW.deviceCookie}=dev_x; Path=${prefix}/; HttpOnly; Secure; SameSite=Strict`);
    expect(relayCookieNames(BROWSER_OFF)).toEqual([OLD.deviceCookie]);
  });
});

describe("[验收线 2] SW 旧新混搭：消息各处理一次，旧邀请链接可开", () => {
  type Posted = unknown[];
  /** 假 ServiceWorkerGlobalScope：没有 caches、没有 indexedDB（idbGet 自己兜底） */
  function bootSw(source: string) {
    const listeners: Record<string, (e: unknown) => void> = {};
    const shown: { title: string; opts: { tag: string; data: Record<string, unknown> } }[] = [];
    const posted: Posted = [];
    const win = { focus: async () => {}, postMessage: (m: unknown) => posted.push(m) };
    const self = {
      addEventListener: (t: string, f: (e: unknown) => void) => { listeners[t] = f; },
      skipWaiting: () => {}, location: { origin: "https://app.example" },
      clients: { claim: async () => {}, matchAll: async () => [win], openWindow: async () => {} },
      registration: { showNotification: async (title: string, opts: never) => { shown.push({ title, opts }); }, getNotifications: async () => [] },
      navigator: {},
    };
    runInNewContext(source, { self, URL, fetch: async () => new Response("{}"), console, Promise, Set, JSON, Date });
    const waits: Promise<unknown>[] = [];
    const ev = (extra: object) => ({ waitUntil: (p: Promise<unknown>) => waits.push(p), ...extra });
    return {
      shown, posted,
      async push(payload: object) { listeners.push(ev({ data: { json: () => payload } })); await Promise.all(waits.splice(0)); },
      async click(i = shown.length - 1) { listeners.notificationclick(ev({ notification: { data: shown[i].opts.data, close() {} } })); await Promise.all(waits.splice(0)); },
    };
  }
  const NEW_SW = readFileSync(join(ROOT, "web/public/sw.js"), "utf8");
  const BASE_SW = execFileSync("git", ["show", "a9ce220db6645b2a49ecd2f860ec8cccf2d984df:web/public/sw.js"], { cwd: ROOT, encoding: "utf8" });
  /** 旧页面（chat.tsx / asks-store.ts 现行写法）：只认旧族 type */
  const oldPage = (msgs: Posted) => msgs.filter((d) => (d as { type?: string }).type === OLD.openAgent || (d as { type?: string }).type === OLD.openAsk).length;
  /**
   * 新页面 = 两个真实监听器的写法：chat.tsx `onSwOpen("agent", e.data, (o) => …hopThenOpen)`、asks-store.ts `onSwOpen("ask", e.data, (o) => enter(o.value))`。
   * 每条消息两个监听器都收到（与 navigator.serviceWorker 的 message 事件相同）
   */
  const newPage = (msgs: Posted) => {
    const handled: SwOpen[] = [];
    for (const data of msgs) {
      onSwOpen("agent", data, (o) => handled.push(o));
      onSwOpen("ask", data, (o) => handled.push(o));
    }
    return handled;
  };

  test("新 SW / 旧页：proto=floka 的推送点开只发一条，旧页面处理一次；同 id 再点不重发", async () => {
    const sw = bootSw(NEW_SW);
    await sw.push({ title: "t", agent: "web", fp: "", proto: "floka", id: "n1" });
    expect(sw.shown[0].opts.tag).toBe(NEW.notificationTag);
    await sw.click();
    await sw.click();
    expect(sw.posted).toEqual([swOpenMessage({ kind: "agent", agent: "web", fp: "" }, "floka", "n1")]);
    expect(oldPage(sw.posted)).toBe(1);
    expect(newPage(sw.posted)).toEqual([{ kind: "agent", value: "web", fp: "" }]);
  });

  test("旧 SW / 新页：基线 sw.js 发的旧消息，新页面处理一次（重复投递去重）", async () => {
    const sw = bootSw(BASE_SW);
    await sw.push({ title: "t", ask: "a1", agent: "web", fp: "" });
    await sw.click();
    expect(sw.posted).toEqual([{ type: OLD.openAsk, ask: "a1", fp: "" }]);
    expect(newPage([...sw.posted, ...sw.posted])).toEqual([{ kind: "ask", value: "a1", fp: "" }]);
    expect(oldPage(sw.posted)).toBe(1);
  });

  test("页面收件箱：只发新族 type 的消息也认；同 id 只处理一次；agent / ask 互不吞；无关消息不理", () => {
    const msgs = [
      { type: NEW.openAgent, agent: "solo", fp: "" },
      { type: OLD.openAgent, alias: NEW.openAgent, agent: "dup", fp: "", id: "n9" },
      { type: NEW.openAgent, agent: "dup", fp: "", id: "n9" },
      { type: OLD.openAsk, ask: "solo", fp: "" }, // 同一个值、不同 kind：ask 监听器照处理
      { type: "other", agent: "x" }, { type: OLD.openAgent }, null, "str",
    ];
    expect(newPage(msgs)).toEqual([
      { kind: "agent", value: "solo", fp: "" }, { kind: "agent", value: "dup", fp: "" }, { kind: "ask", value: "solo", fp: "" },
    ]);
  });

  test("页面收件箱：没 id 的同一条 2 秒内只处理一次，超过 2 秒再来照常处理；换机器（fp 不同）不算同一条", () => {
    let t = 1_000;
    const inbox = createSwInbox("agent", () => t);
    const m = { type: OLD.openAgent, agent: "web", fp: "" };
    expect(inbox(m)).toEqual({ kind: "agent", value: "web", fp: "" });
    t += 1_500;
    expect(inbox(m)).toBeNull();
    expect(inbox({ ...m, fp: "aaaa-bbbb-cccc-dddd" })).not.toBeNull();
    t += 2_001; // 距第一次 3.5 秒
    expect(inbox(m)).toEqual({ kind: "agent", value: "web", fp: "" });
    expect(createSwInbox("ask", () => t)(m)).toBeNull(); // agent 消息进 ask 收件箱不算
  });

  test("不带 proto 的推送：新 SW 的通知与消息与基线 SW 逐项相同", async () => {
    const [a, b] = [bootSw(NEW_SW), bootSw(BASE_SW)];
    for (const sw of [a, b]) { await sw.push({ title: "t", agent: "web", fp: "", ts: 5 }); await sw.click(); }
    expect(a.shown).toEqual(b.shown);
    expect(a.posted).toEqual(b.posted);
    expect(notificationTag(undefined, undefined)).toBe(OLD.notificationTag);
    expect(swOpenMessage({ kind: "agent", agent: "web", fp: "" }, "")).toEqual(b.posted[0] as never);
  });

  test("邀请落地页：off 与基线逐字相同，旧 scheme 链接照给", async () => {
    const base = execFileSync("git", ["show", "a9ce220db6645b2a49ecd2f860ec8cccf2d984df:src/bridge/invite-page.ts"], { cwd: ROOT, encoding: "utf8" });
    const html = await invitePageResponse(BROWSER_OFF).text();
    expect(html).toContain(`open.href = (mobile ? "claudestra://join#" : "web+claudestra:") + code;`);
    const baseHtml = base.slice(base.indexOf("const HTML = `") + "const HTML = `".length, base.indexOf("</html>`;") + "</html>".length);
    expect(html).toBe(baseHtml);
  });
});

describe("[验收线 3] off / observe 认证不变；回旧版本仍认最新配对，无 CSRF 绕过", () => {
  const MATRIX: { name: string; p: Probe; want: number }[] = [
    { name: "旧 cookie + 旧头", p: { cookies: { [OLD.deviceCookie]: "A" }, csrf: { [OLD.deviceHeader]: "1" } }, want: 200 },
    { name: "旧 cookie + 新头", p: { cookies: { [OLD.deviceCookie]: "A" }, csrf: { [NEW.deviceHeader]: "1" } }, want: 403 },
    { name: "旧 cookie + 两族头", p: { cookies: { [OLD.deviceCookie]: "A" }, csrf: { [OLD.deviceHeader]: "1", [NEW.deviceHeader]: "1" } }, want: 200 },
    { name: "只有新 cookie", p: { cookies: { [NEW.deviceCookie]: "A" }, csrf: { [OLD.deviceHeader]: "1" } }, want: 401 },
    { name: "旧新 cookie 不同值", p: { cookies: { [OLD.deviceCookie]: "A", [NEW.deviceCookie]: "B" }, csrf: { [OLD.deviceHeader]: "1" } }, want: 200 },
    { name: "旧 cookie GET", p: { cookies: { [OLD.deviceCookie]: "A" }, method: "GET" }, want: 200 },
  ];
  const real = (p: Probe): Probe => ({ ...p, cookies: Object.fromEntries(Object.entries(p.cookies ?? {}).map(([k, v]) => [k, v === "A" ? tokenA : tokenB])) });

  test("off 与 observe：每一格都按现行只认旧族判（新名字被无视，不多放、不多拒）", async () => {
    const log = spyOn(console, "info").mockImplementation(() => {});
    try {
      for (const row of MATRIX) {
        expect({ row: row.name, status: (await hit(BROWSER_OFF, real(row.p))).status }).toEqual({ row: row.name, status: row.want });
        expect({ row: row.name, status: (await hit(OBSERVE, real(row.p))).status }).toEqual({ row: row.name, status: row.want });
      }
      expect(log.mock.calls.some((c) => String(c[0]).startsWith("[floka-browser] observe"))).toBe(true);
      expect(log.mock.calls.every((c) => !String(c[0]).includes(tokenA) && !String(c[0]).includes(tokenB))).toBe(true);
    } finally { log.mockRestore(); }
  });

  test("observe 只记判断，读出来与 off 相同", () => {
    const log = spyOn(console, "info").mockImplementation(() => {});
    try {
      const header = `${OLD.deviceCookie}=dev_a; ${NEW.deviceCookie}=dev_b`;
      expect(readBrowserCookie(header, "deviceCookie", OBSERVE)).toEqual(readBrowserCookie(header, "deviceCookie", BROWSER_OFF));
      const h = new Headers({ [NEW.deviceHeader]: "1" });
      expect(readCsrfHeader(h, OBSERVE)).toEqual(readCsrfHeader(h, BROWSER_OFF));
      expect(cookieValueFrom(header, undefined, OBSERVE)).toBe("dev_a");
    } finally { log.mockRestore(); }
  });

  test("write=on 配对后回滚到旧版本：浏览器里的旧族 cookie 就是最新那把，旧版本照认；旧版本不认新头，CSRF 不绕过", async () => {
    const jar = deviceCookieHeaders(tokenB, { path: "/", secure: false }, WRITE).map((c) => c.split(";")[0]);
    expect(jar).toEqual([`${OLD.deviceCookie}=${tokenB}`, `${NEW.deviceCookie}=${tokenB}`]);
    const cookies = Object.fromEntries(jar.map((kv) => kv.split("=") as [string, string]));
    // 回滚 = 旧版本的认证：只认旧族（off 档逐字等于现行）
    const ok = await hit(BROWSER_OFF, { cookies, csrf: { [OLD.deviceHeader]: "1" } });
    expect(ok.status).toBe(200);
    expect(await hit(BROWSER_OFF, { cookies, csrf: { [NEW.deviceHeader]: "1" } })).toEqual({ status: 403, code: "csrf" });
    expect(await hit(BROWSER_OFF, { cookies })).toEqual({ status: 403, code: "csrf" });
  });

  /** 按浏览器规则把 Set-Cookie 落进 cookie jar（同名覆盖，Max-Age=0 删除） */
  function applySetCookies(jar: Map<string, string>, setCookies: string[]): void {
    for (const c of setCookies) {
      const [kv, ...attrs] = c.split(";").map((s) => s.trim());
      const i = kv!.indexOf("=");
      const name = kv!.slice(0, i);
      if (attrs.some((a) => a.toLowerCase() === "max-age=0")) jar.delete(name);
      else jar.set(name, kv!.slice(i + 1));
    }
  }
  const header = (jar: Map<string, string>) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  async function hitJar(policy: BrowserPolicy, jar: Map<string, string>): Promise<{ status: number; code?: string; id?: string }> {
    setBrowserPolicyForTest(policy);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/agents`, { method: "POST", headers: { cookie: header(jar), [OLD.deviceHeader]: "1" } });
    applySetCookies(jar, res.headers.getSetCookie());
    const body = await res.json() as { code?: string; credential?: { id?: string } };
    return { status: res.status, code: body.code, id: body.credential?.id };
  }
  const opts = { path: "/", secure: false };

  test("[回归] write=on 配对 A 后关新写入（只开接收）重新配对 B：残留新族被删，jar 只剩 B，认证过", async () => {
    const jar = new Map<string, string>();
    applySetCookies(jar, deviceCookieHeaders(tokenA, opts, WRITE));
    applySetCookies(jar, deviceCookieHeaders(tokenB, opts, RECEIVE));
    expect([...jar]).toEqual([[OLD.deviceCookie, tokenB]]);
    expect(readBrowserCookie(header(jar), "deviceCookie", RECEIVE)).toEqual({ status: "ok", value: tokenB, family: "claudestra" });
    const b = await hitJar(RECEIVE, jar);
    expect(b.status).toBe(200);
    expect((await hitJar(WRITE, jar)).id).toBe(b.id);
  });

  test("[回归] write=on 配对 A → 回旧版本 / off 档重新配对 B → 再开双认：首个请求冲突照拒并删新族镜像，之后按旧族认 B；CSRF 不降级", async () => {
    const jar = new Map<string, string>();
    applySetCookies(jar, deviceCookieHeaders(tokenA, opts, WRITE));
    applySetCookies(jar, deviceCookieHeaders(tokenB, opts, BROWSER_OFF)); // 旧版本 / off：只写旧族（与现行逐字相同，删不到新族）
    expect(readBrowserCookie(header(jar), "deviceCookie", RECEIVE)).toEqual({ status: "conflict" });
    expect(await hitJar(RECEIVE, jar)).toMatchObject({ status: 401, code: "device_conflict" });
    expect([...jar]).toEqual([[OLD.deviceCookie, tokenB]]);
    const b = await hitJar(RECEIVE, jar);
    expect(b.status).toBe(200);
    // 冲突恢复不放松 CSRF：缺头仍 403
    expect(await hit(RECEIVE, { cookies: Object.fromEntries(jar) })).toEqual({ status: 403, code: "csrf" });
    // 再开新写入续上两族同值
    applySetCookies(jar, deviceCookieHeaders(tokenB, opts, WRITE));
    expect((await hitJar(WRITE, jar)).id).toBe(b.id);
  });

  test("off / observe 下冲突不存在：旧族照认，响应不带任何 Set-Cookie（逐字等于现状）", async () => {
    for (const p of [BROWSER_OFF, OBSERVE]) {
      const jar = new Map([[OLD.deviceCookie, tokenB], [NEW.deviceCookie, tokenA]]);
      const log = spyOn(console, "info").mockImplementation(() => {});
      try { expect((await hitJar(p, jar)).status).toBe(200); } finally { log.mockRestore(); }
      expect(jar.get(NEW.deviceCookie)).toBe(tokenA);
    }
  });
});
