/**
 * 沙箱 lab 模式的闸（src/lib/sandbox-lab.ts 与接到 lib/sandbox.ts 的几处）：审查重点是「lab 能不能被绕到生产」。
 * 纯函数逐条钉住：生产中继 / 别的回环中继、生产 APNs 配置、真推送服务的订阅、指向非 lab 实例（生产端口、别的机器、
 * 标记不对的目录）的 peer 一律拒；lab 开关写错或没和沙箱一起开直接报错。
 * 再起一个带 lab 环境的子进程：fetch / WebSocket / node:https / node:http2 连真中继域名、api.push.apple.com、fcm、公网 IP、
 * 生产端口都被出站闸门拒并打 sandbox-outbound-blocked；writePeers / saveEnvText 在沙箱里拒。两实例实测见 PR 的验收记录。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  isLab, labConfigProblems, labOutboundPorts, labPeerUrlProblem, labPushEndpointProblem, labRelayUrl, labRelayUrlProblem, readLabInstances,
} from "../src/lib/sandbox-lab.js";
import {
  sandboxBridgeEnvProblems, sandboxDisabledOutsideLab, sandboxPeerUrlProblem, sandboxPushEndpointProblem, sandboxRelayUrlProblem, SANDBOX_MARKER,
} from "../src/lib/sandbox.js";
import { OUTBOUND_BLOCKED_MARK } from "../src/lib/sandbox-outbound.js";
import { sandboxManagerRefusal } from "../src/lib/sandbox-env.js";
import { sandboxDeniedRoute } from "../src/bridge/sandbox-routes.js";
import { DEFAULT_RELAY_URL } from "../src/lib/setup-remote-access.js";
import { PushGateway } from "../src/relay/push.js";
import { labRelayEnvProblems } from "../scripts/sandbox-lab-relay.ts";
import { testChildEnv } from "./test-env.ts";

const REPO = join(import.meta.dir, "..");
const BUN = process.execPath;
const PROD = 3847;
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "lab-gate-")));
const LAB = join(tmp, "lab");
// 端口布局同 scripts/sandbox-lab.ts：A、B、A 入口、B 入口、中继、假推送、假 APNs
const [A, B, IA, IB, RELAY, PUSH, APNS] = [24910, 24911, 24912, 24913, 24914, 24915, 24916];

function marker(side: string, port: number, ingressPort: number, lab = LAB): void {
  mkdirSync(join(LAB, side), { recursive: true });
  writeFileSync(join(LAB, side, SANDBOX_MARKER), JSON.stringify({ root: join(LAB, side), port, ingressPort, lab }));
}
marker("a", A, IA);
marker("b", B, IB);
marker("c", 24920, 24921, "/somewhere/else"); // 标记记的 lab 不是这个目录：不算 lab 实例
mkdirSync(join(LAB, "d"));
writeFileSync(join(LAB, "d", SANDBOX_MARKER), JSON.stringify({ root: "/tmp/not-me", port: 24930, lab: LAB })); // 根对不上

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** 实例 A 的完整 lab 环境（scripts/sandbox.ts 给 --lab --pair 的那份），extra 覆盖 */
function labEnvA(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_SANDBOX_LAB: "1", CLAUDESTRA_SANDBOX_ROOT: join(LAB, "a"), CLAUDESTRA_LAB_ROOT: LAB,
    CLAUDESTRA_LAB_RELAY_PORT: String(RELAY), CLAUDESTRA_LAB_PUSH_PORT: String(PUSH), CLAUDESTRA_LAB_APNS_PORT: String(APNS),
    CLAUDESTRA_LAB_PORTS: [A, IA, B, IB, RELAY].join(","), CLAUDESTRA_SANDBOX_DENY_PORTS: `${PROD},3848`, BRIDGE_PORT: String(A), ...extra,
  };
}

