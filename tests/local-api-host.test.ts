/**
 * 本地 API：GET /api/v1/host、POST /api/v1/agents/:name/open、POST /api/v1/projects/:id/open——本机 = 真实回环，或本机反代转来、
 * 来源地址是本机网卡（lib/same-host.ts，另见 tests/same-host.test.ts）；直连客户端自己写的 X-Forwarded-For 不算；
 * 经中继的永远不算本机，直托管时回 localEntry。打开方式的候选表与 argv 拼装（lib/host-openers.ts）直测。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setHostDepsForTest } from "../src/bridge/local-api/host.js";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import { setRequestContext, type RequestContext } from "../src/bridge/request-context.js";
import { detectOpeners, openArgv, type Probe } from "../src/lib/host-openers.js";
import type { Principal } from "../src/lib/principals.js";

const OWNER: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: "2026-01-01T00:00:00Z", manage: true, credential: "dev_o1" };
const GUEST: Principal = { id: "guest:1234", role: "external", name: "friend", agents: ["worker"], createdAt: "2026-01-01T00:00:00Z", manage: false, credential: "dev_g1" };
const RELAY: RequestContext = { source: "relay", clientIp: "127.0.0.1", relayBase: "relay.test", pathPrefix: "/m/16f9-b5d1-30fb-8923", https: true };
const LAN: RequestContext = { source: "lan", clientIp: "192.168.1.9", https: false };
const LOOPBACK: RequestContext = { source: "loopback", clientIp: "127.0.0.1", https: false };
/** 本机反代（Caddy / tailscale serve）转来：对端是回环、带 XFF，所以 source 是 lan */
const VIA_PROXY: RequestContext = { source: "lan", clientIp: "127.0.0.1", https: true };

