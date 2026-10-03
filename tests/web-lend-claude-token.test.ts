/** 出借面板「Claude 登录」接口：owner 闸在 IO 之前；只读本机登录状态与旧 token 残留位置；setup-token 写入一律 405，不回显请求体。 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLendClaudeTokenApi } from "../src/bridge/local-api/lend-claude-token.js";
import { claudeTokenPath, legacyClaudeToken } from "../src/lib/lend-claude-token.js";
import { effectivePrincipal, type DeviceCredential } from "../src/lib/devices.js";
import type { Principal } from "../src/lib/principals.js";
const base: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: "2026-01-01", terminal: true };
const device = (manage: boolean, agents = ["*"], terminal = true) => effectivePrincipal({ principal: base, credential: {
  id: "d", v: 1, type: "bearer", hash: "fake", deviceName: "test", createdAt: "2026-01-01",
  grant: { agents, terminal, manage },
} as DeviceCredential });
const path = "/lend/claude-token";
const at = Date.UTC(2026, 9, 2);

test("owner / 全权凭据之前不做任何 IO；写入（旧面板的粘贴 token）一律 405，不回显、不落盘", async () => {
  let io = 0;
  const api = makeLendClaudeTokenApi({ readiness: async () => { io++; return { ready: true, reason: null, at }; },
    legacy: () => { io++; return { file: null, envVar: false }; } });
  for (const p of [device(false), device(true, ["worker"]), { ...base, id: "guest:x", role: "external" } as Principal]) {
    expect((await api(new Request("http://test"), path, p))?.status).toBe(403);
  }
  expect(io).toBe(0);
  for (const method of ["POST", "DELETE", "PUT"]) {
    const r = await api(new Request("http://test", { method, body: JSON.stringify({ token: "fake-secret-cl4" }) }), path, device(true));
    expect(r?.status).toBe(405);
    expect(await r?.text()).not.toContain("fake-secret-cl4");
  }
  expect(io).toBe(0);
  expect(await api(new Request("http://test"), "/lend/other", device(true))).toBeNull();
});

test("GET 报本机登录能不能接单 + 旧 token 残留位置；旧网页包按 configured 显示", async () => {
  const api = makeLendClaudeTokenApi({ readiness: async () => ({ ready: false, reason: "本机 Claude Code 没登录", at }),
    legacy: () => ({ file: "/state/lend-credentials/claude-token.json", envVar: true }) });
  const r = await api(new Request("http://test"), path, device(true));
  expect(await r?.json()).toEqual({ loggedIn: false, reason: "本机 Claude Code 没登录", legacyTokenFile: "/state/lend-credentials/claude-token.json",
    legacyTokenEnv: true, configured: false, savedAt: null });
  const failing = makeLendClaudeTokenApi({ readiness: async () => { throw new Error("fake-secret-cl4"); }, legacy: () => ({ file: null, envVar: false }) });
  const bad = await failing(new Request("http://test"), path, device(true));
  expect(bad?.status).toBe(503);
  expect(await bad?.text()).not.toContain("fake-secret-cl4");
});

test("旧 token 文件只报位置（不读内容、不删）；环境变量只报有没有", () => {
  const root = mkdtempSync(join(tmpdir(), "cl4-legacy-"));
  try {
    const env = { CLAUDESTRA_STATE_DIR: root };
    expect(legacyClaudeToken(env)).toEqual({ file: null, envVar: false });
    const file = claudeTokenPath(env);
    mkdirSync(join(root, "lend-credentials"), { mode: 0o700 });
    writeFileSync(file, JSON.stringify({ token: "fake-old-setup", savedAt: null }), { mode: 0o600 });
    const hint = legacyClaudeToken({ ...env, CLAUDE_CODE_OAUTH_TOKEN: "fake-env-token" });
    expect(hint).toEqual({ file, envVar: true });
    expect(JSON.stringify(hint)).not.toContain("fake-");
    expect(readdirSync(join(root, "lend-credentials"))).toEqual(["claude-token.json"]);
    expect(readFileSync(file, "utf8")).toContain("fake-old-setup");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