describe("lab 开关", () => {
  test("只认 1 / 空 / 0；lab 必须和沙箱一起开，否则报错（不悄悄当成开或关）", () => {
    expect(isLab({})).toBe(false);
    expect(isLab({ CLAUDESTRA_SANDBOX_LAB: "0", CLAUDESTRA_SANDBOX: "1" })).toBe(false);
    expect(isLab(labEnvA())).toBe(true);
    expect(() => isLab({ CLAUDESTRA_SANDBOX_LAB: "1" })).toThrow("只能和 CLAUDESTRA_SANDBOX=1 一起用");
    expect(() => isLab({ CLAUDESTRA_SANDBOX_LAB: "1", CLAUDESTRA_SANDBOX: "0" })).toThrow("只能和");
    expect(() => isLab({ CLAUDESTRA_SANDBOX_LAB: "yes", CLAUDESTRA_SANDBOX: "1" })).toThrow("不认识");
  });

  test("非沙箱 / 普通沙箱：lab 放行的功能一律不开，闸都返回拒绝或空", () => {
    expect(sandboxDisabledOutsideLab("中继", {})).toBeNull(); // 非沙箱：生产行为不变
    expect(sandboxDisabledOutsideLab("中继", { CLAUDESTRA_SANDBOX: "1" })).toContain("lab 模式才开");
    expect(sandboxDisabledOutsideLab("中继", labEnvA())).toBeNull();
    expect(sandboxRelayUrlProblem(labRelayUrl(labEnvA())!, { CLAUDESTRA_SANDBOX: "1" })).toBe("沙箱不连中继");
    expect(sandboxPeerUrlProblem(`http://127.0.0.1:${B}`, { CLAUDESTRA_SANDBOX: "1" })).toBe("沙箱不建 peer");
    expect(sandboxPeerUrlProblem(undefined, { CLAUDESTRA_SANDBOX: "1" })).toBe("沙箱不建 peer");
    expect(sandboxPushEndpointProblem(`https://127.0.0.1:${PUSH}/wp/x`, { CLAUDESTRA_SANDBOX: "1" })).toBe("沙箱不收推送订阅");
    for (const f of [sandboxRelayUrlProblem, sandboxPeerUrlProblem, sandboxPushEndpointProblem]) expect(f("https://anything.example", {})).toBeNull();
    expect(labOutboundPorts({ CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_LAB_PORTS: "1,2" })).toEqual([]);
  });
});

describe("lab 配置自洽（沙箱进程加载时查）", () => {
  test("完整配置没有问题", () => expect(labConfigProblems(labEnvA(), A, [PROD])).toEqual([]));

  test("lab 端口撞生产、重复、缺失、沙箱根不在 lab 目录下一层，都报", () => {
    expect(labConfigProblems(labEnvA({ CLAUDESTRA_LAB_RELAY_PORT: String(PROD), CLAUDESTRA_LAB_PORTS: `${A},${PROD}` }), A, [PROD]).join()).toContain("是生产端口");
    expect(labConfigProblems(labEnvA({ CLAUDESTRA_LAB_PUSH_PORT: String(PROD) }), A, [PROD]).join()).toContain("是生产端口");
    expect(labConfigProblems(labEnvA({ CLAUDESTRA_LAB_APNS_PORT: String(RELAY) }), A, [PROD]).join()).toContain("重复");
    expect(labConfigProblems(labEnvA({ CLAUDESTRA_LAB_RELAY_PORT: undefined }), A, [PROD]).join()).toContain("没设");
    expect(labConfigProblems(labEnvA({ CLAUDESTRA_LAB_PORTS: `${A},abc` }), A, [PROD]).join()).toContain("不合法");
    expect(labConfigProblems(labEnvA({ CLAUDESTRA_LAB_ROOT: "relative/lab" }), A, [PROD]).join()).toContain("绝对路径");
    expect(labConfigProblems(labEnvA({ CLAUDESTRA_SANDBOX_ROOT: join(tmp, "elsewhere") }), A, [PROD]).join()).toContain("不在 lab 目录");
    expect(labConfigProblems(labEnvA({ CLAUDESTRA_LAB_RELAY_PORT: "24999" }), A, [PROD]).join()).toContain("不在 CLAUDESTRA_LAB_PORTS");
    expect(labConfigProblems(labEnvA({ CLAUDESTRA_LAB_RELAY_PORT: String(A) }), A, [PROD]).join()).toContain("与 bridge 端口相同");
  });

  test("出站放行名单 = 实例端口 + 假推送两个端口，没有生产端口", () => {
    expect(labOutboundPorts(labEnvA()).sort()).toEqual([A, B, IA, IB, RELAY, PUSH, APNS].sort());
  });
});