let dir: string;
let workerDir: string;
let masterDir: string;
const opened: [string, string][] = [];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "local-api-host-"));
  workerDir = join(dir, "repo-a");
  masterDir = join(dir, "master");
  mkdirSync(workerDir);
  mkdirSync(masterDir);
  writeFileSync(join(dir, "registry.json"), JSON.stringify({ socket: "", agents: { "agent-worker": { cwd: workerDir, status: "active" }, "agent-nocwd": { status: "stopped" } } }));
  writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects: [{ id: "proj", name: "P", dirs: [workerDir, join(dir, "repo-b")], createdAt: "" }] }));
  setHostDepsForTest({
    registryPath: join(dir, "registry.json"),
    projectsPath: join(dir, "projects.json"),
    masterDir,
    open: async (id, d) => {
      opened.push([id, d]);
      return id === "nope" ? { ok: false, error: "不支持的打开方式" } : { ok: true };
    },
  });
});
afterAll(() => {
  setHostDepsForTest(undefined);
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, ctx: RequestContext, p: Principal, body?: unknown, xff?: string): Promise<Response> {
  const r = new Request(`http://bridge.local${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(xff ? { "x-forwarded-for": xff } : {}) },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  setRequestContext(r, ctx);
  return (await handleLocalApi(r, new URL(r.url), p))!;
}

describe("GET /api/v1/host", () => {
  test("relay / lan → {local:false}，不给平台与程序清单；伪造 X-Forwarded-For=127.0.0.1 也不算本机", async () => {
    for (const ctx of [RELAY, LAN]) {
      const res = await call("GET", "/api/v1/host", ctx, OWNER, undefined, "127.0.0.1");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, local: false });
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
  test("本机反代转来：XFF 最右一跳是本机地址 → 本机；是外部地址（手机 / 别的电脑）→ 不是；左边伪造的不算", async () => {
    const local = async (xff: string) => ((await (await call("GET", "/api/v1/host", VIA_PROXY, OWNER, undefined, xff)).json()) as { local: boolean }).local;
    expect(await local("127.0.0.1")).toBe(true);
    expect(await local("::1")).toBe(true);
    expect(await local("100.64.9.9")).toBe(false);
    expect(await local("127.0.0.1, 100.64.9.9")).toBe(false);
    opened.length = 0;
    expect((await call("POST", "/api/v1/agents/worker/open", VIA_PROXY, OWNER, { with: "finder" }, "127.0.0.1")).status).toBe(200);
    expect((await call("POST", "/api/v1/agents/worker/open", VIA_PROXY, OWNER, { with: "finder" }, "100.64.9.9")).status).toBe(403);
    expect(opened).toEqual([["finder", workerDir]]);
    opened.length = 0;
  });
  test("经中继 + 直托管前端 → localEntry {port, sameNetwork}（同网提示来自中继）；没直托管 / 非中继 → 没有", async () => {
    const prev = process.env.BRIDGE_STATIC_DIR;
    process.env.BRIDGE_STATIC_DIR = dir;
    try {
      const entryOf = async (ctx: RequestContext) => ((await (await call("GET", "/api/v1/host", ctx, OWNER)).json()) as { localEntry?: unknown }).localEntry;
      expect(await entryOf(RELAY)).toEqual({ port: expect.any(Number), sameNetwork: false });
      expect(await entryOf({ ...RELAY, sameNetwork: true })).toEqual({ port: expect.any(Number), sameNetwork: true });
      expect(await entryOf(LAN)).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.BRIDGE_STATIC_DIR;
      else process.env.BRIDGE_STATIC_DIR = prev;
    }
  });
  test("回环 → local:true + platform + openers（每项 id/label/kind）", async () => {
    const j = (await (await call("GET", "/api/v1/host", LOOPBACK, GUEST)).json()) as { local: boolean; platform: string; openers: { id: string; label: string; kind: string }[] };
    expect(j.local).toBe(true);
    expect(["darwin", "linux", "win32"]).toContain(j.platform);
    expect(Array.isArray(j.openers)).toBe(true);
    for (const o of j.openers) expect(Object.keys(o).sort()).toEqual(["id", "kind", "label"]);
  });
});

describe("POST /api/v1/agents/:name/open", () => {
  test("非回环一律 403（在 scope 校验之前，不泄露 agent 存在与否）", async () => {
    expect((await call("POST", "/api/v1/agents/worker/open", RELAY, OWNER, { with: "finder" })).status).toBe(403);
    expect((await call("POST", "/api/v1/agents/worker/open", LAN, OWNER, { with: "finder" }, "127.0.0.1")).status).toBe(403);
    expect((await call("POST", "/api/v1/agents/nonexistent/open", RELAY, OWNER, { with: "finder" })).status).toBe(403);
    expect(opened).toEqual([]);
  });
  test("回环：scope 外 403；没 with 400；坏 JSON 400；未知 agent / 没 cwd 404；不支持的打开方式 422", async () => {
    expect((await call("POST", "/api/v1/agents/other/open", LOOPBACK, GUEST, { with: "finder" })).status).toBe(403);
    expect((await call("POST", "/api/v1/agents/worker/open", LOOPBACK, OWNER, {})).status).toBe(400);
    expect((await call("POST", "/api/v1/agents/worker/open", LOOPBACK, OWNER, "{")).status).toBe(400);
    expect((await call("POST", "/api/v1/agents/ghost/open", LOOPBACK, OWNER, { with: "finder" })).status).toBe(404);
    expect((await call("POST", "/api/v1/agents/nocwd/open", LOOPBACK, OWNER, { with: "finder" })).status).toBe(404);
    expect((await call("POST", "/api/v1/agents/worker/open", LOOPBACK, OWNER, { with: "nope" })).status).toBe(422);
    expect(opened).toEqual([["nope", workerDir]]);
  });
  test("回环 + scope 内：裸名 / agent- 前缀都能找到目录；master 用 MASTER_DIR", async () => {
    opened.length = 0;
    expect(await (await call("POST", "/api/v1/agents/worker/open", LOOPBACK, GUEST, { with: "finder" })).json()).toEqual({ ok: true, dir: workerDir });
    expect(await (await call("POST", "/api/v1/agents/agent-worker/open", LOOPBACK, OWNER, { with: "vscode" })).json()).toEqual({ ok: true, dir: workerDir });
    expect(await (await call("POST", "/api/v1/agents/master/open", LOOPBACK, OWNER, { with: "iterm" })).json()).toEqual({ ok: true, dir: masterDir });
    expect(opened).toEqual([["finder", workerDir], ["vscode", workerDir], ["iterm", masterDir]]);
  });
});

describe("POST /api/v1/projects/:id/open", () => {
  test("非回环 403；回环但没 manage 403；未知 project / 越界 index 404；index 选第几个目录", async () => {
    expect((await call("POST", "/api/v1/projects/proj/open", RELAY, OWNER, { with: "finder" })).status).toBe(403);
    expect((await call("POST", "/api/v1/projects/proj/open", LOOPBACK, GUEST, { with: "finder" })).status).toBe(403);
    expect((await call("POST", "/api/v1/projects/zzz/open", LOOPBACK, OWNER, { with: "finder" })).status).toBe(404);
    expect((await call("POST", "/api/v1/projects/proj/open", LOOPBACK, OWNER, { with: "finder", index: 5 })).status).toBe(404);
    opened.length = 0;
    expect(await (await call("POST", "/api/v1/projects/proj/open", LOOPBACK, OWNER, { with: "finder" })).json()).toEqual({ ok: true, dir: workerDir });
    expect(await (await call("POST", "/api/v1/projects/proj/open", LOOPBACK, OWNER, { with: "finder", index: 1 })).json()).toEqual({ ok: true, dir: join(dir, "repo-b") });
    expect(opened.length).toBe(2);
  });
});

describe("lib/host-openers", () => {
  const macProbe: Probe = { exists: (p) => p === "/Applications/iTerm.app" || p === "/Applications/kitty.app" || p === "~/Applications/Cursor.app", which: () => false };
  const linuxProbe: Probe = { exists: () => false, which: (c) => c === "code" || c === "kitty" || c === "xdg-open" };
  test("darwin：Finder 永远在；.app 按四个目录探测；PATH 不算", () => {
    expect(detectOpeners("darwin", macProbe).map((o) => o.id)).toEqual(["finder", "iterm", "kitty", "cursor"]);
    expect(detectOpeners("darwin", macProbe).find((o) => o.id === "iterm")).toEqual({ id: "iterm", label: "iTerm2", kind: "terminal" });
  });
  test("linux：靠 PATH；macOS 专属项不出现", () => {
    expect(detectOpeners("linux", linuxProbe).map((o) => o.id)).toEqual(["xdg", "kitty", "vscode"]);
  });
  test("argv：目录只来自参数；darwin 走 open -a，多段参数的终端走 --args；linux 走命令；不可用 / 未知 → null", () => {
    expect(openArgv("finder", "/w s", "darwin", macProbe)).toEqual(["open", "/w s"]);
    expect(openArgv("iterm", "/w", "darwin", macProbe)).toEqual(["open", "-a", "iTerm", "/w"]);
    expect(openArgv("kitty", "/w", "darwin", macProbe)).toEqual(["open", "-a", "kitty", "--args", "--directory", "/w"]);
    expect(openArgv("cursor", "/w", "darwin", macProbe)).toEqual(["open", "-a", "Cursor", "/w"]);
    expect(openArgv("kitty", "/w", "linux", linuxProbe)).toEqual(["kitty", "--directory", "/w"]);
    expect(openArgv("vscode", "/w", "linux", linuxProbe)).toEqual(["code", "/w"]);
    expect(openArgv("xdg", "/w", "linux", linuxProbe)).toEqual(["xdg-open", "/w"]);
    expect(openArgv("explorer", "C:\\w", "win32", linuxProbe)).toEqual(["explorer", "C:\\w"]);
    expect(openArgv("vscode", "/w", "darwin", macProbe)).toBeNull();
    expect(openArgv("rm -rf", "/w", "darwin", macProbe)).toBeNull();
    expect(openArgv("finder", "/w", "linux", linuxProbe)).toBeNull();
  });
});