describe("中继地址闸", () => {
  test("只认逐字相同的 lab 中继；生产中继、别的回环端口、换写法一律拒", () => {
    const env = labEnvA();
    expect(labRelayUrl(env)).toBe(`ws://127.0.0.1:${RELAY}`);
    expect(labRelayUrlProblem(`ws://127.0.0.1:${RELAY}`, env)).toBeNull();
    for (const bad of [DEFAULT_RELAY_URL, "wss://relay.example.com", `ws://127.0.0.1:${RELAY + 1}`, `ws://localhost:${RELAY}`,
      `wss://127.0.0.1:${RELAY}`, `ws://127.0.0.1:${RELAY}/`, `ws://user@127.0.0.1:${RELAY}`, `ws://127.0.0.1:${PROD}`]) {
      expect(labRelayUrlProblem(bad, env)).toContain("不是 lab 中继");
    }
    expect(labRelayUrlProblem(`ws://127.0.0.1:${RELAY}`, { ...env, CLAUDESTRA_LAB_RELAY_PORT: undefined })).toContain("一律拒绝");
  });

  test("bridge 环境：lab 里 RELAY_URL / PEER_INGRESS_PORT 只能指向 lab 自己；APNs 凭据、对外开放的键照旧拒", () => {
    const ok = labEnvA({ RELAY_URL: `ws://127.0.0.1:${RELAY}`, PEER_INGRESS_PORT: String(IA) });
    expect(sandboxBridgeEnvProblems(PROD, ok)).toEqual([]);
    const bad: Array<[Record<string, string>, string]> = [
      [{ RELAY_URL: DEFAULT_RELAY_URL }, "RELAY_URL"],
      [{ RELAY_URL: `ws://127.0.0.1:${B}` }, "RELAY_URL"],
      [{ PEER_INGRESS_PORT: String(A) }, "PEER_INGRESS_PORT"], // 等于自己的 bridge 端口
      [{ PEER_INGRESS_PORT: "3848" }, "PEER_INGRESS_PORT"],
      [{ PEER_INGRESS_PORT: String(PUSH) }, "PEER_INGRESS_PORT"], // 假推送端口不是实例端口
      [{ APNS_KEY_ID: "ABC123" }, "APNS_KEY_ID"],
      [{ APNS_TEAM_ID: "T" }, "APNS_TEAM_ID"],
      [{ APNS_KEY_DIR: "/x" }, "APNS_KEY_DIR"],
      [{ PEER_INGRESS_PUBLIC: "1" }, "PEER_INGRESS_PUBLIC"],
      [{ PEER_PUBLIC_URL: "https://x.ts.net" }, "PEER_PUBLIC_URL"],
      [{ DISCORD_BOT_TOKEN: "t" }, "DISCORD_BOT_TOKEN"],
    ];
    for (const [extra, key] of bad) expect(sandboxBridgeEnvProblems(PROD, { ...ok, ...extra }).join(), key).toContain(key);
    // 普通沙箱（没开 lab）：lab 中继地址也不行
    expect(sandboxBridgeEnvProblems(PROD, { CLAUDESTRA_SANDBOX: "1", BRIDGE_PORT: String(A), RELAY_URL: `ws://127.0.0.1:${RELAY}` }).join()).toContain("RELAY_URL");
  });
});

describe("推送闸", () => {
  test("订阅 endpoint 只认 https://127.0.0.1:<假推送端口>；真推送服务、别的端口、http、带凭据的都拒", () => {
    const env = labEnvA();
    expect(labPushEndpointProblem(`https://127.0.0.1:${PUSH}/wp/abc`, env)).toBeNull();
    for (const bad of ["https://fcm.googleapis.com/fcm/send/x", "https://web.push.apple.com/QGx", "https://updates.push.services.mozilla.com/wpush/v2/x",
      `https://127.0.0.1:${APNS}/wp/x`, `http://127.0.0.1:${PUSH}/wp/x`, `https://localhost:${PUSH}/wp/x`, `https://u:p@127.0.0.1:${PUSH}/wp/x`,
      `https://127.0.0.1:${PUSH}.evil.com/`, "not a url"]) {
      expect(labPushEndpointProblem(bad, env), bad).not.toBeNull();
    }
    expect(sandboxPushEndpointProblem("https://fcm.googleapis.com/fcm/send/x", env)).not.toBeNull();
  });

  test("中继推送网关钉死 origin：别的 endpoint 回 endpoint_forbidden，后端一次都不调", async () => {
    const sent: string[] = [];
    const gw = new PushGateway({
      perFpPerMinute: 100, log: () => {}, allowPrivateEndpoints: true, pinEndpointOrigin: `https://127.0.0.1:${PUSH}`,
      webPush: async (s) => (sent.push(s.endpoint), 201), apns: null,
    });
    const frame = (endpoint: string) => ({ t: "push", id: "p1", kind: "webpush", subscription: { endpoint, keys: { p256dh: "BP", auth: "au" } }, payload: "{}" });
    for (const e of ["https://fcm.googleapis.com/fcm/send/x", `https://127.0.0.1:${PUSH + 1}/wp/x`, `https://localhost:${PUSH}/wp/x`]) {
      expect((await gw.handle("fp", frame(e)))?.error).toBe("endpoint_forbidden");
    }
    expect(sent).toEqual([]);
    expect((await gw.handle("fp", frame(`https://127.0.0.1:${PUSH}/wp/x`)))?.ok).toBe(true);
    expect(sent).toEqual([`https://127.0.0.1:${PUSH}/wp/x`]);
  });

  test("lab 中继进程：环境里带真推送凭据就拒绝启动；没开 lab 也拒", () => {
    const base = { ...labEnvA(), RELAY_URL: `ws://127.0.0.1:${RELAY}`, RELAY_NAME: "lab-a" };
    expect(labRelayEnvProblems(base)).toEqual([]);
    for (const k of ["APNS_KEY_ID", "RELAY_APNS_KEY_PATH", "RELAY_APNS_TEAM_ID", "RELAY_VAPID_KEYS"]) expect(labRelayEnvProblems({ ...base, [k]: "x" }).join()).toContain(k);
    expect(labRelayEnvProblems({ ...base, CLAUDESTRA_SANDBOX_LAB: undefined }).join()).toContain("lab 中继只由");
    expect(labRelayEnvProblems({ ...base, CLAUDESTRA_SANDBOX: undefined }).join()).toContain("只能和");
  });
});

describe("peer 闸：只认同一 lab 目录下、标记对得上的沙箱实例", () => {
  const inst = readLabInstances(LAB, SANDBOX_MARKER);

  test("读标记：根与 lab 都对得上的才算（c 记的 lab 不对，d 记的根不对）", () => {
    expect(inst.map((i) => i.ports).sort()).toEqual([[A, IA], [B, IB]]);
    expect(readLabInstances(join(tmp, "missing"), SANDBOX_MARKER)).toEqual([]);
  });

  test("回环 + 实例端口放行；生产端口、别的机器、非实例端口、带凭据、怪协议一律拒；relay:// 只认小写前缀", () => {
    for (const ok of [`http://127.0.0.1:${B}`, `http://127.0.0.1:${IB}`, `http://localhost:${IB}`, `https://127.0.0.1:${IA}`, "relay://81b7-94ac-2b5c-d1bf"]) {
      expect(labPeerUrlProblem(ok, inst), ok).toBeNull();
    }
    for (const bad of [`http://127.0.0.1:${PROD}`, "http://127.0.0.1:3848", `http://100.64.1.2:${B}`, `http://192.168.1.5:${IB}`, "https://mac.tail1234.ts.net",
      `http://127.0.0.1:24920`, `http://127.0.0.1:24930`, `http://127.0.0.1:${RELAY}`, `http://u:p@127.0.0.1:${B}`, `ftp://127.0.0.1:${B}`, "RELAY://x", "nope"]) {
      expect(labPeerUrlProblem(bad, inst), bad).not.toBeNull();
    }
  });

  test("接进 sandboxPeerUrlProblem：按环境里的 lab 目录读标记；没有地址（只入站）的记录放行", () => {
    expect(sandboxPeerUrlProblem(`http://127.0.0.1:${IB}`, labEnvA())).toBeNull();
    expect(sandboxPeerUrlProblem(`http://127.0.0.1:${PROD}`, labEnvA())).not.toBeNull();
    expect(sandboxPeerUrlProblem(undefined, labEnvA())).toBeNull();
    expect(sandboxPeerUrlProblem(`http://127.0.0.1:${IB}`, labEnvA({ CLAUDESTRA_LAB_ROOT: join(tmp, "other") }))).not.toBeNull();
  });
});

describe("入口放行面", () => {
  test("manager：peer 新流程只在 lab 开；老三步握手、tidy 在 lab 里也不开；--external 只在 lab 放行", () => {
    for (const c of ["peer-invite-new", "peer-join-auto", "peer-invite-redeem", "peer-http-list", "external"]) {
      expect(sandboxManagerRefusal([c], false), c).not.toBeNull();
      expect(sandboxManagerRefusal([c], true), c).toBeNull();
    }
    for (const c of ["peer-http-invite", "peer-http-join", "peer-http-accept", "peer-http-tidy", "install-cli", "update", "resume"]) {
      expect(sandboxManagerRefusal([c], true), c).not.toBeNull();
    }
    expect(sandboxManagerRefusal(["create", "x", "/d", "--external"], false)).toContain("external");
    expect(sandboxManagerRefusal(["create", "x", "/d", "--external"], true)).toBeNull();
    expect(sandboxManagerRefusal(["restart", "--include-master"], true)).not.toBeNull();
  });

  test("路由：/peers 只标成 lab 放行，其余拒绝表照旧", () => {
    expect(sandboxDeniedRoute("GET", "/peers")?.lab).toBe(true);
    expect(sandboxDeniedRoute("POST", "/peers/redeem")?.lab).toBe(true);
    for (const [m, p] of [["POST", "/update"], ["POST", "/restart-all"], ["PUT", "/config/claude-defaults"], ["POST", "/agents/resume"]]) {
      expect(sandboxDeniedRoute(m!, p!)?.lab, p).toBeUndefined();
    }
  });
});

describe("lab 进程里的兜底（子进程，真装上出站闸门）", () => {
  const home = join(tmp, "home");
  mkdirSync(home, { recursive: true });
  const childEnv = () => testChildEnv({
    HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", ...labEnvA(), BRIDGE_URL: `ws://localhost:${A}`,
    CLAUDESTRA_STATE_DIR: join(LAB, "a", "state"), CLAUDESTRA_RUNTIME_DIR: join(LAB, "a", "run"),
  }) as Record<string, string>;
  const run = async (code: string) => {
    const p = Bun.spawn([BUN, "--no-env-file", "-e", code], { cwd: tmp, stdout: "pipe", stderr: "pipe", env: childEnv() });
    const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
    return { code: await p.exited, out: out.trim(), err };
  };

  test("闸外地址（真中继、Apple / Google 推送、公网 IP、生产端口）四种客户端全拒并打日志；lab 端口放行", async () => {
    const bad = [DEFAULT_RELAY_URL.replace("wss:", "https:"), "https://api.push.apple.com/3/device/abc", "https://api.sandbox.push.apple.com",
      "https://fcm.googleapis.com/fcm/send/x", "https://1.1.1.1/", `http://127.0.0.1:${PROD}/hook`, "http://100.64.1.2:3847/api/v1/agents"];
    // 放行的请求一律带已中止的 signal / 立刻销毁：闸门万一失守也不会真连出去
    const r = await run(`
      await import(${JSON.stringify(join(REPO, "src", "lib", "paths.ts"))});
      const https = require("node:https"), http = require("node:http"), http2 = require("node:http2");
      const verdict = async (f) => { try { await f(); return "through"; } catch (e) { return String(e.message).includes("沙箱模式拒绝出站请求") ? "blocked" : "through:" + e.name; } };
      const out = [];
      for (const u of ${JSON.stringify(bad)}) {
        out.push(await verdict(() => fetch(u, { signal: AbortSignal.abort() })));
        out.push(await verdict(() => { new WebSocket(u.replace(/^http/, "ws")).close(); }));
        out.push(await verdict(() => { (u.startsWith("https") ? https : http).request(u).destroy(); }));
        out.push(await verdict(() => { http2.connect(u).destroy(); }));
      }
      out.push(await verdict(() => { https.request({ hostname: "fcm.googleapis.com", port: 443, path: "/x" }).destroy(); }));
      out.push(await verdict(() => { https.get("https://127.0.0.1:${PUSH}/", { host: "api.push.apple.com" }).destroy(); }));
      out.push(await verdict(() => { http.request({ socketPath: "/tmp/x.sock" }).destroy(); }));
      console.log(out.filter((v) => v !== "blocked").join(",") || "all-blocked");
      const allowed = [];
      allowed.push(await verdict(() => fetch("http://127.0.0.1:${RELAY}/healthz", { signal: AbortSignal.abort() })));
      allowed.push(await verdict(() => { https.request("https://127.0.0.1:${PUSH}/wp/x").on("error", () => {}).destroy(); }));
      allowed.push(await verdict(() => { http2.connect("https://127.0.0.1:${APNS}").on("error", () => {}).destroy(); }));
      console.log(allowed.join(","));`);
    const [blocked, allowed] = r.out.split("\n");
    expect(blocked, r.err).toBe("all-blocked");
    expect(allowed, r.err).toBe("through:AbortError,through,through");
    expect(r.err.split(OUTBOUND_BLOCKED_MARK).length - 1).toBe(bad.length * 4 + 3);
    expect(r.err).toContain("api.push.apple.com");
    expect(r.err).toContain("fcm.googleapis.com");
  }, 30_000);

  test("lab 配置坏了（中继端口是生产端口）：沙箱进程加载就拒绝，闸门都来不及装", async () => {
    const r = await run(`Object.assign(process.env, { CLAUDESTRA_LAB_RELAY_PORT: "${PROD}", CLAUDESTRA_LAB_PORTS: "${A},${PROD}" });
      await import(${JSON.stringify(join(REPO, "src", "lib", "paths.ts"))}); console.log("loaded");`);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("是生产端口");
    expect(r.out).not.toContain("loaded");
  }, 30_000);

  test("writePeers 落盘前过闸；saveEnvText 在沙箱里一律拒（挡住写 .env 打开对外入口）", async () => {
    const r = await run(`
      const { writePeers } = await import(${JSON.stringify(join(REPO, "src", "lib", "peers.ts"))});
      const { saveEnvText } = await import(${JSON.stringify(join(REPO, "src", "lib", "peer-ingress-config.ts"))});
      const out = [];
      const peer = (baseUrl) => ({ httpPeers: [{ name: "x", baseUrl, addedAt: "t" }], pendingInvites: [] });
      for (const u of ["http://127.0.0.1:${PROD}", "http://100.64.1.2:${IB}", "https://mac.tail1234.ts.net"]) {
        try { await writePeers(peer(u)); out.push("written"); } catch (e) { out.push(String(e.message).includes("不能记") ? "refused" : "err:" + e.message); }
      }
      await writePeers(peer("http://127.0.0.1:${IB}")); out.push("ok");
      try { saveEnvText(${JSON.stringify(join(tmp, "x.env"))}, "PEER_INGRESS_PUBLIC=1\\n"); out.push("env-written"); } catch (e) { out.push("env-refused"); }
      console.log(out.join(","));`);
    expect(r.out, r.err).toBe("refused,refused,refused,ok,env-refused");
  }, 30_000);
});
